/**
 * wake-cron-layer.test.ts — Tier-1 unit test for WakeCronLayer.
 * Mirrors dream-cron-layer.test.ts: build the layer (which registers the
 * cron at registration time), assert the WakeCron marker resolves with a
 * triggerId. Uses FakeWakeReasoner + WakeLogStore.Memory — no model calls,
 * no disk I/O.
 *
 * Key idiom (mirroring dream-cron-layer.test.ts):
 *   - Clock.Default (luna's Clock tag) + TestContext.TestContext (Effect's
 *     TestClock) are BOTH required and distinct tags. Provide Clock.Default
 *     first, then TestContext last so TestClock wraps everything.
 */
import { describe, expect, it } from "vitest"
import { Duration, Effect, Layer, TestClock, TestContext } from "effect"
import { Clock } from "../clock.js"
import { WakeCron, WakeCronLayer } from "./wake-cron-layer.js"
import { FakeWakeReasoner } from "./reasoner.js"
import { WakeLogStore } from "./wake-log-store.js"
import type { WakeDigest } from "./types.js"

const emptyDigest: WakeDigest = {
  workspaceSlug: "test",
  observations: [],
  pickedActionId: null,
  pickedReason: "noop",
  proposedActions: [],
}

const wakeDeps = Layer.mergeAll(
  FakeWakeReasoner.of(emptyDigest),
  WakeLogStore.Memory,
)

describe("WakeCronLayer", () => {
  it("(a) builds and exposes the WakeCron marker with the correct expr + slug", async () => {
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* WakeCron
          return { expr: marker.expr, slug: marker.workspaceSlug }
        }).pipe(
          Effect.provide(
            WakeCronLayer("*/30 * * * *", {
              workspaceSlug: "test",
              workspacePath: "/tmp/not-used",
            }),
          ),
          Effect.provide(wakeDeps),
          Effect.provide(Clock.Default),
          Effect.provide(TestContext.TestContext),
        ),
      ),
    )
    expect(out.expr).toBe("*/30 * * * *")
    expect(out.slug).toBe("test")
  })

  it("(b) the WakeCron marker resolves with a non-empty triggerId", async () => {
    const triggerId = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* WakeCron
          // Advance the clock to show the layer stays alive past build.
          yield* TestClock.adjust(Duration.hours(2))
          return marker.triggerId
        }).pipe(
          Effect.provide(
            WakeCronLayer("0 * * * *", {
              workspaceSlug: "test",
              workspacePath: "/tmp/not-used",
            }),
          ),
          Effect.provide(wakeDeps),
          Effect.provide(Clock.Default),
          Effect.provide(TestContext.TestContext),
        ),
      ),
    )
    expect(typeof triggerId).toBe("string")
    expect(triggerId.length).toBeGreaterThan(0)
  })
})
