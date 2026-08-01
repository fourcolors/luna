// packages/core/src/dream/types.ts
import type { Effect } from "effect"
import { Data } from "effect"
import type { MemoryRecord } from "@luna/memory"
import type { DistilledSession } from "./distill.js"

/** The change a reasoner proposes. `after` is an idempotent desired end-state. */
export type DreamOpKind =
  | "memory_dedup" // exact-duplicate removal — the ONLY auto-applied kind in Phase 1
  | "memory_staleness" // proposed + held until Phase 3 survey
  | "memory_contradiction" // proposed + held
  | "belief_candidate" // Phase 2 §7.2: auto-materialized as a PROPOSED belief record (inert until Phase 3 activation); undoable via revert
  | "skill_improvement" // held audit + SuggestedActions chip; NEVER writes skill files

/**
 * Payload for skill_improvement ops (`DreamOp.after`).
 * Bridged to SuggestedActions (create_skill | task) — never auto-applied to disk.
 */
export interface SkillImprovementAfter {
  /** create a new user skill, or task a rewrite of an existing user skill. */
  readonly mode: "create" | "update"
  /** Existing skill id when mode=update; null for create. */
  readonly skillId: string | null
  /** Short chip title shown in the UI. */
  readonly title: string
  /** Optional longer chip detail. */
  readonly detail: string | null
  /** Self-contained authoring prompt for the accept → prompt-job subagent. */
  readonly prompt: string
}

/** Compact skill catalog line for the dream reasoner (no bodies). */
export interface DreamSkillSummary {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  readonly source: string
}

export interface DreamOp {
  readonly kind: DreamOpKind
  /** The memory record id this op concerns (or skill id / synthetic id for skill_improvement). */
  readonly targetId: string
  /** Snapshot of the target before the op (for undo). null when target is new. */
  readonly before: unknown
  /** Idempotent desired end-state. `null` means "delete the target". */
  readonly after: unknown
  /** Why the reasoner proposed this. Stored verbatim for the survey + training. */
  readonly rationale: string
}

/**
 * Per-kind semantic traits of a dream op — the ONE place that knows what each
 * DreamOpKind means operationally. `Record<DreamOpKind, …>` is exhaustive, so
 * adding a new kind (e.g. a future `skill_candidate`) is a COMPILE ERROR until
 * its traits are declared — no silent fall-through defaults scattered across
 * dream.ts.
 *
 * Consumers (all derive, never redeclare):
 *  - `MATERIALIZE_OPS` (dream.ts) ← `materialize`
 */
export interface DreamOpTraits {
  /** Materialized to the store on apply (vs. held as a 'proposed' audit row). */
  readonly materialize: boolean
}

export const DREAM_OP_TRAITS: Record<DreamOpKind, DreamOpTraits> = {
  memory_dedup: {
    materialize: true, // idempotent exact-dup delete (Phase 1)
  },
  memory_staleness: {
    materialize: false, // held until the Phase 3 survey
  },
  memory_contradiction: {
    materialize: false, // held until the Phase 3 survey
  },
  belief_candidate: {
    materialize: true, // staged as a PROPOSED belief (inert until activation)
  },
  skill_improvement: {
    materialize: false, // NEVER write skill files; chip + audit only
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
  readonly sessions: ReadonlyArray<DistilledSession>
  readonly memories: ReadonlyArray<MemoryRecord>
  /**
   * Skill catalog snapshot (id/name/description/enabled/source only — no bodies).
   * Empty when SkillRegistry is not wired. Used for skill_improvement proposals.
   */
  readonly skills?: ReadonlyArray<DreamSkillSummary>
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
