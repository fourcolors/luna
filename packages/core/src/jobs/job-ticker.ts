/**
 * JobTicker — the Phase-12b global scheduler (DESIGN.md §5.3.2).
 *
 * Replaces the per-trigger fiber model with a single supervised fiber that
 * polls the `jobs` table every minute (or whatever `tickInterval` the boot
 * layer chooses), atomically claims due rows, and dispatches them to the
 * `WorkerRegistry`. Each claimed row also writes a `job_runs` row that
 * closes when the worker terminates — that's the per-fire audit ledger.
 *
 * Invariants honoured:
 *   - §3.4 #1 iterable lifetime ≡ Scope: the ticker fiber lives in the Layer
 *     Scope; closing the Layer interrupts the loop and any in-flight worker
 *     fibers (they're forked into the ticker's own Scope).
 *   - §3.4 #4 interruption cascades top-down.
 *   - §6.3 additive errors: no error escapes the loop. Worker failures
 *     surface in the `job_runs` row's `status='failed'` / `error` column.
 *     A faulting JobsStore call logs at WARN, the row stays in 'running'
 *     until the next tick re-attempts.
 *
 * job-ticker-producer-executor-276 (Oban's producer/executor split): before
 * this seam, `drainOnce` read `listDue` then `Effect.forEach(due, handleJob,
 * {concurrency: dispatchConcurrency})` and AWAITED every dispatch before
 * returning - so a single long-running worker (a 15-minute dream on a big
 * backlog) blocked the WHOLE tick loop for its duration: no `listDue` ran,
 * and anything else that became due in that window wasn't claimed until the
 * blocked drain finally returned. Jobs fired LATE, never lost (the claim had
 * already advanced `next_run_at`, and boot reconcile closes true orphans),
 * but the architecture had the tick loop doing the job of a worker pool.
 * Now the loop is a fast PRODUCER only: per due row it does the synchronous
 * SQLite work (claim, the one-shot/quarantine/unknown-kind guards,
 * `claimAndStartRun`) and FORKS the slow part - the worker dispatch and its
 * aftermath (retry/reset, touch, postCommit) - into its own EXECUTOR fiber,
 * then moves on to the next row without waiting. `drainOnce` (and the public
 * `drain`) return as soon as every due row this tick has been claimed or
 * forked, never once it has fully run. See `executors` (the in-flight guard)
 * and `producerSemaphore` (serialization) below, and `executor` (the forked
 * tail, now in job-ticker-executor.ts) for the three pieces that make that
 * split safe. The tick loop itself lives in job-ticker-producer.ts, and boot
 * reconciliation (below) in job-ticker-reconcile.ts.
 *
 * Why a single fiber and not per-row? Per-row would explode fiber count on a
 * thousand-row jobs table and re-create the per-trigger cost we're replacing.
 * Each worker dispatch is bounded by a per-dispatch backstop deadline
 * (Effect.timeoutFail) so a stuck worker is interrupted rather than blocking
 * its executor indefinitely; `dispatchConcurrency` (default 4) now bounds
 * total IN-FLIGHT executors (a slot cap checked at the top of each tick), not
 * a per-tick `Effect.forEach` concurrency - see `JobTickerOptions.dispatchConcurrency`.
 *
 * job-ticker-oban-deadlines (Seam 1 — deadline + grace): the backstop is
 * `workerDeadline` for a bare-function worker registration with NO payload
 * `timeout_ms` override (back-compat, unchanged from before this seam) OR,
 * when a per-dispatch timeout resolves from `payload.timeout_ms` (highest
 * priority) or the worker's registered `defaultTimeoutMs`,
 * `min(max(resolved, 1s) + grace, maxWorkerDeadline)`. Production boot wiring
 * (prompt-worker.ts, workflow-worker.ts, dream-worker.ts) registers each
 * kind's `defaultTimeoutMs` so this path is the norm, not the exception — see
 * each worker's `*WorkerLayer`. The `grace` window exists so a well-behaved
 * worker with its OWN inner timeout (e.g. the dream worker's per-chunk
 * `LUNA_DREAM_TIMEOUT_MS`) gets to fail on its own typed WorkerError terms
 * FIRST, with the ticker's timeoutFail only firing as a true last resort.
 * This only helps single-turn-shaped workers, though: a worker whose total
 * work spans many inner timeouts (dream draining a long backlog across many
 * chunks) can still legitimately run past `defaultTimeoutMs + grace` and hit
 * the ticker's backstop as `deadline_passed` — that is the EXPECTED terminal
 * for such a dispatch, and Seam 3 (retry) is what makes that survivable: the
 * job just resumes from its last committed watermark on the next attempt.
 *
 * job-ticker-oban-deadlines (Seam 3 — retry with backoff + max attempts): a
 * RECURRING job (has a resolvable cron `schedule`/`spec` — one-shots are
 * excluded, they never retry) whose dispatch fails with a RETRYABLE reason
 * (`deadline_passed`/`worker_failed`/`defect` — NOT `bad_payload` or
 * `unknown_kind`, which are deterministic and would otherwise hot-loop the
 * backoff cadence) gets its `next_run_at` pulled EARLIER than its natural
 * next cron fire, to `finishedAt + retryBackoff(attempt)`, and
 * `retry_attempt` bumped — UNLESS the just-failed attempt number
 * (`retry_attempt + 1`) has reached `maxAttempts` (`payload.max_attempts`
 * clamped to [1,10], else `defaultMaxAttempts`, default 3), in which case the
 * job is EXHAUSTED: no retry is scheduled and `retry_attempt` resets to 0 so
 * it falls back to its natural cron cadence with a clean slate. `retry_attempt`
 * also resets to 0 on the next success. This is deliberately modeled after
 * Oban's job-level retry: a transient failure (a flaky SDK call, a temporary
 * deadline_passed) gets a fast nudge instead of waiting out the job's full
 * cron period, but only up to a bounded number of attempts.
 *
 * This is the ONLY scheduler — the chat-server always wires this layer. The
 * agent-facing scheduler tools are fully ticker-driven (a schedule is a
 * `kind:"prompt"` row); the wake / dream cycles run as `kind:"wake"` /
 * `kind:"dream"` rows drained here. The legacy `kind="cron"` rows from the
 * removed V1 (fiber-per-cron) path are never claimed — the ticker reads
 * `enabled=1 AND next_run_at <= now` and skips `kind="cron"` rows defensively
 * so any stragglers left in an existing DB stay inert.
 */
