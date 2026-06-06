/**
 * JobsStore types — persisted-job record + service API.
 *
 * Lives in the `jobs` table per DESIGN.md §5.1. Phase 1 (this file) only
 * handles `cron` kind; `oneshot` and `file-watch` are reserved for later
 * phases. Stream-kind TriggerAgent triggers are NOT persisted — Streams are
 * inherently process-local and cannot be serialized.
 *
 * Storage model — one row per registered cron schedule:
 *   id            (string, PK)   — same value returned as TriggerId by
 *                                  scheduler-tools.schedule_create.
 *   kind          (string)       — "cron" (phase 1)
 *   spec          (string)       — the 5-field cron expression
 *   payload_json  (string)       — { label, source: "scheduler-tools" | other }
 *   next_run      (int | null)   — opportunistic, may lag
 *   last_run      (int | null)   — opportunistic, may lag
 *   last_status   (string|null)  — "scheduled" | "fired" | "errored"
 *   created_at    (int)          — epoch ms, when row was inserted
 *   updated_at    (int)          — epoch ms, last time any column changed
 */
import type { Effect } from "effect"
import { Data } from "effect"

export type JobKind = "cron" | "oneshot" | "file-watch"

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
}

export class JobsStoreError extends Data.TaggedError("JobsStoreError")<{
  readonly op: "record" | "list" | "delete" | "update" | "boot"
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
}
