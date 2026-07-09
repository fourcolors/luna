/**
 * JobsStore types — persisted-job record + service API.
 *
 * Lives in the `jobs` table per DESIGN.md §5.1. The live kinds are the V2
 * ticker kinds (`prompt`, `workflow`, `dream`, `wake`); `oneshot` and
 * `file-watch` are reserved for later phases, and `cron` is a legacy kind kept
 * only so the ticker can recognize and skip rows left by the removed V1 path.
 *
 * Storage model — one row per schedule:
 *   id            (string, PK)   — same value returned as the schedule id by
 *                                  scheduler-tools.schedule_create.
 *   kind          (string)       — one of JobKind (see below)
 *   spec          (string)       — the 5-field cron expression
 *   payload_json  (string)       — { label, source: "scheduler-tools" | other }
 *   next_run      (int | null)   — opportunistic, may lag
 *   last_run      (int | null)   — opportunistic, may lag
 *   last_status   (string|null)  — "scheduled" | "fired" | "errored"
 *   created_at    (int)          — epoch ms, when row was inserted
 *   updated_at    (int)          — epoch ms, last time any column changed
 *
 * Phase 12b (scheduler-rebuild) additive columns — see DESIGN.md §5.3:
 *   schedule      (string|null) — cron expression (replaces `spec` for new rows)
 *   enabled       (int)          — 0|1; 0 makes the ticker skip this row
 *   next_run_at   (int|null)     — when the ticker should next fire this row
 *
 * Plus a new `job_runs` table for per-fire audit history (one row per fire).
 */
import type { Effect } from "effect"
import { Data } from "effect"

// The live V2 ticker kinds are "prompt" + "workflow" (generic workers) plus the
// dedicated "dream" + "wake" workers: the install script writes rows with these
// kinds and the JobTicker dispatches them through the WorkerRegistry under the
// matching DREAM_WORKER_KIND / WAKE_WORKER_KIND discriminant. "cron" is retained
// only so the ticker recognizes (and skips) inert rows left by the removed V1
// path; "oneshot" / "file-watch" are reserved for later phases.
export type JobKind =
  | "cron"
  | "oneshot"
  | "file-watch"
  | "prompt"
  | "workflow"
  | "dream"
  | "wake"

export interface PersistedJob {
  readonly id: string
  readonly kind: JobKind
  readonly spec: string
  readonly payload: { readonly label: string; readonly source?: string } & Record<string, unknown>
  readonly nextRun: number | null
  readonly lastRun: number | null
  readonly lastStatus: string | null
  readonly createdAt: number
  readonly updatedAt: number

  // Phase 12b additive columns (DESIGN.md §5.3 / PR #51).
  // Legacy rows have `schedule = null` — readers fall back to `spec`.
  // `enabled` defaults to `true`; `nextRunAt` is what the ticker reads.
  readonly schedule: string | null
  readonly enabled: boolean
  readonly nextRunAt: number | null

  /**
   * Oban-style retry counter (job-ticker-oban-deadlines). Bumped by the
   * JobTicker each time a RECURRING job's dispatch fails, so the retry
   * backoff can grow (see `JobTickerOptions.retryBackoff`); reset to 0 on
   * the next success. One-shot jobs never retry, so this stays 0 for them.
   * Defaults to 0 for every existing row via the SCHEMA_V3 migration.
   */
  readonly retryAttempt: number
}

/**
 * JobRun — one row per cron fire (or per oneshot dispatch). Written by the
 * JobTicker (Phase 12b). Used for audit + the daily-brief acceptance test.
 *
 * `waiting` (widget-system.md Phase 5) is NOT a terminal status: a running
 * job that summons operator input (the `request_input` tool) flips
 * running→waiting→running via `updateRunStatus` while `finished_at` stays
 * NULL. Only `recordRunEnd` writes a terminal status.
 */
export type JobRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "success"
  | "failed"
  | "cancelled"

/** The non-terminal statuses `updateRunStatus` may write (running↔waiting). */
export type JobRunLiveStatus = Extract<JobRunStatus, "running" | "waiting">

/** The terminal statuses only `recordRunEnd` may write. */
export type JobRunTerminalStatus = Exclude<
  JobRunStatus,
  "queued" | "running" | "waiting"
>

export interface JobRun {
  readonly id: number
  readonly jobId: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly status: JobRunStatus
  readonly attempt: number
  readonly outputText: string | null
  readonly error: string | null
  readonly stepsJson: string | null
}

export class JobsStoreError extends Data.TaggedError("JobsStoreError")<{
  readonly op:
    | "record"
    | "list"
    | "delete"
    | "update"
    | "boot"
    | "claim"
    | "run_start"
    | "run_end"
    | "run_status"
  readonly message: string
  readonly cause?: unknown
}> {}

export interface JobsStoreApi {
  /**
   * Insert a new persisted job. `id` is caller-supplied (so scheduler-tools
   * can use the TriggerId it has already generated).
   */
  readonly record: (input: {
    readonly id: string
    readonly kind: JobKind
    readonly spec: string
    readonly payload: { readonly label: string; readonly source?: string } & Record<
      string,
      unknown
    >
    /**
     * Optional V2 fields applied ATOMICALLY at insert. Lets a caller create a
     * row already in its final armed state (e.g. a one-shot that is enabled +
     * due now) in a single write, instead of record()+setV2Fields() — which
     * leaves a window where the row is transiently due and a ticker could
     * double-fire it. Defaults: `enabled = true`, `nextRunAt = null`.
     */
    readonly enabled?: boolean
    readonly nextRunAt?: number | null
  }) => Effect.Effect<PersistedJob, JobsStoreError>

