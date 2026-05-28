/**
 * dream-cron.test.ts — Tier-1 unit test for registerDreamCron.
 *
 * Layer wiring mirrors trigger-agent.test.ts: chain `Effect.provide` calls
 * rather than `Layer.mergeAll`, because `TriggerAgentLayer.Default` depends on
 * `JobScheduler` and `JobSchedulerLayer.make` depends on luna's `Clock` —
 * `Layer.mergeAll` does not resolve inter-layer dependencies.
 *
 * Test (a): structural check — registerDreamCron wires a cron entry into
 * trigger.list() with the correct kind and expr.
 *
 * Test (b): behavioural check — advancing TestClock by 1 hour fires one dream
 * cycle, and the watermark advances past epoch 0. (b) requires TestContext to
 * swap the Effect runtime clock for TestClock so the cron's `Effect.sleep` is
 * virtual.
 */
import { describe, expect, it } from "vitest"
import { Chunk, Duration, Effect, Exit, Layer, Ref, Stream, TestClock, TestContext } from "effect"
import { Clock } from "../clock.js"
import { JobScheduler, JobSchedulerLayer } from "../jobs/job-scheduler.js"
import { TriggerAgent, TriggerAgentLayer } from "../jobs/trigger-agent.js"
import { DreamStore } from "./dream-store.js"
import { FakeReasoner } from "./reasoner.js"
import { SessionStore } from "../session/session-store.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryRecord } from "@luna/memory"
import { registerDreamCron } from "./dream.js"

// Minimal Ref-backed memory router double (mirrors dream.test.ts).
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
          const next = new Map(m)
          next.delete(id)
          return [had, next]
        }),
      query: () => Stream.empty,
      search: () => Stream.empty,
    } as never
  }),
)

// Dream service layers — all self-contained, safe to merge.
const dreamLayers = Layer.mergeAll(
  DreamStore.Memory,
  FakeReasoner.of([]), // no-op dream — only watermark advances
  SessionStore.Default,
  FakeMemoryEmpty,
)

/**
 * Wire the full layer stack, mirroring trigger-agent.test.ts's `program()`
 * helper: chain Effect.provide in dependency order so each layer finds its
 * requirements satisfied.
 *
 * TestContext.TestContext is provided last so it wraps everything and replaces
 * the Effect runtime Clock for TestClock-driven tests.
 */
const provide = <A, E>(
  prog: Effect.Effect<A, E, JobScheduler | TriggerAgent | DreamStore | Clock>,
) =>
  Effect.scoped(
    prog.pipe(
      Effect.provide(TriggerAgentLayer.Default),
      Effect.provide(JobSchedulerLayer.make({ capacity: 16 })),
      Effect.provide(dreamLayers),
      Effect.provide(Clock.Default),
      Effect.provide(TestContext.TestContext),
    ),
  )

describe("registerDreamCron", () => {
  it("(a) registers a cron entry visible in trigger.list()", async () => {
    const result = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const trig = yield* TriggerAgent
          yield* registerDreamCron(trig, "0 * * * *")
          return yield* trig.list
        }),
      ),
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.kind).toBe("cron")
    expect(result[0]?.expr).toBe("0 * * * *")
  })

  it("(b) firing the cron (via TestClock.adjust) advances the dream watermark", async () => {
    // TestClock starts at epoch 0; advancing 1 hour → first hourly tick fires.
    // The dream job runs runDream(3_600_000), setting watermark to 3_600_000.
    const result = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const trig = yield* TriggerAgent
          const store = yield* DreamStore
          const sched = yield* JobScheduler

          // Collect one job result in background before registering.
          const collected = yield* Effect.fork(
            sched.results.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.map(Chunk.toReadonlyArray),
            ),
          )

          yield* registerDreamCron(trig, "0 * * * *")

          // Advance virtual time by 1 hour — epoch 0 → 3_600_000ms.
          // The cron loop wakes, builds + submits the dream job.
          yield* TestClock.adjust(Duration.hours(1))

          // Await job completion (proves the fiber ran).
          const exit = yield* collected.await
          if (Exit.isFailure(exit)) return null as number | null

          return yield* store.getWatermark
        }),
      ),
    )
    // Watermark should be non-null and advanced past epoch 0.
    expect(result).not.toBeNull()
    expect(result).toBeGreaterThan(0)
  })
})
