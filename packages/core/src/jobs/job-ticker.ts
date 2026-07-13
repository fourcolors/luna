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
 * forked, never once it has fully run. See `executors` (the in-flight guard),
 * `producerSemaphore` (serialization), and `executor` (the forked tail)
 * below for the three pieces that make that split safe.
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
import { Cron, Duration, Effect, Either, FiberMap, Layer, Ref, Schedule } from "effect"
import * as EffectClock from "effect/Clock"
import { Clock } from "../clock.js"
import { JobsStoreService } from "./jobs-store.js"
import type { JobRun, JobRunTerminalStatus, PersistedJob } from "./jobs-store-types.js"
import { WorkerRegistry, WorkerError } from "./worker-registry.js"
import type { WorkerEntry } from "./worker-registry.js"

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
}

/**
 * job-ticker-oban-deadlines (Seam 3). `WorkerError` reasons that represent a
 * plausibly-transient failure (a wedged worker, an SDK hiccup, an unexpected
 * defect) — these are the ONLY reasons that earn a retry. `bad_payload` and
 * `unknown_kind` are DETERMINISTIC: the exact same dispatch will fail the
 * exact same way every time, so retrying them on a tight backoff only burns
 * cycles and turns a once-per-cron-period failure into a hot-loop. They fall
 * back to the job's natural cron cadence instead (unretried).
 */
const RETRYABLE_WORKER_ERROR_REASONS: ReadonlySet<string> = new Set([
  "deadline_passed",
  "worker_failed",
  "defect",
])

/**
 * job-ticker-oban-deadlines (Seam 3). Resolve the max-attempts ceiling for
 * one dispatch: `payload.max_attempts` when it is a finite, truncates-to-a-
 * positive-integer value (clamped to the Oban-inspired upper bound of 10),
 * else the ticker's `defaultMaxAttempts` (default 3). A non-numeric,
 * non-finite, zero, or negative payload value falls through cleanly to the
 * default rather than disabling retries outright.
 */
const MAX_ATTEMPTS_CEILING = 10
const resolveMaxAttempts = (
  payload: unknown,
  defaultMaxAttempts: number,
): number => {
  if (payload !== null && typeof payload === "object") {
    const raw = (payload as Record<string, unknown>)["max_attempts"]
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const n = Math.trunc(raw)
      if (n >= 1) return Math.min(n, MAX_ATTEMPTS_CEILING)
    }
  }
  return defaultMaxAttempts
}

/**
 * job-ticker-oban-deadlines (Seam 1). Extract a payload-level `timeout_ms`
 * override — the highest-priority source in the per-dispatch timeout
 * resolution (ahead of a worker's registered `defaultTimeoutMs` and the
 * ticker's `workerDeadline` fallback). Mirrors the same defensive-parse
 * pattern prompt-worker.ts and workflow-worker.ts already use for this exact
 * field: only a finite, positive number counts; garbage (NaN, negative,
 * string, missing) falls through cleanly to the next source.
 */
const extractPayloadTimeoutMs = (payload: unknown): number | undefined => {
  if (payload === null || typeof payload !== "object") return undefined
  const raw = (payload as Record<string, unknown>)["timeout_ms"]
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return undefined
  }
  return raw
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Compute the next fire time for a `jobs` row from its `schedule` field.
 * Falls back to the legacy `spec` column when `schedule` is null (legacy
 * rows). Returns null when neither parse succeeds — the ticker will leave
 * `next_run_at` alone in that case (and the row stays due forever, which is
 * the right pain signal — operators will see it spinning in logs).
 */
const computeNextRunAt = (
  job: PersistedJob,
  fromMs: number,
): number | null => {
  const expr = job.schedule ?? job.spec
  if (!expr) return null
  // Pin matching to UTC (not the host's TZ). Without the explicit "UTC" arg,
  // Effect's Cron interprets the expression in `process.env.TZ`, so the same
  // schedule would fire at a different wall-clock time depending on where the
  // server runs. UTC keeps install-time and runtime computations identical.
  const parsed = Cron.parse(expr, "UTC")
  if (Either.isLeft(parsed)) return null
  try {
    const nextDate = Cron.next(parsed.right, new Date(fromMs))
    return nextDate.getTime()
  } catch {
    return null
  }
}

/**
 * job-ticker-oban-deadlines (Seam 3) — default retry backoff, mirroring the
 * doubling-capped pattern already used by `packages/vault/src/op-sync.ts`'s
 * `nextDelayMsPure`. `attempt` is the 1-indexed retry counter (the value
 * `retry_attempt` is bumped TO for this failure). Base 1 min, doubling per
 * attempt, capped at 30 min so a chronically-failing recurring job (e.g. a
 * mis-configured dream backlog) settles into a steady nagging cadence
 * instead of either hot-looping the ticker or going silent for hours.
 */