import { Duration, Effect, FiberMap, Layer, Ref, Schedule } from "effect"
import * as EffectClock from "effect/Clock"
import { Clock } from "../clock.js"
import {
  resolveDoctorEnqueueConfig,
  type DoctorEnqueueConfig,
} from "../doctor/doctor-enqueue.js"
import { defaultRetryBackoffMs, makeExecutor } from "./job-ticker-executor.js"
import { makeDrainOnce } from "./job-ticker-producer.js"
import { runBootReconcile } from "./job-ticker-reconcile.js"
import { JobsStoreService } from "./jobs-store.js"
import { WorkerRegistry } from "./worker-registry.js"

// ── Public API ──────────────────────────────────────────────────────────────

export interface JobTickerApi {
  /**
   * Drain one tick worth of due jobs. Useful for test drivers that want to
   * advance time + force a drain without sleeping the real Clock. The
   * supervised loop calls this on each Schedule.fixed boundary in production.
   *
   * job-ticker-producer-executor-276: this is the PRODUCER only - it returns
   * as soon as every due row this tick has been claimed (guard path) or
   * forked into an executor fiber, NOT once those executors finish. A test
   * (or the caller) that needs to observe post-dispatch state (job_runs
   * outcome, retry_attempt, next_run_at pulled earlier) MUST `yield*
   * awaitIdle` after `drain` - see below.
   *
   * Returns a summary of what happened on this tick (for logs + tests).
   */
  readonly drain: Effect.Effect<TickSummary>

