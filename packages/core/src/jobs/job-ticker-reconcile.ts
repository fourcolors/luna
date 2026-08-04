/**
 * JobTicker boot reconciliation — the RECONCILIATION seam of the
 * job-ticker-producer-executor-276 module split (extracted verbatim from
 * job-ticker.ts; see that file's module header for the full crash-safety
 * rationale of the ticker as a whole).
 *
 * Runs ONCE, before the tick loop forks: a hard crash between
 * recordRunStart and recordRunEnd leaves job_runs rows stuck
 * `running`/`waiting` forever, and a claim may leave sticky
 * last_status='running' with a far-future next_run_at. This closes open
 * runs as cancelled and repairs job rows (clears sticky status; pulls
 * forward next_run_at for enabled recurring jobs that had a running
 * orphan), then quarantines rows with unparseable payload_json so they stop
 * appearing as forever-due ghosts in listDue (skipped by rowToJob).
 * Best-effort throughout — a failure logs and boot continues.
 */
import { Effect } from "effect"
import type { Clock } from "../clock.js"
import type { JobsStoreApi } from "./jobs-store-types.js"

export const runBootReconcile = (
  store: JobsStoreApi,
  clock: Clock,
): Effect.Effect<void> =>
  Effect.gen(function* () {
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

    // A4: quarantine enabled rows with unparseable payload_json so they
    // stop appearing as forever-due ghosts in listDue (skipped by rowToJob).
    const quarantined = yield* store
      .quarantineUnparseablePayloads({ finishedAt: bootNow })
      .pipe(
        Effect.catchAll((err) =>
          Effect.as(
            Effect.logWarning(
              `[luna/sched] payload quarantine pass failed: ${err.message}`,
            ),
            0,
          ),
        ),
      )
    if (quarantined > 0) {
      yield* Effect.logWarning(
        `[luna/sched] boot quarantine: disabled ${quarantined} job(s) with unparseable payload_json`,
      )
    }
  })
