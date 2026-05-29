import { describe, expect, it } from "vitest"
import { beliefStrength, rankByStrength } from "./scoring.js"
import { makeBeliefRecord } from "./types.js"
import type { BeliefContent } from "./types.js"

const DAY = 86_400_000
const base: BeliefContent = {
  statement: "s", confidence: 0.8, status: "active", domain: "d",
  evidence: [], validationHistory: [], outreachRights: { enabled: false, minConfidence: 0.8 },
}

describe("beliefStrength", () => {
  it("empty validation history is NEUTRAL (1.0), not zero", () => {
    // fresh, confident, unvalidated belief must NOT score 0 (the spec trap)
    const s = beliefStrength(base, /*updatedAt*/ 1000, /*now*/ 1000)
    expect(s).toBeCloseTo(0.8, 5) // confidence * 1 (recency) * 1 (validation)
  })
  it("decays with staleness", () => {
    const fresh = beliefStrength(base, 0, 0)
    const old = beliefStrength(base, 0, 45 * DAY)
    expect(old).toBeLessThan(fresh)
    expect(old).toBeGreaterThan(0) // never zeroed (floor)
  })
  it("never decays below the floor even when ancient", () => {
    const ancient = beliefStrength(base, 0, 10_000 * DAY)
    expect(ancient).toBeCloseTo(0.8 * 0.1, 5) // recency floor 0.1
  })
  it("confirmed history strengthens; rejected weakens", () => {
    const at = 0, now = 0
    const confirmed = beliefStrength(
      { ...base, validationHistory: [{ at, verdict: "confirmed", via: "survey" }] }, at, now)
    const rejected = beliefStrength(
      { ...base, validationHistory: [{ at, verdict: "rejected", via: "survey" }] }, at, now)
    expect(confirmed).toBeGreaterThan(0.8) // > neutral
    expect(rejected).toBeLessThan(0.8) // < neutral
  })
  it("single corrected verdict floors the factor at 0.25", () => {
    // net = -1, net/count = -1 → 1 + (-1) = 0 → clamped to floor 0.25
    const s = beliefStrength(
      { ...base, validationHistory: [{ at: 0, verdict: "corrected", via: "survey" }] }, 0, 0)
    expect(s).toBeCloseTo(0.8 * 0.25, 5) // 0.2
  })
  it("corrected + confirmed nets to neutral (1.0)", () => {
    // net = -1 + 1 = 0 → factor 1.0
    const s = beliefStrength(
      {
        ...base,
        validationHistory: [
          { at: 0, verdict: "corrected", via: "survey" },
          { at: 0, verdict: "confirmed", via: "survey" },
        ],
      },
      0,
      0,
    )
    expect(s).toBeCloseTo(0.8, 5)
  })
  it("two confirmed votes absorb one rejection (net 0 → neutral)", () => {
    // net = +1 + 1 - 2 = 0 → factor 1.0
    const s = beliefStrength(
      {
        ...base,
        validationHistory: [
          { at: 0, verdict: "confirmed", via: "survey" },
          { at: 0, verdict: "confirmed", via: "survey" },
          { at: 0, verdict: "rejected", via: "survey" },
        ],
      },
      0,
      0,
    )
    expect(s).toBeCloseTo(0.8, 5)
  })
})

describe("rankByStrength", () => {
  it("orders strongest first", () => {
    const strong = makeBeliefRecord({ statement: "strong", confidence: 0.9, domain: "d", status: "active", now: 0 })
    const weak = makeBeliefRecord({ statement: "weak", confidence: 0.2, domain: "d", status: "active", now: 0 })
    const ranked = rankByStrength([weak, strong], 0)
    expect(ranked.map((r) => r.id)).toEqual([strong.id, weak.id])
  })
  it("fresher record ranks first when confidence is equal", () => {
    // makeBeliefRecord's `now` sets updatedAt → same confidence, different age
    const old = makeBeliefRecord({ statement: "old", confidence: 0.8, domain: "d", status: "active", now: 0 })
    const fresh = makeBeliefRecord({ statement: "fresh", confidence: 0.8, domain: "d", status: "active", now: 45 * DAY })
    const ranked = rankByStrength([old, fresh], 45 * DAY)
    expect(ranked.map((r) => r.id)).toEqual([fresh.id, old.id])
  })
  it("breaks ties deterministically by id.localeCompare (smaller id first)", () => {
    // identical confidence + updatedAt + empty validation → identical strength
    const a = makeBeliefRecord({ statement: "alpha", confidence: 0.8, domain: "d", status: "active", now: 0 })
    const b = makeBeliefRecord({ statement: "beta", confidence: 0.8, domain: "d", status: "active", now: 0 })
    const [smaller, larger] = [a.id, b.id].sort((x, y) => x.localeCompare(y))
    const ranked = rankByStrength([a, b], 0)
    expect(ranked.map((r) => r.id)).toEqual([smaller, larger])
  })
  it("does not mutate the input array", () => {
    const weak = makeBeliefRecord({ statement: "weak", confidence: 0.2, domain: "d", status: "active", now: 0 })
    const strong = makeBeliefRecord({ statement: "strong", confidence: 0.9, domain: "d", status: "active", now: 0 })
    const input = [weak, strong]
    rankByStrength(input, 0)
    expect(input.map((r) => r.id)).toEqual([weak.id, strong.id]) // original order intact
  })
})
