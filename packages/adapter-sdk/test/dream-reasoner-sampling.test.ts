/**
 * dream-reasoner-sampling.test.ts — Slice B (sampling-based confidence,
 * MEASURE-ONLY) at the adapter-sdk reasoner seam.
 *
 * Drives the reasoner against a fake SDKClient that returns N varied results
 * across the N passes and asserts: pass-1 ops materialize UNCHANGED (the belief
 * keeps its verbalized confidence) and the additive `sampledConfidence` /
 * `sampleCount` fields are attached for logging. Those op fields are read via a
 * cast since they are optional on DreamOp. Every consumed fake result is a valid
 * JSON op array, so pass-1 always materializes.
 *
 * Fixture (deterministic; agreement is order-independent because it counts over
 * all passes — only "which result is pass 1" matters, and pass-1 is the FIRST
 * `sdk.query()` call by contract):
 *   - call 0 (PASS 1, privileged "today's path"): proposes belief X @ 0.85.
 *   - calls 1..4 (extra passes): X present in 3 of the 4 (with VARYING verbalized
 *     confidence + a whitespace/case variant of X's statement, proving GREEN
 *     clusters by deriveBeliefId not exact text), absent in 1.
 *   ⇒ X is in 4 of 5 passes ⇒ sampledConfidence = 0.8, sampleCount = 5.
 *   ⇒ The MATERIALIZED belief is pass-1's X @ 0.85 (verbalized), NOT the sampled
 *     value — behavior byte-identical.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import type { MemoryRecord } from "@luna/memory"
import { MemoryRouterTag } from "@luna/memory"
import { CalibrationStore, Clock, DreamReasoner, deriveBeliefId } from "@luna/core"
import type { DreamInputs, DreamOp } from "@luna/core"
import { SDKClient } from "../src/sdk-client.js"
import { DreamReasonerDefault } from "../src/dream-reasoner.js"
import { makeFakeQuery, makeResultMessage } from "./fake-sdk.js"

// ---------------------------------------------------------------------------
// Doubles (copied from dream-reasoner.test.ts)
// ---------------------------------------------------------------------------

const EMPTY_INPUTS: DreamInputs = { sessions: [], memories: [] }

const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, MemoryRecord>>(
        new Map(initial.map((r) => [r.id, r])),
      )
      return {
        put: (rec: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(rec.id, rec)),
        get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
        delete: (id: string) =>
          Ref.modify(store, (m) => {
            const had = m.has(id)
            const next = new Map(m)
            next.delete(id)
            return [had, next]
          }),
        query: () => Stream.empty,
        search: () => Stream.empty,
      } as never
    }),
  )

/**
 * The MEASURE-ONLY sampling extras are gated on a CalibrationStore being
 * present in the ambient context (the only consumer of the agreement signal —
 * no sink, no cost). Tests that exercise sampling provide this in-memory sink;
 * the no-sink gate test omits it.
 */
const CalSink: Layer.Layer<CalibrationStore> = CalibrationStore.Memory.pipe(
  Layer.provide(Clock.Test(0)),
)

const runReason = (
  inputs: DreamInputs,
  sdkLayer: Layer.Layer<SDKClient>,
  memLayer: Layer.Layer<typeof MemoryRouterTag>,
  calLayer: Layer.Layer<CalibrationStore> | null = CalSink,
) => {
  const eff = Effect.gen(function* () {
    const r = yield* DreamReasoner
    return yield* r.reason(inputs)
  }).pipe(
    Effect.provide(DreamReasonerDefault),
    Effect.provide(sdkLayer),
    Effect.provide(memLayer),
  )
  return calLayer === null ? eff : eff.pipe(Effect.provide(calLayer))
}

// ---------------------------------------------------------------------------
// Belief X — its canonical statement + two whitespace/case variants. All three
// collapse to the SAME deriveBeliefId, so GREEN must cluster them as one belief.
// ---------------------------------------------------------------------------
const X_DOMAIN = "comms"
const X_STATEMENT = "Operator prefers terse answers"
const X_ID = deriveBeliefId(X_DOMAIN, X_STATEMENT)

