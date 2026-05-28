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
            { kind: "belief_candidate", targetId: "new-belief", before: null, after: { statement: "x" }, rationale: "pattern" },
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
    expect(out.rows).toHaveLength(3)
    expect(out.rows.every((r) => r.status === "proposed")).toBe(true)
    expect(out.rows.every((r) => r.appliedAt === null)).toBe(true)
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
