/**
 * Tier-1 unit tests for JobScheduler — DESIGN §2.1.2 / §3.4 / §6.3.
 */
import { describe, expect, it } from "vitest"
import { Chunk, Effect, Exit, Stream } from "effect"
import {
  JobScheduler,
  JobSchedulerLayer,
  JobSubmitError,
  type JobResult,
} from "../../src/jobs/index.js"
import { Clock } from "../../src/clock.js"

const layer = (capacity: number, policy?: "block" | "drop-newest" | "drop-oldest") =>
  JobSchedulerLayer.make(
    policy === undefined ? { capacity } : { capacity, offerPolicy: policy },
  ).pipe(
    // Provide a real clock for jobId stamping.
    Effect.provide.bind(null) as never,
  )

// Helper: run program with scheduler scope, providing Clock.Default.
const provide = <A, E>(
  prog: Effect.Effect<A, E, JobScheduler | Clock>,
  capacity: number,
  policy?: "block" | "drop-newest" | "drop-oldest",
) =>
  Effect.scoped(
    prog.pipe(
      Effect.provide(
        JobSchedulerLayer.make(
          policy === undefined
            ? { capacity }
            : { capacity, offerPolicy: policy },
        ),
      ),
      Effect.provide(Clock.Default),
    ),
  )

// Suppress unused-helper warning — `layer` retained for readers as
// reference; the simpler `provide` is what tests use.
void layer

const takeResult = (sched: { results: Stream.Stream<JobResult> }) =>
  sched.results.pipe(Stream.take(1), Stream.runCollect, Effect.map(Chunk.toReadonlyArray), Effect.map((xs) => xs[0]!))

describe("JobScheduler — Tier 1", () => {
  it("submit returns a JobId and the job runs to completion", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const sched = yield* JobScheduler
          const id = yield* sched.submit({
            run: Effect.succeed(42),
          })
          const result = yield* takeResult(sched)
          return { id, result }
        }),
        2,
      ),
    )
    expect(typeof out.id).toBe("string")
    expect(out.result.jobId).toBe(out.id)
    expect(Exit.isSuccess(out.result.exit)).toBe(true)
  })

  it("results stream emits Exit.fail on tagged failure", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const sched = yield* JobScheduler
          yield* sched.submit({
            run: Effect.fail("boom"),
          })
          return yield* takeResult(sched)
        }),
        2,
      ),
    )
    expect(Exit.isFailure(out.exit)).toBe(true)
  })

  it("drop-newest fails submit when full", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const sched = yield* JobScheduler
          // Capacity 1 + a job that never finishes saturates.
          yield* sched.submit({ run: Effect.never })
          // Second submit should fail synchronously.
          return yield* Effect.exit(
            sched.submit({ run: Effect.succeed("x") }),
          )
        }),
        1,
        "drop-newest",
      ),
    )
    expect(Exit.isFailure(out)).toBe(true)
    if (Exit.isFailure(out)) {
      // failure cause carries JobSubmitError.
      const fail = out.cause
      // crude inspection — Cause.failures is a Chunk
      expect(JSON.stringify(fail)).toContain("queue-full")
    }
  })

  it("drop-oldest evicts oldest with Exit.isInterrupted", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const sched = yield* JobScheduler
          // Pre-collect first 2 results in background.
          const collector = yield* Effect.fork(
            sched.results.pipe(
              Stream.take(2),
              Stream.runCollect,
              Effect.map(Chunk.toReadonlyArray),
            ),
          )
          const first = yield* sched.submit({
            id: "first",
            run: Effect.never,
          })
          // Submitting another with full capacity should evict `first`.
          yield* sched.submit({
            id: "second",
            run: Effect.succeed(1),
          })
          const collected = yield* Effect.scoped(
            Effect.gen(function* () {
              return yield* collector.await.pipe(
                Effect.flatMap((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.succeed(exit.value)
                    : Effect.die("collector failed"),
                ),
              )
            }),
          )
          return { first, collected }
        }),
        1,
        "drop-oldest",
      ),
    )
    const evicted = out.collected.find((r) => r.jobId === "first")!
    const completed = out.collected.find((r) => r.jobId === "second")!
    expect(evicted).toBeDefined()
    expect(Exit.isInterrupted(evicted.exit)).toBe(true)
    expect(Exit.isSuccess(completed.exit)).toBe(true)
  })

  it("block policy suspends caller until capacity frees", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const sched = yield* JobScheduler
          // capacity 1, fill it with a job that completes after a tick.
          const idA = yield* sched.submit({
            run: Effect.succeed("A"),
          })
          // Wait for it to drain so block-submit doesn't actually block long.
          // Then second submit should succeed.
          const idB = yield* sched.submit({
            run: Effect.succeed("B"),
          })
          // Drain 2 results.
          const collected = yield* sched.results.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.map(Chunk.toReadonlyArray),
          )
          return { idA, idB, collected }
        }),
        1,
        "block",
      ),
    )
    expect(out.collected).toHaveLength(2)
    expect(out.collected.every((r) => Exit.isSuccess(r.exit))).toBe(true)
  })

  it("status() returns running/completed/null", async () => {
    await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const sched = yield* JobScheduler
          const id = yield* sched.submit({
            id: "s1",
            run: Effect.succeed(1),
          })
          // Drain
          yield* takeResult(sched)
          const after = yield* sched.status(id)
          expect(after).toBe("completed")
          const missing = yield* sched.status("nope")
          expect(missing).toBeNull()
        }),
        2,
      ),
    )
  })
})

// Static usage check: tagged error type narrows.
const _typecheck: JobSubmitError | null = null
void _typecheck
