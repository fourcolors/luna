/**
 * WorkflowRuntime — Phase 12.
 *
 * Runtime-layer service that drives workflow execution. Per DESIGN §4, this
 * layer depends on WorkflowState (Persistence) and Clock (Boot).
 *
 * Execution model:
 *   - `start(wf, input)` creates a WorkflowRecord (pending) then forks a
 *     supervised daemon fiber that runs `wf.run(input)`.
 *   - On success: status → "completed", checkpoint written.
 *   - On failure: status → "errored", WorkflowCompensationError appended to
 *     the event log. The fiber exits cleanly (failure does NOT propagate up).
 *   - On scope close (Layer teardown): all in-flight fibers are interrupted,
 *     status → "compensated" (incomplete workflows are marked interrupted).
 *
 * Suspend/resume (Phase 12 — trivial impl):
 *   - `suspend` interrupts the running fiber + writes checkpoint.
 *   - `resume` forks a new fiber from scratch (no Activity replay yet;
 *     replay becomes meaningful when Activities are introduced in a later
 *     phase).
 *
 * Per DESIGN §7.3: "no public DSL until 2+ real workflows exist." The
 * `WorkflowDef<I, O, E>` interface is internal and NOT re-exported from
 * @effect/workflow. When a real workflow DSL is needed, a WorkflowEngine.
 * layerMemory adapter layer can be added without changing this API.
 *
 * Invariants:
 *   - §3.4 #1 no cross-Scope Fiber refs: `FiberSet` guards all running fibers.
 *     Public API exposes ids and records only; never Fiber references.
 *   - §3.4 #4 interruption cascades: Layer.scoped finalizer closes the
 *     FiberSet which interrupts all in-flight workflow fibers. Status is
 *     marked "compensated" for any workflow that didn't complete.
 *   - §6.2 frozen errors: only WorkflowCompensationError; no new TaggedErrors.
 *   - Ref-atomic bookkeeping: running fiber registry via Ref<Map<id, Fiber>>.
 */
import {
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Ref,
} from "effect"
import { Clock } from "../clock.js"
import { WorkflowCompensationError } from "../errors.js"
import { WorkflowState } from "../workflow-state/workflow-state.js"
import type { WorkflowDef, WorkflowId } from "../workflow-state/types.js"
import type { WorkflowRuntimeApi } from "./types.js"

