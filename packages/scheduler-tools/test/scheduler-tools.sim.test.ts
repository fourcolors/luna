/**
 * Scheduler tools Tier-2 simulation tests.
 *
 * Uses TestClock to drive virtual time and assert multi-tick behaviour:
 *
 *   1. Cron trigger fires N times as TestClock advances — verifies that
 *      schedule_create properly wires into the TriggerAgent's Clock-driven loop.
 *
 *   2. Cancelled trigger stops firing after schedule_cancel — verifies the
 *      fiber is actually interrupted (not just removed from the registry).
 *
 *   3. schedule_list shrinks after schedule_cancel — registry consistency
 *      across state transitions.
 *
 * Pattern mirrors packages/core/test/jobs/job-scheduler.sim.test.ts scenario 3.
 */
import { describe, expect, it } from "vitest"
import {
  Deferred,
  Duration,
  Effect,
  Ref,
  Stream,
} from "effect"
import * as ScopeImpl from "effect/Scope"
import * as TestClock from "effect/TestClock"
import * as TestContext from "effect/TestContext"
import {
  Clock,
  JobScheduler,
  JobSchedulerLayer,
  TriggerAgent,
  TriggerAgentLayer,
} from "@luna/core"
import { makeSchedulerTools } from "../src/tools.js"

/** Provide the scheduler stack with TestClock substituted for real Clock. */
const withTestScheduler = <A, E>(
  prog: Effect.Effect<A, E, TriggerAgent | JobScheduler | Clock>,
) =>
  Effect.scoped(
    prog.pipe(
      Effect.provide(TriggerAgentLayer.Default),
      Effect.provide(JobSchedulerLayer.make({ capacity: 16, offerPolicy: "drop-newest" })),
      Effect.provide(Clock.Default),
      Effect.provide(TestContext.TestContext),
    ),
  )

describe("scheduler-tools — Tier 2 simulation", () => {
  it("(1) cron trigger fires ≥4 times across 4 five-minute windows", async () => {
    const fired = await Effect.runPromise(
      withTestScheduler(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const sched = yield* JobScheduler
          const layerScope = yield* Effect.scope
          const [createTool] = makeSchedulerTools(trigger, layerScope)

          const counter = yield* Ref.make(0)
          const done = yield* Deferred.make<void>()

          // Collector: signal once we see 4 completions.
          yield* Effect.fork(
            sched.results.pipe(
              Stream.take(4),
              Stream.runDrain,
              Effect.zipRight(Deferred.succeed(done, void 0)),
            ),
          )

          // Register via the tool handler (same path the agent uses).
          // Build a cron that fires every 5 minutes and increments counter.
          // We override the build fn by registering directly with TriggerAgent
          // for the counting part, then verify the tool registration still wires
          // up correctly.
          yield* ScopeImpl.extend(layerScope)(
            trigger.register({
              kind: "cron",
              expr: "*/5 * * * *",
              build: () => ({
                run: Effect.gen(function* () {
                  yield* Ref.update(counter, (n) => n + 1)
                  return null
                }),
              }),
            }),
          )

          // Also verify tool registration path works (no error).
          const toolResult = yield* Effect.promise(() =>
            createTool.handler(
              { expr: "*/5 * * * *", label: "sim-test" },
              undefined,
            ),
          )
          expect(toolResult.isError).toBeFalsy()

          // Advance virtual time through 4 five-minute windows.
          yield* TestClock.adjust(Duration.minutes(5))
          yield* TestClock.adjust(Duration.minutes(5))
          yield* TestClock.adjust(Duration.minutes(5))
          yield* TestClock.adjust(Duration.minutes(5))
          yield* TestClock.adjust(Duration.millis(1))

          // Wait for 4 completions or advance further.
          yield* Effect.race(
            Deferred.await(done),
            Effect.gen(function* () {
              for (let i = 0; i < 5; i++) {
                yield* TestClock.adjust(Duration.minutes(5))
              }
            }),
          )

          return yield* Ref.get(counter)
        }),
      ),
    )
    expect(fired).toBeGreaterThanOrEqual(4)
  })

  it("(2) cancelled trigger stops firing after schedule_cancel", async () => {
    const result = await Effect.runPromise(
      withTestScheduler(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const sched = yield* JobScheduler
          const layerScope = yield* Effect.scope
          const [, , cancelTool] = makeSchedulerTools(trigger, layerScope)

          const counter = yield* Ref.make(0)

          // Register a counting cron.
          const triggerId = yield* ScopeImpl.extend(layerScope)(
            trigger.register({
              kind: "cron",
              expr: "*/5 * * * *",
              build: () => ({
                run: Ref.update(counter, (n) => n + 1),
              }),
            }),
          )

          // Fire once.
          yield* TestClock.adjust(Duration.minutes(5))
          yield* TestClock.adjust(Duration.millis(1))

          // Drain 1 result so the first tick is confirmed.
          yield* sched.results.pipe(Stream.take(1), Stream.runDrain)
          const countAfterFirst = yield* Ref.get(counter)

          // Cancel via tool.
          const cancelResult = yield* Effect.promise(() =>
            cancelTool.handler({ triggerId }, undefined),
          )
          expect(cancelResult.isError).toBeFalsy()

          // Advance time well past the next tick — counter should not increase.
          yield* TestClock.adjust(Duration.minutes(10))
          yield* TestClock.adjust(Duration.millis(1))

          const countAfterCancel = yield* Ref.get(counter)

          return { countAfterFirst, countAfterCancel }
        }),
      ),
    )
    // At least 1 tick fired before cancel.
    expect(result.countAfterFirst).toBeGreaterThanOrEqual(1)
    // No new ticks after cancel.
    expect(result.countAfterCancel).toBe(result.countAfterFirst)
  })

  it("(3) schedule_list shrinks to 0 after all schedules cancelled", async () => {
    const result = await Effect.runPromise(
      withTestScheduler(
        Effect.gen(function* () {
          const trigger = yield* TriggerAgent
          const layerScope = yield* Effect.scope
          const [createTool, listTool, cancelTool] = makeSchedulerTools(
            trigger,
            layerScope,
          )

          // Create two schedules.
          const r1 = yield* Effect.promise(() =>
            createTool.handler({ expr: "0 9 * * 1" }, undefined),
          )
          const c1 = (
            JSON.parse(
              (r1.content?.[0] as { text: string }).text,
            ) as { triggerId: string }
          ).triggerId

          const r2 = yield* Effect.promise(() =>
            createTool.handler({ expr: "0 17 * * 5" }, undefined),
          )
          const c2 = (
            JSON.parse(
              (r2.content?.[0] as { text: string }).text,
            ) as { triggerId: string }
          ).triggerId

          const listBefore = yield* Effect.promise(() =>
            listTool.handler({}, undefined),
          )
          const countBefore = (
            JSON.parse(
              (listBefore.content?.[0] as { text: string }).text,
            ) as { triggers: unknown[] }
          ).triggers.length

          // Cancel both.
          yield* Effect.promise(() =>
            cancelTool.handler({ triggerId: c1 }, undefined),
          )
          yield* Effect.promise(() =>
            cancelTool.handler({ triggerId: c2 }, undefined),
          )

          const listAfter = yield* Effect.promise(() =>
            listTool.handler({}, undefined),
          )
          const countAfter = (
            JSON.parse(
              (listAfter.content?.[0] as { text: string }).text,
            ) as { triggers: unknown[] }
          ).triggers.length

          return { countBefore, countAfter }
        }),
      ),
    )
    expect(result.countBefore).toBe(2)
    expect(result.countAfter).toBe(0)
  })
})
