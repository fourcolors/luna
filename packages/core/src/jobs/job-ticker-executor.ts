/**
 * JobTicker EXECUTOR — the forked-tail seam of the
 * job-ticker-producer-executor-276 module split (extracted verbatim from
 * job-ticker.ts; see that file's module header for the full producer/
 * executor split rationale, and its Seam 1 / Seam 3 doc comments for the
 * deadline+grace and retry+backoff design this module implements).
 *
 * `makeExecutor` closes over the ticker's resolved config (deadlines,
 * retry backoff, doctor config) and returns the per-dispatch executor
 * function the producer (job-ticker-producer.ts) forks into its
 * `executors` FiberMap.
 */
import { Duration, Effect } from "effect"
import type { ClockService } from "../clock.js"
import {
  evalPredicate,
  extractHealthPayload,
  type PredicateOutcome,
} from "./outcome-health-predicate.js"
import {
  handleDoctorWorkflowFailure,
  isDoctorWorkflowJob,
  maybeEnqueueDoctor,
  type DoctorEnqueueConfig,
} from "../doctor/doctor-enqueue.js"
import type {
  JobRun,
  JobsStoreApi,
  PersistedJob,
} from "./jobs-store-types.js"
import { WorkerError } from "./worker-registry.js"
import type { WorkerEntry, WorkerRegistryApi } from "./worker-registry.js"

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
export const defaultRetryBackoffMs = (attempt: number): number => {
  const n = Math.max(1, Math.floor(attempt) || 1)
  return Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * Math.pow(2, n - 1))
}

/**
 * job-ticker-oban-deadlines (Seam 1) — the lower clamp bound applied to a
 * per-dispatch timeout resolved from `payload.timeout_ms` or a worker's
 * `defaultTimeoutMs` (NOT the back-compat `workerDeadline` fallback path,
 * which is intentionally left unclamped — see job-ticker.ts's module
 * header). Without this floor a misconfigured payload (`timeout_ms: 5`) or
 * worker registration could hand the ticker a sub-second backstop.
 */
const MIN_RESOLVED_TIMEOUT_MS = 1_000


/** Config + collaborators `makeExecutor` closes over. */
export interface ExecutorDeps {
  readonly store: JobsStoreApi
  readonly registry: WorkerRegistryApi
  readonly clock: ClockService
  readonly workerDeadlineMs: number
  readonly graceMs: number
  readonly maxWorkerDeadlineMs: number
  readonly retryBackoff: (attempt: number) => Duration.Input
  readonly defaultMaxAttempts: number
  readonly doctorCfg: DoctorEnqueueConfig
  /**
   * ADR 0001 Phase 2 — outcome-health alerting. Injected from the
   * JobTickerLayer so the executor stays typed Effect<void> (R=never).
   * Called only on successful dispatches that carry a `health` predicate.
   * Fires at-most-once per (jobId, outcomeState) via recordIfChanged dedupe.
   * A missing / undefined dep silently skips predicate evaluation.
   */
  readonly noteApi?: {
    readonly recordIfChanged: (
      input: {
        readonly sessionId: string
        readonly kind: string
        readonly summary: string
        readonly payload?: unknown
      },
      opts?: { readonly fingerprint?: string }
    ) => Promise<unknown>
  }
}

/**
 * job-ticker-producer-executor-276 - the EXECUTOR: the forked tail of
 * a real dispatch. Exactly the pre-split `handleJob`'s post-entry-check
 * body, lifted verbatim: resolve the per-dispatch timeout (Seam 1),
 * build `ctx`, `dispatch(...).pipe(timeoutFail, catchAllDefect,
 * either)`, close `job_runs` (Seam 3 retry/reset), `touch`, then
 * `postCommit` (issue #277). Typed `Effect.Effect<void>` (E=never) to
 * satisfy `FiberMap<string, void, never>` (see job-ticker.ts's `executors`
 * doc) - every store call stays wrapped in `Effect.catch`/
 * `Effect.catchDefect` for exactly the reason the old `handleJob` doc
 * gave: an escaped typed failure here would only kill THIS fiber (FiberMap
 * doesn't cascade fiber failures between entries), but an escaped DEFECT
 * would still need catching so the fiber closes cleanly and frees its
 * FiberMap slot rather than dying in a way that could surface as a
 * Layer-level defect. The executor needs NO manual `ensuring` to free its
 * slot - `FiberMap` auto-removes the jobId entry when the fiber completes,
 * which is what lifts the in-flight guard for the NEXT tick.
 */
