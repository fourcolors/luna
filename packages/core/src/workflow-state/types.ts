/**
 * WorkflowState — public types (Phase 12).
 *
 * Column-shape mirrors DESIGN §5.1 (lines 299–316) 1:1 so the SQLite
 * codec layer (a later phase per §5.2) is thin. No deviation from the
 * schema definition; the status union is kept identical to the SQL CHECK.
 *
 * WorkflowDef is an INTERNAL interface — NOT imported from @effect/workflow.
 * Per DESIGN §7.3: "no public DSL until 2+ real workflows exist." When the
 * first real workflow consumer lands, WorkflowEngine.layerMemory (from
 * @effect/workflow@0.18.1) replaces the internal dispatch fiber; the public
 * surface stays the same.
 */
import type { Effect, Stream } from "effect"

export type WorkflowId = string
export type WorkflowStatus =
  | "pending"
  | "running"
  | "suspended"
  | "completed"
  | "errored"
  | "compensated"

/**
 * Column-mirrored row from DESIGN §5.1 `workflows` table.
 */
export interface WorkflowRecord {
  readonly id: WorkflowId
  readonly kind: string
  readonly sessionId: string | null
  readonly status: WorkflowStatus
  /** JSON-serialized checkpoint payload. Empty string when pending. */
  readonly checkpoint: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * Ordered event from DESIGN §5.1 `workflow_events` table.
 */
export interface WorkflowEvent {
  readonly workflowId: WorkflowId
  readonly seq: number
  readonly kind: string
  readonly payload: string
  readonly ts: number
}

/**
 * Internal workflow definition. Callers supply this to WorkflowRuntime.start().
 * The `run` Effect is the workflow body; it receives input and returns output.
 * Errors raised by `run` are caught and turned into `WorkflowCompensationError`
 * (wrapping the original cause). The runtime drives the fiber and mirrors
 * state transitions into WorkflowState.
 */
export interface WorkflowDef<I, O, E = never> {
  readonly kind: string
  readonly run: (input: I) => Effect.Effect<O, E>
}

export interface WorkflowQuery {
  readonly kind?: string
  readonly status?: ReadonlyArray<WorkflowStatus>
  readonly sessionId?: string | null
}

export interface WorkflowStateApi {
  /** Create a new workflow record in `pending` state. Returns the id. */
  readonly create: (opts: {
    kind: string
    sessionId?: string | null
  }) => Effect.Effect<WorkflowId>

  readonly get: (
    id: WorkflowId,
  ) => Effect.Effect<WorkflowRecord | null>

  readonly setStatus: (
    id: WorkflowId,
    status: WorkflowStatus,
    checkpoint?: string,
  ) => Effect.Effect<void>

  readonly writeCheckpoint: (
    id: WorkflowId,
    checkpoint: string,
  ) => Effect.Effect<void>

  /** Append a structured event to the ordered event log. */
  readonly appendEvent: (
    workflowId: WorkflowId,
    kind: string,
    payload: unknown,
  ) => Effect.Effect<void>

  readonly readEvents: (
    workflowId: WorkflowId,
  ) => Effect.Effect<ReadonlyArray<WorkflowEvent>>

  readonly list: (
    query?: WorkflowQuery,
  ) => Effect.Effect<ReadonlyArray<WorkflowRecord>>
}
