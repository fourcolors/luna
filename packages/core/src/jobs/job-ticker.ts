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
 * Within a tick, due jobs are dispatched sequentially; each worker dispatch is
 * bounded by `workerDeadline` (Effect.timeoutFail) so a stuck worker is
 * interrupted rather than blocking the loop indefinitely. (The JobScheduler
 * pool is V1's mechanism — the V2 ticker does NOT route through it.)
 *
 * Cutover note: V2 is the DEFAULT scheduler — the chat-server wires this layer
 * unless `LUNA_SCHEDULER_V2_ENABLED=0` (the kill switch). The agent-facing
 * scheduler tools are fully V2 (a schedule is a `kind:"prompt"` row). The
 * wake / dream cycles still run on their own TriggerAgent loops, separate from
 * this ticker; the two don't touch the same rows (V2 reads `enabled=1 AND
 * next_run_at <= now` and skips `kind="cron"` rows entirely).
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
  /** V1 cron rows (`kind="cron"`) skipped — they belong to TriggerAgent, not
   *  the V2 ticker, so they are never claimed or dispatched here. */
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

      /** One tick. Idempotent on the read-side; the claim() guards writes. */
      const drainOnce: Effect.Effect<TickSummary> = Effect.gen(function* () {
        const tickAt = yield* clock.nowMs()
        const due = yield* store.listDue(tickAt).pipe(
          Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<PersistedJob>)),
        )

        let claimed = 0
        let succeeded = 0
        let failed = 0
        let skippedUnknownKind = 0
        let skippedClaimLost = 0
        let skippedV1Cron = 0

        for (const job of due) {
          // V1 cron rows (kind="cron") belong to the in-process TriggerAgent,
          // not the V2 ticker — there is no "cron" worker, so claiming one would
          // write a spurious unknown_kind failure every tick. Skip them
          // structurally so a missed enabled=false opt-out (the V1→V2 disable is
          // best-effort) can NEVER leak a V1 row into V2 dispatch.
          if (job.kind === "cron") {
            skippedV1Cron++
            continue
          }
          // Pre-screen: do we have a worker for this kind? If not, we still
          // claim (so we don't hot-loop on it) but immediately mark failed
          // with an `unknown_kind` error. The operator's next session will
          // see the failure row in `job_runs`.
          const worker = yield* registry.lookup(job.kind)
          const nextRunAt = computeNextRunAt(job, tickAt)

          const won = yield* store.claim(job.id, {
            claimAt: tickAt,
            nextRunAt,
            previousLastRun: job.lastRun,
          }).pipe(
            Effect.catchAll(() => Effect.succeed(false)),
          )
          if (!won) {
            skippedClaimLost++
            continue
          }
          claimed++

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
              continue
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
            continue
          }

          // Record run start.
          const run = yield* store.recordRunStart({
            jobId: job.id,
            startedAt: tickAt,
            attempt: 1,
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
            continue
          }

          // Worker absent — close the run as failed.
          if (!worker) {
            skippedUnknownKind++
            failed++
            const finishedAt = yield* clock.nowMs()
            yield* store.recordRunEnd(run.id, {
              finishedAt,
              status: "failed",
              error: `no worker registered for kind "${job.kind}"`,
            }).pipe(Effect.catchAll(() => Effect.void))
            continue
          }

          // Dispatch the worker. Errors caught into Either so the ticker keeps
          // draining; the result is closed into job_runs regardless of outcome.
          // ctx.deadline is computed from a fresh clock read (NOT tickAt) so it
          // matches the relative `timeoutFail(workerDeadlineMs)` below — jobs
          // dispatch sequentially, so a tickAt-based deadline would be wrong for
          // the 2nd+ job (advertising less time than the worker actually gets).
          const dispatchAt = yield* clock.nowMs()
          const ctx = {
            jobId: job.id,
            runId: run.id,
            attempt: 1,
            deadline: dispatchAt + workerDeadlineMs,
          }
          const result = yield* registry
            .dispatch(job.kind, job.payload, ctx)
            .pipe(
              // ENFORCE the deadline: a worker that overruns is interrupted
              // rather than left to block the single ticker fiber indefinitely
              // (the old behaviour — the deadline was advisory only). The
              // timeout surfaces as a deadline_passed WorkerError and is closed
              // into job_runs like any other failure.
              Effect.timeoutFail({
                onTimeout: () =>
                  new WorkerError({
                    reason: "deadline_passed",
                    kind: job.kind,
                    message: `worker for kind "${job.kind}" exceeded the ${workerDeadlineMs}ms deadline and was interrupted`,
                  }),
                duration: Duration.millis(workerDeadlineMs),
              }),
              // Convert an uncaught worker DEFECT (a synchronous throw /
              // Effect.die — e.g. JSON.parse on a malformed payload) into a
              // typed failure. Otherwise it escapes the for-loop, leaving this
              // run stuck `running` and skipping every remaining due job this
              // tick. `Effect.either` only traps the typed E channel, not defects.
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
            succeeded++
            yield* store.recordRunEnd(run.id, {
              finishedAt,
              status: "success",
              outputText: result.right.outputText,
              stepsJson: result.right.stepsJson ?? null,
            }).pipe(Effect.catchAll(() => Effect.void))
          } else {
            failed++
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
          }
          // recordRunEnd closes the job_runs row but does NOT touch jobs.last_status,
          // which claim() set to 'running'. Reset it to the run's outcome so a
          // recurring schedule isn't shown as perpetually 'running' between fires.
          yield* store
            .touch(job.id, {
              lastStatus: result._tag === "Right" ? "fired" : "errored",
            })
            .pipe(Effect.catchAll(() => Effect.void))
        }

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
