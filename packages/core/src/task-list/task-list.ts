/**
 * TaskList — Persistence-layer in-memory store of team-scoped tasks.
 *
 * DESIGN.md §4 places this in the Persistence layer (line 205) alongside
 * SessionStore / MemoryRouter / WorkflowState. §5.1 (lines 285–297) defines
 * the eventual SQL schema; this in-memory implementation mirrors the column
 * shape 1:1 (snake_case → camelCase) so the eventual SQL persistence is a
 * thin codec, not a redesign.
 *
 * Invariants honored (cite §-anchor):
 *   - §3.4 #1 (no cross-Scope Fiber refs): `subscribe()` returns a
 *     `Stream<TaskEvent>` via `Stream.fromPubSub`. The Stream's consumer
 *     Scope owns the drain fiber; the underlying PubSub is never exposed.
 *   - §4 (topology): TaskList depends ONLY on Clock (Boot layer). It does
 *     NOT depend on SessionService, AccountBroker, or any Runtime-layer
 *     module. Phase 11c (TeamBroker) consumes TaskList — never the reverse.
 *   - §5.1 schema parity: in-memory `Task` mirrors the `tasks` table 1:1.
 *     Field-name drift would break the future SQL codec.
 *   - §6.1 + §6.3 additive errors: `TaskNotFoundError`, `TaskAlreadyClaimed`,
 *     `TaskValidationError` live in `./errors.ts`. The frozen
 *     `packages/core/src/errors.ts` is NOT modified.
 *   - §7 service signature: `Effect.Tag("luna/TaskList")` with
 *     `TaskList.Default: Layer<TaskList, never, Clock>` — mirrors AgentRegistry.
 *   - Atomic claim: implemented via a single `Ref.modify` so concurrent
 *     claimers race deterministically — exactly one wins, others see the
 *     post-mutation state and fail with TaskAlreadyClaimedError.
 *
 * Out of scope (Phase 11a): SQL persistence, dependsOn DAG enforcement,
 * team-existence validation, pagination, authorization, mailbox semantics.
 */
