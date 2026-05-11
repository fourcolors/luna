/**
 * JobScheduler — supervised job pool with bounded backpressure (DESIGN §2.1.2,
 * M3 §15). Phase 11.5b: refactored to delegate fiber/capacity supervision to
 * `makeSupervisedPool` (`../supervised-pool/`); JobScheduler now adds the
 * Job-domain concerns on top of the generic helper:
 *   - JobId generation via `Clock`
 *   - status tracking (queued / running / completed)
 *   - mapping `SubmitOutcome` → `JobSubmitError`
 *   - re-broadcasting pool results as `JobResult` (id → jobId rename)
 *
 * Invariants honored (cite §-anchor):
 *   - §3.4 #1 iterable lifetime ≡ Scope: jobs run inside the SupervisedPool's
 *     FiberSet (owned by the scheduler's Layer Scope). JobIds are plain
 *     strings — callers never receive a `Fiber.RuntimeFiber` reference.
 *   - §3.4 #4 interruption cascades top-down: scheduler's Scope contains the
 *     pool's Scope (built via `yield* makeSupervisedPool`); closing the
 *     scheduler closes the pool, which interrupts every member fiber and
 *     finalizes per-job Scopes.
 *   - §6.3 additive errors: `JobSubmitError` raised on submit; per-job
 *     failures surface inside `JobResult.exit` (never thrown to caller).
 *   - §7 service signature: `Effect.Tag` with namespaced key, Layer factory
 *     under `JobSchedulerLayer.make`. `JobSchedulerApi` shape unchanged.
 *
 * Backpressure model (delegated to SupervisedPool):
 *   - `block` — submit suspends until a slot frees.
 *   - `drop-newest` — pool returns `rejected-full` → mapped to `JobSubmitError`.
 *   - `drop-oldest` — pool returns `evicted` (carries `evictedId`+`acceptedId`);
 *     evicted job's `Exit.isInterrupted` flows via the results stream.
 *
 * LIFO finalizer ordering (critical for cascade-cancel sim, test (2)):
 *   Registration order inside this scoped effect:
 *     1. `Queue.shutdown(schedulerResultsQueue)` finalizer
 *     2. (relay-fiber-join finalizer)
 *     3. `makeSupervisedPool` — internally registers pool's queue-shutdown
 *        then FiberSet finalizers
 *     4. `Effect.forkDaemon(relay)` — relay fiber tracked via Ref
 *   LIFO close runs:
 *     a. FiberSet finalizer → interrupts member fibers; each `onExit` pushes
 *        its (interrupted) PoolResult into the pool's results queue.
 *     b. Pool queue shutdown → pool.results stream completes naturally.
 *     c. Relay fiber drains the rest of pool.results, forwards every
 *        PoolResult to the scheduler queue, then exits naturally.
 *     d. Relay-fiber-join finalizer awaits the relay (no-op since it's
 *        already done).
 *     e. Scheduler queue shutdown → consumers of `JobScheduler.results`
 *        observe end-of-stream having received every final exit.
 *   Note: we use `Effect.forkDaemon` (not `forkScoped`) for the relay so
 *   Scope close does NOT interrupt the relay before the pool drains. The
 *   relay-fiber-join finalizer (registered before the pool) provides the
 *   "terminates with scheduler scope" guarantee asked for by §3.4 #1.
 *
 * Restart policy: NONE. Per-advisor: callers embed `Effect.retry` inside
 * `JobSpec.run` if they want retries.
 */
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Ref,
  Stream,
} from "effect"
import type * as Scope from "effect/Scope"
import { Clock } from "../clock.js"
import { makeSupervisedPool } from "../supervised-pool/supervised-pool.js"
import type {
  PoolPolicy,
  SubmitOutcome,
} from "../supervised-pool/types.js"
import { JobSubmitError } from "./errors.js"

export type JobId = string
export type JobStatus = "queued" | "running" | "completed"
export type OfferPolicy = "block" | "drop-newest" | "drop-oldest"

