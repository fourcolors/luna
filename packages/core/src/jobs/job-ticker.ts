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
 * Why a single fiber and not per-row? Per-row would explode fiber count on a
 * thousand-row jobs table and re-create the per-trigger cost we're replacing.
 * Within a tick, due jobs are dispatched with BOUNDED concurrency
 * (`dispatchConcurrency`, default 4) via `Effect.forEach(..., {concurrency}
 * )`; each worker dispatch is bounded by a per-dispatch backstop deadline
 * (Effect.timeoutFail) so a stuck worker is interrupted rather than blocking
 * the tick indefinitely.
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
import { Cron, Duration, Effect, Either, Layer, Ref, Schedule } from "effect"
import * as EffectClock from "effect/Clock"
import { Clock } from "../clock.js"
import { JobsStoreService } from "./jobs-store.js"
import type { JobRunTerminalStatus, PersistedJob } from "./jobs-store-types.js"
import { WorkerRegistry, WorkerError } from "./worker-registry.js"

// ── Public API ──────────────────────────────────────────────────────────────

export interface JobTickerApi {
  /**
   * Drain one tick worth of due jobs. Useful for test drivers that want to
   * advance time + force a drain without sleeping the real Clock. The
   * supervised loop calls this on each Schedule.fixed boundary in production.
   *
   * Returns a summary of what happened on this tick (for logs + tests).
   */
  readonly drain: Effect.Effect<TickSummary>
}

export interface TickSummary {
  readonly tickAt: number
  readonly considered: number
  readonly claimed: number
  readonly succeeded: number
  readonly failed: number
  readonly skippedUnknownKind: number
  readonly skippedClaimLost: number
  /** Legacy `kind="cron"` rows (from the removed V1 path) skipped — there is no
   *  "cron" worker, so they are never claimed or dispatched here. */
  readonly skippedV1Cron: number
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
   * job-ticker-oban-deadlines (Seam 4). How many due jobs to dispatch
   * concurrently within a single tick, via
   * `Effect.forEach(due, handleJob, {concurrency})`. Bounded (not
   * per-row-unbounded) so a large due batch cannot explode fiber count the
   * way the removed V1 per-trigger-fiber model did. Default 4.
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
   * (see `handleJob`); once that number reaches `maxAttempts` the failure is
   * NOT retried — `retry_attempt` resets to 0 and the job falls back to its
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

