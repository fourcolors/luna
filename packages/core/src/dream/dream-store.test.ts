import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock } from "../clock.js"
import { DreamStore } from "./dream-store.js"
import type { DreamAuditRowInput } from "./types.js"

const provide = <A, E>(eff: Effect.Effect<A, E, DreamStore | Clock>) =>
  eff.pipe(Effect.provide(DreamStore.Memory), Effect.provide(Clock.Default))

const baseInput = (over: Partial<DreamAuditRowInput> = {}): DreamAuditRowInput => ({
  dreamId: "dream-0-100",
  at: 50,
  op: "memory_dedup",
  targetId: "mem-1",
  before: { id: "mem-1" },
  after: null,
  rationale: "exact duplicate of mem-2",
  status: "applied",
  appliedAt: 50,
  ...over,
})

describe("DreamStore (Memory)", () => {
  it("records an op and reads it back by id", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          const id = yield* store.record(baseInput())
          const row = yield* store.get(id)
          return { id, row }
        }),
      ),
    )
    expect(typeof out.id).toBe("string")
    expect(out.row?.op).toBe("memory_dedup")
    expect(out.row?.status).toBe("applied")
    expect(out.row?.revertedAt).toBeNull()
  })

  it("INSERT OR IGNORE: same (dreamId,targetId,op) recorded twice yields one row", async () => {
    const rows = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          yield* store.record(baseInput())
          yield* store.record(baseInput()) // identical key → ignored
          return yield* store.list({ dreamId: "dream-0-100" })
        }),
      ),
    )
    expect(rows).toHaveLength(1)
  })

  it("filters by status", async () => {
    const rows = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          yield* store.record(baseInput({ targetId: "a", op: "memory_dedup", status: "applied" }))
          yield* store.record(baseInput({ targetId: "b", op: "memory_staleness", status: "proposed", appliedAt: null }))
          return yield* store.list({ status: "proposed" })
        }),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.targetId).toBe("b")
  })

  it("markReverted flips status and sets revertedAt", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          const id = yield* store.record(baseInput())
          const ok = yield* store.markReverted(id, 999)
          const row = yield* store.get(id)
          return { ok, row }
        }),
      ),
    )
    expect(out.ok).toBe(true)
    expect(out.row?.status).toBe("reverted")
    expect(out.row?.revertedAt).toBe(999)
  })

  it("watermark round-trips; defaults to null", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const store = yield* DreamStore
          const before = yield* store.getWatermark
          yield* store.setWatermark(12345)
          const after = yield* store.getWatermark
          return { before, after }
        }),
      ),
    )
    expect(out.before).toBeNull()
    expect(out.after).toBe(12345)
  })
})
