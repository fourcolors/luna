import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { DreamStore } from "./dream-store.js"
import { applyOps, revert, deriveDreamId, runDream } from "./dream.js"
import type { DreamOp } from "./types.js"
import { SessionStore } from "../session/session-store.js"
import { FakeReasoner } from "./reasoner.js"
import { makeBeliefRecord } from "../beliefs/types.js"
import { CalibrationStore } from "../alignment/calibration-store.js"

// Minimal Ref-backed memory router double (only the methods applyOps uses).
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
        // unused by applyOps — provide inert stubs
        query: () => Stream.empty,
        search: () => { throw new Error("unused") },
      } as never
    }),
  )

const rec = (id: string): MemoryRecord => ({
  id, namespace: "operator", kind: "note", content: { id },
  schemaVersion: 1, createdAt: 0, updatedAt: 0, tags: [],
})

const provide = <A, E>(eff: Effect.Effect<A, E, any>, mem = FakeMemory([rec("dup-1")])) =>
  eff.pipe(Effect.provide(DreamStore.Memory), Effect.provide(mem), Effect.provide(Clock.Default))

describe("applyOps", () => {
  it("auto-applies memory_dedup (deletes the duplicate) and logs it 'applied'", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          const ops: DreamOp[] = [
            { kind: "memory_dedup", targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "exact dup of canon-1" },
          ]
          yield* applyOps("dream-0-100", ops)
          const stillThere = yield* mem.get("dup-1")
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return { stillThere, rows }
        }),
      ),
    )
    expect(out.stillThere).toBeNull() // deleted
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.status).toBe("applied")
    expect(out.rows[0]?.appliedAt).not.toBeNull()
  })

  it("does NOT apply non-dedup ops; logs them 'proposed' and leaves memory untouched", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          const ops: DreamOp[] = [
            { kind: "memory_staleness", targetId: "dup-1", before: rec("dup-1"), after: { ...rec("dup-1"), content: { updated: true } }, rationale: "stale" },
            { kind: "memory_contradiction", targetId: "other-1", before: null, after: { resolved: true }, rationale: "conflict" },
          ]
          yield* applyOps("dream-0-100", ops)
          const untouched = yield* mem.get("dup-1")
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return { untouched, rows }
        }),
      ),
    )
    expect(out.untouched).not.toBeNull() // staleness was NOT applied
    expect(out.rows).toHaveLength(2)
    expect(out.rows.every((r) => r.status === "proposed")).toBe(true)
    expect(out.rows.every((r) => r.appliedAt === null)).toBe(true)
  })

  it("materializes belief_candidate as a proposed belief record (audit 'applied')", async () => {
    const candidate = makeBeliefRecord({ statement: "Operator prefers terse answers", confidence: 0.6, domain: "comms", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          const ops: DreamOp[] = [
            { kind: "belief_candidate", targetId: candidate.id, before: null, after: candidate, rationale: "recurring pattern across 3 sessions" },
          ]
          yield* applyOps("dream-0-100", ops)
          const stored = yield* mem.get(candidate.id)
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return { stored, rows }
        }),
        FakeMemory([]),
      ),
    )
    expect(out.stored).not.toBeNull() // belief record written
    expect((out.stored!.content as { status: string }).status).toBe("proposed")
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.status).toBe("applied") // op applied (undoable)
  })

  it("records exactly ONE calibration row — only for the belief_candidate op (write path, measure-only)", async () => {
    const candidate = makeBeliefRecord({ statement: "Operator prefers terse answers", confidence: 0.6, domain: "comms", now: 0 })
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        // A dedup op (no beliefId/confidence) and a belief_candidate op in one apply.
        yield* applyOps("dream-0-100", [
          { kind: "memory_dedup", targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "dup" },
          { kind: "belief_candidate", targetId: candidate.id, before: null, after: candidate, rationale: "pattern" },
        ])
        const cal = yield* CalibrationStore
        return yield* cal.list()
      }).pipe(
        Effect.provide(DreamStore.Memory),
        Effect.provide(FakeMemory([rec("dup-1")])),
        Effect.provide(CalibrationStore.Memory),
        Effect.provide(Clock.Default),
      ) as Effect.Effect<any, any, never>,
    )
    // Only the belief_candidate logs a calibration row; memory_dedup does NOT.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.beliefId).toBe(candidate.id)
    expect(rows[0]?.confidence).toBe(0.6)        // verbalized placeholder, read from the belief
    expect(rows[0]?.detectability).toBe(1)        // belief_candidate → detectable (heuristic)
    expect(rows[0]?.sampleCount).toBe(1)          // Slice A placeholder
    expect(rows[0]?.dreamId).toBe("dream-0-100")
  })

  // ── Slice 3 — tier classifier, MEASURE-ONLY ──────────────────────────────────
  // The SAME additive hook that logs the Slice A calibration row ALSO records a
  // measure-only `tier` (write-only, Effect.ignore'd, never read back). The
  // expected tier is HARDCODED (not computed via classifyTier) so this assertion
  // is independent of the classifier's internals.
  //
  // Expected: at the hook, confidence 0.6 (verbalized), detectability 1
  // (heuristic), revertabilityFor(belief_candidate, true) = 0.9, stakes = null
  // ⇒ effRev 0.9, confidence 0.6 ⇒ classifyTier ⇒ Tier 1.
  it("records a measure-only `tier` on the belief_candidate calibration row (Slice 3, write-only)", async () => {
    const candidate = makeBeliefRecord({ statement: "Operator prefers terse answers", confidence: 0.6, domain: "comms", now: 0 })
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        yield* applyOps("dream-0-100", [
          { kind: "belief_candidate", targetId: candidate.id, before: null, after: candidate, rationale: "pattern" },
        ])
        const cal = yield* CalibrationStore
        return yield* cal.list()
      }).pipe(
        Effect.provide(DreamStore.Memory),
        Effect.provide(FakeMemory([])),
        Effect.provide(CalibrationStore.Memory),
        Effect.provide(Clock.Default),
      ) as Effect.Effect<any, any, never>,
    )
    expect(rows).toHaveLength(1)
    // tier is OPTIONAL/nullable on the row type; cast because RED has no `tier`
    // field yet. Hardcoded expected tier — do NOT import classifyTier here.
    expect((rows[0] as { tier?: number }).tier).toBe(1)
  })

  // ── HARD INVARIANT (c): a calibration failure can NEVER fail a dream turn ───
  // The calibration PREP (readBelief / classifyTier over op.after) can throw on
  // a malformed record — a sync throw is a DEFECT, not a typed failure, so it
  // must be swallowed by the hook (catchAllCause), not just Effect.ignore'd.
  it("a malformed belief_candidate `after` defects the calibration prep — turn still succeeds", async () => {
    // `after` lacks `content` ⇒ readBelief(after).confidence throws TypeError.
    const malformed = { id: "belief-broken" } as unknown as MemoryRecord
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        yield* applyOps("dream-0-100", [
          { kind: "belief_candidate", targetId: "belief-broken", before: null, after: malformed, rationale: "malformed" },
        ])
        const store = yield* DreamStore
        const cal = yield* CalibrationStore
        return {
          rows: yield* store.list({ dreamId: "dream-0-100" }),
          calRows: yield* cal.list(),
        }
      }).pipe(
        Effect.provide(DreamStore.Memory),
        Effect.provide(FakeMemory([])),
        Effect.provide(CalibrationStore.Memory),
        Effect.provide(Clock.Default),
      ) as Effect.Effect<any, any, never>,
    )
    // The turn completed: the op still applied + audited; only the calibration
    // row is missing (the instrumentation failed, the dream did not).
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]?.status).toBe("applied")
    expect(out.calRows).toHaveLength(0)
  })

  it("with NO CalibrationStore provided, applyOps still succeeds (warns, never fails)", async () => {
    const candidate = makeBeliefRecord({ statement: "x", confidence: 0.6, domain: "comms", now: 0 })
    const rows = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          yield* applyOps("dream-0-100", [
            { kind: "belief_candidate", targetId: candidate.id, before: null, after: candidate, rationale: "pattern" },
          ])
          const store = yield* DreamStore
          return yield* store.list({ dreamId: "dream-0-100" })
        }),
        FakeMemory([]),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe("applied")
  })
})

