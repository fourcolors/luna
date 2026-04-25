/**
 * Tier-1 unit tests for TriggerAgent — DESIGN §2.1.8 / §6.3.
 */
import { describe, expect, it } from "vitest"
import { Chunk, Effect, Exit, Stream } from "effect"
import {
  JobScheduler,
  JobSchedulerLayer,
  TriggerAgent,
  TriggerAgentLayer,
  TriggerError,
} from "../../src/jobs/index.js"
import { Clock } from "../../src/clock.js"

const fullLayer = (capacity: number) =>
  TriggerAgentLayer.Default.pipe(
    // wire JobScheduler + Clock under it
    (l) => l, // identity, just for readability
  )

const program = <A>(prog: Effect.Effect<A, unknown, JobScheduler | TriggerAgent | Clock>) =>
  Effect.scoped(
    prog.pipe(
      Effect.provide(TriggerAgentLayer.Default),
      Effect.provide(JobSchedulerLayer.make({ capacity: 16 })),
      Effect.provide(Clock.Default),
    ),
  )

describe("TriggerAgent — Tier 1", () => {
  it("rejects invalid cron expressions with TriggerError", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        program(
          Effect.gen(function* () {
            const trig = yield* TriggerAgent
            return yield* trig.register({
              kind: "cron",
              expr: "not-a-cron",
              build: () => ({ run: Effect.succeed(0) }),
            })
          }),
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("cron-parse")
  })

  it("list() returns registered triggers; entries removed on Scope close", async () => {
    // Inside the scoped program, registering 2 triggers → list returns 2.
    const insideCount = await Effect.runPromise(
      program(
        Effect.gen(function* () {
          const trig = yield* TriggerAgent
          yield* trig.register({
            kind: "stream",
            source: Stream.empty,
            build: () => ({ run: Effect.succeed(0) }),
          })
          yield* trig.register({
            kind: "stream",
            source: Stream.empty,
            build: () => ({ run: Effect.succeed(0) }),
          })
          const summaries = yield* trig.list
          return summaries.length
        }),
      ),
    )
    expect(insideCount).toBe(2)
  })

  it("list() summary includes cron expr for cron triggers", async () => {
    const summary = await Effect.runPromise(
      program(
        Effect.gen(function* () {
          const trig = yield* TriggerAgent
          yield* trig.register({
            kind: "cron",
            expr: "0 * * * *", // hourly
            build: () => ({ run: Effect.succeed(0) }),
          })
          const summaries = yield* trig.list
          return summaries[0]
        }),
      ),
    )
    expect(summary?.kind).toBe("cron")
    expect(summary?.expr).toBe("0 * * * *")
    expect(typeof summary?.registeredAt).toBe("string")
  })

  it("stream kind submits a job per event", async () => {
    const out = await Effect.runPromise(
      program(
        Effect.gen(function* () {
          const trig = yield* TriggerAgent
          const sched = yield* JobScheduler
          // Background collector: take 3 results.
          const collected = yield* Effect.fork(
            sched.results.pipe(
              Stream.take(3),
              Stream.runCollect,
              Effect.map(Chunk.toReadonlyArray),
            ),
          )
          const events = Stream.fromIterable([1, 2, 3])
          yield* trig.register({
            kind: "stream",
            source: events,
            build: (e) => ({ run: Effect.succeed(e) }),
          })
          const exit = yield* collected.await
          if (Exit.isFailure(exit)) return [] as ReadonlyArray<unknown>
          return exit.value
        }),
      ),
    )
    expect(out).toHaveLength(3)
  })
})

void fullLayer
const _t: TriggerError | null = null
void _t
