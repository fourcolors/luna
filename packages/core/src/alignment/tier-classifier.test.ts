// packages/core/src/alignment/tier-classifier.test.ts
//
// RED (PING) for Slice 3 — tier classifier, MEASURE-ONLY.
//
// This file imports classifyTier / revertabilityFor / TierInputs from
// ./tier-classifier.js, which does NOT exist yet. It MUST fail at import with
// "Cannot find module './tier-classifier.js'" — that is the correct RED reason
// (the slice's pure unit is missing), NOT a harness error.
//
// classifyTier is PURE + synchronous, so this file imports ONLY vitest +
// tier-classifier.js (no Effect / Clock / store), keeping the RED reason
// unambiguous.
//
// The MEASURE-ONLY integration RED (a belief_candidate op recording a tier)
// lives in dream/dream.test.ts — that file loads dream.js (which does NOT
// import tier-classifier.js in RED) and fails by ASSERTION, so it does not
// collapse at import.
import { describe, expect, it } from "vitest"
import {
  classifyTier,
  revertabilityFor,
  type Tier,
  type TierInputs,
} from "./tier-classifier.js"

const i = (over: Partial<TierInputs> = {}): TierInputs => ({
  confidence: 0.9,
  detectability: 1,
  revertability: 0.9,
  stakes: null,
  ...over,
})

// ── Pure classifyTier — the six contract cases ───────────────────────────────

describe("classifyTier — tier boundaries (MEASURE-ONLY; pure, total)", () => {
  it("S1 Tier 0: safe + confident + low stakes", () => {
    // effRev = 1 * 0.9 = 0.9 >= 0.8; confidence 0.9 >= 0.8; stakes 0.2 < 0.3.
    expect(classifyTier(i({ confidence: 0.9, detectability: 1, revertability: 0.9, stakes: 0.2 }))).toBe(0)
  })

  it("S2 Tier 1: confident-enough + reversible-enough, stakes unknown", () => {
    // effRev = 0.7; confidence 0.6 < 0.8 (not Tier 0) but >= 0.5; stakes null.
    expect(classifyTier(i({ confidence: 0.6, detectability: 1, revertability: 0.7, stakes: null }))).toBe(1)
  })

  it("S3 Tier 2: low confidence drops it to blocking confirm", () => {
    // confidence 0.4 < 0.5 ⇒ fails Tier 0 AND Tier 1 despite effRev 0.9.
    expect(classifyTier(i({ confidence: 0.4, detectability: 1, revertability: 0.9, stakes: null }))).toBe(2)
  })

  it("S3b Tier 2: high stakes overrides high confidence + perfect reversibility", () => {
    // stakes 0.8 >= 0.7 fails Tier 1's stakes gate (and >= 0.3 fails Tier 0's).
    expect(classifyTier(i({ confidence: 0.95, detectability: 1, revertability: 1, stakes: 0.8 }))).toBe(2)
  })

  it("S3c Tier 2: silent ⇒ effRev 0 ⇒ cannot be Tier 0/1 (preferences gate because silent)", () => {
    // detectability 0 ⇒ effRev = 0 * 1 = 0 ⇒ fails effRev >= 0.8 and >= 0.5.
    expect(classifyTier(i({ confidence: 0.95, detectability: 0, revertability: 1, stakes: null }))).toBe(2)
  })
})

// ── S4 — purity / totality ───────────────────────────────────────────────────

describe("classifyTier — S4 purity + totality (never throws, clamps defensively)", () => {
  it("out-of-range / NaN inputs never throw and return a valid Tier", () => {
    const call = () =>
      classifyTier({ confidence: 2, detectability: -1, revertability: NaN, stakes: 5 })
    expect(call).not.toThrow()
    const t = call()
    expect([0, 1, 2]).toContain(t)
    // detectability -1 clamps to 0 ⇒ effRev 0 ⇒ cannot be Tier 0/1 ⇒ Tier 2.
    expect(t).toBe(2)
  })

  it("garbage stakes (negative / NaN / >1) is treated as MAXIMALLY risky, not low-risk", () => {
    // Otherwise-perfect inputs; only stakes is garbage. Must NOT pass the Tier-0
    // stakes gate — the "garbage ⇒ gated" invariant. (Pre-fix, stakes:-1 clamped
    // to 0 and wrongly returned Tier 0.)
    const safe = { confidence: 0.95, detectability: 1, revertability: 1 }
    expect(classifyTier({ ...safe, stakes: -1 })).toBe(2)
    expect(classifyTier({ ...safe, stakes: NaN })).toBe(2)
    expect(classifyTier({ ...safe, stakes: 5 })).toBe(2)
    // sanity: a VALID low stakes with the same inputs IS Tier 0.
    expect(classifyTier({ ...safe, stakes: 0.1 })).toBe(0)
  })

  it("the type is the 0|1|2 union (compile-time assertion only)", () => {
    const t: Tier = classifyTier(i())
    expect([0, 1, 2]).toContain(t)
  })
})

// ── revertabilityFor — documented placeholder heuristic ──────────────────────

describe("revertabilityFor — placeholder heuristic (DECISION NEEDING CONFIRMATION)", () => {
  it("a materialized, revertable op scores high (0.9)", () => {
    expect(revertabilityFor("belief_candidate", true)).toBe(0.9)
    expect(revertabilityFor("memory_dedup", true)).toBe(0.9)
  })

  it("a held 'proposed' op (not materialized) scores low (0.3)", () => {
    expect(revertabilityFor("memory_staleness", false)).toBe(0.3)
    expect(revertabilityFor("memory_contradiction", false)).toBe(0.3)
  })
})