describe("revert", () => {
  it("restores the before snapshot and marks the row reverted", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          // Apply a dedup that deletes dup-1 (before = the record).
          yield* applyOps("dream-0-100", [
            { kind: "memory_dedup", targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "dup" },
          ])
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          const ok = yield* revert(rows[0]!.id)
          const restored = yield* mem.get("dup-1")
          const row = yield* store.get(rows[0]!.id)
          return { ok, restored, row }
        }),
      ),
    )
    expect(out.ok).toBe(true)
    expect(out.restored).not.toBeNull() // before snapshot put back
    expect(out.row?.status).toBe("reverted")
  })

  it("revert undoes a materialized belief_candidate (deletes the proposed record)", async () => {
    const candidate = makeBeliefRecord({ statement: "x", confidence: 0.6, domain: "comms", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const mem = yield* MemoryRouterTag
          const store = yield* DreamStore
          yield* applyOps("dream-0-100", [
            { kind: "belief_candidate", targetId: candidate.id, before: null, after: candidate, rationale: "pattern" },
          ])
          const rowId = (yield* store.list({ dreamId: "dream-0-100" }))[0]!.id
          const reverted = yield* revert(rowId)
          const afterRevert = yield* mem.get(candidate.id)
          const row = yield* store.get(rowId)
          return { reverted, afterRevert, status: row?.status }
        }),
        FakeMemory([]),
      ),
    )
    expect(out.reverted).toBe(true)
    expect(out.afterRevert).toBeNull()        // proposed belief deleted
    expect(out.status).toBe("reverted")        // audit row flipped
  })

  it("refuses to revert a proposed (never-applied) row", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          yield* applyOps("dream-0-100", [
            { kind: "memory_staleness", targetId: "dup-1", before: rec("dup-1"), after: rec("dup-1"), rationale: "stale" },
          ])
          const rows = yield* store.list({ dreamId: "dream-0-100" })
          return yield* revert(rows[0]!.id)
        }),
      ),
    )
    expect(out).toBe(false)
  })
})