const beliefOp = (statement: string, confidence: number) => ({
  kind: "belief_candidate",
  domain: X_DOMAIN,
  statement,
  confidence,
  evidence: ["session:s-1#m-1"],
  rationale: "recurring pattern",
})

// A distinct noise belief in a different domain (its own deriveBeliefId).
const noiseOp = (n: number) => ({
  kind: "belief_candidate",
  domain: "ops",
  statement: `noise belief ${n}`,
  confidence: 0.5,
  evidence: ["session:s-1#m-2"],
  rationale: "noise",
})

// The 5 pass results, in call order. Pass 1 (index 0) is the privileged path.
//   pass 1: X @ 0.85                         → contains X  (MATERIALIZES)
//   pass 2: "  operator PREFERS terse answers " @ 0.40  → variant of X → same id
//   pass 3: X (canonical) @ 0.92             → contains X
//   pass 4: noise only                       → does NOT contain X
//   pass 5: "Operator   prefers terse   answers" @ 0.10 → variant of X → same id
// ⇒ X in 4 of 5 passes ⇒ sampledConfidence(X) = 0.8, sampleCount = 5.
const PASS_RESULTS: ReadonlyArray<string> = [
  JSON.stringify([beliefOp(X_STATEMENT, 0.85)]),
  JSON.stringify([beliefOp("  operator PREFERS terse answers ", 0.4), noiseOp(2)]),
  JSON.stringify([beliefOp(X_STATEMENT, 0.92)]),
  JSON.stringify([noiseOp(4)]),
  JSON.stringify([beliefOp("Operator   prefers terse   answers", 0.1)]),
]

/**
 * Fake SDKClient whose build() is invoked ONCE per sdk.query() call. A closure
 * counter returns PASS_RESULTS[i] for the i-th call (call 0 = pass 1). After the
 * list is exhausted it returns an empty op array (harmless; never reached for
 * N<=5). This is how N varied results are produced across the N passes.
 */
const fakeSamplingClient = (
  results: ReadonlyArray<string> = PASS_RESULTS,
): { layer: Layer.Layer<SDKClient>; calls: () => number } => {
  let i = 0
  const layer = SDKClient.fake((_params) => {
    const text = results[i] ?? "[]"
    i++
    const resultMsg = { ...makeResultMessage("sid", `uuid-${i}`), result: text }
    return makeFakeQuery({ messages: [resultMsg] }).query
  })
  // `calls` exposes how many sdk.query() invocations actually happened, so the
  // cost-gate tests can assert extras were (not) launched, not just that the
  // sampling fields are absent.
  return { layer, calls: () => i }
}

// Carry the (not-yet-existing) Slice-B fields via a cast so this file compiles
// against today's DreamOp. RED fails on the assertion, GREEN adds the fields.
type SampledOp = DreamOp & {
  readonly sampledConfidence?: number
  readonly sampleCount?: number
}

