/**
 * WorkflowState — in-memory persistence layer for WorkflowRuntime (Phase 12).
 *
 * Mirrors DESIGN §5.1 (lines 299–316) column-for-column:
 *   workflows(id, kind, session_id, state, checkpoint, created_at, updated_at)
 *   workflow_events(workflow_id, seq, kind, payload, ts, PRIMARY KEY(wid,seq))
 *
 * Invariants honored (cite §-anchor):
 *   - §3.4 #3 Ref-atomic updates: all mutations go through Ref.update/modify
 *     so concurrent reads never observe partial state.
 *   - §4 (topology): WorkflowState depends ONLY on Clock (Persistence layer).
 *     WorkflowRuntime (Runtime layer) consumes this — never the reverse.
 *   - §5.1 schema parity: in-memory WorkflowRecord mirrors the workflows table
 *     column-for-column. WorkflowEvent mirrors workflow_events. Field-name
 *     drift from §5.1 would break the future SQL codec.
 *   - §5.2 migration policy: SQL codec is a separate phase; in-memory is the
 *     default.
 *   - §6.1 error taxonomy: raises WorkflowCompensationError only from the
 *     WorkflowRuntime; this persistence layer returns nulls for missing records
 *     (callers handle missing-record semantics).
 *   - Clock dependency: creation/update timestamps use Clock.nowMs();
 *     id generation uses Clock.genId() — same as TaskList, SessionStore.
 */
import { Context,
  Effect,
  Layer,
  Ref,
} from "effect"
import { Clock } from "../clock.js"
import type {
  WorkflowEvent,
  WorkflowId,
  WorkflowQuery,
  WorkflowRecord,
  WorkflowStateApi,
  WorkflowStatus,
} from "./types.js"

interface InternalState {
  readonly workflows: ReadonlyMap<WorkflowId, WorkflowRecord>
  /** workflowId → ordered event log (append-only; seq = index + 1). */
  readonly events: ReadonlyMap<WorkflowId, ReadonlyArray<WorkflowEvent>>
}

const makeEmpty = (): InternalState => ({
  workflows: new Map(),
  events: new Map(),
})

export class WorkflowState extends Context.Service<WorkflowState, WorkflowStateApi>()("luna/WorkflowState") {
  static readonly Default: Layer.Layer<WorkflowState, never, Clock> =
    Layer.effect(
      WorkflowState,
      Effect.gen(function* () {
        const clock = yield* Clock
        const stateRef = yield* Ref.make<InternalState>(makeEmpty())

        const genId = (): Effect.Effect<WorkflowId> =>
          clock.nowMs().pipe(
            Effect.map(
              (ms) => `wf-${ms}-${Math.random().toString(36).slice(2, 10)}` as WorkflowId,
            ),
          )

        const create: WorkflowStateApi["create"] = ({ kind, sessionId }) =>
          Effect.gen(function* () {
            const id = yield* genId()
            const now = yield* clock.nowMs()
            const record: WorkflowRecord = {
              id,
              kind,
              sessionId: sessionId ?? null,
              status: "pending",
              checkpoint: "",
              createdAt: now,
              updatedAt: now,
            }
            yield* Ref.update(stateRef, (s) => ({
              workflows: new Map([...s.workflows, [id, record]]),
              events: new Map([...s.events, [id, []]]),
            }))
            return id
          })

        const get: WorkflowStateApi["get"] = (id) =>
          Ref.get(stateRef).pipe(
            Effect.map((s) => s.workflows.get(id) ?? null),
          )

        const setStatus: WorkflowStateApi["setStatus"] = (
          id,
          status,
          checkpoint,
        ) =>
          Effect.gen(function* () {
            const now = yield* clock.nowMs()
            yield* Ref.update(stateRef, (s) => {
              const existing = s.workflows.get(id)
              if (!existing) return s
              const updated: WorkflowRecord = {
                ...existing,
                status,
                checkpoint: checkpoint ?? existing.checkpoint,
                updatedAt: now,
              }
              return {
                ...s,
                workflows: new Map([...s.workflows, [id, updated]]),
              }
            })
          })

        const writeCheckpoint: WorkflowStateApi["writeCheckpoint"] = (
          id,
          checkpoint,
        ) =>
          Effect.gen(function* () {
            const now = yield* clock.nowMs()
            yield* Ref.update(stateRef, (s) => {
              const existing = s.workflows.get(id)
              if (!existing) return s
              const updated: WorkflowRecord = {
                ...existing,
                checkpoint,
                updatedAt: now,
              }
              return {
                ...s,
                workflows: new Map([...s.workflows, [id, updated]]),
              }
            })
          })

        const appendEvent: WorkflowStateApi["appendEvent"] = (
          workflowId,
          kind,
          payload,
        ) =>
          Effect.gen(function* () {
            const now = yield* clock.nowMs()
            yield* Ref.update(stateRef, (s) => {
              const existing = s.events.get(workflowId) ?? []
              const seq = existing.length + 1
              const ev: WorkflowEvent = {
                workflowId,
                seq,
                kind,
                payload: JSON.stringify(payload),
                ts: now,
              }
              return {
                ...s,
                events: new Map([
                  ...s.events,
                  [workflowId, [...existing, ev]],
                ]),
              }
            })
          })

        const readEvents: WorkflowStateApi["readEvents"] = (workflowId) =>
          Ref.get(stateRef).pipe(
            Effect.map((s) => s.events.get(workflowId) ?? []),
          )

        const list: WorkflowStateApi["list"] = (query) =>
          Ref.get(stateRef).pipe(
            Effect.map((s) => {
              let records = Array.from(s.workflows.values())
              if (query?.kind !== undefined) {
                const k = query.kind
                records = records.filter((r) => r.kind === k)
              }
              if (query?.status !== undefined && query.status.length > 0) {
                const statuses = new Set<WorkflowStatus>(query.status)
                records = records.filter((r) => statuses.has(r.status))
              }
              if (query?.sessionId !== undefined) {
                const sid = query.sessionId
                records = records.filter((r) => r.sessionId === sid)
              }
              return records as ReadonlyArray<WorkflowRecord>
            }),
          )

        return {
          create,
          get,
          setStatus,
          writeCheckpoint,
          appendEvent,
          readEvents,
          list,
        } satisfies WorkflowStateApi
      }),
    )
}