  /**
   * job-ticker-producer-executor-276 (codex amendment 2) - resolves once
   * every currently in-flight executor fiber has completed (success, failure,
   * or interruption). `FiberMap.awaitEmpty` under the hood: deterministic on
   * the SAME fiber-completion signal `FiberMap` already uses to auto-remove
   * an entry, NOT a real-sleep poll - a poll would encode test correctness in
   * wall-clock timing and add CI flakiness for no reason. Tests migrate from
   * reading `drain`'s (now-removed) `succeeded`/`failed` fields to `yield*
   * drain; yield* awaitIdle; const runs = yield* store.listRuns(jobId)`.
   */
  readonly awaitIdle: Effect.Effect<void>

  /**
   * Live scheduler health snapshot (updated after every drain, including quiet
   * ticks). Used by `/readyz.scheduler` and ops. Detects a hung/dead producer
   * loop (lastTickAge), not "all workers healthy" - slots can be full while
   * ticks stay fresh; `inFlight` is included for that case.
   */
  readonly health: Effect.Effect<SchedulerHealthSnapshot>
}

/**
 * Additive readiness signal for JobTicker. Report-only by default on /readyz
 * (process stays ready); `LUNA_SCHEDULER_STRICT_READY=1` may treat degraded
 * as overall not-ready (chat-server / ui-ws wiring).
 */
export interface SchedulerHealthSnapshot {
  readonly status: "ok" | "degraded" | "initializing"
  readonly lastTickAt: number | null
  readonly lastTickAgeMs: number | null
  readonly inFlight: number
  readonly tickIntervalMs: number
  readonly lastTick: {
    readonly considered: number
    readonly claimed: number
    readonly forked: number
    readonly skippedInFlight: number
    readonly skippedNoCapacity: number
    readonly failedInline: number
  }
}

export interface TickSummary {
  readonly tickAt: number
  readonly considered: number
  /** Rows claimed this tick - guard-path claims (one-shot re-encounter,
   *  quarantine, unknown-kind) PLUS real dispatches forked (`forked` below is
   *  a subset of this count, not additional to it). */
  readonly claimed: number
  /** job-ticker-producer-executor-276 - real dispatches forked into an
   *  executor fiber this tick. Per-run success/failure is no longer known at
   *  `drain` return (see the module header); it lands in `job_runs`, queryable
   *  via `listRuns`, once the executor closes. */
  readonly forked: number
  /** job-ticker-producer-executor-276 (amendment 1) - a due row skipped
   *  because its jobId is already `FiberMap.has` in `executors`: a dispatch
   *  that outlives its cron period must not be re-claimed while its executor
   *  fiber is still running. This is the uniqueness guarantee the old
   *  await-all `drainOnce` got for free by construction. */
  readonly skippedInFlight: number
  /** job-ticker-producer-executor-276 - a real dispatch skipped because the
   *  start-of-tick slot snapshot (`dispatchConcurrency - inFlight`) was
   *  already exhausted. NOT claimed (next_run_at untouched), so the row stays
   *  due and is retried next tick - no loss, worst case ~one tick interval of
   *  delay under saturation (see the module's Backpressure doc). */
  readonly skippedNoCapacity: number
  readonly skippedUnknownKind: number
  readonly skippedClaimLost: number
  /** Legacy `kind="cron"` rows (from the removed V1 path) skipped — there is no
   *  "cron" worker, so they are never claimed or dispatched here. */
  readonly skippedV1Cron: number
  /** job-ticker-producer-executor-276 - unknown-kind closes written INLINE by
   *  the producer (no worker to dispatch, so no fork): the only failures the
   *  producer itself can observe by the time `drain` returns. Every other
   *  outcome (worker success/failure, retry scheduling) happens later inside
   *  a forked executor and is visible only via `listRuns` after `awaitIdle`. */
  readonly failedInline: number
  /** Closed `job_runs` rows deleted by this tick's retention sweep (0 if the
   *  sweep interval has not elapsed since the last prune). */
  readonly pruned: number
}

export class JobTicker extends Effect.Tag("luna/JobTicker")<
  JobTicker,
  JobTickerApi
>() {}

// ── Layer config ────────────────────────────────────────────────────────────

