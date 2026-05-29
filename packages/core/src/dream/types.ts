// packages/core/src/dream/types.ts
import type { Effect } from "effect"
import { Data } from "effect"
import type { MemoryRecord } from "@luna/memory"
import type { SessionSummary } from "../session/types.js"
import type { StoredMessage } from "../messages.js"

/** The change a reasoner proposes. `after` is an idempotent desired end-state. */
export type DreamOpKind =
  | "memory_dedup" // exact-duplicate removal — the ONLY auto-applied kind in Phase 1
  | "memory_staleness" // proposed + held until Phase 3 survey
  | "memory_contradiction" // proposed + held
  | "belief_candidate" // Phase 2 §7.2: auto-materialized as a PROPOSED belief record (inert until Phase 3 activation); undoable via revert

export interface DreamOp {
  readonly kind: DreamOpKind
  /** The memory record id this op concerns. */
  readonly targetId: string
  /** Snapshot of the target before the op (for undo). null when target is new. */
  readonly before: unknown
  /** Idempotent desired end-state. `null` means "delete the target". */
  readonly after: unknown
  /** Why the reasoner proposed this. Stored verbatim for the survey + training. */
  readonly rationale: string
}

export type DreamAuditStatus = "applied" | "proposed" | "reverted"

export interface DreamAuditRow {
  readonly id: string
  readonly dreamId: string
  readonly at: number
  readonly op: DreamOpKind
  readonly targetId: string
  readonly before: unknown
  readonly after: unknown
  readonly rationale: string
  readonly status: DreamAuditStatus
  readonly appliedAt: number | null
  readonly revertedAt: number | null
}

/** Insert shape — `id` is generated; `revertedAt` starts null. */
export interface DreamAuditRowInput {
  readonly dreamId: string
  readonly at: number
  readonly op: DreamOpKind
  readonly targetId: string
  readonly before: unknown
  readonly after: unknown
  readonly rationale: string
  readonly status: DreamAuditStatus
  readonly appliedAt: number | null
}

export interface DreamAuditQuery {
  readonly dreamId?: string
  readonly status?: DreamAuditStatus
  readonly targetId?: string
  readonly limit?: number
}

/** Everything the reasoner reads for one dream cycle. */
export interface DreamInputs {
  readonly sessions: ReadonlyArray<{
    readonly summary: SessionSummary
    readonly messages: ReadonlyArray<StoredMessage>
  }>
  readonly memories: ReadonlyArray<MemoryRecord>
}

export interface DreamReasonerApi {
  readonly reason: (
    inputs: DreamInputs,
  ) => Effect.Effect<ReadonlyArray<DreamOp>, DreamError>
}
// NOTE: the `DreamReasoner` Effect.Tag is declared in `reasoner.ts`, not here —
// types.ts holds only data shapes + the port *interface*.

export class DreamError extends Data.TaggedError("DreamError")<{
  readonly op: string
  readonly message: string
  readonly cause?: unknown
}> {}
