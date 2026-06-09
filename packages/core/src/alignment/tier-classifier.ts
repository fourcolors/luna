/**
 * tier-classifier — Slice 3 (MEASURE-ONLY).
 *
 * A PURE, TOTAL function that classifies a proposed change into an autonomy
 * **tier** from `(effective-reversibility, stakes, calibrated-confidence)`,
 * where `effective-reversibility = detectability × revertability`.
 *
 *   Tier 0 = auto-apply-eligible (safest)
 *   Tier 1 = provisional / async
 *   Tier 2 = blocking confirm
 *
 * HARD invariant (mirror calibration.feature.md §HARD / tier-classifier.feature.md):
 * the classifier output (the recorded `tier`) is MEASURE-ONLY, WRITE-ONLY
 * instrumentation. It may NEVER gate a dream turn and may NEVER be read back
 * into scoring.ts / inject.ts / cadence.ts / activation / MATERIALIZE_OPS /
 * belief strength. We record it to learn whether the tier boundaries are sane
 * BEFORE any code is ever allowed to branch on them. Anything that reads `tier`
 * back into behavior is a HARD violation, not a feature.
 *
 * SIGNAL HONESTY — none of the inputs is a "real" calibrated signal today:
 *  - confidence    — the VERBALIZED Dream-reasoner placeholder (Slice A);
 *                    Slice B will make it sampling-based. This module is
 *                    agnostic to how the 0..1 number was produced.
 *  - detectability — the dream.ts `detectabilityFor()` heuristic
 *                    (belief_candidate → 1, else 0). PLACEHOLDER.
 *  - revertability — NO real score exists; see `revertabilityFor` placeholder.
 *  - stakes        — NO signal exists anywhere in the codebase; `null` = unknown.
 */
import type { DreamOpKind } from "../dream/types.js"
import { DREAM_OP_TRAITS } from "../dream/types.js"

/** Autonomy tier. Lower = safer. */
export type Tier = 0 | 1 | 2

export interface TierInputs {
  /** Calibrated confidence, 0..1 (TODAY: verbalized placeholder). */
  readonly confidence: number
  /** Detectability, 0..1 (TODAY: detectabilityFor heuristic). */
  readonly detectability: number
  /** Revertability, 0..1 (TODAY: revertabilityFor placeholder). */
  readonly revertability: number
  /** Stakes, 0..1, or `null` when unknown (TODAY: always null — no signal). */
  readonly stakes: number | null
}

// ── Boundary constants — DECISIONS NEEDING CONFIRMATION ──────────────────────
// These thresholds are first-guess defaults. They need calibration against
// recorded measure-only data before any of them is trusted. Flagged in
// tier-classifier.feature.md §"Decisions needing confirmation" (1).

/** Tier 0 gate: confidence must be at least this. */
const TIER0_MIN_CONFIDENCE = 0.8
/** Tier 0 gate: effective-reversibility must be at least this. */
const TIER0_MIN_EFF_REV = 0.8
/** Tier 0 gate: stakes (if known) must be strictly below this. */
const TIER0_MAX_STAKES = 0.3

/** Tier 1 gate: confidence must be at least this. */
const TIER1_MIN_CONFIDENCE = 0.5
/** Tier 1 gate: effective-reversibility must be at least this. */
const TIER1_MIN_EFF_REV = 0.5
/** Tier 1 gate: stakes (if known) must be strictly below this. */
const TIER1_MAX_STAKES = 0.7

/**
 * Clamp `x` into [0, 1]. NaN (and any non-number poison) is treated DEFENSIVELY
 * as `safe` — the safe extreme for the caller's gate. Note that a naive
 * `Math.max(0, Math.min(1, x))` returns NaN for NaN input (NaN comparisons are
 * always false), so the explicit NaN guard is required for totality.
 */
const clamp01 = (x: number, safe: number): number =>
  Number.isNaN(x) ? safe : x < 0 ? 0 : x > 1 ? 1 : x

/**
 * PURE + TOTAL: never throws. Classifies into Tier 0 | 1 | 2.
 *
 * confidence / detectability / revertability clamp to [0, 1] with a SAFE
 * extreme of 0 (an undetectable / unconfident / irreversible change is the
 * dangerous case, so out-of-range / NaN degrades toward "blocking confirm").
 * stakes clamps with a SAFE extreme of 1 (an out-of-range / NaN stakes is
 * treated as maximally risky) — but ONLY when non-null. `stakes === null`
 * (unknown) is preserved as the "no stakes gate" case BEFORE clamping, so
 * clamping never silently turns unknown into 0 (which would falsely pass the
 * low-stakes gates).
 *
 *   effRev = clamp(detectability) × clamp(revertability)
 *   Tier 0 iff confidence >= 0.8 AND effRev >= 0.8 AND (stakes null OR < 0.3)
 *   Tier 1 iff (NOT Tier 0) AND confidence >= 0.5 AND effRev >= 0.5 AND
 *               (stakes null OR < 0.7)
 *   Tier 2 otherwise
 */
export const classifyTier = (i: TierInputs): Tier => {
  const confidence = clamp01(i.confidence, 0)
  const detectability = clamp01(i.detectability, 0)
  const revertability = clamp01(i.revertability, 0)
  // Preserve `null` (unknown) BEFORE clamping. A KNOWN stakes that is
  // out-of-[0,1] or non-finite is GARBAGE → maximally risky (1), never the
  // low-risk 0 (garbage must gate, not auto-apply). In-range values pass through.
  // NB: a naive clamp01 would map a NEGATIVE stakes to 0 (lowest risk) — the
  // opposite of safe — so stakes does not use clamp01.
  const stakes: number | null =
    i.stakes === null ? null : i.stakes >= 0 && i.stakes <= 1 ? i.stakes : 1

  const effRev = detectability * revertability

  if (
    confidence >= TIER0_MIN_CONFIDENCE &&
    effRev >= TIER0_MIN_EFF_REV &&
    (stakes === null || stakes < TIER0_MAX_STAKES)
  ) {
    return 0
  }

  if (
    confidence >= TIER1_MIN_CONFIDENCE &&
    effRev >= TIER1_MIN_EFF_REV &&
    (stakes === null || stakes < TIER1_MAX_STAKES)
  ) {
    return 1
  }

  return 2
}

// ── revertabilityFor — placeholder heuristic (DECISION NEEDING CONFIRMATION) ──
// NO real revert-cost score exists in the codebase. The per-kind magnitudes
// live in DREAM_OP_TRAITS (dream/types.ts) — the single exhaustive table of
// op-kind semantics — so adding a new DreamOpKind cannot silently default
// here. Confirm magnitudes against real revert-cost data before any behavior
// branches on them. Flagged in tier-classifier.feature.md §(2).

/**
 * Documented PLACEHOLDER heuristic for revertability of a dream op, derived
 * from DREAM_OP_TRAITS:
 *  - a materialized, cheap-to-undo op (belief_candidate / memory_dedup) → 0.9
 *  - a held 'proposed' op (not materialized)                           → 0.3
 *
 * DECISION NEEDING CONFIRMATION — the magnitudes are a guess.
 */
export const revertabilityFor = (
  opKind: DreamOpKind,
  materialized: boolean,
): number => {
  const r = DREAM_OP_TRAITS[opKind].revertability
  return materialized ? r.materialized : r.held
}