export interface JobTickerOptions {
  /**
   * Tick cadence. Default 60 seconds (DESIGN.md §5.3.2). Tests pass a
   * smaller value + TestClock.adjust to verify multiple drains.
   */
  readonly tickInterval?: Duration.DurationInput

  /**
   * Per-worker deadline. ENFORCED: a dispatch that overruns is interrupted via
   * `Effect.timeoutFail` and closed as a `deadline_passed` failure (also fills
   * `WorkerContext.deadline`). Default 5 minutes.
   */
  readonly workerDeadline?: Duration.DurationInput

  /**
   * Retention: closed `job_runs` rows older than this are pruned so the audit
   * ledger does not grow without bound. Default 30 days.
   */
  readonly retentionMaxAge?: Duration.DurationInput

  /**
   * How often the retention sweep actually runs. The ticker checks on every
   * drain but only prunes once this interval has elapsed since the last sweep,
   * so a 60s tick does not issue a DELETE every minute. Default 6 hours.
   */
  readonly retentionSweepInterval?: Duration.DurationInput

  /**
   * Whether to fork the supervised auto-tick loop. Default true (production).
   * Tests set this false to drive `drain` deterministically without a
   * background fiber racing the explicit drain on the shared store.
   */
  readonly autoStart?: boolean

  /**
   * job-ticker-oban-deadlines (Seam 1). Extra buffer added on top of a
   * worker's OWN `defaultTimeoutMs` (WorkerRegistry.WorkerEntry) before the
   * ticker's outer backstop interrupts it — see the module header. Only
   * applies to kinds registered with an explicit `defaultTimeoutMs`; a
   * bare-function registration (the common case, and every kind registered
   * before this seam) uses `workerDeadline` exactly as before, with NO grace
   * added, so existing deployments and tests are unaffected. Default 30s.
   */
  readonly grace?: Duration.DurationInput

  /**
   * job-ticker-oban-deadlines (Seam 1). Hard outer cap on the per-dispatch
   * backstop deadline for a worker registered with `defaultTimeoutMs`,
   * regardless of how large `defaultTimeoutMs + grace` computes to. Prevents
   * a misconfigured per-kind timeout from starving the ticker of a bounded
   * ceiling. Default 30 min.
   */
  readonly maxWorkerDeadline?: Duration.DurationInput

  /**
   * job-ticker-oban-deadlines (Seam 4), meaning CHANGED by
   * job-ticker-producer-executor-276: this used to bound a single tick's
   * `Effect.forEach(due, handleJob, {concurrency})`. Now that dispatch is
   * forked (see the module header), it bounds the total number of IN-FLIGHT
   * executor fibers at once - a start-of-tick snapshot
   * (`dispatchConcurrency - FiberMap.size(executors)`) caps how many NEW
   * dispatches the producer forks this tick; a row that doesn't fit waits
   * (undisturbed, still due) for a slot next tick. The option name is kept
   * for config back-compat even though the mechanism it bounds changed.
   * Bounded (not per-row-unbounded) so a large due batch - or one dispatch
   * that outlives its cron period - cannot explode fiber count the way the
   * removed V1 per-trigger-fiber model did. Default 4.
   */
  readonly dispatchConcurrency?: number

  /**
   * job-ticker-oban-deadlines (Seam 3). Backoff schedule for a RECURRING
   * job's retry after a failed dispatch. Given the job's retry attempt
   * number (1-indexed, counting the failure that just happened), returns how
   * long after `finishedAt` (the post-dispatch clock read, NOT `tickAt`) to
   * next attempt it. Defaults to exponential backoff: 1 min * 2^(attempt-1),
   * capped at 30 min. One-shot jobs never retry — see the one-shot guard in
   * `drainOnce`.
   */
  readonly retryBackoff?: (attempt: number) => Duration.DurationInput

