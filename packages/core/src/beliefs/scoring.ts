import type { MemoryRecord } from "@luna/memory"
import { readBelief } from "./types.js"
import type { BeliefContent } from "./types.js"

const DAY = 86_400_000
/** Linear-decay denominator; recency floors at RECENCY_FLOOR before this age (≈81d). */
const STALE_HORIZON_DAYS = 90
/** Recency never zeroes a belief — an old but confident belief still counts. */
const RECENCY_FLOOR = 0.1

/**
 * Belief strength — the eviction + ranking key. Higher = keep / inject first.
 * `confidence × recencyFactor × validationFactor`, where recency and validation
 * are floor-bounded so neither alone can zero a belief with non-zero confidence
 * (the spec's "× validation-track-record" trap:
 * validationHistory is empty until Phase 3, so it MUST be neutral, not 0).
 */
export function beliefStrength(
  content: BeliefContent,
  updatedAt: number,
  now: number,
): number {
  const ageDays = Math.max(0, (now - updatedAt) / DAY)
  const recencyFactor = Math.max(RECENCY_FLOOR, 1 - ageDays / STALE_HORIZON_DAYS)

  const h = content.validationHistory
  let validationFactor = 1.0 // NEUTRAL when no validation yet
  if (h.length > 0) {
    let net = 0
    for (const v of h) {
      if (v.verdict === "confirmed") net += 1
      else if (v.verdict === "corrected") net -= 1
      else net -= 2 // rejected hurts most
    }
    // map net/count into a bounded multiplier around 1.0
    validationFactor = Math.min(2, Math.max(0.25, 1 + net / h.length))
  }

  return content.confidence * recencyFactor * validationFactor
}

/** Rank belief records strongest-first (stable for equal strength via id). */
export function rankByStrength(
  records: ReadonlyArray<MemoryRecord>,
  now: number,
): ReadonlyArray<MemoryRecord> {
  return [...records].sort((a, b) => {
    const d = beliefStrength(readBelief(b), b.updatedAt, now) -
      beliefStrength(readBelief(a), a.updatedAt, now)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
}
