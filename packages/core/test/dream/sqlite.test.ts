import { describe, expect, it } from "vitest"
import { Effect, Layer, Scope } from "effect"
import { Clock } from "../../src/clock.js"
import { LunaSqliteBootstrap } from "../../src/db/sqlite-bootstrap.js"
import { DreamStore } from "../../src/dream/dream-store.js"
import type { DreamAuditRowInput } from "../../src/dream/types.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "core test — bootstrap stub",
} as const)

const makeFullLayer = (dbPath: string) => {
  const clockL = Clock.Default
  const storeL = DreamStore.makeLayer(dbPath).pipe(
    Layer.provide(clockL),
    Layer.provide(bootstrapStubL),
  )
  return Layer.mergeAll(storeL, clockL)
}

const run = <A, E>(
  prog: Effect.Effect<A, E, DreamStore | Clock | Scope.Scope>,
  dbPath = ":memory:",
) =>
  Effect.runPromise(
    Effect.scoped(prog).pipe(Effect.provide(makeFullLayer(dbPath))) as Effect.Effect<A, E, never>,
  )

const input = (over: Partial<DreamAuditRowInput> = {}): DreamAuditRowInput => ({
  dreamId: "dream-0-100",
  at: 50,
  op: "memory_dedup",
  targetId: "mem-1",
  before: { id: "mem-1" },
  after: null,
  rationale: "dup",
  status: "applied",
  appliedAt: 50,
  ...over,
})

d("DreamStore (sqlite)", () => {
  it("records, reads back, and round-trips before/after JSON", async () => {
    const row = await run(
      Effect.gen(function* () {
        const store = yield* DreamStore
        const id = yield* store.record(input({ before: { a: 1 }, after: null }))
        return yield* store.get(id)
      }),
    )
    expect(row?.op).toBe("memory_dedup")
    expect(row?.before).toEqual({ a: 1 })
    expect(row?.after).toBeNull()
  })

  it("INSERT OR IGNORE on (dream_id,target_id,op) returns the same id", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* DreamStore
        const id1 = yield* store.record(input())
        const id2 = yield* store.record(input())
        const rows = yield* store.list({ dreamId: "dream-0-100" })
        return { id1, id2, rows }
      }),
    )
    expect(out.rows).toHaveLength(1)
    expect(out.id1).toBe(out.id2)
  })

  it("markReverted + watermark persist", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* DreamStore
        const id = yield* store.record(input())
        const ok = yield* store.markReverted(id, 999)
        yield* store.setWatermark(777)
        return { ok, row: yield* store.get(id), wm: yield* store.getWatermark }
      }),
    )
    expect(out.ok).toBe(true)
    expect(out.row?.status).toBe("reverted")
    expect(out.wm).toBe(777)
  })
})