  /**
   * job-ticker-oban-deadlines (Seam 3). Ceiling on total attempts for a
   * RECURRING job's retry loop when the job's payload does not specify its
   * own `max_attempts`. A dispatch's attempt number is `retry_attempt + 1`
   * (see the producer's `claimAndStartRun` call and the executor's retry
   * logic); once that number reaches `maxAttempts` the failure is NOT
   * retried - `retry_attempt` resets to 0 and the job falls back to its
   * natural cron cadence (Oban's `max_attempts` analogue). Default 3.
   */
  readonly defaultMaxAttempts?: number

  /**
   * On Layer/Scope teardown, wait for in-flight executors up to this long
   * before FiberMap interrupts them (A1b graceful drain). Default 90_000 ms.
   * Override with env `LUNA_SCHED_DRAIN_MS` when options omit it. `0` skips
   * the wait (immediate interrupt — useful in unit tests).
   */
  readonly shutdownDrainMs?: number

  /**
   * Phase B1 — auto-enqueue the doctor workflow when a non-exempt job
   * chronically fails (`fail_streak` / `orphan_streak`). Always enabled
   * by default; pass `enabled: false` only in tests.
   */
  readonly doctor?: {
    /** Default true. */
    readonly enabled?: boolean
    /** Default 5. */
    readonly failStreakThreshold?: number
    /** Default 5. */
    readonly orphanStreakThreshold?: number
    /** Default 3. */
    readonly maxHealAttempts?: number
    /**
     * Absolute path to `luna-doctor-workflow.ts`. Defaults to
     * `join(cwd, 'apps/server/scripts/luna-doctor-workflow.ts')` or
     * `LUNA_DOCTOR_CLI`.
     */
    readonly cliPath?: string
    readonly bunBin?: string
    readonly lunaHome?: string
  }
}

// ── Layer ───────────────────────────────────────────────────────────────────
//
// The Seam 1 (deadline+grace) and Seam 3 (retry+backoff) helpers that used
// to live here now live in job-ticker-executor.ts alongside the `executor`
// they configure; `computeNextRunAt` lives in job-ticker-producer.ts
// alongside the tick loop that calls it; boot reconciliation lives in
// job-ticker-reconcile.ts. This file keeps the public API types above and
// the composition Layer below.

/**
 * Build a supervised JobTicker. The forked loop is interrupted when the
 * layer's Scope closes.
 *
 *   const tickerL = JobTickerLayer({ tickInterval: Duration.seconds(60) })
 *     .pipe(Layer.provide(Layer.mergeAll(JobsStoreService.SQLite, workerRegistryL)))
 */
export const JobTickerLayer = (
  options?: JobTickerOptions,
): Layer.Layer<
  JobTicker,
  never,
  JobsStoreService | WorkerRegistry | Clock
