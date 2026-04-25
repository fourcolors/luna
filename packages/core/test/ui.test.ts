/**
 * UIService — tests (Phase 22).
 *
 * Critical sim per advisor: events emitted BEFORE subscribe must NOT
 * be delivered (PubSub fan-out semantics); events emitted AFTER
 * subscribe MUST be delivered. This is the exact failure mode Phase 14
 * fixed; UIService must inherit the eager-subscribe behavior.
 */
import { describe, expect, it } from "vitest"
import {
  Chunk,
  Duration,
  Effect,
  Fiber,
  Layer,
  Stream,
} from "effect"
import { Clock } from "../src/clock.js"
import { ObservabilityService } from "../src/observability/index.js"
import { UIService, DEFAULT_UI_KINDS } from "../src/ui/index.js"

const makeFullLayer = (config?: Parameters<typeof UIService.makeLayer>[0]) => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer(config).pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  return Layer.mergeAll(uiL, obsL, clockL)
}

const run = <A, E>(
  prog: Effect.Effect<A, E, UIService | ObservabilityService | Clock>,
  config?: Parameters<typeof UIService.makeLayer>[0],
) =>
  Effect.runPromise(
    Effect.scoped(prog.pipe(Effect.provide(makeFullLayer(config)))),
  )

describe("UIService", () => {
  it("forwards default whitelisted kinds (ToolCall) and filters out non-whitelisted", async () => {
    const collected = await run(
      Effect.gen(function* () {
        const ui = yield* UIService
        const obs = yield* ObservabilityService
        const stream = yield* ui.subscribe

        // Fork collector BEFORE emitting (eager subscribe contract).
        const fiber = yield* Effect.fork(
          stream.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
          ),
        )

        // Yield so the collector can attach to the filtered stream.
        yield* Effect.sleep(Duration.millis(10))

        // Emit one whitelisted (ToolCall) and one whitelisted (CostAccrued).
        yield* obs.emit({
          kind: "ToolCall",
          ts: new Date().toISOString(),
          level: "info",
          sessionId: "s1",
          tool: "bash",
          inputDigest: "x",
          durationMs: 1,
          status: "ok",
        })
        yield* obs.emit({
          kind: "CostAccrued",
          ts: new Date().toISOString(),
          level: "info",
          sessionId: "s1",
          tokensIn: 1,
          tokensOut: 1,
          cacheRead: 0,
          cacheWrite: 0,
          estimatedUsd: 0.001,
        })

        return yield* Fiber.join(fiber)
      }),
    )
    expect(collected).toHaveLength(2)
    expect(collected[0]?.kind).toBe("ToolCall")
    expect(collected[1]?.kind).toBe("CostAccrued")
  })

  it("eager-subscribe contract: events emitted AFTER subscribe ARE delivered", async () => {
    // The exact Phase-14 race regression test, in a UIService wrapper.
    const got = await run(
      Effect.gen(function* () {
        const ui = yield* UIService
        const obs = yield* ObservabilityService
        const stream = yield* ui.subscribe // eager-attach happens here
        const fiber = yield* Effect.fork(
          stream.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
          ),
        )
        yield* Effect.sleep(Duration.millis(10))
        yield* obs.emit({
          kind: "SessionStart",
          ts: new Date().toISOString(),
          level: "info",
          sessionId: "s2",
          model: "x",
          optionsDigest: "y",
        })
        return yield* Fiber.join(fiber)
      }),
    )
    expect(got).toHaveLength(1)
    expect(got[0]?.kind).toBe("SessionStart")
  })

  it("custom kind whitelist: only matching kinds pass through", async () => {
    const got = await run(
      Effect.gen(function* () {
        const ui = yield* UIService
        const obs = yield* ObservabilityService
        const stream = yield* ui.subscribe
        const fiber = yield* Effect.fork(
          stream.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
          ),
        )
        yield* Effect.sleep(Duration.millis(10))

        // Emit ToolCall (NOT whitelisted) — should be dropped.
        yield* obs.emit({
          kind: "ToolCall",
          ts: new Date().toISOString(),
          level: "info",
          sessionId: "s",
          tool: "bash",
          inputDigest: "x",
          durationMs: 1,
          status: "ok",
        })
        // Emit Error (whitelisted) — should pass.
        yield* obs.emit({
          kind: "Error",
          ts: new Date().toISOString(),
          level: "error",
          errorTag: "TestError",
          message: "test",
        })
        return yield* Fiber.join(fiber)
      }),
      { kinds: ["Error"] },
    )
    expect(got).toHaveLength(1)
    expect(got[0]?.kind).toBe("Error")
  })

  it("DEFAULT_UI_KINDS is non-empty and includes core kinds", () => {
    expect(DEFAULT_UI_KINDS.length).toBeGreaterThan(0)
    expect(DEFAULT_UI_KINDS).toContain("SessionStart")
    expect(DEFAULT_UI_KINDS).toContain("Error")
  })
})