      // Boot reconcile (runs ONCE, before the loop forks): a hard crash
      // between recordRunStart and recordRunEnd leaves job_runs rows stuck
      // `running`/`waiting` forever. Close them as cancelled so listRuns and
      // the suggested-actions completion observer don't see phantom in-flight
      // work. Best-effort — a failure logs and boot continues.
      const bootNow = yield* clock.nowMs()
      const orphansClosed = yield* store
        .closeOrphanedRuns({
          finishedAt: bootNow,
          error: "orphaned: process restarted before completion",
        })
        .pipe(
          Effect.catchAll((err) =>
            Effect.as(
              Effect.logWarning(
                `[luna/sched] boot orphan reconcile failed: ${err.message}`,
              ),
              0,
            ),
          ),
        )
      if (orphansClosed > 0) {
        yield* Effect.logInfo(
          `[luna/sched] boot reconcile: closed ${orphansClosed} orphaned run(s)`,
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

      /**
       * job-ticker-oban-deadlines (Seam 4) — per-job outcome delta, summed
       * across a tick's `Effect.forEach` to build the `TickSummary` counters.
       * `handleJob` below is typed `Effect.Effect<PerJobOutcome>` — E=never —
       * DELIBERATELY: `Effect.forEach` with `{concurrency}` is fail-fast, so
       * if ANY per-job store write escaped as a typed failure it would
       * interrupt every OTHER in-flight sibling dispatch this tick, dropping
       * their job_runs closes and leaving orphaned 'running' rows (only
       * reaped at next boot). Every store call inside `handleJob` is wrapped
       * in `Effect.catchAll` to a benign fallback for exactly this reason —
       * matching the original sequential loop's per-item error isolation.
       */
      interface PerJobOutcome {
        readonly claimed: number
        readonly succeeded: number
        readonly failed: number
        readonly skippedUnknownKind: number
        readonly skippedClaimLost: number
        readonly skippedV1Cron: number
      }
      const ZERO_OUTCOME: PerJobOutcome = {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        skippedUnknownKind: 0,
        skippedClaimLost: 0,
        skippedV1Cron: 0,
      }
      const outcome = (patch: Partial<PerJobOutcome>): PerJobOutcome => ({
        ...ZERO_OUTCOME,
        ...patch,
      })

      /**
       * Handle exactly one due row: claim → (one-shot/quarantine guard) →
       * recordRunStart → dispatch → recordRunEnd → retry-or-reset (Seam 3) →
       * touch. Never fails (see the PerJobOutcome doc above) so it is safe to
       * run under `Effect.forEach(..., {concurrency: dispatchConcurrency})`.
       */
      const handleJob = (
        job: PersistedJob,
        tickAt: number,
      ): Effect.Effect<PerJobOutcome> =>
        Effect.gen(function* () {
          // Legacy `kind="cron"` rows (from the removed V1 fiber-per-cron path)
          // have no worker — claiming one would write a spurious unknown_kind
          // failure every tick. Skip them structurally so any stragglers left in
          // an existing DB stay inert rather than hot-looping.
          if (job.kind === "cron") {
            return outcome({ skippedV1Cron: 1 })
          }
          // Pre-screen: do we have a worker for this kind? If not, we still
          // claim (so we don't hot-loop on it) but immediately mark failed
          // with an `unknown_kind` error. The operator's next session will
          // see the failure row in `job_runs`. Uses lookupEntry (not lookup)
          // so `defaultTimeoutMs` is available for the Seam-1 backstop below.
          const entry = yield* registry.lookupEntry(job.kind)
          const nextRunAt = computeNextRunAt(job, tickAt)

          const won = yield* store.claim(job.id, {
            claimAt: tickAt,
            nextRunAt,
            previousLastRun: job.lastRun,
          }).pipe(
            Effect.catchAll(() => Effect.succeed(false)),
          )
          if (!won) {
            return outcome({ skippedClaimLost: 1 })
          }

          // One-shot guard: a job with NO schedule expression at all (empty
          // `schedule` AND empty `spec`) is a fire-once job — `claim` set its
          // `next_run_at` to null, and `listDue` returns null-next_run rows, so
          // without this it would re-fire EVERY tick forever (the documented
          // "stays due" trap). Disable it after its single claim. A job with a
          // NON-empty-but-unparseable cron is left alone (the deliberate
          // pain-signal for a misconfigured schedule).
          // `??` only falls through null/undefined, NOT "" — so check BOTH
          // fields explicitly: an empty-string `schedule` alongside a valid
          // `spec` must NOT be misread as a one-shot.
          const scheduleEmpty = (job.schedule ?? "").trim() === ""
          const specEmpty = (job.spec ?? "").trim() === ""
          if (scheduleEmpty && specEmpty) {
            // Re-encounter: we already dispatched this one-shot but its disable
            // hasn't durably landed (storage outage). Retry the disable and
            // SKIP a second dispatch — the in-memory guard is what actually
            // bounds it to once-per-process; the durable disable is just the
            // cross-restart marker.
            if (dispatchedOneShots.has(job.id)) {
              const disabledNow = yield* store
                .setV2Fields(job.id, { enabled: false })
                .pipe(
                  Effect.as(true),
                  Effect.catchAll(() => Effect.succeed(false)),
                )
              if (disabledNow) {
                dispatchedOneShots.delete(job.id)
              } else {
                yield* Effect.logWarning(
                  `[luna/sched] one-shot disable still failing for job=${job.id}; in-memory guard is suppressing re-dispatch`,
                )
              }
              // This one-shot already fired in a prior tick; the re-claim set
              // last_status='running' again. Reset it so it isn't stuck 'running'.
              yield* store
                .touch(job.id, { lastStatus: "fired" })
                .pipe(Effect.catchAll(() => Effect.void))
              return outcome({ claimed: 1 })
            }

            // First dispatch of this one-shot. Mark it BEFORE dispatching so a
            // disable failure can never produce a second run this process.
            dispatchedOneShots.add(job.id)
            const disabled = yield* store
              .setV2Fields(job.id, { enabled: false })
              .pipe(
                Effect.retry(Schedule.recurs(2)),
                Effect.as(true),
                Effect.catchAll((err) =>
                  Effect.as(
                    Effect.logWarning(
                      `[luna/sched] one-shot disable failed for job=${job.id} after retries: ${err.message} — in-memory guard will prevent a re-fire this process`,
                    ),
                    false,
                  ),
                ),
              )
            // Disable landed durably — no need to keep tracking it in memory.
            if (disabled) dispatchedOneShots.delete(job.id)
          } else if (nextRunAt === null) {
            // The schedule/spec is NON-empty (not a one-shot) but
            // computeNextRunAt could not produce a next fire — the cron is
            // unparseable OR has no upcoming match (e.g. "0 0 30 2 *"). The
            // claim left next_run_at=null, so the row would stay due and run a
            // worker on its broken schedule EVERY tick. Quarantine it (disable)
            // and log loudly so the operator can fix or remove the expression.
            yield* store
              .setV2Fields(job.id, { enabled: false })
              .pipe(
                Effect.retry(Schedule.recurs(2)),
                Effect.catchAll((err) =>
                  Effect.logWarning(
                    `[luna/sched] quarantine of malformed-cron job=${job.id} failed: ${err.message} — it may re-fire next tick`,
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
            // claim() set last_status='running'; this row will NOT run, so clear
            // that marker — otherwise a UI/gallery reading jobs.last_status shows
            // a disabled, quarantined schedule as perpetually 'running'.
            yield* store
              .touch(job.id, { lastStatus: "errored" })
              .pipe(Effect.catchAll(() => Effect.void))
            return outcome({ claimed: 1 })
          }

          // Record run start. job-ticker-oban-deadlines (Seam 3): the attempt
          // number is `retry_attempt + 1` — retry_attempt is 0 for a job's
          // first-ever dispatch (or after a reset), so this is 1 as before
          // for the common case; a job mid-retry-streak gets 2, 3, ... so
          // `job_runs.attempt` finally reflects reality instead of always
          // reading 1.
          const attemptNumber = job.retryAttempt + 1
          const run = yield* store.recordRunStart({
            jobId: job.id,
            startedAt: tickAt,
            attempt: attemptNumber,
          }).pipe(
            Effect.catchAll((err) =>
              Effect.gen(function* () {
                // If we can't write run-start, log + skip the dispatch.
                yield* Effect.logWarning(
                  `[luna/sched] recordRunStart failed for job=${job.id}: ${err.message}`,
                )
                return null
              }),
            ),
          )
          if (!run) {
            // Claimed but no run row — don't leave it stuck 'running'.
            yield* store
              .touch(job.id, { lastStatus: "errored" })
              .pipe(Effect.catchAll(() => Effect.void))
            return outcome({ claimed: 1 })
          }

          // Worker absent — close the run as failed.
          if (!entry) {
            const finishedAt = yield* clock.nowMs()
            yield* store.recordRunEnd(run.id, {
              finishedAt,
              status: "failed",
              error: `no worker registered for kind "${job.kind}"`,
            }).pipe(Effect.catchAll(() => Effect.void))
            return outcome({ claimed: 1, failed: 1, skippedUnknownKind: 1 })
          }

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
              // typed failure. Otherwise it escapes `handleJob` as a defect,
              // which `Effect.forEach`'s concurrency would treat as fatal for
              // the WHOLE tick. `Effect.either` only traps the typed E
              // channel, not defects — this MUST run before it.
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
            //      at all), so `scheduleEmpty && specEmpty` alone is what
            //      excludes it here.
            //   3. `nextRunAt !== null` excludes a quarantined/unschedulable
            //      cron (which already `return`ed above and never reaches
            //      here, but the check is kept as a type-safe
            //      belt-and-suspenders against future control-flow changes).
            // AND bounded by `maxAttempts` (payload.max_attempts clamped to
            // [1,10], else `defaultMaxAttempts`) — once the just-failed
            // dispatch's attempt number reaches the ceiling, retrying stops
            // (exhaustion) instead of continuing forever on the backoff
            // cadence.
            const isOneShot = scheduleEmpty && specEmpty
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

          return outcome({
            claimed: 1,
            succeeded: result._tag === "Right" ? 1 : 0,
            failed: result._tag === "Right" ? 0 : 1,
          })
        })

      /** One tick. Idempotent on the read-side; the claim() guards writes. */
      const drainOnce: Effect.Effect<TickSummary> = Effect.gen(function* () {
        const tickAt = yield* clock.nowMs()
        const due = yield* store.listDue(tickAt).pipe(
          Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<PersistedJob>)),
        )

        // Seam 4 — bounded concurrency, not the old strictly-sequential
        // for-loop. `handleJob` is E=never (see its doc) so `Effect.forEach`'s
        // fail-fast-under-concurrency semantics never trigger here: no
        // sibling in-flight dispatch can ever be interrupted by another due
        // job's store write failing.
        const outcomes = yield* Effect.forEach(
          due,
          (job) => handleJob(job, tickAt),
          { concurrency: dispatchConcurrency },
        )
        const totals = outcomes.reduce<PerJobOutcome>(
          (acc, o) => ({
            claimed: acc.claimed + o.claimed,
            succeeded: acc.succeeded + o.succeeded,
            failed: acc.failed + o.failed,
            skippedUnknownKind: acc.skippedUnknownKind + o.skippedUnknownKind,
            skippedClaimLost: acc.skippedClaimLost + o.skippedClaimLost,
            skippedV1Cron: acc.skippedV1Cron + o.skippedV1Cron,
          }),
          ZERO_OUTCOME,
        )
        const { claimed, succeeded, failed, skippedUnknownKind, skippedClaimLost, skippedV1Cron } =
          totals

        // Retention sweep (throttled): prune closed runs older than the
        // retention window. On failure we log and DO NOT advance lastPruneAt,
        // so the next drain retries instead of skipping a full sweep interval.
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
              `[luna/sched] retention prune failed: ${pruneResult.left.message} — will retry next tick`,
            )
          }
        }

        return {
          tickAt,
          considered: due.length,
          claimed,
          succeeded,
          failed,
          skippedUnknownKind,
          skippedClaimLost,
          skippedV1Cron,
          pruned,
        } satisfies TickSummary
      })

