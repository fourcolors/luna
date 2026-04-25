/**
 * TelemetryService — tests (Phase 18).
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../src/clock.js"
import { TelemetryService } from "../src/telemetry/index.js"

const runtime = TelemetryService.makeLayer().pipe(Layer.provide(Clock.Default))

const run = <A>(eff: Effect.Effect<A, never, TelemetryService>) =>
  Effect.runPromise(eff.pipe(Effect.provide(runtime)))

describe("TelemetryService", () => {
  it("inc default n=1 and get returns the value", async () => {
    const value = await run(
      Effect.gen(function* () {
        const t = yield* TelemetryService
        yield* t.inc("toolCalls")
        yield* t.inc("toolCalls")
        yield* t.inc("toolCalls")
        return yield* t.get("toolCalls")
      }),
    )
    expect(value).toBe(3)
  })

  it("inc with custom n", async () => {
    const value = await run(
      Effect.gen(function* () {
        const t = yield* TelemetryService
        yield* t.inc("bytes", {}, 100)
        yield* t.inc("bytes", {}, 250)
        return yield* t.get("bytes")
      }),
    )
    expect(value).toBe(350)
  })

  it("tags partition counters under same name", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t = yield* TelemetryService
        yield* t.inc("toolCalls", { tool: "bash" })
        yield* t.inc("toolCalls", { tool: "bash" })
        yield* t.inc("toolCalls", { tool: "edit" })
        const bash = yield* t.get("toolCalls", { tool: "bash" })
        const edit = yield* t.get("toolCalls", { tool: "edit" })
        const none = yield* t.get("toolCalls")
        return { bash, edit, none }
      }),
    )
    expect(result.bash).toBe(2)
    expect(result.edit).toBe(1)
    expect(result.none).toBe(0)
  })

  it("tag key order does not matter", async () => {
    const value = await run(
      Effect.gen(function* () {
        const t = yield* TelemetryService
        yield* t.inc("x", { a: "1", b: "2" })
        yield* t.inc("x", { b: "2", a: "1" })
        return yield* t.get("x", { a: "1", b: "2" })
      }),
    )
    expect(value).toBe(2)
  })

  it("get returns 0 for unknown counter", async () => {
    const value = await run(
      Effect.gen(function* () {
        const t = yield* TelemetryService
        return yield* t.get("never-incremented")
      }),
    )
    expect(value).toBe(0)
  })

  it("snapshot returns all tracked counters", async () => {
    const snap = await run(
      Effect.gen(function* () {
        const t = yield* TelemetryService
        yield* t.inc("a", { k: "1" }, 5)
        yield* t.inc("a", { k: "2" }, 7)
        yield* t.inc("b")
        return yield* t.snapshot
      }),
    )
    expect(snap).toHaveLength(3)
    const a1 = snap.find((s) => s.name === "a" && s.tags.k === "1")
    const a2 = snap.find((s) => s.name === "a" && s.tags.k === "2")
    const b = snap.find((s) => s.name === "b")
    expect(a1?.value).toBe(5)
    expect(a2?.value).toBe(7)
    expect(b?.value).toBe(1)
    expect(typeof a1?.lastUpdatedTs).toBe("string")
  })

  it("reset clears all counters", async () => {
    const after = await run(
      Effect.gen(function* () {
        const t = yield* TelemetryService
        yield* t.inc("foo")
        yield* t.inc("bar", { x: "y" }, 10)
        yield* t.reset
        return yield* t.snapshot
      }),
    )
    expect(after).toEqual([])
  })

  it("lastUpdatedTs updates on each inc", async () => {
    const result = await run(
      Effect.gen(function* () {
        const t = yield* TelemetryService
        yield* t.inc("z")
        const snap1 = yield* t.snapshot
        const ts1 = snap1[0]?.lastUpdatedTs
        yield* Effect.sleep("5 millis")
        yield* t.inc("z")
        const snap2 = yield* t.snapshot
        const ts2 = snap2[0]?.lastUpdatedTs
        return { ts1, ts2 }
      }),
    )
    expect(result.ts1).toBeDefined()
    expect(result.ts2).toBeDefined()
    // ts2 should be >= ts1 (lexicographic ISO string compare works)
    expect(result.ts2! >= result.ts1!).toBe(true)
  })
})