const RETRY_BACKOFF_BASE_MS = 60_000
const RETRY_BACKOFF_CAP_MS = 30 * 60_000
const defaultRetryBackoffMs = (attempt: number): number => {
  const n = Math.max(1, Math.floor(attempt) || 1)
  return Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * Math.pow(2, n - 1))
}

/**
 * job-ticker-oban-deadlines (Seam 1) — the lower clamp bound applied to a
 * per-dispatch timeout resolved from `payload.timeout_ms` or a worker's
 * `defaultTimeoutMs` (NOT the back-compat `workerDeadline` fallback path,
 * which is intentionally left unclamped — see the module header). Without
 * this floor a misconfigured payload (`timeout_ms: 5`) or worker
 * registration could hand the ticker a sub-second backstop.
 */
const MIN_RESOLVED_TIMEOUT_MS = 1_000

const terminalStatusFrom = (
  result: { _tag: "Right"; right: unknown } | { _tag: "Left"; left: unknown },
): JobRunTerminalStatus =>
  result._tag === "Right" ? "success" : "failed"

// ── Layer ───────────────────────────────────────────────────────────────────

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

      // Boot reconcile (runs ONCE, before the loop forks): a hard crash
      // between recordRunStart and recordRunEnd leaves job_runs rows stuck
      // `running`/`waiting` forever, and a claim may leave sticky
      // last_status='running' with a far-future next_run_at. Close open runs
      // as cancelled and repair job rows (clear sticky status; pull-forward
      // next_run_at for enabled recurring jobs that had a running orphan).
      // Best-effort - a failure logs and boot continues.
      const bootNow = yield* clock.nowMs()
      const reconcile = yield* store
        .reconcileAfterCrash({ finishedAt: bootNow })
        .pipe(
          Effect.catchAll((err) =>
            Effect.as(
              Effect.logWarning(
                `[luna/sched] boot orphan reconcile failed: ${err.message}`,
              ),
              {
                orphansClosed: 0,
                waitingClosed: 0,
                jobsRepaired: 0,
                jobIdsRepaired: [] as ReadonlyArray<string>,
              },
            ),
          ),
        )
      if (
        reconcile.orphansClosed > 0 ||
        reconcile.waitingClosed > 0 ||
        reconcile.jobsRepaired > 0
      ) {
        yield* Effect.logInfo(
          `[luna/sched] boot reconcile: closed ${reconcile.orphansClosed} orphaned run(s) (${reconcile.waitingClosed} waiting); repaired ${reconcile.jobsRepaired} job(s)`,
        )
      }

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
      // producer's own `FiberMap.has` pre-check below. `E=never` (not the
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

      /**
       * job-ticker-producer-executor-276 - the EXECUTOR: the forked tail of
       * a real dispatch. Exactly the pre-split `handleJob`'s post-entry-check
       * body, lifted verbatim: resolve the per-dispatch timeout (Seam 1),
       * build `ctx`, `dispatch(...).pipe(timeoutFail, catchAllDefect,
       * either)`, close `job_runs` (Seam 3 retry/reset), `touch`, then
       * `postCommit` (issue #277). Typed `Effect.Effect<void>` (E=never) to
       * satisfy `FiberMap<string, void, never>` above - every store call
       * stays wrapped in `Effect.catchAll`/`Effect.catchAllDefect` for
       * exactly the reason the old `handleJob` doc gave: an escaped typed
       * failure here would only kill THIS fiber (FiberMap doesn't cascade
       * fiber failures between entries), but an escaped DEFECT would still
       * need catching so the fiber closes cleanly and frees its FiberMap
       * slot rather than dying in a way that could surface as a Layer-level
       * defect. The executor needs NO manual `ensuring` to free its slot -
       * `FiberMap` auto-removes the jobId entry when the fiber completes,
       * which is what lifts the in-flight guard for the NEXT tick.
       */
      const executor = (
        job: PersistedJob,
        run: JobRun,
        entry: WorkerEntry<never>,
        isOneShot: boolean,
        nextRunAt: number | null,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const attemptNumber = run.attempt

          // Seam 1 — per-dispatch timeout resolution, highest priority first:
          //   1. payload.timeout_ms (a finite positive number) — the
          //      documented cross-kind payload convention prompt/workflow
          //      workers already honour internally.
          //   2. the worker's registered `defaultTimeoutMs`.
          //   3. the ticker's `workerDeadline` fallback (back-compat path —
          //      a bare-function registration with NO payload override gets
          //      `workerDeadlineMs` exactly as before this seam: no floor
          //      clamp, no grace added, so existing behaviour/tests are
          //      unaffected).
          // Sources 1 and 2 are clamped to >= MIN_RESOLVED_TIMEOUT_MS (1s)
          // before `grace` is added, then the whole backstop is capped at
          // `maxWorkerDeadlineMs` — this is what stops a payload override
          // from smuggling in either a sub-second backstop or an unbounded
          // one, and (for source 1) is what fixes the two-layer inversion
          // where a payload widened a worker's OWN inner timeout past the
          // worker's registered default but the ticker's outer backstop
          // still fired first at the (narrower) default.
          const payloadTimeoutMs = extractPayloadTimeoutMs(job.payload)
          const resolvedKindTimeoutMs = payloadTimeoutMs ?? entry.defaultTimeoutMs
          // `effectiveMs` is the grace-EXCLUSIVE clamped timeout (spec line 31:
          // "sets ctx.deadline = dispatchAt + effective") — the value a
          // well-behaved worker should treat as ITS deadline, so that a clean
          // between-chunk stop gate (e.g. the dream worker) fires with the
          // full `graceMs` still in hand before the ticker's hard backstop
          // below. `backstopMs` is the grace-INCLUSIVE outer kill used only by
          // `Effect.timeoutFail`. Both share the same `maxWorkerDeadlineMs` cap
          // so `effectiveMs <= backstopMs` always holds (min is monotonic in
          // its first argument), even when `resolvedKindTimeoutMs` itself
          // exceeds the cap.
          const effectiveMs =
            resolvedKindTimeoutMs !== undefined
              ? Math.min(
                  Math.max(resolvedKindTimeoutMs, MIN_RESOLVED_TIMEOUT_MS),
                  maxWorkerDeadlineMs,
                )
              : workerDeadlineMs
          const backstopMs =
            resolvedKindTimeoutMs !== undefined
              ? Math.min(
                  Math.max(resolvedKindTimeoutMs, MIN_RESOLVED_TIMEOUT_MS) + graceMs,
                  maxWorkerDeadlineMs,
                )
              : workerDeadlineMs

          // Dispatch the worker. Errors caught into Either so the ticker keeps
          // draining; the result is closed into job_runs regardless of outcome.
          // ctx.deadline is computed from a fresh clock read (NOT tickAt) so it
          // matches the relative `timeoutFail(backstopMs)` below. It is set to
          // `effectiveMs` (grace-EXCLUSIVE), NOT `backstopMs`, so a worker that
          // consults it (e.g. the dream worker's clean between-chunk stop gate)
          // still has the full grace window before the ticker's hard kill.
          const dispatchAt = yield* clock.nowMs()
          const ctx = {
            jobId: job.id,
            runId: run.id,
            attempt: attemptNumber,
            deadline: dispatchAt + effectiveMs,
          }
          const result = yield* registry
            .dispatch(job.kind, job.payload, ctx)
            .pipe(
              // ENFORCE the deadline: a worker that overruns is interrupted
              // rather than left to block the ticker indefinitely (the old
              // behaviour — the deadline was advisory only). The timeout
              // surfaces as a deadline_passed WorkerError and is closed into
              // job_runs like any other failure.
              Effect.timeoutFail({
                onTimeout: () =>
                  new WorkerError({
                    reason: "deadline_passed",
                    kind: job.kind,
                    message: `worker for kind "${job.kind}" exceeded the ${backstopMs}ms deadline and was interrupted`,
                  }),
                duration: Duration.millis(backstopMs),
              }),
              // Convert an uncaught worker DEFECT (a synchronous throw /
              // Effect.die — e.g. JSON.parse on a malformed payload) into a
              // typed failure. Otherwise it escapes this executor fiber as a
              // defect - FiberMap doesn't cascade a sibling's defect to other
              // entries, but an uncaught defect here would still skip every
              // durable write below (recordRunEnd, retry scheduling, touch),
              // leaving the run stuck 'running' until boot reconcile. `Effect
              // .either` only traps the typed E channel, not defects - this
              // MUST run before it.
              Effect.catchAllDefect((defect) =>
                Effect.fail(
                  new WorkerError({
                    reason: "defect",
                    kind: job.kind,
                    message: `worker for kind "${job.kind}" raised an unexpected defect: ${String(defect)}`,
                  }),
                ),
              ),
              Effect.either,
            )

          const finishedAt = yield* clock.nowMs()
          if (result._tag === "Right") {
            yield* store.recordRunEnd(run.id, {
              finishedAt,
              status: "success",
              outputText: result.right.outputText,
              stepsJson: result.right.stepsJson ?? null,
            }).pipe(Effect.catchAll(() => Effect.void))
            // Seam 3 — clear a stale retry streak on recovery. Only issue the
            // write when there is something to clear: retry_attempt is
            // already 0 for the overwhelming majority of ticks (no prior
            // failure), and an unconditional reset would be a redundant
            // UPDATE on every successful dispatch of every recurring job.
            if (job.retryAttempt !== 0) {
              yield* store
                .setV2Fields(job.id, { retryAttempt: 0 })
                .pipe(Effect.catchAll(() => Effect.void))
            }
          } else {
            const err = result.left as WorkerError
            yield* store.recordRunEnd(run.id, {
              finishedAt,
              status: "failed",
              error: `${err.reason}: ${err.message}`,
              // Workers may pass partial output through WorkerError.stepsJson
              // (e.g. workflow worker on halt) — persist it so the operator
              // can see which step failed without rerunning.
              stepsJson: err.stepsJson ?? null,
            }).pipe(Effect.catchAll(() => Effect.void))
            // Seam 3 — retry a RECURRING job sooner than its natural next
            // cron fire. Gated on THREE explicit conditions, ALL required:
            //   1. err.reason is RETRYABLE (deadline_passed/worker_failed/
            //      defect) — bad_payload/unknown_kind are deterministic, the
            //      identical dispatch will fail the identical way every time,
            //      so retrying them on a tight backoff only hot-loops the
            //      ticker; they fall back to the natural cron cadence instead.
            //   2. NOT a one-shot: a one-shot's FIRST dispatch falls through
            //      to this same dispatch path (it must — that's how it runs
            //      at all), so `isOneShot` (computed by the producer and
            //      passed in - see the executor's parameters) alone is what
            //      excludes it here.
            //   3. `nextRunAt !== null` excludes a quarantined/unschedulable
            //      cron (the producer's guard path already handled that case
            //      and never forks an executor for it, but the check is kept
            //      as a type-safe belt-and-suspenders against future
            //      control-flow changes).
            // AND bounded by `maxAttempts` (payload.max_attempts clamped to
            // [1,10], else `defaultMaxAttempts`) — once the just-failed
            // dispatch's attempt number reaches the ceiling, retrying stops
            // (exhaustion) instead of continuing forever on the backoff
            // cadence.
            const isRetryableReason = RETRYABLE_WORKER_ERROR_REASONS.has(err.reason)
            let retryScheduled = false
            if (isRetryableReason && !isOneShot && nextRunAt !== null) {
              const maxAttempts = resolveMaxAttempts(job.payload, defaultMaxAttempts)
              const newAttempt = job.retryAttempt + 1
              if (newAttempt < maxAttempts) {
                const retryAt =
                  finishedAt + Duration.toMillis(retryBackoff(newAttempt))
                const patch: { retryAttempt: number; nextRunAt?: number } = {
                  retryAttempt: newAttempt,
                }
                // Only pull next_run_at EARLIER than the natural cron fire —
                // claim() already wrote next_run_at=nextRunAt (the
                // cron-computed fire) above, so a retryAt landing AFTER it
                // would be a no-op UPDATE that could only ever push the row
                // LATER by mistake.
                if (retryAt < nextRunAt) patch.nextRunAt = retryAt
                yield* store
                  .setV2Fields(job.id, patch)
                  .pipe(Effect.catchAll(() => Effect.void))
                retryScheduled = true
              }
            }
            // Non-retryable reason, exhausted attempts, one-shot, or an
            // unschedulable cron: no retry was scheduled. On EXHAUSTION in
            // particular this is the Oban-analogue "give up and fall back to
            // cron cadence" terminal — `next_run_at` is left exactly as
            // claim() computed it (the natural next cron fire), and
            // `retry_attempt` resets to 0 so the next natural fire starts a
            // fresh attempt count rather than inheriting a stale streak.
            if (!retryScheduled && job.retryAttempt !== 0) {
              yield* store
                .setV2Fields(job.id, { retryAttempt: 0 })
                .pipe(Effect.catchAll(() => Effect.void))
            }
          }
          // recordRunEnd closes the job_runs row but does NOT touch jobs.last_status,
          // which claim() set to 'running'. Reset it to the run's outcome so a
          // recurring schedule isn't shown as perpetually 'running' between fires.
          yield* store
            .touch(job.id, {
              lastStatus: result._tag === "Right" ? "fired" : "errored",
            })
            .pipe(Effect.catchAll(() => Effect.void))

          // issue #277 - postCommit (deferred delivery) runs LAST, strictly
          // AFTER every durable job-state write above (recordRunEnd, the
          // retry-reset/exhaustion setV2Fields, and touch). A slow or hung
          // delivery must never delay the writes that make the run's
          // terminal status visible - those are what a retry/observer relies
          // on. Bounded with an INDEPENDENT timeout (not the dispatch
          // backstop above, which has already fired/passed by now - delivery
          // legitimately runs after it) because the ticker cannot assume a
          // delivery sink is self-bounding (e.g. a chat-server WS post is
          // typed E=never but can still hang on a stuck connection). Both
          // catchAll (typed TimeoutException) and catchAllDefect (an
          // uncaught throw the worker failed to collapse) are best-effort:
          // logged, never retried, never affect job_runs/jobs state already
          // written above.
          //
          // ACCEPTED RESIDUAL: if the layer's Scope tears down between the
          // touch() above and postCommit completing, that one delivery is
          // lost - the run is already recorded success (or failed, with no
          // retry queued), so nothing re-fires it. This is deliberate: the
          // alternative (running postCommit BEFORE the durable writes, or
          // retrying it) reintroduces the double-delivery race #277 exists
          // to kill. At-most-once here beats at-least-once.
          if (result._tag === "Right" && result.right.postCommit) {
            yield* result.right.postCommit.pipe(
              Effect.timeout(Duration.seconds(30)),
              Effect.catchAll((err) =>
                Effect.logWarning(
                  `[luna/sched] postCommit failed for job=${job.id}: ${String(err)}`,
                ),
              ),
              Effect.catchAllDefect((defect) =>
                Effect.logWarning(
                  `[luna/sched] postCommit raised a defect for job=${job.id}: ${String(defect)}`,
                ),
              ),
            )
          }
        })

      /**
       * job-ticker-producer-executor-276 - the PRODUCER. One tick: read
       * `listDue`, then for each row either (a) a GUARD path - one-shot
       * re-encounter or quarantine - that plain-claims and returns
       * synchronously, no run row, no fork; (b) an UNKNOWN-KIND path that
       * claims + writes an inline failed `job_runs` row (there is no worker
       * to dispatch, so nothing to fork); or (c) a REAL DISPATCH that
       * atomically claims-and-starts the run (`claimAndStartRun`, amendment
       * 4) and forks the executor. Runs inside `producerSemaphore` so `drain`
       * and the auto-tick loop can never race each other's writes to
       * `dispatchedOneShots` or the slot snapshot (amendment 3). Idempotent
       * on the read side; every write is still guarded by an optimistic CAS
       * (`claim`/`claimAndStartRun`), same as before the split.
       */
      const drainOnce: Effect.Effect<TickSummary> = producerSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const tickAt = yield* clock.nowMs()
          const due = yield* store.listDue(tickAt).pipe(
            Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<PersistedJob>)),
          )

          // Backpressure (issue #276) - a START-OF-TICK snapshot of in-flight
          // executors. This is an UPPER bound on live concurrency: the
          // producer can UNDER-admit (a slot freed mid-tick by an executor
          // that finishes early isn't reused until next tick) but can NEVER
          // over-admit past `dispatchConcurrency`. Worst case under
          // saturation a due row waits one extra tick (~60s default) for a
          // slot - acceptable at Luna's scale (a handful of jobs at
          // concurrency 4; documented as a non-goal to optimize further, not
          // an oversight).
          const inFlight = yield* FiberMap.size(executors)
          let slots = Math.max(0, dispatchConcurrency - inFlight)

          let claimed = 0
          let forked = 0
          let skippedInFlight = 0
          let skippedNoCapacity = 0
          let skippedUnknownKind = 0
          let skippedClaimLost = 0
          let skippedV1Cron = 0
          let failedInline = 0

          for (const job of due) {
            // Legacy `kind="cron"` rows (from the removed V1 fiber-per-cron
            // path) have no worker - claiming one would write a spurious
            // unknown_kind failure every tick. Skip them structurally so any
            // stragglers left in an existing DB stay inert rather than
            // hot-looping.
            if (job.kind === "cron") {
              skippedV1Cron++
              continue
            }

            // Uniqueness (issue #276 amendment 1) - a dispatch that outlives
            // its cron period must not be re-claimed while its executor is
            // still running. This is the ONLY thing that restores the
            // uniqueness the pre-split await-all `drainOnce` got for free by
            // construction (the tick loop literally couldn't start a second
            // drain until the first one - including every dispatch -
            // returned).
            const alreadyInFlight = yield* FiberMap.has(executors, job.id)
            if (alreadyInFlight) {
              skippedInFlight++
              continue
            }

            // Pre-screen: do we have a worker for this kind? Uses
            // lookupEntry (not lookup) so `defaultTimeoutMs` is available
            // for the Seam-1 backstop the executor computes.
            const entry = yield* registry.lookupEntry(job.kind)
            const nextRunAt = computeNextRunAt(job, tickAt)
            // One-shot guard: a job with NO schedule expression at all (empty
            // `schedule` AND empty `spec`) is a fire-once job - `claim` sets
            // its `next_run_at` to null, and `listDue` returns null-next_run
            // rows, so without this it would re-fire EVERY tick forever (the
            // documented "stays due" trap).
            // `??` only falls through null/undefined, NOT "" - so check BOTH
            // fields explicitly: an empty-string `schedule` alongside a valid
            // `spec` must NOT be misread as a one-shot.
            const scheduleEmpty = (job.schedule ?? "").trim() === ""
            const specEmpty = (job.spec ?? "").trim() === ""
            const isOneShot = scheduleEmpty && specEmpty
            // Quarantine: the schedule/spec is NON-empty (not a one-shot) but
            // computeNextRunAt could not produce a next fire - the cron is
            // unparseable OR has no upcoming match (e.g. "0 0 30 2 *"). A job
            // with a NON-empty-but-unparseable cron is left alone otherwise
            // (the deliberate pain-signal for a misconfigured schedule).
            const quarantine = !isOneShot && nextRunAt === null
            const reEncounter = isOneShot && dispatchedOneShots.has(job.id)

            if (reEncounter) {
              // GUARD PATH - we already dispatched this one-shot but its
              // disable hasn't durably landed (storage outage). Retry the
              // disable and SKIP a second dispatch - the in-memory guard is
              // what actually bounds it to once-per-process; the durable
              // disable is just the cross-restart marker. Plain claim (no
              // run row, no fork): re-claiming just refreshes last_run so a
              // competing read doesn't see stale state.
              const won = yield* store.claim(job.id, {
                claimAt: tickAt,
                nextRunAt,
                previousLastRun: job.lastRun,
              }).pipe(Effect.catchAll(() => Effect.succeed(false)))
              if (!won) {
                skippedClaimLost++
                continue
              }
              const disabledNow = yield* store
                .setV2Fields(job.id, { enabled: false })
                .pipe(Effect.as(true), Effect.catchAll(() => Effect.succeed(false)))
              if (disabledNow) {
                dispatchedOneShots.delete(job.id)
              } else {
                yield* Effect.logWarning(
                  `[luna/sched] one-shot disable still failing for job=${job.id}; in-memory guard is suppressing re-dispatch`,
                )
              }
              // This one-shot already fired in a prior tick; the re-claim set
              // last_status='running' again. Reset it so it isn't stuck
              // 'running'.
              yield* store
                .touch(job.id, { lastStatus: "fired" })
                .pipe(Effect.catchAll(() => Effect.void))
              claimed++
              continue
            }

            if (quarantine) {
              // GUARD PATH - verbatim disable + log + touch from the
              // pre-split handleJob.
              const won = yield* store.claim(job.id, {
                claimAt: tickAt,
                nextRunAt,
                previousLastRun: job.lastRun,
              }).pipe(Effect.catchAll(() => Effect.succeed(false)))
              if (!won) {
                skippedClaimLost++
                continue
              }
              yield* store
                .setV2Fields(job.id, { enabled: false })
                .pipe(
                  Effect.retry(Schedule.recurs(2)),
                  Effect.catchAll((err) =>
                    Effect.logWarning(
                      `[luna/sched] quarantine of malformed-cron job=${job.id} failed: ${err.message} - it may re-fire next tick`,
                    ),
                  ),
                )
              yield* Effect.logWarning(
                `[luna/sched] job=${job.id} has an unschedulable cron (schedule=${JSON.stringify(
                  job.schedule,
                )} spec=${JSON.stringify(
                  job.spec,
                )}); disabled it to stop the every-tick re-fire`,
              )
              // claim() set last_status='running'; this row will NOT run, so
              // clear that marker - otherwise a UI/gallery reading
              // jobs.last_status shows a disabled, quarantined schedule as
              // perpetually 'running'.
              yield* store
                .touch(job.id, { lastStatus: "errored" })
                .pipe(Effect.catchAll(() => Effect.void))
              claimed++
              continue
            }

            if (!entry) {
              // UNKNOWN-KIND PATH - claim + write the run row SYNCHRONOUSLY
              // in the producer: there is no worker to dispatch, so there is
              // nothing to fork. A one-shot with no worker is ALSO disabled
              // here (critic amendment 1, sub-case a) - the disable is
              // orthogonal to worker presence, matching the pre-split
              // handleJob (its one-shot bookkeeping ran before the entry
              // check, unconditionally).
              const won = yield* store.claim(job.id, {
                claimAt: tickAt,
                nextRunAt,
                previousLastRun: job.lastRun,
              }).pipe(Effect.catchAll(() => Effect.succeed(false)))
              if (!won) {
                skippedClaimLost++
                continue
              }
              if (isOneShot) {
                dispatchedOneShots.add(job.id)
                const disabled = yield* store
                  .setV2Fields(job.id, { enabled: false })
                  .pipe(
                    Effect.retry(Schedule.recurs(2)),
                    Effect.as(true),
                    Effect.catchAll((err) =>
                      Effect.as(
                        Effect.logWarning(
                          `[luna/sched] one-shot disable failed for job=${job.id} after retries: ${err.message} - in-memory guard will prevent a re-fire this process`,
                        ),
                        false,
                      ),
                    ),
                  )
                if (disabled) dispatchedOneShots.delete(job.id)
              }
              const attemptNumber = job.retryAttempt + 1
              const run = yield* store.recordRunStart({
                jobId: job.id,
                startedAt: tickAt,
                attempt: attemptNumber,
              }).pipe(
                Effect.catchAll((err) =>
                  Effect.gen(function* () {
                    yield* Effect.logWarning(
                      `[luna/sched] recordRunStart failed for job=${job.id}: ${err.message}`,
                    )
                    return null
                  }),
                ),
              )
              if (!run) {
                // Claimed but no run row - don't leave it stuck 'running'.
                yield* store
                  .touch(job.id, { lastStatus: "errored" })
                  .pipe(Effect.catchAll(() => Effect.void))
                claimed++
                continue
              }
              const finishedAt = yield* clock.nowMs()
              yield* store.recordRunEnd(run.id, {
                finishedAt,
                status: "failed",
                error: `no worker registered for kind "${job.kind}"`,
              }).pipe(Effect.catchAll(() => Effect.void))
              yield* store
                .touch(job.id, { lastStatus: "errored" })
                .pipe(Effect.catchAll(() => Effect.void))
              claimed++
              failedInline++
              skippedUnknownKind++
              continue
            }

            // REAL DISPATCH - needs an admission slot (issue #276
            // backpressure). Checked BEFORE claiming so a saturated tick
            // leaves the row due and UNCLAIMED (critic amendment 1, sub-case
            // b) - it is retried next tick, not silently dropped or
            // wrongly disabled.
            if (slots <= 0) {
              skippedNoCapacity++
              continue
            }
            slots--

            const attemptNumber = job.retryAttempt + 1
            // Amendment 4 - claim + run-start as ONE transaction, closing the
            // orphan-run-with-no-ledger-row window a separate claim() +
            // recordRunStart() would reopen now that dispatch is forked (see
            // the module header and jobs-store-types.ts's doc on this
            // method).
            const started = yield* store.claimAndStartRun(job.id, {
              claimAt: tickAt,
              nextRunAt,
              previousLastRun: job.lastRun,
              startedAt: tickAt,
              attempt: attemptNumber,
            }).pipe(
              Effect.catchAll((err) =>
                Effect.gen(function* () {
                  yield* Effect.logWarning(
                    `[luna/sched] claimAndStartRun failed for job=${job.id}: ${err.message}`,
                  )
                  return null
                }),
              ),
            )
            if (!started) {
              skippedClaimLost++
              continue
            }

            // issue #276 post-build audit (codex, gpt-5.5) fixes:
            //
            // (fix 2 - bound synchronous worker execution) `FiberMap.run` ->
            // `runFork` STARTS the forked fiber SYNCHRONOUSLY, so without a
            // yield the executor's body would begin running inside the
            // `FiberMap.run` call itself - and a worker's synchronous prefix
            // would run to completion right here, inside the producer's
            // permit-held `drainOnce`, extending the tick by that worker's sync
            // duration. `Effect.yieldNow()` as the fiber's first op prevents
            // that: the fork returns to the producer before any executor body
            // runs.
            //
            // What this does NOT guarantee (honest scope - codex post-build
            // audit): the producer's `withPermits(1)` holds the permit until
            // ALL of `drainOnce` returns, and the producer keeps running after
            // this fork. At a downstream suspend point (the one-shot
            // `setV2Fields` below, or Effect's ~2048-op fairness yield) the
            // scheduler MAY run this forked executor's body while the permit is
            // still held. For every worker Luna actually has (prompt / dream /
            // workflow / wake - all async) this is immaterial: the executor
            // yields at its FIRST async op (the SDK/subprocess dispatch)
            // microseconds in, so it never extends `drainOnce` and the next
            // tick fires on schedule.
            //
            // ACCEPTED RESIDUAL: a purely SYNCHRONOUS CPU-bound worker could
            // run during such a producer suspension while the permit is held.
            // Luna has no such worker, and one would monopolize the single JS
            // event loop for its whole duration regardless of any semaphore
            // (freezing the tick loop AND every other executor) - so releasing
            // the permit at the fork point would not mitigate it. Documented,
            // not engineered around; if a sync CPU worker is ever added, it must
            // itself yield cooperatively, which no permit restructuring can
            // substitute for.
            //
            // (fix 4 - one-shot drop window) FORK FIRST, disable AFTER. Durably
            // disabling a one-shot before the fork means an interrupt in that gap
            // leaves it disabled-but-never-dispatched = permanently lost. Forking
            // first guarantees the executor is registered/scheduled; if teardown
            // then interrupts before the disable lands, the row simply re-fires
            // once on the next process start - the documented at-least-once
            // one-shot fallback (see the `dispatchedOneShots` doc) - never a
            // silent drop. The `FiberMap.has` in-flight guard + `dispatchedOneShots`
            // still prevent any double-fire; the producer runs single-threaded
            // inside the permit, so no other tick observes the brief window
            // between the fork and the disable.
            yield* FiberMap.run(
              executors,
              job.id,
              Effect.yieldNow().pipe(
                Effect.zipRight(
                  executor(job, started.run, entry, isOneShot, nextRunAt),
                ),
              ),
              { onlyIfMissing: true },
            )
            claimed++
            forked++

            if (isOneShot) {
              // One-shot at-most-once bookkeeping, now AFTER the fork (fix 4
              // above): mark in-memory + durably disable so listDue stops
              // returning it. `dispatchedOneShots` covers the window between the
              // executor self-removing from the FiberMap and this durable disable
              // landing (a storage outage); the `if (disabled) delete` clears the
              // in-memory marker once the durable disable is confirmed.
              dispatchedOneShots.add(job.id)
              const disabled = yield* store
                .setV2Fields(job.id, { enabled: false })
                .pipe(
                  Effect.retry(Schedule.recurs(2)),
                  Effect.as(true),
                  Effect.catchAll((err) =>
                    Effect.as(
                      Effect.logWarning(
                        `[luna/sched] one-shot disable failed for job=${job.id} after retries: ${err.message} - in-memory guard will prevent a re-fire this process`,
                      ),
                      false,
                    ),
                  ),
                )
              if (disabled) dispatchedOneShots.delete(job.id)
            }
          }

          if (skippedNoCapacity > 0) {
            yield* Effect.logWarning(
              `[luna/sched] tick saturated: ${skippedNoCapacity} due job(s) left unclaimed (all ${dispatchConcurrency} executor slot(s) in flight) - retried next tick`,
            )
          }

          // Retention sweep (throttled): prune closed runs older than the
          // retention window. On failure we log and DO NOT advance
          // lastPruneAt, so the next drain retries instead of skipping a
          // full sweep interval.
          let pruned = 0
          const lastPrune = yield* Ref.get(lastPruneAt)
          if (tickAt - lastPrune >= retentionSweepIntervalMs) {
            const pruneResult = yield* store
              .pruneRuns(tickAt - retentionMaxAgeMs)
              .pipe(Effect.either)
            if (pruneResult._tag === "Right") {
              pruned = pruneResult.right
              yield* Ref.set(lastPruneAt, tickAt)
            } else {
              yield* Effect.logWarning(
                `[luna/sched] retention prune failed: ${pruneResult.left.message} - will retry next tick`,
              )
            }
          }

          const summary = {
            tickAt,
            considered: due.length,
            claimed,
            forked,
            skippedInFlight,
            skippedNoCapacity,
            skippedUnknownKind,
            skippedClaimLost,
            skippedV1Cron,
            failedInline,
            pruned,
          } satisfies TickSummary
          // Publish health after every drain (including quiet considered=0 ticks)
          // so /readyz can detect a hung producer via lastTickAge.
          const inFlightNow = yield* FiberMap.size(executors)
          const observedAt = yield* clock.nowMs()
          yield* publishHealth(summary, inFlightNow, observedAt)
          return summary
        }),
      )

      // issue #276 - `awaitIdle` resolves once every currently in-flight
      // executor completes. `FiberMap.awaitEmpty` on a map with E=never
      // returns `Effect<void, never>` = `Effect<void>`, matching the public
      // `awaitIdle` type exactly (see the `executors` doc above for why
      // E=never was chosen at construction).
      const awaitIdle: Effect.Effect<void> = FiberMap.awaitEmpty(executors)

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
