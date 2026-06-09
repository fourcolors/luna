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
import { CalibrationStore } from "../alignment/calibration-store.js"
import { makeBeliefRecord } from "../beliefs/types.js"
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

  // ── serviceOption wiring proof (PR #100 HIGH finding) ──────────────────────
  // CalibrationStore is an OPTIONAL dep read via Effect.serviceOption inside
  // the dream job. That only works in prod if the layer provided INTO the cron
  // composition (Layer.provide on the composed cron layer — the exact shape
  // buildDreamCronLayer uses) is inherited by the FORKED job fiber's runtime
  // context. This test fires a real cron tick under TestClock and asserts a
  // calibration row lands in the SAME store instance (layer memoization), the
  // regression guard for "instrumentation silently no-ops in prod".
  it("(c) a CalibrationStore provided into the cron composition is seen by the fired job (serviceOption)", async () => {
    const candidate = makeBeliefRecord({
      statement: "Operator prefers terse answers",
      confidence: 0.6,
      domain: "comms",
      now: 0,
    })
    const beliefOps = [
      {
        kind: "belief_candidate" as const,
        targetId: candidate.id,
        before: null,
        after: candidate,
        rationale: "pattern",
      },
    ]
    // ONE layer instance, referenced both inside the cron composition and by
    // the test's read path — Effect's MemoMap builds it once, so both see the
    // same Ref-backed store.
    const calL = CalibrationStore.Memory.pipe(Layer.provide(Clock.Test(0)))
    const deps = Layer.mergeAll(
      DreamStore.Memory,
      FakeReasoner.of(beliefOps),
      SessionStore.Default,
      FakeMemoryEmpty,
    )
    // HOURLY expr, not "0 3 * * *": the cron's next-fire delay derives from
    // the luna Clock (Clock.Default = REAL wall time), so a 3am expr could be
    // up to ~24 REAL hours away — beyond any sane TestClock.adjust. An hourly
    // expr is always < 1h away, so adjust(2h) is guaranteed to cross it.
    const cronL = DreamCronLayer("0 * * * *").pipe(
      Layer.provide(deps),
      // The shape under test: the sink provided into the composition (same as
      // buildDreamCronLayer's calibrationStoreL), NOT to the test effect.
      Layer.provide(calL),
    )

    const rows = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* DreamCron
          yield* TestClock.adjust(Duration.hours(2))
          // DreamCronLayer encapsulates its JobScheduler (no results stream to
          // await), so give the submitted job's worker fiber cooperative slots
          // to run to completion before reading the store.
          for (let i = 0; i < 50; i++) yield* Effect.yieldNow()
          const cal = yield* CalibrationStore
          return yield* cal.list()
        }).pipe(
          Effect.provide(Layer.mergeAll(cronL, calL)),
          Effect.provide(Clock.Default),
          Effect.provide(TestContext.TestContext),
        ),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.beliefId).toBe(candidate.id)
    expect(rows[0]?.confidence).toBe(0.6)
  })
})
