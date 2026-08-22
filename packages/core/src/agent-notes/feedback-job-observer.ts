/**
 * feedback-job-observer.ts — folds a feedback-triggered job's terminal run
 * status back onto the `ui_feedback_status` row that spawned it.
 *
 * Mirrors ../suggested-actions/accept-handler.ts's completion observer
 * (Layer.effect + Effect.forkScoped poller on Schedule.fixed): the durable
 * jobs path has no push-notify, so this forks a background fiber that polls
 * JobsStore.listRuns(resolvedRef) for every feedback row still `status:
 * 'queued'` and folds a terminal run (success / failed / cancelled) back
 * onto the note.
 *
 * Deps are plain Promise-returning functions, not Effect services — the same
 * posture feedback-job-bridge.ts takes, and for the same reason: the tick
 * logic (pollFeedbackJobsOnce) is unit-tested directly with fakes under
 * `bun test`, no Effect runtime required to exercise it. The exported Layer
 * is only a thin wiring shim so chat-server can fork this alongside
 * AcceptHandlerLayer's own observer.
 *
 * Only rows still `queued` are polled, and each terminal fold-back is a
 * guarded update that only succeeds while the row is still `queued`. A
 * working agent (or a human) that moves a note out of `queued` before the
 * write is no longer overwritten, and any existing triage note is preserved
 * by appending the outcome marker rather than replacing it.
 */
import { Duration, Effect, Layer, Schedule } from "effect"
import type { FeedbackSetStatusDep } from "./feedback-job-bridge.js"

/** Default completion-poll cadence (mirrors accept-handler.ts's DEFAULT_POLL_INTERVAL). */
const DEFAULT_POLL_INTERVAL = Duration.seconds(10)

/** Bounded per-tick fetch — this is a best-effort background loop, never an
 *  unbounded sweep of the whole table. */
const DEFAULT_QUEUE_LIMIT = 100

/** Hard cap on the error snippet folded into the notes field. The curated
 *  `feedback-set-status` wire clamps human notes to 4000 characters; the
 *  observer's auto-generated failure marker must stay well under that. */
const MAX_ERROR_SNIPPET_LEN = 500

const truncateWithEllipsis = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}...` : s

/** The `fbj-` prefix feedbackJobIdFor stamps (feedback-job-bridge.ts) — only
 *  a resolvedRef with this prefix can possibly be a feedback-triggered job.
 *  Anything else (a manually-set resolvedRef, e.g. a pasted PR link) is not
 *  this observer's business and must be left alone. */
const FEEDBACK_JOB_ID_PREFIX = "fbj-"

/** The queued-feedback row shape this observer needs: just enough to find
 *  its linked job (resolvedRef) and identify the note (id) for setStatus. */
export interface QueuedFeedbackRow {
  readonly id: string
  readonly resolvedRef: string | null
}

/** The minimal job-run shape this observer needs off JobsStoreApi.listRuns. */
export interface FeedbackJobRunLookup {
  readonly status: string
  readonly finishedAt: number | null
  readonly error: string | null
}

export interface FeedbackJobObserverDeps {
  /** List ui_feedback_status rows currently `status: 'queued'`, bounded to
   *  `limit`. Ordering is irrelevant — every queued row is visited every
   *  tick until it leaves the queued state. */
  readonly listQueued: (limit: number) => Promise<ReadonlyArray<QueuedFeedbackRow>>
  /** JobsStore.listRuns adapted to Promise (mirrors FeedbackJobsDep's own
   *  Promise-adaptation of the Effect-based JobsStoreApi). */
  readonly listRuns: (
    jobId: string,
    limit: number,
  ) => Promise<ReadonlyArray<FeedbackJobRunLookup>>
  readonly setStatus: FeedbackSetStatusDep
  readonly nowMs: () => number
}

export interface FeedbackJobObserverOptions {
  /** Completion-poll cadence. Default 10s. */
  readonly pollInterval?: Duration.Input
  /** Per-tick queued-row fetch bound. Default 100. */
  readonly queueLimit?: number
}

/**
 * One best-effort tick: list queued rows, check each linked job's latest
 * run, fold a terminal result back onto the note. Every I/O step is wrapped
 * in its own try/catch so one bad row (a throwing listRuns/setStatus call)
 * can never abort the rest of the batch — this function must never throw.
 * Exported directly for unit tests; no Effect runtime needed to exercise it.
 */
export const pollFeedbackJobsOnce = async (
  deps: FeedbackJobObserverDeps,
  queueLimit: number = DEFAULT_QUEUE_LIMIT,
): Promise<void> => {
  let rows: ReadonlyArray<QueuedFeedbackRow>
  try {
    rows = await deps.listQueued(queueLimit)
  } catch {
    return
  }

  for (const row of rows) {
    if (row.resolvedRef === null || !row.resolvedRef.startsWith(FEEDBACK_JOB_ID_PREFIX)) {
      continue
    }

    let runs: ReadonlyArray<FeedbackJobRunLookup>
    try {
      runs = await deps.listRuns(row.resolvedRef, 1)
    } catch {
      continue
    }
    const latest = runs[0]
    if (latest === undefined || latest.finishedAt === null) continue

    try {
      if (latest.status === "success") {
        await deps.setStatus(
          {
            id: row.id,
            status: "resolved",
            resolvedRef: row.resolvedRef,
            notes: "auto: feedback job completed",
            expectedStatus: "queued",
            appendNotes: true,
          },
          deps.nowMs(),
        )
      } else if (latest.status === "failed" || latest.status === "cancelled") {
        const errorSnippet = truncateWithEllipsis(
          latest.error ?? "unknown error",
          MAX_ERROR_SNIPPET_LEN,
        )
        await deps.setStatus(
          {
            id: row.id,
            status: "job-failed",
            resolvedRef: row.resolvedRef,
            notes: `auto: feedback job failed: ${errorSnippet}`,
            expectedStatus: "queued",
            appendNotes: true,
          },
          deps.nowMs(),
        )
      }
      // Any other run status (queued/running/waiting) is not terminal —
      // nothing to fold back yet, leave the row queued for the next tick.
    } catch {
      // Best-effort: a failed setStatus just means the row stays `queued`
      // and the next tick retries — never crash the loop over one row.
    }
  }
}

/**
 * Layer wiring: forks pollFeedbackJobsOnce on a fixed schedule, tied to the
 * layer's Scope so it stops when the server shuts down. No service Tag is
 * provided here (nothing needs to *resolve* this observer — it is pure
 * background wiring, like WakeWorkerLayer/DreamWorkerLayer), so
 * Layer.effectDiscard is the right constructor: it strips Scope out of the
 * layer's own requirements once the fork is set up, exactly as
 * AcceptHandlerLayer's own forkScoped completion observer does inside its
 * Layer.effect(AcceptHandler, ...).
 */
export const FeedbackJobObserverLayer = (
  deps: FeedbackJobObserverDeps,
  options?: FeedbackJobObserverOptions,
): Layer.Layer<never> => {
  const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL
  const queueLimit = options?.queueLimit ?? DEFAULT_QUEUE_LIMIT

  const tick = Effect.tryPromise({
    try: () => pollFeedbackJobsOnce(deps, queueLimit),
    catch: () => undefined,
  }).pipe(Effect.ignore)

  return Layer.effectDiscard(
    tick.pipe(Effect.repeat(Schedule.fixed(pollInterval)), Effect.forkScoped),
  )
}
