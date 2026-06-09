// packages/core/src/dream/sample-agreement.test.ts
//
// Unit tests for `computeAgreement` (Slice B, MEASURE-ONLY): a PURE + TOTAL +
// synchronous per-belief multi-sample agreement frequency over N reasoning
// passes. The reasoner integration (pass-1 ops materialize unchanged + the
// sampling fields attached) is covered in
// packages/adapter-sdk/test/dream-reasoner-sampling.test.ts.
import { describe, expect, it } from "vitest"
import { computeAgreement } from "./sample-agreement.js"

// A "pass" is a list of belief candidates; clustering is by `beliefId`
// (= deriveBeliefId(domain, statement)). computeAgreement only needs the id.
type Cand = { readonly beliefId: string }
const c = (beliefId: string): Cand => ({ beliefId })

describe("computeAgreement — pure agreement fraction (MEASURE-ONLY; pure, total)", () => {
  it("4 of 5 passes contain X → sampledConfidence 0.8, sampleCount 5", () => {
    // 4 passes contain X, 1 does not. (Z appears once = 0.2; noise irrelevant.)
    const passes: ReadonlyArray<ReadonlyArray<Cand>> = [
      [c("X"), c("noise-1")],
      [c("X")],
      [c("X"), c("noise-2")],
      [c("X")],
      [c("Z")], // no X here
    ]
    const out = computeAgreement(passes)
    const x = out.get("X")
    expect(x).toBeDefined()
    expect(x!.sampledConfidence).toBe(0.8) // 4/5, exact in JS
    expect(x!.sampleCount).toBe(5)
  })

  it("1 of 5 passes contains Y (a one-off) → sampledConfidence 0.2, sampleCount 5", () => {
    const passes: ReadonlyArray<ReadonlyArray<Cand>> = [
      [c("Y")], // only here
      [c("A")],
      [c("B")],
      [c("C")],
      [c("D")],
    ]
    const out = computeAgreement(passes)
    const y = out.get("Y")
    expect(y).toBeDefined()
    expect(y!.sampledConfidence).toBe(0.2) // 1/5, exact in JS
    expect(y!.sampleCount).toBe(5)
  })

  it("within-pass dedup: a belief appearing twice in ONE pass counts once for that pass", () => {
    // pass 1 = [A, A]  (A twice in the SAME pass), pass 2 = [B].
    // "passes containing" semantics ⇒ A in 1 of 2 passes ⇒ 0.5 (NOT 1.0).
    // A naive occurrence-counter would wrongly give A = 2/2 = 1.0 — this
    // fixture discriminates the two.
    const passes: ReadonlyArray<ReadonlyArray<Cand>> = [
      [c("A"), c("A")],
      [c("B")],
    ]
    const out = computeAgreement(passes)
    expect(out.get("A")?.sampledConfidence).toBe(0.5) // 1/2
    expect(out.get("A")?.sampleCount).toBe(2)
    expect(out.get("B")?.sampledConfidence).toBe(0.5) // 1/2
    expect(out.get("B")?.sampleCount).toBe(2)
  })

  it("empty input → empty map (never divides by zero)", () => {
    const out = computeAgreement([])
    expect(out.size).toBe(0)
  })

  it("degenerate N: a SINGLE pass → empty map (single pass ≠ sampling)", () => {
    // Agreement over one pass is a meaningless constant 1.0 — the measurement
    // itself owns the insufficient-data rule (like calculateEce's n<30 → null),
    // so no caller can accidentally log constant-1 "agreement".
    const out = computeAgreement([[c("X"), c("Y")]])
    expect(out.size).toBe(0)
  })

  it("a pass that is itself empty still counts toward the denominator", () => {
    // 3 passes, X in 1 of them, 2 passes empty. X ⇒ 1/3.
    const passes: ReadonlyArray<ReadonlyArray<Cand>> = [[c("X")], [], []]
    const out = computeAgreement(passes)
    expect(out.get("X")?.sampledConfidence).toBeCloseTo(1 / 3, 12)
    expect(out.get("X")?.sampleCount).toBe(3)
    // empty passes contribute NO ids to the map.
    expect(out.size).toBe(1)
  })
})