  /** List every persisted job, ordered by createdAt ASC. */
  readonly listAll: () => Effect.Effect<ReadonlyArray<PersistedJob>, JobsStoreError>

  /** Get one row by id. */
  readonly getById: (id: string) => Effect.Effect<PersistedJob | null, JobsStoreError>

  /** Delete by id. Returns `true` when a row was removed. */
  readonly remove: (id: string) => Effect.Effect<boolean, JobsStoreError>

  /**
   * Update the opportunistic fields (`next_run`, `last_run`, `last_status`).
   * Used by the trigger loop to surface "when did this last fire?" without
   * blocking the cron tick on a write.
   */
  readonly touch: (
    id: string,
    patch: {
      readonly nextRun?: number | null
      readonly lastRun?: number | null
      readonly lastStatus?: string | null
    },
  ) => Effect.Effect<boolean, JobsStoreError>

  // ── Phase 12b — JobTicker reads ─────────────────────────────────────────

  /**
   * Set the V2 fields (schedule / enabled / nextRunAt). All three are
   * independent partial patches. Returns true when a row was updated.
   * No-op when the id does not exist.
   */
  readonly setV2Fields: (
    id: string,
    patch: {
      readonly schedule?: string | null
      readonly enabled?: boolean
      readonly nextRunAt?: number | null
      /** Oban-style retry counter — see `PersistedJob.retryAttempt`. */
      readonly retryAttempt?: number
    },
  ) => Effect.Effect<boolean, JobsStoreError>

  /**
   * Return every row with `enabled = 1 AND (next_run_at IS NULL OR next_run_at <= now)`.
   * The ticker calls this at each tick boundary, then `claim()`s each result.
   */
  readonly listDue: (
    now: number,
  ) => Effect.Effect<ReadonlyArray<PersistedJob>, JobsStoreError>

  /**
   * Optimistic claim. Writes `last_run = claimAt`, `last_status = "running"`,
   * `next_run_at = nextRunAt` — but ONLY when the row's `last_run` is still
   * `previousLastRun` (i.e. no other ticker beat us to it). Returns true on
   * successful claim. Single-process today; the watchdog also guards against
   * a future distributed ticker (Phase 14).
   */
  readonly claim: (
    id: string,
    args: {
      readonly claimAt: number
      readonly nextRunAt: number | null
      readonly previousLastRun: number | null
    },
  ) => Effect.Effect<boolean, JobsStoreError>

  // ── Phase 12b — JobRuns CRUD (per-fire audit ledger) ────────────────────

  /**
   * Insert a new `job_runs` row in `status="running"`. Returns the row
   * (with its auto-assigned id) so the worker can later close it.
   */
  readonly recordRunStart: (input: {
    readonly jobId: string
    readonly startedAt: number
    readonly attempt?: number
  }) => Effect.Effect<JobRun, JobsStoreError>

  /**
   * Close a `job_runs` row: write `finished_at`, terminal `status`,
   * optional `output_text`/`error`/`steps_json`. Returns true on update.
   */
  readonly recordRunEnd: (
    runId: number,
    end: {
      readonly finishedAt: number
      readonly status: JobRunTerminalStatus
      readonly outputText?: string | null
      readonly error?: string | null
      readonly stepsJson?: string | null
    },
  ) => Effect.Effect<boolean, JobsStoreError>

  /**
   * Flip a LIVE run between `running` and `waiting` (widget-system.md
   * Phase 5: a running job summons operator input and parks in `waiting`
   * until the answer/timeout, then flips back). `finished_at` stays NULL —
   * `waiting` is not an end state; only `recordRunEnd` closes a row.
   *
   * Guarded against zombie writes: a row whose `finished_at` is already set
   * (the ticker closed the run while the tool's flip-back was still in
   * flight — e.g. the SDK turn timed out mid-wait) is left untouched and the
   * call returns `false`.
   */
  readonly updateRunStatus: (
    runId: number,
    status: JobRunLiveStatus,
  ) => Effect.Effect<boolean, JobsStoreError>

  /**
   * Recent runs for a given job (descending by started_at). Default limit
   * `25` — chat surfaces can ask for a tail; the ticker doesn't read this.
   */
  readonly listRuns: (
    jobId: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<JobRun>, JobsStoreError>

  /**
   * Retention sweep: delete every CLOSED `job_runs` row whose `finished_at`
   * is strictly before `cutoffMs`. Rows still in flight (`finished_at IS
   * NULL` — running/waiting) are NEVER pruned. Returns the number deleted.
   * The ticker calls this with `now - retentionMaxAgeMs` so the audit ledger
   * does not grow without bound.
   */
  readonly pruneRuns: (
    cutoffMs: number,
  ) => Effect.Effect<number, JobsStoreError>

  /**
   * Crash recovery: close every IN-FLIGHT run (`finished_at IS NULL` — i.e.
   * `running`/`waiting`) as `cancelled`, stamping `finished_at` and an
   * `error` (only when the row has none). A hard crash between
   * `recordRunStart` and `recordRunEnd` otherwise leaves rows stuck forever.
   * The ticker calls this ONCE at boot, before the first drain. Returns the
   * number of rows closed.
   */
  readonly closeOrphanedRuns: (args: {
    readonly finishedAt: number
    readonly error?: string
  }) => Effect.Effect<number, JobsStoreError>
}
