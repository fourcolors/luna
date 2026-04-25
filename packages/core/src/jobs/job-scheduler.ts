/**
 * JobScheduler — supervised job pool with bounded backpressure (DESIGN §2.1.2,
 * M3 §15). FIRST Fiber-supervision module in the codebase.
 *
 * Invariants honored (cite §-anchor):
 *   - §3.4 #1 iterable lifetime ≡ Scope: jobs run as FiberSet members; the
 *     FiberSet is owned by the Layer Scope. JobIds are plain strings —
 *     callers never receive a `Fiber.RuntimeFiber` reference.
 *   - §3.4 #4 interruption cascades top-down: closing the scheduler's Scope
 *     interrupts the FiberSet, every member fiber receives Exit.isInterrupted,
 *     and per-job Scopes (used by `acquireSession` etc.) finalize cleanly.
 *   - §6.3 additive errors: `JobSubmitError` raised on submit; per-job
 *     failures surface inside `JobResult.exit` (never thrown to caller).
 *   - §7 service signature: `Effect.Tag` with namespaced key, Layer factory
 *     under `JobSchedulerLayer.make`.
 *
 * Backpressure model:
 *   In-flight slot count == `capacity`. A `Semaphore` enforces this. The
 *   `OfferPolicy` chooses what `submit` does when no slot is available:
 *     - `block`     — suspend the caller until a slot frees (FIFO via
 *                     Semaphore's internal queue).
 *     - `drop-newest` — fail with `JobSubmitError({reason:"queue-full"})`.
 *     - `drop-oldest` — interrupt the oldest in-flight job and take its
 *                       slot. The evicted job's JobResult carries
 *                       `Exit.isInterrupted`.
 *
 * Per-job Scope alignment:
 *   Each `JobSpec.run` is invoked under `Effect.scoped`, giving it its own
 *   Scope. Resources acquired inside (e.g. `AccountBroker.acquireSession`)
 *   release on job completion — exactly mirroring the Phase 9.5 adapter
 *   pattern.
 *
 * Restart policy: NONE. Per-advisor: callers embed `Effect.retry` inside
 * `JobSpec.run` if they want retries. Trigger agents naturally re-fire on
 * the next cron tick.
 */
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Queue,
  Ref,
  Stream,
} from "effect"
import type * as Scope from "effect/Scope"
import { Clock } from "../clock.js"
import { JobSubmitError } from "./errors.js"

export type JobId = string
export type JobStatus = "queued" | "running" | "completed"
export type OfferPolicy = "block" | "drop-newest" | "drop-oldest"

export interface JobSpec {
  /** Optional caller-supplied id; if absent, scheduler generates one. */
  readonly id?: string
  /**
   * The job effect. Runs under its own Scope (provided by scheduler) so
   * any `Effect.addFinalizer` / `acquireSession` inside finalizes when
   * the job ends — success, failure, or interruption.
   */
  readonly run: Effect.Effect<unknown, unknown, Scope.Scope>
}

export interface JobResult {
  readonly jobId: JobId
  readonly exit: Exit.Exit<unknown, unknown>
}

export interface JobSchedulerOptions {
  readonly capacity: number
  readonly offerPolicy?: OfferPolicy
}

export interface JobSchedulerApi {
  readonly submit: (job: JobSpec) => Effect.Effect<JobId, JobSubmitError>
  readonly results: Stream.Stream<JobResult>
  readonly status: (id: JobId) => Effect.Effect<JobStatus | null>
}

export class JobScheduler extends Effect.Tag(
  "experiment-agent/JobScheduler",
)<JobScheduler, JobSchedulerApi>() {}

interface RunningEntry {
  readonly jobId: JobId
  readonly fiber: Fiber.RuntimeFiber<unknown, unknown>
}

