// packages/core/src/alignment/calibration-store.test.ts
//
// Tests for the Slice A calibration-logging units (MEASURE-ONLY): CalibrationStore
// + pure calculateEce / joinVerdicts. Mirrors alignment-store.test.ts —
// Effect.provide(CalibrationStore.Memory) + Clock.Test; idempotency = record
// twice expect length 1.
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock } from "../clock.js"
import {
  CalibrationStore,
  calculateEce,
  joinVerdicts,
  type CalibrationRowInput,
  type JoinVerdictInput,
} from "./calibration-store.js"

const provide = <A, E>(eff: Effect.Effect<A, E, CalibrationStore | Clock>) =>
  eff.pipe(Effect.provide(CalibrationStore.Memory), Effect.provide(Clock.Test(1000)))

const rec = (over: Partial<CalibrationRowInput> = {}): CalibrationRowInput => ({
  dreamId: "dream-0-0",
  targetId: "belief-x",
  beliefId: "belief-x",
  proposalAt: 1000,
  confidence: 0.6,
  detectability: 1,
  sampleCount: 1,
  ...over,
})

// ── S1: record + idempotent (first-write-wins) ───────────────────────────────

describe("CalibrationStore (Memory) — S1 append-only + idempotent", () => {
  it("records a row and lists it", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* CalibrationStore
          yield* s.record(rec({ dreamId: "d1", targetId: "t1" }))
          yield* s.record(rec({ dreamId: "d2", targetId: "t2" }))
          return yield* s.list()
        }),
      ),
    )
    expect(out).toHaveLength(2)
  })

  it("is idempotent on (dreamId, targetId) — second record() is ignored, first-write-wins", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* CalibrationStore
          yield* s.record(
            rec({ dreamId: "d", targetId: "t", confidence: 0.6, detectability: 1, sampleCount: 1 }),
          )
          // SAME (dreamId, targetId); different payload fields. Must be IGNORED.
          yield* s.record(
            rec({ dreamId: "d", targetId: "t", confidence: 0.99, detectability: 0, sampleCount: 7 }),
          )
          return yield* s.list()
        }),
      ),
    )
    expect(out).toHaveLength(1)
    // first-write-wins: the FIRST payload is the one persisted.
    expect(out[0]?.confidence).toBe(0.6)
    expect(out[0]?.detectability).toBe(1)
    expect(out[0]?.sampleCount).toBe(1)
  })

  it("persists all the input fields on the stored row", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* CalibrationStore
          yield* s.record(
            rec({
              dreamId: "dream-A",
              targetId: "belief-A",
              beliefId: "belief-A",
              proposalAt: 4242,
              confidence: 0.73,
              detectability: 1,
              sampleCount: 3,
            }),
          )
          return yield* s.list()
        }),
      ),
    )
    expect(out).toHaveLength(1)
    const r = out[0]!
    expect(r.dreamId).toBe("dream-A")
    expect(r.beliefId).toBe("belief-A")
    expect(r.proposalAt).toBe(4242)
    expect(r.confidence).toBe(0.73)
    expect(r.detectability).toBe(1)
    expect(r.sampleCount).toBe(3)
    // id derives from (dreamId, targetId) only.
    expect(r.id).toBe("cal-dream-A-belief-A")
  })
})

// ── S2: temporal join, not equijoin ──────────────────────────────────────────

