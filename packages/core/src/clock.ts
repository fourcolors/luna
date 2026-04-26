/**
 * Clock — trivial reference Service demonstrating the framework pattern.
 *
 * Every module in Luna follows this shape:
 *   1. Extend Effect.Service with a namespaced key.
 *   2. Define the effect that builds the default implementation.
 *   3. Expose a Test layer for deterministic testing (via Layer swap).
 *
 * See DESIGN.md §4 (Service Topology) and §8.3 (Layer-swap test doubles).
 */
import { Effect, Layer } from "effect"

export class Clock extends Effect.Service<Clock>()(
  "luna/Clock",
  {
    effect: Effect.sync(() => ({
      nowMs: () => Effect.sync(() => Date.now()),
      nowIso: () => Effect.sync(() => new Date().toISOString()),
    })),
  },
) {
  /**
   * Test layer: deterministic clock that returns a fixed timestamp.
   * Use in tests via `Effect.provide(Clock.Test(1234))`.
   */
  static Test = (fixedMs: number): Layer.Layer<Clock> =>
    Layer.succeed(
      Clock,
      Clock.of({
        _tag: "luna/Clock",
        nowMs: () => Effect.sync(() => fixedMs),
        nowIso: () => Effect.sync(() => new Date(fixedMs).toISOString()),
      }),
    )
}