const make = (
  opts: JobSchedulerOptions,
): Effect.Effect<JobSchedulerApi, never, Clock | Scope.Scope> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const policy: OfferPolicy = opts.offerPolicy ?? "block"
    const capacity = Math.max(1, opts.capacity)

    // Outbound results channel. Unbounded so producers (job-finalizer)
    // never block on slow Stream consumers.
    const resultsQueue = yield* Queue.unbounded<JobResult>()
    // Register the queue-shutdown finalizer FIRST so LIFO ordering causes
    // it to run AFTER the FiberSet interrupts every member fiber; each
    // fiber's onExit pushes its final JobResult while the queue is still
    // open. Without this ordering the queue would close before
    // interrupted fibers could surface their JobResult.
    yield* Effect.addFinalizer(() => Queue.shutdown(resultsQueue))

    // Supervised pool — Scope-attached. Closing this Scope interrupts every
    // member (§3.4 #4). Registered AFTER the queue-shutdown finalizer so
    // its own finalizer runs FIRST.
    const fiberSet = yield* FiberSet.make<unknown, unknown>()

    // Per-job slot accounting. Tracks insertion order (FIFO) for drop-oldest.
    const running = yield* Ref.make<ReadonlyArray<RunningEntry>>([])
    const statuses = yield* Ref.make<ReadonlyMap<JobId, JobStatus>>(new Map())

    // Backpressure permit. `take()` returns an Effect that suspends until a
    // permit is available — perfect for the `block` policy. Effect's
    // Semaphore lacks a sync `available` accessor, so we mirror the
    // in-flight count in a Ref for policy decisions.
    const slots = yield* Effect.makeSemaphore(capacity)
    const inFlightCount = yield* Ref.make(0)

    // Submit-mutex: serializes drop-newest / drop-oldest decisions so that
    // size checks + state mutation are atomic w.r.t. other submits.
    const submitMutex = yield* Effect.makeSemaphore(1)

    // Shutdown flag — set on Scope close so late submits fail cleanly.
    const shuttingDown = yield* Ref.make(false)
    yield* Effect.addFinalizer(() => Ref.set(shuttingDown, true))

    const setStatus = (id: JobId, s: JobStatus | null) =>
      Ref.update(statuses, (m) => {
        const next = new Map(m)
        if (s === null) next.delete(id)
        else next.set(id, s)
        return next
      })

    const genId = (): Effect.Effect<JobId> =>
      clock.nowMs().pipe(
        Effect.map(
          (ms) =>
            `job-${ms}-${Math.random().toString(36).slice(2, 10)}` as JobId,
        ),
      )

    /**
     * Wraps user's `JobSpec.run` so on exit we (a) emit a JobResult,
     * (b) release the in-flight slot, (c) drop from runningOrder.
     * Wrapped in Effect.scoped so the per-job Scope finalizes on exit.
     */
    const wrappedRun = (
      jobId: JobId,
      run: Effect.Effect<unknown, unknown, Scope.Scope>,
    ): Effect.Effect<unknown, unknown> =>
      Effect.scoped(run).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            // Best-effort: if the queue is shutdown, offer just resolves
            // false — never throws. Surface JobResult before slot release
            // so consumers see the result even if a new submit immediately
            // takes the freed slot.
            yield* Queue.offer(resultsQueue, { jobId, exit })
            yield* Ref.update(running, (xs) =>
              xs.filter((e) => e.jobId !== jobId),
            )
            yield* setStatus(jobId, "completed")
            yield* Ref.update(inFlightCount, (n) => Math.max(0, n - 1))
            yield* slots.release(1)
          }),
        ),
      )

    /** Fork the wrapped job into the FiberSet. Returns the fiber handle so
     *  drop-oldest can interrupt it; callers MUST NOT leak this fiber. */
    const forkJob = (
      jobId: JobId,
      run: Effect.Effect<unknown, unknown, Scope.Scope>,
    ): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>> =>
      Effect.gen(function* () {
        yield* Ref.update(inFlightCount, (n) => n + 1)
        const fiber = yield* FiberSet.run(fiberSet, wrappedRun(jobId, run))
        yield* Ref.update(running, (xs) => [...xs, { jobId, fiber }])
        yield* setStatus(jobId, "running")
        return fiber
      })

    const submit: JobSchedulerApi["submit"] = (job) =>
      Effect.gen(function* () {
        const down = yield* Ref.get(shuttingDown)
        if (down) {
          return yield* Effect.fail(
            job.id !== undefined
              ? new JobSubmitError({
                  reason: "shutting-down",
                  jobId: job.id,
                })
              : new JobSubmitError({ reason: "shutting-down" }),
          )
        }
        const jobId: JobId = job.id ?? (yield* genId())

        if (policy === "block") {
          // Acquire suspends until a slot is free — FIFO suspend order.
          yield* setStatus(jobId, "queued")
          yield* slots.take(1)
          yield* forkJob(jobId, job.run)
          return jobId
        }

        // drop-newest / drop-oldest must be atomic w.r.t. other submits.
        return yield* submitMutex.withPermits(1)(
          Effect.gen(function* () {
            // Try to grab a slot non-blockingly using mirrored counter.
            const live = yield* Ref.get(inFlightCount)
            if (live < capacity) {
              yield* slots.take(1)
              yield* forkJob(jobId, job.run)
              return jobId
            }
            if (policy === "drop-newest") {
              return yield* Effect.fail(
                new JobSubmitError({
                  reason: "queue-full",
                  jobId,
                }),
              )
            }
            // drop-oldest: interrupt the oldest in-flight job. Its onExit
            // hook will release the slot AND emit an interrupted JobResult.
            const xs = yield* Ref.get(running)
            if (xs.length === 0) {
              // Should not happen — capacity was full but no running.
              // Fall back to acquiring (will block briefly).
              yield* slots.take(1)
              yield* forkJob(jobId, job.run)
              return jobId
            }
            const oldest = xs[0]!
            // Interrupt without awaiting — its onExit will release.
            yield* Fiber.interruptFork(oldest.fiber)
            // Wait for slot to free.
            yield* slots.take(1)
            yield* forkJob(jobId, job.run)
            return jobId
          }),
        )
      })

    const results: JobSchedulerApi["results"] = Stream.fromQueue(resultsQueue)

    const status: JobSchedulerApi["status"] = (id) =>
      Ref.get(statuses).pipe(Effect.map((m) => m.get(id) ?? null))

    return {
      submit,
      results,
      status,
    } satisfies JobSchedulerApi
  })

export const JobSchedulerLayer = {
  make: (opts: JobSchedulerOptions): Layer.Layer<JobScheduler, never, Clock> =>
    Layer.scoped(JobScheduler, make(opts)),
} as const

// Re-export for convenience: tests sometimes need to inspect Cause kinds.
export { Cause }