export const makeExecutor = (
  deps: ExecutorDeps,
) => (
  job: PersistedJob,
  run: JobRun,
  entry: WorkerEntry<never>,
  isOneShot: boolean,
  nextRunAt: number | null,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const {
      store,
      registry,
      clock,
      workerDeadlineMs,
      graceMs,
      maxWorkerDeadlineMs,
      retryBackoff,
      defaultMaxAttempts,
      doctorCfg,
    } = deps
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
    // `Effect.timeoutOrElse`. Both share the same `maxWorkerDeadlineMs` cap
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

    // Dispatch the worker. Errors caught into Result so the ticker keeps
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
        Effect.timeoutOrElse({
          orElse: () => Effect.fail(new WorkerError({
              reason: "deadline_passed",
              kind: job.kind,
              message: `worker for kind "${job.kind}" exceeded the ${backstopMs}ms deadline and was interrupted`,
            })),
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
        Effect.catchDefect((defect) =>
          Effect.fail(
            new WorkerError({
              reason: "defect",
              kind: job.kind,
              message: `worker for kind "${job.kind}" raised an unexpected defect: ${String(defect)}`,
            }),
          ),
        ),
        Effect.result,
      )

    const finishedAt = yield* clock.nowMs()
    if (result._tag === "Success") {
      yield* store.recordRunEnd(run.id, {
        finishedAt,
        status: "success",
        outputText: result.success.outputText,
        stepsJson: result.success.stepsJson ?? null,
      }).pipe(Effect.catch(() => Effect.void))
      // Seam 3 + Phase B1 — clear retry + doctor streaks on recovery.
      // Only write when something is non-zero / non-ok so healthy ticks
      // stay free of redundant UPDATEs.
      if (
        job.retryAttempt !== 0 ||
        job.failStreak !== 0 ||
        job.orphanStreak !== 0 ||
        job.healAttempts !== 0 ||
        job.healState !== "ok"
      ) {
        yield* store
          .setV2Fields(job.id, {
            retryAttempt: 0,
            failStreak: 0,
            orphanStreak: 0,
            healAttempts: 0,
            healState: "ok",
          })
          .pipe(Effect.catch(() => Effect.void))
      }
    } else {
      const err = result.failure as WorkerError
      const errMsg = `${err.reason}: ${err.message}`
      yield* store.recordRunEnd(run.id, {
        finishedAt,
        status: "failed",
        error: errMsg,
        // Workers may pass partial output through WorkerError.stepsJson
        // (e.g. workflow worker on halt) — persist it so the operator
        // can see which step failed without rerunning.
        stepsJson: err.stepsJson ?? null,
      }).pipe(Effect.catch(() => Effect.void))
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
            .pipe(Effect.catch(() => Effect.void))
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
          .pipe(Effect.catch(() => Effect.void))
      }

      // Phase B1 — doctor auto-heal. Doctor workflow jobs never
      // become patients themselves; failures re-enqueue or escalate
      // the *patient*. Everyone else bumps fail_streak and may
      // enqueue a doctor one-shot once the threshold is hit.
      if (isDoctorWorkflowJob(job)) {
        yield* handleDoctorWorkflowFailure(
          store,
          job,
          errMsg,
          doctorCfg,
          finishedAt,
        ).pipe(Effect.catchDefect(() => Effect.void))
      } else {
        const newFailStreak = job.failStreak + 1
        yield* store
          .setV2Fields(job.id, { failStreak: newFailStreak })
          .pipe(Effect.catch(() => Effect.void))
        yield* maybeEnqueueDoctor(
          store,
          { ...job, failStreak: newFailStreak },
          errMsg,
          doctorCfg,
          finishedAt,
        ).pipe(Effect.catchDefect(() => Effect.void))
      }
    }
    // recordRunEnd closes the job_runs row but does NOT touch jobs.last_status,
    // which claim() set to 'running'. Reset it to the run's outcome so a
    // recurring schedule isn't shown as perpetually 'running' between fires.
    yield* store
      .touch(job.id, {
        lastStatus: result._tag === "Success" ? "fired" : "errored",
      })
      .pipe(Effect.catch(() => Effect.void))

    // ADR 0001 Phase 2 — Outcome-health predicate evaluation.
    // Runs only on success, AFTER every durable job-state write above
    // (recordRunEnd, retry/reset setV2Fields, touch). A predicate result
    // of "stale" or "unknown" NEVER affects the run's terminal status —
    // "job ran successfully" and "job achieved a fresh outcome" are
    // distinct properties. Advisor hard requirement: no foreign-DB I/O
    // inside the tick producer — evaluation is here in the executor fiber.
    if (result._tag === "Success" && deps.noteApi) {
      const health = extractHealthPayload(job.payload)
      if (health !== null) {
        yield* Effect.promise(async () => {
          const outcome: PredicateOutcome = await evalPredicate(health)
          const { noteApi } = deps
          if (!noteApi) return

          let newOutcomeState: string
          if (outcome.ok) {
            newOutcomeState = outcome.result.state // "fresh" | "stale"
            const patchV5: { lastOutcomeSuccessAt?: number; outcomeState: string } = {
              outcomeState: newOutcomeState,
            }
            if (newOutcomeState === "fresh") {
              patchV5.lastOutcomeSuccessAt = finishedAt
            }
            // Fire-and-forget store write — never throws into executor.
            await store
              .setV2Fields(job.id, patchV5)
              .pipe(Effect.catch(() => Effect.succeed(false)))
              .pipe(Effect.runPromise)
              .catch(() => false)
          } else {
            newOutcomeState = "unknown"
            await store
              .setV2Fields(job.id, { outcomeState: "unknown" })
              .pipe(Effect.catch(() => Effect.succeed(false)))
              .pipe(Effect.runPromise)
              .catch(() => false)
          }

          // Emit a notify-only agent_note when stale or unknown.
          // Fingerprinted on (jobId, outcomeState) so a persistently-
          // stale job produces exactly ONE note per state (dedupe proof).
          if (newOutcomeState !== "fresh") {
            const detail = outcome.ok
              ? (outcome.result.detail ?? "")
              : outcome.error.message
            const summary =
              `[outcome-health] job ${job.id} (${job.payload?.label ?? "unlabelled"}): ` +
              `predicate "${health.predicate}" → ${newOutcomeState}` +
              (detail ? `: ${detail}` : "")
            await noteApi
              .recordIfChanged(
                {
                  sessionId: "system",
                  kind: "outcome-health",
                  summary,
                  payload: {
                    jobId: job.id,
                    label: job.payload?.label,
                    predicate: health.predicate,
                    outcomeState: newOutcomeState,
                    detail,
                  },
                },
                { fingerprint: `${job.id}:${newOutcomeState}` },
              )
              .catch(() => undefined)
          }
        }).pipe(Effect.catch(() => Effect.void))
      }
    }

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
    if (result._tag === "Success" && result.success.postCommit) {
      yield* result.success.postCommit.pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.catch((err) =>
          Effect.logWarning(
            `[luna/sched] postCommit failed for job=${job.id}: ${String(err)}`,
          ),
        ),
        Effect.catchDefect((defect) =>
          Effect.logWarning(
            `[luna/sched] postCommit raised a defect for job=${job.id}: ${String(defect)}`,
          ),
        ),
      )
    }
  })

