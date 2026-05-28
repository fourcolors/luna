import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { DreamStore } from "./dream-store.js"
import { applyOps, revert, deriveDreamId } from "./dream.js"
import type { DreamOp } from "./types.js"

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
        query: () => { throw new Error("unused") },
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
