// packages/core/src/alignment/cadence.ts
/**
 * Cadence controller — pure EWMA + interval math (Phase 3, §2.1 / §3.3).
 * No I/O. Mirror of packages/core/src/beliefs/scoring.ts discipline.
 *
 * Two central properties enforced by tests:
 *   1. "Slow to grant, fast to revoke" — asymmetric smoothing constants.
 *   2. "Fast clawback" — convex interval curve keeps cadence near MIN across
 *      most of the ewma range; even from converged full trust (ewma=1.0) two
 *      worst-case surveys snap the interval back to the ~1-day floor.
 *
 * DETECTION-LATENCY CAVEAT: clawback completes in ≤2 surveys, but from
 * converged trust the *next* survey is ~30 days out — so worst-case wall-clock
 * from drift → floor-cadence is ~30d + clawback. This is an inherent property
 * of the pure cadence controller. An out-of-band immediate trigger for the
 * riskiest signals (the §2.3 outreach_welcome bypass-the-clock path) is a
 * survey-service concern, not this module's.
 */
import type { BeliefVerdict } from "../beliefs/types.js"

const DAY = 86_400_000

/** §2.1 asymmetric hysteresis: trust slow to grant, fast to revoke. */
export const ALPHA_UP = 0.15 // good signal → slow climb
export const ALPHA_DOWN = 0.6 // bad signal → fast clawback (must dominate ALPHA_UP)

/** §2.1 cadence bounds. */
export const MIN_INTERVAL_DAYS = 1 // dormant floor / clawback target
export const MAX_INTERVAL_DAYS = 30 // capped backoff

/**
 * Convex interval-curve exponent. Intervals stay short across most of the ewma
 * range and only ease toward MAX near FULL trust — so any drop in ewma pulls
 * the interval back toward MIN fast (§2.1 "fast to revoke"), while reaching the
 * 30-day cap requires sustained high trust ("slow to grant"). A LINEAR curve
 * (exponent 1) fails the fast-clawback property test — do not lower this to 1.
 */
export const INTERVAL_CURVE = 3

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/**
 * EWMA update with asymmetric smoothing. `signalValue` is normalized [0,1]
 * (clamped). When the signal pulls the score UP we move slowly (ALPHA_UP);
 * when it pulls DOWN we move fast (ALPHA_DOWN) — the §2.1 invariant that one
 * bad signal outweighs one equal-magnitude good one. Result clamped to [0,1].
 */
export function updateEwma(prev: number, signalValue: number): number {
  const v = clamp01(signalValue)
  const alpha = v >= prev ? ALPHA_UP : ALPHA_DOWN
  return clamp01(prev + alpha * (v - prev))
}

/**
 * Next survey timestamp. Maps ewma ∈ [0,1] onto an interval clamped to
 * [MIN, MAX] days via a CONVEX curve (ewma^INTERVAL_CURVE): the interval stays
 * near MIN across most of the range and only eases toward MAX near full trust.
 * Combined with the asymmetric updateEwma (fast ALPHA_DOWN), this makes a drop
 * in trust pull the cadence back toward 1 day within ≤2 surveys (§2.1 fast
 * clawback) while reaching 30 days needs sustained high alignment (slow grant).
 */
export function nextSurveyAt(ewma: number, lastSurveyAt: number): number {
  const e = clamp01(ewma)
  const intervalDays =
    MIN_INTERVAL_DAYS +
    (MAX_INTERVAL_DAYS - MIN_INTERVAL_DAYS) * Math.pow(e, INTERVAL_CURVE)
  return lastSurveyAt + Math.round(intervalDays * DAY)
}

/**
 * Normalize a verdict/score into a [0,1] signal value for the EWMA.
 * Belief verdicts: confirmed=1, corrected=0.5, rejected=0. A raw task-quality
 * score is passed through (clamped).
 */
export function signalValueForVerdict(input: {
  verdict?: BeliefVerdict
  score?: number
}): number {
  if (input.score !== undefined) {
    // NaN/non-finite would poison the EWMA forever (clamp01(NaN)=NaN, and all
    // NaN comparisons are false) → fall back to neutral.
    return Number.isFinite(input.score) ? clamp01(input.score) : 0.5
  }
  switch (input.verdict) {
    case "confirmed":
      return 1
    case "corrected":
      return 0.5
    case "rejected":
      return 0
    default:
      return 0.5 // neutral when neither supplied
  }
}
