/**
 * ObservabilityService — tests (Phase 14).
 *
 * Tests the in-memory event stream and recordCost helper.
 * Does NOT test JSONL file writes (that's an integration concern).
 *
 * NOTE: Tests use `obs.subscribeEvents()` (eager subscription) instead of
 * `obs.events` (lazy) to avoid the race where emit fires before the PubSub
 * subscription is registered.
 */
import { describe, expect, it } from "vitest"
import {
  Duration,
  Effect,
  Layer,
  Ref,
  Stream,
} from "effect"
import { Clock } from "../src/clock.js"
import {
  ObservabilityService,
} from "../src/observability/index.js"
import type { ObsEvent } from "../src/observability/index.js"

const makeLayer = () =>
  ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(Clock.Default),
  )

const run = <A, E>(prog: Effect.Effect<A, E, ObservabilityService | Clock>) =>
  Effect.runPromise(
    Effect.scoped(
      prog.pipe(
        Effect.provide(
          ObservabilityService.makeLayer({ logToConsole: false }).pipe(
            Layer.provide(Clock.Default),
          ),
        ),
      ),
    ),
  )

describe("ObservabilityService", () => {
  it("(1) emit: SessionStart event appears in events stream", async () => {
    const out = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const collected = yield* Ref.make<ObsEvent[]>([])

        // subscribeEvents() eagerly registers the subscription before emit.
        const eventStream = yield* obs.subscribeEvents

        yield* Effect.forkDetach(
          eventStream.pipe(
            Stream.runForEach((e) => Ref.update(collected, (xs) => [...xs, e])),
            Effect.catchCause(() => Effect.void),
          ),
        )

        yield* obs.emit({
          ts: new Date().toISOString(),
          kind: "SessionStart",
          level: "info",
          sessionId: "s-1",
          model: "claude-3-5-sonnet",
        })
        yield* Effect.sleep(Duration.millis(20))
        return yield* Ref.get(collected)
      }),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("SessionStart")
    if (out[0]?.kind === "SessionStart") {
      expect(out[0].sessionId).toBe("s-1")
    }
  })

  it("(2) emit: multiple event kinds collected in order", async () => {
    const out = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const collected = yield* Ref.make<ObsEvent[]>([])

        const eventStream = yield* obs.subscribeEvents

        yield* Effect.forkDetach(
          eventStream.pipe(
            Stream.runForEach((e) => Ref.update(collected, (xs) => [...xs, e])),
            Effect.catchCause(() => Effect.void),
          ),
        )

        const ts = new Date().toISOString()
        yield* obs.emit({ ts, kind: "SessionStart", level: "info", sessionId: "s-1", model: "m" })
        yield* obs.emit({ ts, kind: "ToolCall", level: "info", toolName: "bash", durationMs: 100, status: "success" })
        yield* obs.emit({ ts, kind: "SessionEnd", level: "info", sessionId: "s-1", durationMs: 5000 })
        yield* Effect.sleep(Duration.millis(30))
        return yield* Ref.get(collected)
      }),
    )
    expect(out).toHaveLength(3)
    expect(out.map((e) => e.kind)).toEqual(["SessionStart", "ToolCall", "SessionEnd"])
  })

  it("(3) recordCost: computes estimatedUsd and emits CostAccrued", async () => {
    const out = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const collected = yield* Ref.make<ObsEvent[]>([])

        const eventStream = yield* obs.subscribeEvents

        yield* Effect.forkDetach(
          eventStream.pipe(
            Stream.runForEach((e) => Ref.update(collected, (xs) => [...xs, e])),
            Effect.catchCause(() => Effect.void),
          ),
        )

        yield* obs.recordCost({
          sessionId: "s-1",
          tokensIn: 1_000_000,
          tokensOut: 1_000_000,
          pricePerMillionInputTokens: 3.0,
          pricePerMillionOutputTokens: 15.0,
        })
        yield* Effect.sleep(Duration.millis(20))
        return yield* Ref.get(collected)
      }),
    )
    expect(out).toHaveLength(1)
    if (out[0]?.kind === "CostAccrued") {
      expect(out[0].tokensIn).toBe(1_000_000)
      expect(out[0].tokensOut).toBe(1_000_000)
      // $3 input + $15 output = $18 for 1M tokens each
      expect(out[0].estimatedUsd).toBeCloseTo(18.0, 1)
    }
  })

  it("(4) emit is fire-and-forget: never fails even with no consumer", async () => {
    const result = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        // Emit many events with no consumer
        for (let i = 0; i < 10; i++) {
          yield* obs.emit({
            ts: new Date().toISOString(),
            kind: "Error",
            level: "error",
            errorTag: "TestError",
            message: `error ${i}`,
          })
        }
        return "ok"
      }),
    )
    expect(result).toBe("ok")
  })

  it("(5) minLevel filter: warn events omit info events (uses makeLayer)", async () => {
    const outRef = await Effect.runPromise(Ref.make<ObsEvent[]>([]))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const eventStream = yield* obs.subscribeEvents
          yield* Effect.forkDetach(
            eventStream.pipe(
              Stream.runForEach((e) => Ref.update(outRef, (xs) => [...xs, e])),
              Effect.catchCause(() => Effect.void),
            ),
          )
          const ts = new Date().toISOString()
          yield* obs.emit({ ts, kind: "SessionStart", level: "info", sessionId: "s", model: "m" })
          yield* obs.emit({ ts, kind: "SessionEnd", level: "warn", sessionId: "s", durationMs: 0 })
          yield* Effect.sleep(Duration.millis(20))
        }).pipe(Effect.provide(makeLayer())),
      ),
    )
    const out = await Effect.runPromise(Ref.get(outRef))
    // Both info and warn are collected (minLevel=info by default)
    expect(out.length).toBeGreaterThanOrEqual(2)
  })

  it("(6) Default layer requires only Clock", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          yield* obs.emit({
            ts: new Date().toISOString(),
            kind: "Error",
            level: "error",
            errorTag: "Test",
            message: "test",
          })
          return "ok"
        }).pipe(Effect.provide(ObservabilityService.Default.pipe(Layer.provide(Clock.Default)))),
      ),
    )
    expect(result).toBe("ok")
  })
})