describe("deriveDreamId", () => {
  it("is a pure function of the window bounds", () => {
    expect(deriveDreamId(0, 100)).toBe("dream-0-100")
    expect(deriveDreamId(0, 100)).toBe(deriveDreamId(0, 100))
  })
})

// ── Idempotency invariant ─────────────────────────────────────────────────────
// dreamId is keyed on (watermark, cutoff) where cutoff = max(lastMessageAt) of
// sessions actually gathered — NOT on `now`. This means a crash retry on a
// later tick (different `now`) still produces the same dreamId and INSERT OR
// IGNORE collapses duplicate audit rows.
//
// When no sessions are in the window (empty SessionStore), cutoff === watermark
// === 0, so both runs produce dreamId "dream-0-0" regardless of `now`.
// ─────────────────────────────────────────────────────────────────────────────

describe("runDream (end-to-end, idempotent)", () => {
  it("crash retry with a DIFFERENT now is still a no-op (idempotent)", async () => {
    const ops = [
      { kind: "memory_dedup" as const, targetId: "dup-1", before: rec("dup-1"), after: null, rationale: "dup" },
    ]
    const layers = Layer.mergeAll(
      DreamStore.Memory,
      SessionStore.Default,
      FakeMemory([rec("dup-1")]),
      FakeReasoner.of(ops),
      Clock.Default,
    )
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* DreamStore
        yield* runDream(1000)           // window (0, 0] over empty sessions → cutoff=0 → dreamId "dream-0-0"
        const after1 = yield* store.list({})
        // Simulate a crash BEFORE the watermark was durably advanced, then a
        // retry on a LATER tick with a different `now`.
        yield* store.setWatermark(0)
        yield* runDream(2000)           // different now, same empty window → same cutoff=0 → same dreamId "dream-0-0"
        const after2 = yield* store.list({})
        return { after1, after2 }
      }).pipe(Effect.provide(layers)) as Effect.Effect<any, any, never>,
    )
    expect(out.after1).toHaveLength(1)
    expect(out.after2).toHaveLength(1) // collapses despite different `now` — proves dreamId is NOT keyed on now
  })
})
