// @internal — not exported from packages/core/src/index.ts. Phase 11.5a.
/**
 * SupervisedPool — generic Fiber-supervision helper (Phase 11.5a).
 *
 * Extracted verbatim-in-spirit from `packages/core/src/jobs/job-scheduler.ts`.
 * Consumers (JobScheduler in 11.5b, future TeamBroker candidates) wrap this
 * helper with their own typed error channels / id generators / status maps.
 *
 * Invariants honored (cite §-anchor + template line):
 *   - §3.4 #4 LIFO finalizer ordering: `Queue.shutdown` finalizer registered
 *     BEFORE `FiberSet.make` so the FiberSet finalizer runs FIRST (interrupts
 *     in-flight fibers, allowing their `onExit` to push final PoolResults)
 *     and the queue-shutdown finalizer runs AFTER, closing the results
 *     queue. Template: `job-scheduler.ts:108-113`.
 *   - §3.4 #1 no cross-Scope fiber refs: `RunningEntry` stays internal; the
 *     public `SupervisedPool` API exposes only string ids. Template:
 *     `job-scheduler.ts:89`.
 *   - Ref-shadow-size: `Effect.Semaphore` has no sync `available` accessor,
 *     so we mirror in-flight count in `Ref<number>` for drop-policy
 *     decisions. Template: `job-scheduler.ts:121-124`.
 *   - Submit-mutex atomicity: drop-oldest / drop-newest decisions read size,
 *     decide, and fork-or-interrupt under a single-permit semaphore to be
 *     atomic w.r.t. concurrent submits. Template: `job-scheduler.ts:128, 215`.
 *   - Per-job Scope isolation: each `job.run` is invoked under its OWN
 *     `Effect.scoped(...)` so job-level finalizers fire on job completion,
 *     not on pool Scope close. Template: `job-scheduler.ts:159`.
 *   - Supervisor-failure-kills-pool: emergent from Scope cascade; no
 *     explicit code.
 */
import {
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Queue,
  Ref,
  Stream,
} from "effect"
import type * as Scope from "effect/Scope"
import type {
  PoolJob,
  PoolResult,
  SubmitOutcome,
  SupervisedPool,
  SupervisedPoolConfig,
} from "./types.js"

interface RunningEntry {
  readonly id: string
  readonly fiber: Fiber.RuntimeFiber<unknown, unknown>
}