import { Effect, Layer, PubSub, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import {
  TaskAlreadyClaimedError,
  TaskNotFoundError,
  TaskValidationError,
} from "./errors.js"

// ─── Types ──────────────────────────────────────────────────────────────────

export type TaskId = string

export type TaskStatus =
  | "created"
  | "claimed"
  | "in_progress"
  | "completed"
  | "blocked"

/**
 * In-memory shape mirroring DESIGN §5.1 `tasks` columns (snake_case → camelCase).
 * When SQL persistence lands, the migration is a thin row-codec.
 */
export interface Task {
  readonly id: TaskId
  readonly teamName: string
  readonly subject: string
  readonly description?: string
  readonly assignee?: string
  readonly status: TaskStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly completedAt?: number
  readonly dependsOn?: ReadonlyArray<TaskId>
}

export interface TaskSpec {
  readonly id?: TaskId
  readonly teamName: string
  readonly subject: string
  readonly description?: string
  readonly assignee?: string
  readonly dependsOn?: ReadonlyArray<TaskId>
}

export type TaskEvent =
  | { readonly _tag: "submitted"; readonly task: Task }
  | { readonly _tag: "claimed"; readonly taskId: TaskId; readonly assignee: string }
  | {
      readonly _tag: "statusChanged"
      readonly taskId: TaskId
      readonly from: TaskStatus
      readonly to: TaskStatus
    }
  | { readonly _tag: "completed"; readonly taskId: TaskId }

export interface TaskQuery {
  readonly teamName?: string
  readonly assignee?: string
  readonly status?: TaskStatus | ReadonlyArray<TaskStatus>
}

export interface TaskListApi {
  readonly submit: (
    spec: TaskSpec,
  ) => Effect.Effect<TaskId, TaskValidationError>
  readonly claim: (
    id: TaskId,
    assignee: string,
  ) => Effect.Effect<Task, TaskNotFoundError | TaskAlreadyClaimedError>
  readonly setStatus: (
    id: TaskId,
    status: TaskStatus,
  ) => Effect.Effect<Task, TaskNotFoundError | TaskValidationError>
  readonly complete: (
    id: TaskId,
  ) => Effect.Effect<Task, TaskNotFoundError | TaskValidationError>
  readonly list: (q?: TaskQuery) => Effect.Effect<ReadonlyArray<Task>>
  readonly subscribe: () => Stream.Stream<TaskEvent>
  readonly get: (id: TaskId) => Effect.Effect<Task | null>
}

// ─── Status transition table ────────────────────────────────────────────────

/**
 * Transition table (per brief §4):
 *   created     → claimed (via claim()) | blocked
 *   claimed     → in_progress | blocked | completed
 *   in_progress → blocked | completed
 *   blocked     → in_progress | claimed | completed
 *   completed   → (terminal)
 *
 * `claim()` itself drives created→claimed; `setStatus` honors the rest. Note
 * blocked→claimed is permitted to allow re-claim after un-block, but assignee
 * is preserved (not changed) by setStatus — only `claim()` mutates assignee.
 */
const validateTransition = (from: TaskStatus, to: TaskStatus): boolean => {
  if (from === "completed") return false
  if (from === to) return true // no-op; treated as valid by setStatus (still bumps updatedAt)
  switch (from) {
    case "created":
      return to === "claimed" || to === "blocked"
    case "claimed":
      return to === "in_progress" || to === "blocked" || to === "completed"
    case "in_progress":
      return to === "blocked" || to === "completed"
    case "blocked":
      return to === "in_progress" || to === "claimed" || to === "completed"
    default:
      return false
  }
}

// ─── Service Tag + Layer ────────────────────────────────────────────────────

export class TaskList extends Effect.Tag("luna/TaskList")<
  TaskList,
  TaskListApi
>() {
  static readonly Default: Layer.Layer<TaskList, never, Clock> = Layer.scoped(
    TaskList,
    Effect.gen(function* () {
      const clock = yield* Clock

      const ref = yield* Ref.make<ReadonlyMap<TaskId, Task>>(new Map())

      /**
       * Unbounded PubSub: chosen over bounded so a slow subscriber CANNOT
       * block writers (brief §5 sim scenario 4). Trade-off: a permanently
       * stalled subscriber accumulates events in memory. Acceptable here
       * because (a) TaskList is a low-volume control-plane store (task
       * counts measured in dozens, not millions), (b) subscribers are
       * scoped — when a Team's Scope closes the subscription drops and
       * the buffer drains. If memory pressure ever becomes real, switch
       * to `PubSub.sliding(N)` and document the drop policy.
       */
      const pubsub = yield* PubSub.unbounded<TaskEvent>()
      // Shutdown pubsub when this Scope closes so any remaining subscribers
      // get a clean stream-end rather than hanging forever.
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

      const genId = (): Effect.Effect<TaskId> =>
        clock.nowMs().pipe(
          Effect.map(
            (ms) =>
              `task-${ms}-${Math.random().toString(36).slice(2, 10)}` as TaskId,
          ),
        )

      const submit: TaskListApi["submit"] = (spec) =>
        Effect.gen(function* () {
          if (spec.subject.trim().length === 0) {
            return yield* Effect.fail(
              new TaskValidationError({
                field: "subject",
                message: "subject must be non-empty",
              }),
            )
          }
          if (spec.teamName.trim().length === 0) {
            return yield* Effect.fail(
              new TaskValidationError({
                field: "teamName",
                message: "teamName must be non-empty",
              }),
            )
          }
          const id = spec.id ?? (yield* genId())
          const now = yield* clock.nowMs()
          // Build with omitted optional fields rather than `: undefined` to
          // satisfy exactOptionalPropertyTypes.
          const base = {
            id,
            teamName: spec.teamName,
            subject: spec.subject,
            // Pre-assignment at submit moves status straight to "claimed"
            // so semantics match a synchronous submit-and-claim pair.
            status: (spec.assignee !== undefined
              ? "claimed"
              : "created") as TaskStatus,
            createdAt: now,
            updatedAt: now,
          }
          const task: Task = {
            ...base,
            ...(spec.description !== undefined
              ? { description: spec.description }
              : {}),
            ...(spec.assignee !== undefined
              ? { assignee: spec.assignee }
              : {}),
            ...(spec.dependsOn !== undefined
              ? { dependsOn: spec.dependsOn }
              : {}),
          }
          // Atomic insert — if id collides, treat as ValidationError so
          // callers don't silently overwrite (mirrors AgentRegistry semantics).
          const inserted = yield* Ref.modify(ref, (m) => {
            if (m.has(id)) return [false, m] as const
            const next = new Map(m)
            next.set(id, task)
            return [true, next] as const
          })
          if (!inserted) {
            return yield* Effect.fail(
              new TaskValidationError({
                field: "id",
                message: `task "${id}" already exists`,
              }),
            )
          }
          yield* PubSub.publish(pubsub, { _tag: "submitted", task })
          if (spec.assignee !== undefined) {
            // Mirror the claim event so subscribers see consistent
            // submitted→claimed ordering for pre-assigned tasks.
            yield* PubSub.publish(pubsub, {
              _tag: "claimed",
              taskId: id,
              assignee: spec.assignee,
            })
          }
          return id
        })

      const claim: TaskListApi["claim"] = (id, assignee) =>
        Effect.gen(function* () {
          const now = yield* clock.nowMs()
          type ClaimOutcome =
            | { readonly _tag: "not-found" }
            | {
                readonly _tag: "already-claimed"
                readonly currentAssignee: string
              }
            | { readonly _tag: "idempotent"; readonly task: Task }
            | { readonly _tag: "claimed"; readonly task: Task }
          // Single Ref.modify — atomic check-and-set. Concurrent claimers
          // serialize through the Ref; exactly one observes assignee===undefined
          // and wins. Others see the post-mutation state and we surface the
          // appropriate outcome below.
          const result: ClaimOutcome = yield* Ref.modify(
            ref,
            (m): readonly [ClaimOutcome, ReadonlyMap<TaskId, Task>] => {
              const cur = m.get(id)
              if (cur === undefined) {
                return [{ _tag: "not-found" }, m]
              }
              if (cur.assignee !== undefined && cur.assignee !== assignee) {
                return [
                  {
                    _tag: "already-claimed",
                    currentAssignee: cur.assignee,
                  },
                  m,
                ]
              }
              // Idempotent same-assignee re-claim: keep status untouched if
              // already past "claimed" (e.g. teammate re-asserts ownership of
              // a task they're already in_progress on). Rationale: a re-claim
              // shouldn't regress in_progress→claimed.
              if (cur.assignee === assignee) {
                return [{ _tag: "idempotent", task: cur }, m]
              }
              const next: Task = {
                ...cur,
                assignee,
                status: "claimed",
                updatedAt: now,
              }
              const m2 = new Map(m)
              m2.set(id, next)
              return [{ _tag: "claimed", task: next }, m2]
            },
          )

          switch (result._tag) {
            case "not-found":
              return yield* Effect.fail(new TaskNotFoundError({ taskId: id }))
            case "already-claimed":
              return yield* Effect.fail(
                new TaskAlreadyClaimedError({
                  taskId: id,
                  currentAssignee: result.currentAssignee,
                  attemptedAssignee: assignee,
                }),
              )
            case "idempotent":
              return result.task
            case "claimed":
              yield* PubSub.publish(pubsub, {
                _tag: "claimed",
                taskId: id,
                assignee,
              })
              return result.task
          }
        })

      const setStatus: TaskListApi["setStatus"] = (id, status) =>
        Effect.gen(function* () {
          const now = yield* clock.nowMs()
          type SetOutcome =
            | { readonly _tag: "not-found" }
            | {
                readonly _tag: "invalid-transition"
                readonly from: TaskStatus
                readonly to: TaskStatus
              }
            | {
                readonly _tag: "ok"
                readonly task: Task
                readonly from: TaskStatus
              }
          const result: SetOutcome = yield* Ref.modify(
            ref,
            (m): readonly [SetOutcome, ReadonlyMap<TaskId, Task>] => {
              const cur = m.get(id)
              if (cur === undefined) {
                return [{ _tag: "not-found" }, m]
              }
              if (!validateTransition(cur.status, status)) {
                return [
                  {
                    _tag: "invalid-transition",
                    from: cur.status,
                    to: status,
                  },
                  m,
                ]
              }
              // Construct next without `completedAt: undefined` to satisfy
              // exactOptionalPropertyTypes when the prior value was unset.
              const completedAt =
                status === "completed" ? now : cur.completedAt
              const next: Task = {
                ...cur,
                status,
                updatedAt: now,
                ...(completedAt !== undefined ? { completedAt } : {}),
              }
              const m2 = new Map(m)
              m2.set(id, next)
              return [{ _tag: "ok", task: next, from: cur.status }, m2]
            },
          )

          switch (result._tag) {
            case "not-found":
              return yield* Effect.fail(new TaskNotFoundError({ taskId: id }))
            case "invalid-transition":
              return yield* Effect.fail(
                new TaskValidationError({
                  field: "status",
                  message: `invalid transition: ${result.from} → ${result.to}`,
                }),
              )
            case "ok":
              if (result.from !== status) {
                yield* PubSub.publish(pubsub, {
                  _tag: "statusChanged",
                  taskId: id,
                  from: result.from,
                  to: status,
                })
                if (status === "completed") {
                  yield* PubSub.publish(pubsub, { _tag: "completed", taskId: id })
                }
              }
              return result.task
          }
        })

      const complete: TaskListApi["complete"] = (id) => setStatus(id, "completed")

      const list: TaskListApi["list"] = (q) =>
        Ref.get(ref).pipe(
          Effect.map((m) => {
            const all = Array.from(m.values())
            if (q === undefined) return all
            const statusSet =
              q.status === undefined
                ? null
                : Array.isArray(q.status)
                  ? new Set(q.status as ReadonlyArray<TaskStatus>)
                  : new Set([q.status as TaskStatus])
            return all.filter((t) => {
              if (q.teamName !== undefined && t.teamName !== q.teamName) return false
              if (q.assignee !== undefined && t.assignee !== q.assignee) return false
              if (statusSet !== null && !statusSet.has(t.status)) return false
              return true
            })
          }),
        )

      /**
       * Live-only subscription. `Stream.fromPubSub` opens its own scoped
       * subscription internally — the consumer's Scope owns the drain fiber.
       * No history replay: subscribers attached after a `submit` will NOT
       * see the prior event. Consumers needing history MUST `list()` first
       * then `subscribe()`. This is the intentional simplification stated
       * in the brief §2.
       */
      const subscribe: TaskListApi["subscribe"] = () =>
        Stream.fromPubSub(pubsub)

      const get: TaskListApi["get"] = (id) =>
        Ref.get(ref).pipe(Effect.map((m) => m.get(id) ?? null))

      return {
        submit,
        claim,
        setStatus,
        complete,
        list,
        subscribe,
        get,
      } satisfies TaskListApi
    }),
  )
}
