/**
 * JobTicker PRODUCER — the tick-loop seam of the
 * job-ticker-producer-executor-276 module split (extracted verbatim from
 * job-ticker.ts; see that file's module header for the full producer/
 * executor split rationale and backpressure design).
 *
 * `makeDrainOnce` closes over the ticker's shared resources (the JobsStore,
 * WorkerRegistry, Clock, the `executors` FiberMap, the `dispatchedOneShots`
 * at-most-once guard, the `producerSemaphore` serializer, retention-sweep
 * state, and the health publisher) plus the executor function
 * (job-ticker-executor.ts's `makeExecutor` output) it forks into
 * `executors`, and returns the `drainOnce` effect job-ticker.ts exposes as
 * the public `drain` / auto-tick loop body.
 */
import { Cron, Effect, Result, FiberMap, Ref, Schedule } from "effect"
import type { ClockService } from "../clock.js"
import type { JobRun, JobsStoreApi, PersistedJob } from "./jobs-store-types.js"
import type { TickSummary } from "./job-ticker.js"
import type { WorkerEntry, WorkerRegistryApi } from "./worker-registry.js"

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
  if (Result.isFailure(parsed)) return null
  try {
    const nextDate = Cron.next(parsed.success, new Date(fromMs))
    return nextDate.getTime()
  } catch {
    return null
  }
}

/** Config + collaborators `makeDrainOnce` closes over. */
export interface ProducerDeps {
  readonly store: JobsStoreApi
  readonly registry: WorkerRegistryApi
  readonly clock: ClockService
  readonly dispatchConcurrency: number
  readonly executors: FiberMap.FiberMap<string, void, never>
  readonly dispatchedOneShots: Set<string>
  readonly producerSemaphore: Effect.Semaphore
  readonly retentionSweepIntervalMs: number
  readonly retentionMaxAgeMs: number
  readonly lastPruneAt: Ref.Ref<number>
  readonly publishHealth: (
    summary: TickSummary,
    inFlight: number,
    observedAt: number,
  ) => Effect.Effect<void>
  readonly executor: (
    job: PersistedJob,
    run: JobRun,
    entry: WorkerEntry<never>,
    isOneShot: boolean,
    nextRunAt: number | null,
  ) => Effect.Effect<void>
}

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
export const makeDrainOnce = (
  deps: ProducerDeps,
): Effect.Effect<TickSummary> => {
  const {
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
  } = deps

  return producerSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const tickAt = yield* clock.nowMs()
      const due = yield* store.listDue(tickAt).pipe(
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<PersistedJob>)),
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
          }).pipe(Effect.catch(() => Effect.succeed(false)))
          if (!won) {
            skippedClaimLost++
            continue
          }
          const disabledNow = yield* store
            .setV2Fields(job.id, { enabled: false })
            .pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))
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
            .pipe(Effect.catch(() => Effect.void))
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
          }).pipe(Effect.catch(() => Effect.succeed(false)))
          if (!won) {
            skippedClaimLost++
            continue
          }
          yield* store
            .setV2Fields(job.id, { enabled: false })
            .pipe(
              Effect.retry(Schedule.recurs(2)),
              Effect.catch((err) =>
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
            .pipe(Effect.catch(() => Effect.void))
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
          }).pipe(Effect.catch(() => Effect.succeed(false)))
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
                Effect.catch((err) =>
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
            Effect.catch((err) =>
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
              .pipe(Effect.catch(() => Effect.void))
            claimed++
            continue
          }
          const finishedAt = yield* clock.nowMs()
          yield* store.recordRunEnd(run.id, {
            finishedAt,
            status: "failed",
            error: `no worker registered for kind "${job.kind}"`,
          }).pipe(Effect.catch(() => Effect.void))
          yield* store
            .touch(job.id, { lastStatus: "errored" })
            .pipe(Effect.catch(() => Effect.void))
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
        // job-ticker.ts's module header and jobs-store-types.ts's doc on
        // this method).
        const started = yield* store.claimAndStartRun(job.id, {
          claimAt: tickAt,
          nextRunAt,
          previousLastRun: job.lastRun,
          startedAt: tickAt,
          attempt: attemptNumber,
        }).pipe(
          Effect.catch((err) =>
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
            Effect.andThen(
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
              Effect.catch((err) =>
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
          .pipe(Effect.result)
        if (pruneResult._tag === "Success") {
          pruned = pruneResult.success
          yield* Ref.set(lastPruneAt, tickAt)
        } else {
          yield* Effect.logWarning(
            `[luna/sched] retention prune failed: ${pruneResult.failure.message} - will retry next tick`,
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
}