export const makeSupervisedPool = (
  config: SupervisedPoolConfig,
): Effect.Effect<SupervisedPool, never, Scope.Scope> =>
  Effect.gen(function* () {
    const capacity = Math.max(1, config.capacity)
    const policy = config.policy

    // Unbounded outbound results channel — producers (per-job onExit) must
    // never block on slow Stream consumers.
    const resultsQueue = yield* Queue.unbounded<PoolResult>()

    // Register queue-shutdown FIRST so LIFO ordering runs it AFTER the
    // FiberSet finalizer (registered next). Critical for §3.4 #4: fibers
    // get interrupted while the queue is still open so their onExit can
    // push the final interrupted PoolResult.
    yield* Effect.addFinalizer(() => Queue.shutdown(resultsQueue))

    // Supervised pool — Scope-attached. Closing the Scope interrupts every
    // member fiber (§3.4 #4). Its finalizer runs BEFORE the queue-shutdown
    // finalizer by LIFO order.
    const fiberSet = yield* FiberSet.make<unknown, unknown>()

    // In-flight accounting. `running` tracks insertion order (FIFO) so
    // drop-oldest can evict deterministically.
    const running = yield* Ref.make<ReadonlyArray<RunningEntry>>([])

    // Capacity permit. Effect v3 Semaphore has no sync `available`, so we
    // maintain a Ref shadow for policy decisions.
    const slots = yield* Effect.makeSemaphore(capacity)
    const inFlightCount = yield* Ref.make(0)

    // Serializes drop-policy decisions so "read size → evict → offer" is
    // atomic w.r.t. other concurrent submits.
    const submitMutex = yield* Effect.makeSemaphore(1)

    // Shutdown flag — flipped by explicit `shutdown` and by Scope close.
    // Late submits after either path return `rejected-shutdown`.
    const shuttingDown = yield* Ref.make(false)
    yield* Effect.addFinalizer(() => Ref.set(shuttingDown, true))

    /**
     * Wraps `job.run` with per-job scoping + exit bookkeeping:
     *   - `Effect.scoped(run)` gives each job its OWN Scope (§3.4 #1 — job
     *     resources attach to job Scope, not pool Scope).
     *   - `Effect.onExit` pushes the PoolResult, drops the running entry,
     *     and releases the capacity permit. Ordering matters: result first,
     *     then slot release — so consumers observe the result before a new
     *     submit can grab the freed slot.
     */
    const wrappedRun = (
      id: string,
      run: Effect.Effect<unknown, unknown, Scope.Scope>,
    ): Effect.Effect<unknown, unknown> =>
      Effect.scoped(run).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            // Queue.offer resolves `false` post-shutdown — never throws.
            yield* Queue.offer(resultsQueue, { id, exit })
            yield* Ref.update(running, (xs) => xs.filter((e) => e.id !== id))
            yield* Ref.update(inFlightCount, (n) => Math.max(0, n - 1))
            yield* slots.release(1)
          }),
        ),
      )

    const forkJob = (
      id: string,
      run: Effect.Effect<unknown, unknown, Scope.Scope>,
    ): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>> =>
      Effect.gen(function* () {
        yield* Ref.update(inFlightCount, (n) => n + 1)
        const fiber = yield* FiberSet.run(fiberSet, wrappedRun(id, run))
        yield* Ref.update(running, (xs) => [...xs, { id, fiber }])
        return fiber
      })

    const submit: SupervisedPool["submit"] = (job) =>
      Effect.gen(function* () {
        const down = yield* Ref.get(shuttingDown)
        if (down) {
          return {
            _tag: "rejected-shutdown",
            id: job.id,
          } satisfies SubmitOutcome
        }

        if (policy === "block") {
          // Acquire suspends until a slot frees — FIFO queue via Semaphore.
          yield* slots.take(1)
          // Re-check shutdown after wake — Scope may have closed while we
          // were suspended on the semaphore.
          const downAfter = yield* Ref.get(shuttingDown)
          if (downAfter) {
            yield* slots.release(1)
            return {
              _tag: "rejected-shutdown",
              id: job.id,
            } satisfies SubmitOutcome
          }
          yield* forkJob(job.id, job.run)
          return { _tag: "accepted", id: job.id } satisfies SubmitOutcome
        }

        // drop-newest / drop-oldest: atomic via submitMutex.
        return yield* submitMutex.withPermits(1)(
          Effect.gen(function* () {
            const live = yield* Ref.get(inFlightCount)
            if (live < capacity) {
              yield* slots.take(1)
              yield* forkJob(job.id, job.run)
              return { _tag: "accepted", id: job.id } satisfies SubmitOutcome
            }
            if (policy === "drop-newest") {
              return {
                _tag: "rejected-full",
                id: job.id,
              } satisfies SubmitOutcome
            }
            // drop-oldest: interrupt oldest. Its onExit releases the slot
            // AND surfaces Exit.isInterrupted via the results Stream.
            const xs = yield* Ref.get(running)
            if (xs.length === 0) {
              // Defensive fallback: counter says full but no entries.
              yield* slots.take(1)
              yield* forkJob(job.id, job.run)
              return { _tag: "accepted", id: job.id } satisfies SubmitOutcome
            }
            const oldest = xs[0]!
            const evictedId = oldest.id
            yield* Fiber.interruptFork(oldest.fiber)
            yield* slots.take(1)
            yield* forkJob(job.id, job.run)
            return {
              _tag: "evicted",
              evictedId,
              acceptedId: job.id,
            } satisfies SubmitOutcome
          }),
        )
      })

    const size: SupervisedPool["size"] = Ref.get(inFlightCount)

    // Explicit shutdown: flip the flag + interrupt all in-flight fibers via
    // the FiberSet. Does NOT close the pool Scope (caller owns that). Idempotent.
    const shutdown: SupervisedPool["shutdown"] = Effect.gen(function* () {
      yield* Ref.set(shuttingDown, true)
      // Clearing the FiberSet interrupts all members.
      yield* FiberSet.clear(fiberSet)
    })

    const results: SupervisedPool["results"] = Stream.fromQueue(resultsQueue)

    return {
      submit,
      size,
      shutdown,
      results,
    } satisfies SupervisedPool
  })
