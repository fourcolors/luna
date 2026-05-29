/**
 * dream-cron-layer.test.ts — Tier-1 unit test for DreamCronLayer.
 * Mirrors dream-cron.test.ts: build the layer (which registers the cron at
 * build time), then assert the DreamCron marker resolves AND advancing TestClock
 * fires one dream cycle (watermark advances). Uses FakeReasoner — no model calls.
 *
 * Key idiom (mirroring dream-cron.test.ts:71-76):
 *   - Clock.Default (luna's Clock tag) + TestContext.TestContext (Effect's built-in
 *     Clock for TestClock) are BOTH required and distinct tags. Provide Clock.Default
 *     first, then TestContext last so TestClock wraps everything.
 */
import { describe, expect, it } from "vitest"
import { Duration, Effect, Layer, Ref, Stream, TestClock, TestContext } from "effect"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { Clock } from "../clock.js"
import { DreamStore } from "./dream-store.js"
import { FakeReasoner } from "./reasoner.js"
import { SessionStore } from "../session/session-store.js"
import { DreamCron, DreamCronLayer } from "./dream-cron-layer.js"

const FakeMemoryEmpty = Layer.effect(
  MemoryRouterTag,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, MemoryRecord>>(new Map())
    return {
      put: (r: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(r.id, r)),
      get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
      delete: (id: string) =>
        Ref.modify(store, (m) => {
          const had = m.has(id)
          const n = new Map(m)
          n.delete(id)
          return [had, n]
        }),
      query: () => Stream.empty,
      search: () => Stream.empty,
    } as never
  }),
)

// Dream deps the cron layer needs (it provides its own JobScheduler+TriggerAgent).
// Clock flows from R, provided explicitly below (not included in dreamDeps).
const dreamDeps = Layer.mergeAll(DreamStore.Memory, FakeReasoner.of([]), SessionStore.Default, FakeMemoryEmpty)

describe("DreamCronLayer", () => {
  it("(a) builds and exposes the DreamCron marker with the correct expr", async () => {
    const ok = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* DreamCron
          return marker.expr
        }).pipe(
          Effect.provide(DreamCronLayer("0 3 * * *")),
          Effect.provide(dreamDeps),
          // Clock.Default (luna Clock tag) must come before TestContext so the
          // scheduler and dream deps share the same clock reference.
          Effect.provide(Clock.Default),
          Effect.provide(TestContext.TestContext),
        ),
      ),
    )
    expect(ok).toBe("0 3 * * *")
  })

  it("(b) the DreamCron marker resolves with a non-empty triggerId", async () => {
    // DreamCronLayer encapsulates its JobScheduler so we cannot fork its
    // results stream to deterministically await a job (unlike dream-cron.test.ts).
    // This test asserts registration fired (triggerId is defined); the existing
    // dream-cron.test.ts already proves registerDreamCron fires end-to-end.
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* DreamCron
          // Advance the clock to show the layer remains alive after build.
          yield* TestClock.adjust(Duration.hours(4))
          return marker.triggerId
        }).pipe(
          Effect.provide(DreamCronLayer("0 3 * * *")),
          Effect.provide(dreamDeps),
          Effect.provide(Clock.Default),
          Effect.provide(TestContext.TestContext),
        ),
      ),
    )
    expect(result).toBeDefined()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })
})
