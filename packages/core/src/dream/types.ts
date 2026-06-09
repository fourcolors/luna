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
  /**
   * Slice B MEASURE-ONLY sampling-agreement confidence for belief_candidate ops.
   * (# of N reasoning passes whose candidate set contained THIS beliefId) / N.
   * Purely for logging into calibration_log alongside the verbalized confidence;
   * ABSENT = today's behavior (Slice A, single pass). NEVER substituted into the
   * materialized belief's confidence (that would change belief strength).
   */
  readonly sampledConfidence?: number
  /**
   * Slice B MEASURE-ONLY effective sample size N for belief_candidate ops
   * (= number of passes that actually produced candidates). ABSENT = Slice A
   * (treated as 1 by the calibration hook). Logging metadata only.
   */
  readonly sampleCount?: number
}

/**
 * Per-kind semantic traits of a dream op — the ONE place that knows what each
 * DreamOpKind means operationally. `Record<DreamOpKind, …>` is exhaustive, so
 * adding a new kind (e.g. a future `skill_candidate`) is a COMPILE ERROR until
 * its traits are declared — no silent fall-through defaults scattered across
 * dream.ts / tier-classifier.ts.
 *
 * Consumers (all derive, never redeclare):
 *  - `MATERIALIZE_OPS` (dream.ts)            ← `materialize`
 *  - `detectabilityFor` (dream.ts)           ← `detectability`
 *  - `revertabilityFor` (tier-classifier.ts) ← `revertability`
 *
 * detectability / revertability magnitudes are PLACEHOLDER heuristics
 * (DECISIONS NEEDING CONFIRMATION — see tier-classifier.feature.md): confirm
 * against real calibration data before any behavior branches on them.
 */
export interface DreamOpTraits {
  /** Materialized to the store on apply (vs. held as a 'proposed' audit row). */
  readonly materialize: boolean
  /** Would the operator NOTICE if this op were wrong? (placeholder heuristic) */
  readonly detectability: number
  /** How cheap is undo? (placeholder heuristic) */
  readonly revertability: {
    readonly materialized: number
    readonly held: number
  }
}

export const DREAM_OP_TRAITS: Record<DreamOpKind, DreamOpTraits> = {
  memory_dedup: {
    materialize: true, // idempotent exact-dup delete (Phase 1)
    detectability: 0,
    revertability: { materialized: 0.9, held: 0.3 },
  },
  memory_staleness: {
    materialize: false, // held until the Phase 3 survey
    detectability: 0,
    revertability: { materialized: 0.3, held: 0.3 },
  },
  memory_contradiction: {
    materialize: false, // held until the Phase 3 survey
    detectability: 0,
    revertability: { materialized: 0.3, held: 0.3 },
  },
  belief_candidate: {
    materialize: true, // staged as a PROPOSED belief (inert until activation)
    detectability: 1, // a confidence-bearing proposal we can later score
    revertability: { materialized: 0.9, held: 0.3 },
  },
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