describe("joinVerdicts — S2 temporal join (latest proposal_at < verdict.at)", () => {
  const calRow = (over: Partial<CalibrationRowInput> & { proposalAt: number }): CalibrationRowInput =>
    rec({ beliefId: "belief-x", ...over })

  const verdict = (over: Partial<JoinVerdictInput> = {}): JoinVerdictInput => ({
    beliefId: "belief-x",
    at: 200,
    verdict: "confirmed",
    via: "survey",
    ...over,
  })

  it("a verdict joins the LATEST proposal before it; earlier proposals are unmatched", async () => {
    const A = calRow({ targetId: "tA", proposalAt: 100, confidence: 0.3 })
    const B = calRow({ targetId: "tB", proposalAt: 150, confidence: 0.8 })
    const V = verdict({ at: 200, verdict: "confirmed" })

    const joined = joinVerdicts([A, B], [V])
    // exactly one match: V ↔ B
    expect(joined).toHaveLength(1)
    expect(joined[0]?.confidence).toBe(0.8) // B's confidence, not A's
    expect(joined[0]?.outcome).toBe(1) // confirmed → 1
  })

  it("a re-proposal AFTER the verdict does NOT steal it", async () => {
    const A = calRow({ targetId: "tA", proposalAt: 100, confidence: 0.3 })
    const B = calRow({ targetId: "tB", proposalAt: 150, confidence: 0.8 })
    const C = calRow({ targetId: "tC", proposalAt: 300, confidence: 0.1 }) // after V@200
    const V = verdict({ at: 200, verdict: "confirmed" })

    const joined = joinVerdicts([A, B, C], [V])
    expect(joined).toHaveLength(1)
    // still B (latest proposal_at < 200); C @300 must not match.
    expect(joined[0]?.confidence).toBe(0.8)
  })

  it("ignores non-survey verdicts (via='outreach')", async () => {
    const B = calRow({ targetId: "tB", proposalAt: 150, confidence: 0.8 })
    const V = verdict({ at: 200, via: "outreach" })

    const joined = joinVerdicts([B], [V])
    expect(joined).toHaveLength(0)
  })

  it("maps verdicts to outcomes: confirmed→1, corrected/rejected→0", async () => {
    const mk = (suffix: string, v: JoinVerdictInput["verdict"]) => ({
      cal: calRow({ beliefId: `b-${suffix}`, targetId: `t-${suffix}`, proposalAt: 100 }),
      ver: verdict({ beliefId: `b-${suffix}`, at: 200, verdict: v }),
    })
    const conf = mk("c", "confirmed")
    const corr = mk("x", "corrected")
    const rej = mk("r", "rejected")

    const joined = joinVerdicts(
      [conf.cal, corr.cal, rej.cal],
      [conf.ver, corr.ver, rej.ver],
    )
    expect(joined).toHaveLength(3)
    const byBelief = Object.fromEntries(joined.map((j) => [j.beliefId, j.outcome]))
    expect(byBelief["b-c"]).toBe(1)
    expect(byBelief["b-x"]).toBe(0)
    expect(byBelief["b-r"]).toBe(0)
  })
})

// ── S3 / S4: ECE never gates; insufficient-data sentinel ─────────────────────

const joinedRecs = (n: number, confidence: number, outcome: 0 | 1) =>
  Array.from({ length: n }, () => ({ confidence, outcome }))

describe("calculateEce — S3 never gates (>=30) + S4 sentinel (<30)", () => {
  it("S3: returns a number in [0,1] for >= 30 joined records", () => {
    const records = [
      ...joinedRecs(15, 0.4, 1),
      ...joinedRecs(15, 0.6, 0),
    ] // 30 total
    const ece = calculateEce(records)
    expect(typeof ece).toBe("number")
    expect(ece as number).toBeGreaterThanOrEqual(0)
    expect(ece as number).toBeLessThanOrEqual(1)
  })

  it("S3 boundary: n = 30 returns a number (not null)", () => {
    const ece = calculateEce(joinedRecs(30, 0.5, 1))
    expect(typeof ece).toBe("number")
  })

  it("S4: returns null (not-enough-data sentinel) for < 30, never throws", () => {
    expect(calculateEce(joinedRecs(29, 0.5, 1))).toBeNull()
    expect(calculateEce([])).toBeNull()
  })
})

// ── Pure ECE math — hand-computed, bin-count-invariant fixture ────────────────

describe("calculateEce — pure math (hand-computed)", () => {
  it("two confidence groups (0.25/0.75), each 50% accurate → ECE = 0.25", () => {
    // 20 @ conf 0.25, 10 correct → bin acc 0.50 → gap |0.25-0.50| = 0.25
    // 20 @ conf 0.75, 10 correct → bin acc 0.50 → gap |0.75-0.50| = 0.25
    // ECE = 0.5*0.25 + 0.5*0.25 = 0.25 (invariant to bin count M >= 2;
    // the two groups never share a bin).
    const records = [
      ...joinedRecs(10, 0.25, 1),
      ...joinedRecs(10, 0.25, 0),
      ...joinedRecs(10, 0.75, 1),
      ...joinedRecs(10, 0.75, 0),
    ] // 40 records
    const ece = calculateEce(records)
    expect(ece).toBeCloseTo(0.25, 10)
  })

  it("perfect calibration → ECE = 0", () => {
    // 30 @ conf 1.0, all outcome 1 → bin acc 1.0 → gap 0.
    // (avoid relying on this for the headline assertion; it's a sanity check.)
    const records = joinedRecs(30, 1.0, 1)
    const ece = calculateEce(records)
    expect(ece).toBeCloseTo(0, 10)
  })
})
