/**
 * WorkflowRuntime — public types (Phase 12).
 *
 * Per DESIGN §7.3: "Wraps @effect/workflow; no public DSL until 2+ real
 * workflows exist." The WorkflowDef interface is intentionally generic and
 * NOT imported from @effect/workflow — this decouples the public surface from
 * the engine until concrete workflows drive the API.
 */
import type { Effect, Stream } from "effect"
import type { WorkflowCompensationError } from "../errors.js"
import type {
  WorkflowDef,
  WorkflowId,
  WorkflowQuery,
  WorkflowRecord,
} from "../workflow-state/index.js"

export type { WorkflowDef }

export interface WorkflowRuntimeApi {
  /**
   * Start a new workflow execution. Forks a supervised fiber that runs
   * `wf.run(input)`. Status transitions:
   *   pending → running → completed (or errored/compensated on failure).
   * Returns the workflow id.
   */
  readonly start: <I, O, E>(
    wf: WorkflowDef<I, O, E>,
    input: I,
    opts?: { sessionId?: string | null },
  ) => Effect.Effect<WorkflowId>

  /**
   * Suspend a running workflow. Writes a checkpoint and sets status to
   * "suspended". The dispatch fiber is interrupted. The workflow can be
   * resumed via resume(id, signal).
   */
  readonly suspend: (
    id: WorkflowId,
    reason: string,
  ) => Effect.Effect<void, WorkflowCompensationError>

  /**
   * Resume a suspended workflow. Re-runs `wf.run(input)` from scratch
   * (replay is trivial in Phase 12 — no Activity primitive yet). The
   * checkpoint and event log remain for observability.
   */
  readonly resume: (
    id: WorkflowId,
    signal?: unknown,
  ) => Effect.Effect<void, WorkflowCompensationError>

  /**
   * List workflow records matching an optional query predicate.
   */
  readonly list: (
    q?: WorkflowQuery,
  ) => Effect.Effect<ReadonlyArray<WorkflowRecord>>

  /**
   * Retrieve a single workflow record by id.
   */
  readonly get: (
    id: WorkflowId,
  ) => Effect.Effect<WorkflowRecord | null>
}
