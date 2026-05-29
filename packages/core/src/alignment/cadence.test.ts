// packages/core/src/alignment/cadence.test.ts
import { describe, expect, it } from "vitest"
import {
  updateEwma, nextSurveyAt, signalValueForVerdict,
  ALPHA_UP, ALPHA_DOWN, MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS, INTERVAL_CURVE,
} from "./cadence.js"

const DAY = 86_400_000

describe("updateEwma — asymmetric hysteresis (§2.1)", () => {
  it("trust accrues slowly (ALPHA_UP) on a good signal", () => {
    const next = updateEwma(0.5, 1.0)
    expect(next).toBeCloseTo(0.5 + ALPHA_UP * (1.0 - 0.5), 6)
  })
  it("trust is revoked fast (ALPHA_DOWN) on a bad signal", () => {
    const next = updateEwma(0.5, 0.0)
    expect(next).toBeCloseTo(0.5 + ALPHA_DOWN * (0.0 - 0.5), 6)
  })
  it("INVARIANT: one bad signal moves more than one equal-magnitude good signal", () => {
    // The load-bearing asymmetry — slow to grant, fast to revoke.
    const up = Math.abs(updateEwma(0.5, 1.0) - 0.5)
    const down = Math.abs(updateEwma(0.5, 0.0) - 0.5)
    expect(down).toBeGreaterThan(up)
    expect(ALPHA_DOWN).toBeGreaterThan(ALPHA_UP)
  })
  it("stays clamped to [0,1]", () => {
    expect(updateEwma(0, -5)).toBeGreaterThanOrEqual(0)
    expect(updateEwma(1, 5)).toBeLessThanOrEqual(1)
  })
})

describe("nextSurveyAt — interval curve + FAST CLAWBACK (§2.1)", () => {
  it("high alignment eases to the 30-day cap (slow backoff)", () => {
    expect(nextSurveyAt(1.0, 1000)).toBe(1000 + MAX_INTERVAL_DAYS * DAY)
  })
  it("low alignment is at the 1-day floor", () => {
    expect(nextSurveyAt(0.0, 1000)).toBe(1000 + MIN_INTERVAL_DAYS * DAY)
  })
  // LOAD-BEARING (spec §2.1 central safety property — "fast to revoke").
  // Drives the REAL pipeline (updateEwma → nextSurveyAt) from CONVERGED trust
  // (ewma=1.0, 30-day cadence) through 2 worst-case surveys. Must reach the
  // ~1-day floor — NOT the ~weeks a symmetric/linear design produces. Do NOT
  // replace this with an endpoint test that hand-sets a low ewma: that masks
  // the violation (the bug a symmetric-alpha or linear-curve design hides).
  it("from converged trust, ≤2 bad surveys snap the interval to ~MIN", () => {
    let ewma = 1.0
    ewma = updateEwma(ewma, 0) // worst-case (rejected) survey 1
    ewma = updateEwma(ewma, 0) // worst-case survey 2
    const intervalDays = nextSurveyAt(ewma, 0) / DAY
    expect(intervalDays).toBeLessThanOrEqual(MIN_INTERVAL_DAYS + 1) // at/near floor
  })
  it("trust is SLOW to grant: from the floor, 2 good surveys stay well under the cap", () => {
    let ewma = 0.0
    ewma = updateEwma(ewma, 1) // good survey 1
    ewma = updateEwma(ewma, 1) // good survey 2
    // Tight margin (actual ≈1.62d): catches ALPHA_UP inflation, not just a wide cap.
    expect(nextSurveyAt(ewma, 0) / DAY).toBeLessThan(3)
  })
  // Pin the convexity directly so a revert to a linear curve (1) fails an
  // explicit assertion, not only the pipeline test. Quadratic (2) still meets
  // the ≤2-survey clawback threshold, so it is the correct floor.
  it("interval curve is convex (≥2) — a linear revert is a safety regression", () => {
    expect(INTERVAL_CURVE).toBeGreaterThanOrEqual(2)
  })
  it("interval is monotone in alignment", () => {
    expect(nextSurveyAt(0.5, 0)).toBeGreaterThan(nextSurveyAt(0.0, 0))
    expect(nextSurveyAt(0.5, 0)).toBeLessThan(nextSurveyAt(1.0, 0))
  })
})

describe("signalValueForVerdict", () => {
  it("maps belief verdicts to [0,1]", () => {
    expect(signalValueForVerdict({ verdict: "confirmed" })).toBe(1)
    expect(signalValueForVerdict({ verdict: "rejected" })).toBe(0)
    expect(signalValueForVerdict({ verdict: "corrected" })).toBeCloseTo(0.5, 6)
  })
  it("passes through an explicit task-quality score", () => {
    expect(signalValueForVerdict({ score: 0.8 })).toBe(0.8)
  })
})