describe("DreamReasonerDefault — Slice B sampling (MEASURE-ONLY)", () => {
  it("pass-1 ops materialize UNCHANGED + sampledConfidence/sampleCount attached", async () => {
    const prev = process.env["LUNA_DREAM_SAMPLES"]
    process.env["LUNA_DREAM_SAMPLES"] = "5"
    try {
      const sdk = fakeSamplingClient()
      const ops = (await Effect.runPromise(
        runReason(EMPTY_INPUTS, sdk.layer, FakeMemory()),
      )) as ReadonlyArray<SampledOp>
      expect(sdk.calls()).toBe(5) // pass 1 + 4 extras (sink present, N=5)

      // ── Behavior byte-identical: only PASS 1 materializes ──────────────────
      // The N-loop must NOT multiply materialized beliefs: exactly ONE op, the
      // pass-1 X candidate.
      expect(ops).toHaveLength(1)
      const op = ops[0]!
      expect(op.kind).toBe("belief_candidate")
      expect(op.targetId).toBe(X_ID)
      // Materialized belief confidence = pass-1 VERBALIZED 0.85, NOT the sampled
      // value (0.8). The sampled value is NEVER substituted into the belief.
      const after = op.after as MemoryRecord
      expect(after.id).toBe(X_ID)
      expect((after.content as { confidence: number }).confidence).toBe(0.85)
      expect((after.content as { statement: string }).statement).toBe(X_STATEMENT)

      // ── The NEW Slice-B metadata (this is the RED assertion) ───────────────
      // X appears in 4 of the 5 passes (passes 1,2,3,5 via id-clustering; pass 4
      // is noise-only) ⇒ 0.8. sampleCount = N = 5.
      expect(op.sampledConfidence).toBe(0.8)
      expect(op.sampleCount).toBe(5)
    } finally {
      if (prev === undefined) delete process.env["LUNA_DREAM_SAMPLES"]
      else process.env["LUNA_DREAM_SAMPLES"] = prev
    }
  })

  it("behavior-identical: sampled confidence ≠ verbalized, belief confidence stays verbalized", async () => {
    const prev = process.env["LUNA_DREAM_SAMPLES"]
    process.env["LUNA_DREAM_SAMPLES"] = "5"
    try {
      const ops = (await Effect.runPromise(
        runReason(EMPTY_INPUTS, fakeSamplingClient().layer, FakeMemory()),
      )) as ReadonlyArray<SampledOp>
      const op = ops[0]!
      const beliefConfidence = (op.after as MemoryRecord).content as {
        confidence: number
      }
      // The materialized belief keeps the verbalized value; the sampled value is
      // a DIFFERENT, ADDITIVE number (0.85 vs 0.8) — proving no substitution.
      expect(beliefConfidence.confidence).toBe(0.85)
      expect(op.sampledConfidence).toBe(0.8)
      expect(beliefConfidence.confidence).not.toBe(op.sampledConfidence)
    } finally {
      if (prev === undefined) delete process.env["LUNA_DREAM_SAMPLES"]
      else process.env["LUNA_DREAM_SAMPLES"] = prev
    }
  })

  // ── GREEN-phase coverage (no RED in the required (a)-(d) set): RESILIENCE ──
  // A PASS-1 failure behaves EXACTLY as today's single-pass failure; an EXTRA
  // (2..N) failure is SKIPPED, lowering the effective sample count. Here every
  // extra call ERRORS (the fake yields no success-result message), so only
  // pass 1 survives ⇒ effective N = 1 ⇒ NO real sampling occurred, so the belief
  // STILL materializes unchanged and the sampling fields are ABSENT (identical to
  // Slice A — a constant-1 "agreement" would only pollute the calibration column).
  it("extra-pass failures are skipped → belief materializes; effective N drops", async () => {
    const prev = process.env["LUNA_DREAM_SAMPLES"]
    process.env["LUNA_DREAM_SAMPLES"] = "5"
    try {
      // Pass 1 returns valid X @ 0.85; every later call yields ONLY an assistant
      // message (no type:result/subtype:success) → boundedResultText fails →
      // the extra is caught/ignored.
      let i = 0
      const flakyClient = SDKClient.fake((_params) => {
        const call = i++
        if (call === 0) {
          const ok = {
            ...makeResultMessage("sid", "uuid-pass1"),
            result: JSON.stringify([beliefOp(X_STATEMENT, 0.85)]),
          }
          return makeFakeQuery({ messages: [ok] }).query
        }
        // No success-result message → DreamError(reason) for this extra → skipped.
        const noResult = { ...makeResultMessage("sid", `uuid-${call}`), type: "assistant" }
        return makeFakeQuery({ messages: [noResult as never] }).query
      })

      const ops = (await Effect.runPromise(
        runReason(EMPTY_INPUTS, flakyClient, FakeMemory()),
      )) as ReadonlyArray<SampledOp>

      // Pass-1 belief still materializes UNCHANGED — a failed extra is no new
      // failure mode.
      expect(ops).toHaveLength(1)
      const op = ops[0]!
      expect(op.targetId).toBe(X_ID)
      const after = op.after as MemoryRecord
      expect((after.content as { confidence: number }).confidence).toBe(0.85)

      // Only pass 1 survived ⇒ effective N = 1 ⇒ no real sampling ⇒ fields ABSENT.
      expect(op.sampleCount).toBeUndefined()
      expect(op.sampledConfidence).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env["LUNA_DREAM_SAMPLES"]
      else process.env["LUNA_DREAM_SAMPLES"] = prev
    }
  })

  // ── COST GATES — extras must not launch when their output has nowhere to go ──

  it("no CalibrationStore sink → extras are SKIPPED (1 SDK call), fields absent", async () => {
    const prev = process.env["LUNA_DREAM_SAMPLES"]
    process.env["LUNA_DREAM_SAMPLES"] = "5"
    try {
      const sdk = fakeSamplingClient()
      const ops = (await Effect.runPromise(
        runReason(EMPTY_INPUTS, sdk.layer, FakeMemory(), null), // NO sink
      )) as ReadonlyArray<SampledOp>

      // The agreement signal's only consumer is the calibration log; without it
      // the extra passes would be pure SDK cost — exactly ONE query (pass 1).
      expect(sdk.calls()).toBe(1)
      expect(ops).toHaveLength(1)
      expect(ops[0]!.sampledConfidence).toBeUndefined()
      expect(ops[0]!.sampleCount).toBeUndefined()
      // Pass 1 still materializes unchanged (behavior byte-identical).
      const after = ops[0]!.after as MemoryRecord
      expect((after.content as { confidence: number }).confidence).toBe(0.85)
    } finally {
      if (prev === undefined) delete process.env["LUNA_DREAM_SAMPLES"]
      else process.env["LUNA_DREAM_SAMPLES"] = prev
    }
  })

  it("pass 1 yields NO belief candidates → extras are SKIPPED (1 SDK call)", async () => {
    const prev = process.env["LUNA_DREAM_SAMPLES"]
    process.env["LUNA_DREAM_SAMPLES"] = "5"
    try {
      // Pass 1 returns an empty op array; agreement could never attach to
      // anything, so the 4 extras would be pure waste.
      const sdk = fakeSamplingClient(["[]", ...PASS_RESULTS.slice(1)])
      const ops = (await Effect.runPromise(
        runReason(EMPTY_INPUTS, sdk.layer, FakeMemory()),
      )) as ReadonlyArray<SampledOp>

      expect(sdk.calls()).toBe(1)
      expect(ops).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env["LUNA_DREAM_SAMPLES"]
      else process.env["LUNA_DREAM_SAMPLES"] = prev
    }
  })

  it("LUNA_DREAM_SAMPLES=0 disables sampling (operator opt-out ≠ fall back to default 5)", async () => {
    const prev = process.env["LUNA_DREAM_SAMPLES"]
    process.env["LUNA_DREAM_SAMPLES"] = "0"
    try {
      const sdk = fakeSamplingClient()
      const ops = (await Effect.runPromise(
        runReason(EMPTY_INPUTS, sdk.layer, FakeMemory()),
      )) as ReadonlyArray<SampledOp>

      // An explicit value < 1 clamps to N=1 (sampling OFF) — honoring the
      // natural "disable" spelling instead of silently restoring the default.
      expect(sdk.calls()).toBe(1)
      expect(ops).toHaveLength(1)
      expect(ops[0]!.sampledConfidence).toBeUndefined()
      expect(ops[0]!.sampleCount).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env["LUNA_DREAM_SAMPLES"]
      else process.env["LUNA_DREAM_SAMPLES"] = prev
    }
  })
})
