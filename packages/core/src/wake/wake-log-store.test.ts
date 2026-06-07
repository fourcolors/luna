import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { WakeLogStore } from "./wake-log-store.js"

describe("WakeLogStore.Memory", () => {
  it("appends rows and returns them newest-first via recent()", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WakeLogStore
        const a = yield* store.append({
          wokeAt: 1_000,
          goalSlug: null,
          summary: "early wake",
          outcome: "no-op",
          artifacts: "{}",
        })
        const b = yield* store.append({
          wokeAt: 2_000,
          goalSlug: "goal-x",
          summary: "later wake",
          outcome: "success",
          artifacts: '{"x":1}',
        })
        const c = yield* store.append({
          wokeAt: 1_500,
          goalSlug: null,
          summary: "middle wake",
          outcome: "error",
          artifacts: '{"err":"boom"}',
        })
        const rows = yield* store.recent(10)
        return { a, b, c, rows }
      }).pipe(Effect.provide(WakeLogStore.Memory)),
    )
    expect(out.a).toBe(1)
    expect(out.b).toBe(2)
    expect(out.c).toBe(3)
    expect(out.rows.map((r) => r.wokeAt)).toEqual([2_000, 1_500, 1_000])
    expect(out.rows[0]?.outcome).toBe("success")
    expect(out.rows[0]?.goalSlug).toBe("goal-x")
    expect(out.rows[2]?.artifacts).toBe("{}")
  })

  it("respects the limit on recent()", async () => {
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WakeLogStore
        for (let i = 1; i <= 5; i++) {
          yield* store.append({
            wokeAt: i * 1_000,
            goalSlug: null,
            summary: `wake-${i}`,
            outcome: "no-op",
            artifacts: "{}",
          })
        }
        return yield* store.recent(2)
      }).pipe(Effect.provide(WakeLogStore.Memory)),
    )
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.wokeAt)).toEqual([5_000, 4_000])
  })

  it("isolated layer builds — each provide produces a fresh store", async () => {
    const a = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WakeLogStore
        yield* store.append({
          wokeAt: 1,
          goalSlug: null,
          summary: "a",
          outcome: "no-op",
          artifacts: "{}",
        })
        return yield* store.recent(10)
      }).pipe(Effect.provide(WakeLogStore.Memory)),
    )
    const b = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* WakeLogStore
        return yield* store.recent(10)
      }).pipe(Effect.provide(WakeLogStore.Memory)),
    )
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
  })
})
