/**
 * Clock service — end-to-end smoke test for the M0 scaffolding.
 *
 * Verifies:
 *   1. Default layer yields real wall-clock time (within a tolerance).
 *   2. Test layer yields the fixed timestamp we injected.
 *   3. The Service+Layer pattern composes as expected per DESIGN.md §4.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock } from "../src/clock.js"

describe("Clock service (M0 reference)", () => {
  it("default layer returns real current time", async () => {
    const before = Date.now()
    const program = Effect.gen(function* () {
      const clock = yield* Clock
      return yield* clock.nowMs()
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(Clock.Default)),
    )

    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after + 10) // 10ms tolerance
  })

  it("Test layer returns the injected fixed timestamp", async () => {
    const FIXED = 1_700_000_000_000
    const program = Effect.gen(function* () {
      const clock = yield* Clock
      return yield* clock.nowMs()
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(Clock.Test(FIXED))),
    )

    expect(result).toBe(FIXED)
  })

  it("nowIso on Test layer returns deterministic ISO string", async () => {
    const FIXED = 1_700_000_000_000
    const program = Effect.gen(function* () {
      const clock = yield* Clock
      return yield* clock.nowIso()
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(Clock.Test(FIXED))),
    )

    expect(result).toBe(new Date(FIXED).toISOString())
  })
})
