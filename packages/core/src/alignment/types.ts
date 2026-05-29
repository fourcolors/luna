// packages/core/src/alignment/types.ts
import { Data } from "effect"
import type { BeliefVerdict } from "../beliefs/types.js"

/** Migration-ladder component key for the alignment tables (§5.2). */
export const ALIGNMENT_COMPONENT = "alignment"

/** The three alignment signals (spec §2.3). */
export type SignalKind = "task_quality" | "belief_validation" | "outreach_welcome"

/**
 * Signal kinds that roll into the GLOBAL alignment EWMA (→ survey cadence).
 * `belief_validation` is deliberately ABSENT: it gates per-belief actions and
 * must never be diluted into the aggregate (§2.3 category boundary). All three
 * kinds are still LOGGED to alignment_log; only these feed updateEwma.
 */
export const EWMA_ELIGIBLE: ReadonlySet<SignalKind> = new Set<SignalKind>([
  "task_quality",
  "outreach_welcome",
])

/** A routed signal: which stream it feeds + its normalized value [0,1]. */
export interface AlignmentSignal {
  readonly kind: SignalKind
  /** Normalized [0,1]: 1 = perfectly aligned, 0 = misaligned. */
  readonly value: number
  /** What the signal came from: task id / belief id / outreach id. */
  readonly ref: string
  /** For belief_validation / outreach_welcome: the touched belief id (if any). */
  readonly beliefId?: string
  /** For belief track-record: the survey/outreach verdict, if belief-bound. */
  readonly verdict?: BeliefVerdict
  readonly via: "survey" | "outreach"
}

/** A single survey check-in item (queued by Dream, surfaced by the UI later). */
export interface SurveyItem {
  readonly id: string
  readonly kind: SignalKind
  readonly prompt: string
  /** task id / belief id the item asks about. */
  readonly ref: string
  /** Present for belief-bound items. */
  readonly beliefId?: string
}

/** The human's answer to one survey item. */
export interface SurveyVerdict {
  readonly itemId: string
  readonly kind: SignalKind
  readonly ref: string
  readonly beliefId?: string
  /** task_quality uses `score`; belief/outreach use `verdict`. */
  readonly score?: number // [0,1] for task_quality
  readonly verdict?: BeliefVerdict // confirmed | corrected | rejected
  readonly via: "survey" | "outreach"
  /**
   * Optional stable timestamp for this verdict (spec-delta #5 idempotency).
   * When supplied, processVerdict uses this as the anchor for the log row id,
   * the alignment_log `at`, and the BeliefValidation `at` — so re-processing
   * the same verdict with the same `at` is a no-op (INSERT OR IGNORE + validation
   * dedup both key on `at`). Falls back to clock.nowMs() only for new events
   * where no stable timestamp is available.
   */
  readonly at?: number
}

/** One persisted alignment-log row (§5.2). */
export interface AlignmentLogRow {
  readonly id: string
  readonly at: number
  readonly signalKind: SignalKind
  readonly scoreDelta: number
  readonly ewmaAfter: number | null // null for non-EWMA (belief_validation)
  readonly ref: string
}

/** Insert shape — `id` is derived from (ref, signalKind, at) for idempotency. */
export interface AlignmentLogRowInput {
  readonly at: number
  readonly signalKind: SignalKind
  readonly scoreDelta: number
  readonly ewmaAfter: number | null
  readonly ref: string
}

export interface AlignmentLogQuery {
  readonly signalKind?: SignalKind
  readonly since?: number
  readonly limit?: number
}

export class AlignmentError extends Data.TaggedError("AlignmentError")<{
  readonly op: string
  readonly message: string
  readonly cause?: unknown
}> {}

/** What pendingSurvey returns: the items to ask + the stable issue timestamp. */
export interface PendingSurvey {
  /** Server clock at issue. Stamped onto every returned verdict's `at`
   *  (idempotency anchor — spec-delta D-LOCK-5). All items share it. */
  readonly issuedAt: number
  /** The check-in items: ALWAYS one task_quality item, then ≤cap belief items. */
  readonly items: ReadonlyArray<SurveyItem>
}