export interface JobSpec {
  /** Optional caller-supplied id; if absent, scheduler generates one. */
  readonly id?: string
  /**
   * The job effect. Runs under its own Scope (provided by the underlying
   * SupervisedPool) so any `Effect.addFinalizer` / `acquireSession` inside
   * finalizes when the job ends — success, failure, or interruption.
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
  "luna/JobScheduler",
)<JobScheduler, JobSchedulerApi>() {}

const make = (
  opts: JobSchedulerOptions,
): Effect.Effect<JobSchedulerApi, never, Clock | Scope.Scope> =>
  Effect.gen(function* () {
    const clock = yield* Clock
    const policy: PoolPolicy = opts.offerPolicy ?? "block"

    // Scheduler-owned outbound results channel. Unbounded so the relay
    // fiber never blocks on slow Stream consumers.
    const schedulerResultsQueue = yield* Queue.unbounded<JobResult>()

    // Status map — JobScheduler concern, not pool concern.
    const statuses = yield* Ref.make<ReadonlyMap<JobId, JobStatus>>(new Map())

    const setStatus = (id: JobId, s: JobStatus | null) =>
      Ref.update(statuses, (m) => {
        const next = new Map(m)
        if (s === null) next.delete(id)
        else next.set(id, s)
        return next
      })

    // Relay-fiber handle. Set after forkDaemon below; drained in finalizer.
    const relayRef = yield* Ref.make<Fiber.RuntimeFiber<
      unknown,
      unknown
    > | null>(null)

    // Finalizer #1 registered: scheduler queue shutdown. By LIFO this runs
    // LAST, after pool finalizers AND after the relay-join finalizer below.
    yield* Effect.addFinalizer(() => Queue.shutdown(schedulerResultsQueue))

    // Finalizer #2 registered: await relay completion. Runs BEFORE the
    // queue-shutdown finalizer (registered earlier) but AFTER the pool's
    // own finalizers (registered later, run earlier in LIFO). The relay
    // exits naturally once the pool queue closes — this finalizer simply
    // ensures we don't close the scheduler queue until forwarding is done.
    yield* Effect.addFinalizer(() =>
      Ref.get(relayRef).pipe(
        Effect.flatMap((f) =>
          f === null ? Effect.void : Fiber.join(f).pipe(Effect.ignore),
        ),
      ),
    )

    // Underlying supervised pool. Its finalizers (pool-queue-shutdown,
    // FiberSet) are registered NOW — they will run FIRST on close.
    const pool = yield* makeSupervisedPool({
      capacity: opts.capacity,
      policy,
    })

    // Relay: drain pool.results, update statuses, re-emit as JobResult.
    // Uses forkDaemon (not forkScoped) so Scope close does not interrupt
    // the relay before the pool queue shuts down — the relay terminates
    // naturally when pool.results ends, and the finalizer above awaits it.
    const relay = yield* Effect.forkDaemon(
      pool.results.pipe(
        Stream.runForEach((r) =>
          Effect.gen(function* () {
            yield* setStatus(r.id, "completed")
            // Best-effort offer: if the scheduler queue is already shut
            // down, offer resolves false rather than throwing.
            yield* Queue.offer(schedulerResultsQueue, {
              jobId: r.id,
              exit: r.exit,
            })
          }),
        ),
      ),
    )
    yield* Ref.set(relayRef, relay)

    const genId = (): Effect.Effect<JobId> =>
      clock.nowMs().pipe(
        Effect.map(
          (ms) =>
            `job-${ms}-${Math.random().toString(36).slice(2, 10)}` as JobId,
        ),
      )

    const submit: JobSchedulerApi["submit"] = (job) =>
      Effect.gen(function* () {
        // Generate jobId BEFORE pool.submit so every SubmitOutcome carries
        // a real id (advisor §3.b — slight tighten: rejected JobSubmitError
        // always has jobId set).
        const jobId: JobId = job.id ?? (yield* genId())

        // Provisionally mark queued. On rejection paths we revert.
        yield* setStatus(jobId, "queued")

        const outcome: SubmitOutcome = yield* pool.submit({
          id: jobId,
          run: job.run,
        })

        switch (outcome._tag) {
          case "accepted":
            yield* setStatus(jobId, "running")
            return jobId
          case "evicted":
            // The pool already accepted us and evicted the oldest. The
            // evicted fiber's interrupted Exit will flow through
            // pool.results → relay → scheduler queue.
            yield* setStatus(jobId, "running")
            return jobId
          case "rejected-full":
            yield* setStatus(jobId, null)
            return yield* Effect.fail(
              new JobSubmitError({ reason: "queue-full", jobId }),
            )
          case "rejected-shutdown":
            yield* setStatus(jobId, null)
            return yield* Effect.fail(
              new JobSubmitError({ reason: "shutting-down", jobId }),
            )
        }
      }).pipe(
        Effect.withSpan("luna.job_scheduler.submit", {
          attributes: { "job.id": job.id ?? "generated" },
        }),
      )

    const results: JobSchedulerApi["results"] =
      Stream.fromQueue(schedulerResultsQueue)

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