> => {
  const tickInterval = options?.tickInterval ?? Duration.seconds(60)
  const workerDeadlineMs = Duration.toMillis(
    options?.workerDeadline ?? Duration.minutes(5),
  )
  const retentionMaxAgeMs = Duration.toMillis(
    options?.retentionMaxAge ?? Duration.days(30),
  )
  const retentionSweepIntervalMs = Duration.toMillis(
    options?.retentionSweepInterval ?? Duration.hours(6),
  )
  // Seam 1 (deadline + grace) — only consulted for a kind registered with
  // its own `defaultTimeoutMs`; a bare-function registration never sees
  // these and keeps using `workerDeadlineMs` exactly as before this seam.
  const graceMs = Duration.toMillis(options?.grace ?? Duration.seconds(30))
  const maxWorkerDeadlineMs = Duration.toMillis(
    options?.maxWorkerDeadline ?? Duration.minutes(30),
  )
  // Seam 4 (concurrency) — bounded, not per-row-unbounded (see module header).
  const dispatchConcurrency = options?.dispatchConcurrency ?? 4
  // Seam 3 (retry) — pluggable backoff, defaulting to doubling-capped.
  const retryBackoff =
    options?.retryBackoff ??
    ((attempt: number) => Duration.millis(defaultRetryBackoffMs(attempt)))
  // Seam 3 (retry) — max-attempts ceiling when the payload doesn't specify
  // its own (resolveMaxAttempts clamps a payload override to [1, 10]).
  const defaultMaxAttempts = options?.defaultMaxAttempts ?? 3
  const tickIntervalMs = Duration.toMillis(tickInterval)
  const envDrain = Number(process.env["LUNA_SCHED_DRAIN_MS"] ?? "")
  const shutdownDrainMs =
    options?.shutdownDrainMs ??
    (Number.isFinite(envDrain) && envDrain >= 0 ? envDrain : 90_000)
  // Phase B1 — doctor auto-enqueue config (resolved once at layer build).
  const doctorCfg: DoctorEnqueueConfig = resolveDoctorEnqueueConfig(
    options?.doctor,
  )

  return Layer.scoped(
    JobTicker,
    Effect.gen(function* () {
      const store = yield* JobsStoreService
      const registry = yield* WorkerRegistry
      const clock = yield* Clock

      // Throttle the retention sweep: the ticker drains every minute but we
      // only issue a DELETE once `retentionSweepIntervalMs` has elapsed. Init
      // to 0 so the first drain on a long-lived clock prunes immediately; on a
      // TestClock pinned at 0 the interval has not elapsed, so unit tests that
      // don't care about retention see `pruned: 0`.
      const lastPruneAt = yield* Ref.make(0)

      // Health snapshot for /readyz. Starts `initializing` until the first
      // drainOnce completes (auto loop or explicit drain). Degraded when
      // lastTickAgeMs > 3 * tickIntervalMs after that first tick.
      const healthRef = yield* Ref.make<SchedulerHealthSnapshot>({
        status: "initializing",
        lastTickAt: null,
        lastTickAgeMs: null,
        inFlight: 0,
        tickIntervalMs,
        lastTick: {
          considered: 0,
          claimed: 0,
          forked: 0,
          skippedInFlight: 0,
          skippedNoCapacity: 0,
          failedInline: 0,
        },
      })

      const publishHealth = (
        summary: TickSummary,
        inFlight: number,
        observedAt: number,
      ): Effect.Effect<void> => {
        const lastTickAt = summary.tickAt
        const lastTickAgeMs = Math.max(0, observedAt - lastTickAt)
        const degraded = lastTickAgeMs > 3 * tickIntervalMs
        return Ref.set(healthRef, {
          status: degraded ? "degraded" : "ok",
          lastTickAt,
          lastTickAgeMs,
          inFlight,
          tickIntervalMs,
          lastTick: {
            considered: summary.considered,
            claimed: summary.claimed,
            forked: summary.forked,
            skippedInFlight: summary.skippedInFlight,
            skippedNoCapacity: summary.skippedNoCapacity,
            failedInline: summary.failedInline,
          },
        })
      }

      // Boot reconcile + quarantine (runs ONCE, before the loop forks) — see
      // job-ticker-reconcile.ts for the crash-safety rationale.
      yield* runBootReconcile(store, clock)

      // In-memory at-most-once guard for one-shot jobs. The durable disable
      // (setV2Fields enabled=false) can fail under a storage outage, which
      // would otherwise leave the row enabled+next_run_at NULL and re-fire it
      // every tick. We remember which one-shots THIS process already dispatched
      // and refuse to dispatch them again, even if the disable never lands.
      // Entries are removed the moment the disable durably succeeds, so the set
      // only ever holds one-shots whose disable is currently failing (≈always
      // empty). A process restart clears it — a one-shot that was never marked
      // done will then retry once, which is the correct at-least-once fallback.
      const dispatchedOneShots = new Set<string>()

      // job-ticker-producer-executor-276 (amendment 1) - the in-flight guard.
      // A keyed `FiberMap<jobId, void, never>` of executor fibers, NOT a
      // hand-rolled `Ref<Set<string>>` + `forkScoped` + `ensuring`: a
      // hand-rolled version has a real interrupt-gap - if the producer is
      // interrupted BETWEEN `Ref.update(add id)` and the fork actually
      // existing, no executor ever runs the `ensuring` that removes the id,
      // so the jobId leaks forever and the recurring job is permanently
      // (wrongly) treated as in-flight. `FiberMap.run(map, jobId, executor,
      // {onlyIfMissing:true})` records-and-forks ATOMICALLY (closing that
      // gap) and auto-removes the entry when the fiber completes - success,
      // failure, OR interruption - with no manual `ensuring` needed.
      // `onlyIfMissing` is a second uniqueness backstop on top of the
      // producer's own `FiberMap.has` pre-check (job-ticker-producer.ts).
      // `E=never` (not the
      // default `unknown`) is DELIBERATE: `FiberMap.awaitEmpty` on a map with
      // E=never returns `Effect<void, never>` = `Effect<void>`, matching
      // `awaitIdle`'s declared type exactly (a map with the default E would
      // make `awaitIdle` return `Effect<void, unknown>`, failing `tsc`). It
      // also means `FiberMap.run` only accepts an executor typed
      // `Effect<void, never, R>` - enforcing the SAME "every store call is
      // caught to a benign fallback" discipline the old `handleJob` kept via
      // its own `Effect.Effect<PerJobOutcome>` (E=never) return type.
      // `FiberMap.make` is created here, inside the layer's Scope (the same
      // Scope `Effect.forkScoped` below uses), so `Layer.close()` at teardown
      // interrupts every live executor fiber - the same lifetime guarantee
      // the pre-split code got from forking into the ticker's own Scope.
      const executors = yield* FiberMap.make<string, void, never>()

      // job-ticker-producer-executor-276 (amendment 3) - producer
      // serialization. The pre-split "single producer fiber" assumption was
      // never actually enforced: `drain` is a PUBLIC API and the auto-tick
      // loop forks its own tick, so a manual `drain` call racing the auto
      // loop could corrupt the `dispatchedOneShots` set or the slot
      // snapshot (a one-shot's `next_run_at` stays null forever, so its
      // claim CAS only ever checks the last-read `last_run` - two producer
      // invocations reading concurrently could both see it unclaimed).
      // Wrapping the producer body in a permit-1 semaphore serializes every
      // entry (auto loop AND explicit `drain` calls) so only one producer
      // invocation ever runs at a time. The executor dispatch itself runs on
      // the FORKED fiber, not in the critical section: `FiberMap.run` returns
      // as soon as the fiber exists, and the executor's first op is
      // `Effect.yieldNow()` so its body does not run synchronously inside the
      // fork. The critical section is therefore the fast producer loop (claim
      // / guard / claimAndStartRun writes), not any worker dispatch - see the
      // fork site's "honest scope" comment for the one residual (a synchronous
      // CPU-bound worker, which Luna has none of).
      const producerSemaphore = yield* Effect.makeSemaphore(1)

      // job-ticker-producer-executor-276 - the EXECUTOR (job-ticker-executor.ts):
      // the forked tail of a real dispatch. See that file for the full doc.
      const executor = makeExecutor({
        store,
        registry,
        clock,
        workerDeadlineMs,
        graceMs,
        maxWorkerDeadlineMs,
        retryBackoff,
        defaultMaxAttempts,
        doctorCfg,
      })

      // job-ticker-producer-executor-276 - the PRODUCER (job-ticker-producer.ts):
      // one tick of listDue -> claim/guard/dispatch. See that file for the full doc.
      const drainOnce: Effect.Effect<TickSummary> = makeDrainOnce({
        store,
        registry,
        clock,
        dispatchConcurrency,
        executors,
        dispatchedOneShots,
        producerSemaphore,
        retentionSweepIntervalMs,
        retentionMaxAgeMs,
        lastPruneAt,
        publishHealth,
        executor,
      })

      // issue #276 - `awaitIdle` resolves once every currently in-flight
      // executor completes. `FiberMap.awaitEmpty` on a map with E=never
      // returns `Effect<void, never>` = `Effect<void>`, matching the public
      // `awaitIdle` type exactly (see the `executors` doc above for why
      // E=never was chosen at construction).
      const awaitIdle: Effect.Effect<void> = FiberMap.awaitEmpty(executors)

      // A1b graceful drain: run BEFORE FiberMap's Scope interrupt finalizer
      // (finalizers are LIFO; we register after FiberMap.make so we run first).
      // Gives in-flight executors up to shutdownDrainMs to finish so a clean
      // SIGTERM does not orphan every mid-flight run. Timeout → proceed;
      // remaining fibers are interrupted by FiberMap teardown; next boot's
      // reconcileAfterCrash repairs sticky state.
      // Only when autoStart is on (production). Test stacks use autoStart:false
      // and often dispose mid-flight on purpose — a 90s drain would hang them.
      if (shutdownDrainMs > 0 && options?.autoStart !== false) {
        yield* Effect.addFinalizer(() =>
          awaitIdle.pipe(
            Effect.timeout(Duration.millis(shutdownDrainMs)),
            Effect.matchEffect({
              onFailure: () =>
                Effect.logWarning(
                  `[luna/sched] shutdown drain timed out after ${shutdownDrainMs}ms; remaining executors will be interrupted`,
                ),
              onSuccess: () =>
                Effect.logInfo(`[luna/sched] shutdown drain complete (awaitIdle)`),
            }),
            Effect.asVoid,
          ),
        )
      }

      // Supervised loop. forkScoped ties the loop to the layer Scope so a
      // Layer.close() during teardown interrupts the loop cleanly - AND
      // (issue #276) every in-flight executor fiber, since `executors` was
      // created in this same Scope. Skipped when autoStart=false (tests
      // drive `drain` directly without a background fiber racing the
      // explicit drain on the shared store).
      const supervisedLoop = Effect.gen(function* () {
        const summary = yield* drainOnce.pipe(
          Effect.catchAllDefect((defect) =>
            Effect.gen(function* () {
              yield* Effect.logError(
                `[luna/sched] tick defect (swallowed to keep the loop alive): ${String(defect)}`,
              )
              const empty = {
                tickAt: yield* EffectClock.currentTimeMillis,
                considered: 0,
                claimed: 0,
                forked: 0,
                skippedInFlight: 0,
                skippedNoCapacity: 0,
                skippedUnknownKind: 0,
                skippedClaimLost: 0,
                skippedV1Cron: 0,
                failedInline: 0,
                pruned: 0,
              } satisfies TickSummary
              // Still advance lastTickAt so a one-off defect does not look
              // like a dead loop; repeated defects still leave a fresh stamp.
              const inFlightNow = yield* FiberMap.size(executors)
              yield* publishHealth(empty, inFlightNow, empty.tickAt)
              return empty
            }),
          ),
        )
        if (
          summary.considered > 0 ||
          summary.failedInline > 0 ||
          summary.skippedUnknownKind > 0 ||
          summary.skippedV1Cron > 0 ||
          summary.skippedNoCapacity > 0 ||
          summary.pruned > 0
        ) {
          yield* Effect.logInfo(
            `[luna/sched] tick considered=${summary.considered} claimed=${summary.claimed} forked=${summary.forked} skipped_in_flight=${summary.skippedInFlight} skipped_no_capacity=${summary.skippedNoCapacity} skipped_unknown=${summary.skippedUnknownKind} skipped_claim_lost=${summary.skippedClaimLost} skipped_v1_cron=${summary.skippedV1Cron} failed_inline=${summary.failedInline} pruned=${summary.pruned}`,
          )
        }
      })

      if (options?.autoStart !== false) {
        yield* supervisedLoop.pipe(
          Effect.repeat(Schedule.fixed(tickInterval)),
          Effect.forkScoped,
        )
      }

      return {
        drain: drainOnce,
        awaitIdle,
        health: Effect.gen(function* () {
          const snap = yield* Ref.get(healthRef)
          // Refresh lastTickAgeMs on read so /readyz does not need a tick to
          // age the snapshot (stale lastTickAge from publish time would lag).
          if (snap.lastTickAt === null) return snap
          const now = yield* clock.nowMs()
          const lastTickAgeMs = Math.max(0, now - snap.lastTickAt)
          const degraded = lastTickAgeMs > 3 * tickIntervalMs
          return {
            ...snap,
            lastTickAgeMs,
            status: degraded ? ("degraded" as const) : ("ok" as const),
          }
        }),
      } satisfies JobTickerApi
    }),
  )
}