interface RunningEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly fiber: Fiber.RuntimeFiber<any, any>
  /** Original WorkflowDef so resume can re-run. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly def: WorkflowDef<any, any, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly input: any
}

export class WorkflowRuntime extends Effect.Tag(
  "luna/WorkflowRuntime",
)<WorkflowRuntime, WorkflowRuntimeApi>() {
  static readonly Default: Layer.Layer<
    WorkflowRuntime,
    never,
    Clock | WorkflowState
  > = Layer.scoped(
    WorkflowRuntime,
    Effect.gen(function* () {
      const clock = yield* Clock
      const state = yield* WorkflowState
      const fiberSet = yield* FiberSet.make<unknown, unknown>()
      const running = yield* Ref.make<
        ReadonlyMap<WorkflowId, RunningEntry>
      >(new Map())
      /** Def+input retained for suspended workflows so resume can re-run. */
      const suspended = yield* Ref.make<
        ReadonlyMap<WorkflowId, { def: RunningEntry["def"]; input: RunningEntry["input"] }>
      >(new Map())

      // On scope close: interrupt all in-flight fibers and mark them
      // "compensated" (they were not given a chance to complete cleanly).
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const m = yield* Ref.get(running)
          for (const [id, entry] of m.entries()) {
            yield* Fiber.interrupt(entry.fiber).pipe(Effect.ignore)
            yield* state.setStatus(id, "compensated").pipe(Effect.ignore)
          }
        }),
      )

      // Helper: fork a workflow execution fiber.
      const forkWorkflow = (
        id: WorkflowId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        def: WorkflowDef<any, any, any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: any,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          yield* state.setStatus(id, "running")
          yield* state.appendEvent(id, "start", { input })

          const workflowEffect = def.run(input).pipe(
            Effect.flatMap((result) =>
              Effect.gen(function* () {
                const now = yield* clock.nowMs()
                yield* state.setStatus(
                  id,
                  "completed",
                  JSON.stringify({ result, completedAt: now }),
                )
                yield* state.appendEvent(id, "completed", { result })
                yield* Ref.update(running, (m) => {
                  const next = new Map(m)
                  next.delete(id)
                  return next
                })
              }),
            ),
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                const defect = Exit.failCause(cause)
                const err = new WorkflowCompensationError({
                  workflowId: id,
                  stepId: "run",
                  cause: defect,
                })
                yield* state.setStatus(id, "errored", JSON.stringify({ cause: String(cause) }))
                yield* state.appendEvent(id, "errored", { cause: String(cause) })
                yield* Ref.update(running, (m) => {
                  const next = new Map(m)
                  next.delete(id)
                  return next
                })
                // Don't re-raise — the fiber exits cleanly. WorkflowCompensationError
                // is in the event log. Callers query state to detect failures.
                void err
              }),
            ),
          )

          const fiber = yield* FiberSet.run(fiberSet, workflowEffect)
          yield* Ref.update(running, (m) => {
            const next = new Map(m)
            next.set(id, { fiber, def, input })
            return next
          })
        })

      const start: WorkflowRuntimeApi["start"] = (wf, input, opts) =>
        Effect.gen(function* () {
          const id = yield* state.create({
            kind: wf.kind,
            sessionId: opts?.sessionId ?? null,
          })
          yield* forkWorkflow(id, wf, input)
          return id
        })

      const suspend: WorkflowRuntimeApi["suspend"] = (id, reason) =>
        Effect.gen(function* () {
          const m = yield* Ref.get(running)
          const entry = m.get(id)
          if (entry === undefined) {
            const rec = yield* state.get(id)
            if (rec === null) {
              return yield* Effect.fail(
                new WorkflowCompensationError({
                  workflowId: id,
                  stepId: "suspend",
                  cause: "workflow not found",
                }),
              )
            }
            // Already completed/errored/compensated — no-op.
            return
          }
          // Write checkpoint before interrupting so resume has some state.
          const checkpoint = JSON.stringify({ reason, suspendedAt: yield* clock.nowMs() })
          yield* state.writeCheckpoint(id, checkpoint)
          yield* state.setStatus(id, "suspended")
          yield* state.appendEvent(id, "suspended", { reason })
          yield* Fiber.interrupt(entry.fiber).pipe(Effect.ignore)
          // Retain def+input in suspended map for resume
          yield* Ref.update(suspended, (m) => {
            const next = new Map(m)
            next.set(id, { def: entry.def, input: entry.input })
            return next
          })
          yield* Ref.update(running, (m) => {
            const next = new Map(m)
            next.delete(id)
            return next
          })
        })

      const resume: WorkflowRuntimeApi["resume"] = (id, signal) =>
        Effect.gen(function* () {
          const rec = yield* state.get(id)
          if (rec === null) {
            return yield* Effect.fail(
              new WorkflowCompensationError({
                workflowId: id,
                stepId: "resume",
                cause: "workflow not found",
              }),
            )
          }
          if (rec.status !== "suspended") {
            return yield* Effect.fail(
              new WorkflowCompensationError({
                workflowId: id,
                stepId: "resume",
                cause: `cannot resume workflow in status "${rec.status}"`,
              }),
            )
          }
          // Look up def+input from the suspended map (populated by suspend())
          const suspendedMap = yield* Ref.get(suspended)
          const suspendedEntry = suspendedMap.get(id)
          if (suspendedEntry === undefined) {
            // Def not found — runtime restarted or workflow was never suspended
            // via this runtime instance.
            return yield* Effect.fail(
              new WorkflowCompensationError({
                workflowId: id,
                stepId: "resume",
                cause: "workflow definition not available for replay (runtime restarted?)",
              }),
            )
          }
          // Clear from suspended map — it's back to running
          yield* Ref.update(suspended, (m) => {
            const next = new Map(m)
            next.delete(id)
            return next
          })
          yield* state.appendEvent(id, "resume", { signal })
          yield* forkWorkflow(id, suspendedEntry.def, suspendedEntry.input)
        })

      const list: WorkflowRuntimeApi["list"] = (q) => state.list(q)
      const get: WorkflowRuntimeApi["get"] = (id) => state.get(id)

      return {
        start,
        suspend,
        resume,
        list,
        get,
      } satisfies WorkflowRuntimeApi
    }),
  )
}
