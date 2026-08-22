/**
 * Clock — trivial reference Service demonstrating the framework pattern.
 *
 * Every module in Luna follows this shape:
 *   1. Extend Context.Service with a namespaced key.
 *   2. Define Layer.effect that builds the default implementation.
 *   3. Expose a Test layer for deterministic testing (via Layer swap).
 *
 * See DESIGN.md §4 (Service Topology) and §8.3 (Layer-swap test doubles).
 */
import { Context, Effect, Layer } from "effect"

export type ClockService = {
  readonly nowMs: () => Effect.Effect<number>
  readonly nowIso: () => Effect.Effect<string>
}

export class Clock extends Context.Service<Clock, ClockService>()("luna/Clock") {
  static readonly Default: Layer.Layer<Clock> = Layer.effect(
    Clock,
    Effect.sync(() =>
      Clock.of({
        nowMs: () => Effect.sync(() => Date.now()),
        nowIso: () => Effect.sync(() => new Date().toISOString()),
      }),
    ),
  )

  /**
   * Test layer: deterministic clock that returns a fixed timestamp.
   * Use in tests via `Effect.provide(Clock.Test(1234))`.
   */
  static Test = (fixedMs: number): Layer.Layer<Clock> =>
    Layer.succeed(
      Clock,
      Clock.of({
        nowMs: () => Effect.sync(() => fixedMs),
        nowIso: () => Effect.sync(() => new Date(fixedMs).toISOString()),
      }),
    )
}