      // Supervised loop. forkScoped ties the loop to the layer Scope so a
      // Layer.close() during teardown interrupts the loop cleanly. Skipped when
      // autoStart=false (tests drive `drain` directly without a background
      // fiber racing the explicit drain on the shared store).
      const supervisedLoop = Effect.gen(function* () {
        const summary = yield* drainOnce.pipe(
          Effect.catchAllDefect((defect) =>
            Effect.gen(function* () {
              yield* Effect.logError(
                `[luna/sched] tick defect (swallowed to keep the loop alive): ${String(defect)}`,
              )
              return {
                tickAt: yield* EffectClock.currentTimeMillis,
                considered: 0,
                claimed: 0,
                succeeded: 0,
                failed: 0,
                skippedUnknownKind: 0,
                skippedClaimLost: 0,
                skippedV1Cron: 0,
                pruned: 0,
              } satisfies TickSummary
            }),
          ),
        )
        if (
          summary.considered > 0 ||
          summary.failed > 0 ||
          summary.skippedUnknownKind > 0 ||
          summary.skippedV1Cron > 0 ||
          summary.pruned > 0
        ) {
          yield* Effect.logInfo(
            `[luna/sched] tick considered=${summary.considered} claimed=${summary.claimed} succeeded=${summary.succeeded} failed=${summary.failed} skipped_unknown=${summary.skippedUnknownKind} skipped_claim_lost=${summary.skippedClaimLost} skipped_v1_cron=${summary.skippedV1Cron} pruned=${summary.pruned}`,
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
      } satisfies JobTickerApi
    }),
  )
}
