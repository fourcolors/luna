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
 * The supervised JobScheduler pool still gives us bounded parallelism for
 * the workers themselves.
 *
 * Cutover note: the chat-server wires this layer behind
 * `LUNA_SCHEDULER_V2_ENABLED=1` so it runs side-by-side with the legacy
 * TriggerAgent loops until migration is complete. The two systems don't
 * touch the same rows: V2 reads `enabled=1 AND next_run_at <= now`, V1
 * reads via its in-memory TriggerAgent registry. A given row should belong
 * to exactly one regime at a time.
 */
import { Cron, Duration, Effect, Either, Layer, Schedule } from "effect"
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
   * Soft per-worker deadline used to fill `WorkerContext.deadline`. Advisory
   * only — V1 does not interrupt overrun workers (DESIGN.md §5.3.6).
   * Default 5 minutes.
   */
  readonly workerDeadline?: Duration.DurationInput
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
  const parsed = Cron.parse(expr)
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

  return Layer.scoped(
    JobTicker,
    Effect.gen(function* () {
      const store = yield* JobsStoreService
      const registry = yield* WorkerRegistry
      const clock = yield* Clock

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

        for (const job of due) {
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
          if (((job.schedule ?? job.spec) ?? "").trim() === "") {
            yield* store
              .setV2Fields(job.id, { enabled: false })
              .pipe(Effect.catchAll(() => Effect.void))
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
          if (!run) continue

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
          const ctx = {
            jobId: job.id,
            runId: run.id,
            attempt: 1,
            deadline: tickAt + workerDeadlineMs,
          }
          const result = yield* registry.dispatch(job.kind, job.payload, ctx)
            .pipe(Effect.either)

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
        }

        return {
          tickAt,
          considered: due.length,
          claimed,
          succeeded,
          failed,
          skippedUnknownKind,
          skippedClaimLost,
        } satisfies TickSummary
      })

      // Supervised loop. forkScoped ties the loop to the layer Scope so a
      // Layer.close() during teardown interrupts the loop cleanly.
      yield* Effect.gen(function* () {
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
              } satisfies TickSummary
            }),
          ),
        )
        if (
          summary.considered > 0 ||
          summary.failed > 0 ||
          summary.skippedUnknownKind > 0
        ) {
          yield* Effect.logInfo(
            `[luna/sched] tick considered=${summary.considered} claimed=${summary.claimed} succeeded=${summary.succeeded} failed=${summary.failed} skipped_unknown=${summary.skippedUnknownKind} skipped_claim_lost=${summary.skippedClaimLost}`,
          )
        }
      }).pipe(
        Effect.repeat(Schedule.fixed(tickInterval)),
        Effect.forkScoped,
      )

      return {
        drain: drainOnce,
      } satisfies JobTickerApi
    }),
  )
}
