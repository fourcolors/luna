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
 *
 * S11a - clean-shutdown marker: chat-server.ts's SIGTERM/SIGINT handlers
 * write `$LUNA_HOME/.luna-clean-shutdown` synchronously, before dispose
 * starts, whenever the process is stopping deliberately (deploy, manual
 * systemctl stop/restart) rather than crashing. This module is the ONLY
 * consumer: it unlinks the marker (never reads its content - existence is
 * the only signal) exactly once, right here at boot, before
 * reconcileAfterCrash runs, so a crash mid-reconcile can't re-consume a
 * marker this same boot already unlinked. The store layer never touches
 * the filesystem - see jobs-store-types.ts's reconcileAfterCrash doc
 * comment. `lunaHome` must be passed explicitly by the caller (see
 * `consumeCleanShutdownMarker` below) - there is no `process.env` fallback,
 * so this destructive `unlinkSync` can never fire on a `JobTickerLayer`
 * build that doesn't opt in.
 */
import { unlinkSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { Clock } from "../clock.js"
import type { JobsStoreApi } from "./jobs-store-types.js"

export const CLEAN_SHUTDOWN_MARKER_NAME = ".luna-clean-shutdown"

/**
 * Trims and rejects an empty `lunaHome`. No `process.env` fallback by
 * design - see the module header. Named distinctly from
 * `doctor/workflow-payload.ts`'s `resolveLunaHome` (opposite contract:
 * that one defaults to `~/.luna`, this one never does).
 */
const resolveMarkerHome = (lunaHome?: string): string | undefined => {
  const trimmed = lunaHome?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

/**
 * Consume-once read of the S11a clean-shutdown marker. Unlinks BEFORE
 * returning so a crash mid-reconcile can't leave the marker for a later
 * boot to double-consume. Best-effort: a missing marker or an unlink
 * failure both degrade to `false` (fails TOWARD orphan-streak counting,
 * never away from the crash-reconcile repair, which always runs
 * regardless of this marker). No `lunaHome` also degrades to `false`,
 * without touching the filesystem at all.
 */
const consumeCleanShutdownMarker = (lunaHome?: string): boolean => {
  const home = resolveMarkerHome(lunaHome)
  if (home === undefined) return false
  const markerPath = join(home, CLEAN_SHUTDOWN_MARKER_NAME)
  try {
    unlinkSync(markerPath)
    return true
  } catch {
    return false
  }
}

export const runBootReconcile = (
  store: JobsStoreApi,
  clock: Clock,
  options?: { readonly lunaHome?: string | undefined },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const bootNow = yield* clock.nowMs()
    const cleanShutdown = consumeCleanShutdownMarker(options?.lunaHome)
    const reconcile = yield* store
      .reconcileAfterCrash({ finishedAt: bootNow, cleanShutdown })
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
        `[luna/sched] boot reconcile: closed ${reconcile.orphansClosed} orphaned run(s) (${reconcile.waitingClosed} waiting); repaired ${reconcile.jobsRepaired} job(s); clean_shutdown=${cleanShutdown}`,
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
