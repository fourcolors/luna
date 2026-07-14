/**
 * JobHealApi — privileged, backup-gated mutations for the doctor workflow.
 * Only the doctor CLI / apply path should call patchPatient.
 */
import { Effect } from "effect"
import type {
  JobsStoreApi,
  PersistedJob,
  JobRun,
} from "../jobs/jobs-store-types.js"
import { DoctorBackupStore } from "./backup-store.js"
import type { DoctorFinding, RemedyClass } from "./types.js"
import type { AgentNotesApi } from "../agent-notes/types.js"

export interface PatientSnapshot {
  readonly job: PersistedJob
  readonly recentRuns: ReadonlyArray<JobRun>
}

export interface JobPatch {
  readonly payload?: Record<string, unknown>
  readonly schedule?: string
  readonly enabled?: boolean
  readonly nextRunAt?: number | null
  readonly resetStreaks?: boolean
  readonly lastStatus?: string
}

export interface JobHealApi {
  readonly getPatient: (
    jobId: string,
  ) => Effect.Effect<PatientSnapshot, string>
  readonly backupPatient: (
    jobId: string,
    meta: {
      finding: DoctorFinding
      attempt: number
      remedyClass: RemedyClass
    },
  ) => Effect.Effect<string, string>
  readonly patchPatient: (
    jobId: string,
    backupId: string,
    patch: JobPatch,
  ) => Effect.Effect<void, string>
  readonly restoreFromBackup: (backupId: string) => Effect.Effect<void, string>
  readonly escalate: (
    jobId: string,
    report: {
      intent: string
      diagnosis: string
      attemptedFixes: ReadonlyArray<string>
      healAttempts: number
      backupIds: ReadonlyArray<string>
    },
  ) => Effect.Effect<void, string>
}

export interface MakeJobHealApiOptions {
  readonly jobs: JobsStoreApi
  readonly backups?: DoctorBackupStore
  readonly notes?: AgentNotesApi | null
  readonly nowMs?: () => number
}

const deepMergePayload = (
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => ({ ...base, ...patch })

export const makeJobHealApi = (opts: MakeJobHealApiOptions): JobHealApi => {
  const backups = opts.backups ?? new DoctorBackupStore()
  const now = opts.nowMs ?? (() => Date.now())

  const getPatient: JobHealApi["getPatient"] = (jobId) =>
    Effect.gen(function* () {
      const job = yield* opts.jobs.getById(jobId).pipe(
        Effect.mapError((e) => e.message),
      )
      if (!job) return yield* Effect.fail(`job not found: ${jobId}`)
      const recentRuns = yield* opts.jobs.listRuns(jobId, 10).pipe(
        Effect.mapError((e) => e.message),
      )
      return { job, recentRuns }
    })

  const backupPatient: JobHealApi["backupPatient"] = (jobId, meta) =>
    Effect.gen(function* () {
      const snap = yield* getPatient(jobId)
      try {
        const rec = backups.create({
          finding: meta.finding,
          doctorAttempt: meta.attempt,
          remedyClass: meta.remedyClass,
          before: snap,
          nowMs: now(),
        })
        return rec.manifest.id
      } catch (e) {
        return yield* Effect.fail(`backup failed: ${String(e)}`)
      }
    })

  const patchPatient: JobHealApi["patchPatient"] = (jobId, backupId, patch) =>
    Effect.gen(function* () {
      const manifest = backups.readManifest(backupId)
      if (!manifest) {
        return yield* Effect.fail(`invalid or missing backupId: ${backupId}`)
      }
      if (manifest.patient.kind !== "job" || manifest.patient.id !== jobId) {
        return yield* Effect.fail(
          `backup ${backupId} is for ${manifest.patient.kind}:${manifest.patient.id}, not job:${jobId}`,
        )
      }
      const job = yield* opts.jobs.getById(jobId).pipe(
        Effect.mapError((e) => e.message),
      )
      if (!job) return yield* Effect.fail(`job not found: ${jobId}`)

      const nextPayload =
        patch.payload !== undefined
          ? deepMergePayload(
              job.payload as Record<string, unknown>,
              patch.payload,
            )
          : undefined

      // record() overwrites full row when id exists? Check store API...
      // setV2Fields for enabled/nextRunAt; for payload we need remove+record or an update.
      // JobsStore has no updatePayload — use remove + record preserving id, or touch-only.
      // Looking at store: record rejects duplicates. So we need setV2Fields + a payload path.
      // Check if setV2Fields can set payload... only schedule, enabled, nextRunAt, retryAttempt.
      // For B0 we re-record by removing and inserting carefully.

      if (nextPayload !== undefined) {
        yield* opts.jobs.remove(jobId).pipe(Effect.mapError((e) => e.message))
        yield* opts.jobs
          .record({
            id: jobId,
            kind: job.kind,
            spec: patch.schedule ?? job.schedule ?? job.spec,
            payload: nextPayload as PersistedJob["payload"],
            enabled: patch.enabled ?? job.enabled,
            nextRunAt:
              patch.nextRunAt !== undefined ? patch.nextRunAt : job.nextRunAt,
          })
          .pipe(Effect.mapError((e) => e.message))
        if (patch.schedule !== undefined && patch.schedule !== job.schedule) {
          yield* opts.jobs
            .setV2Fields(jobId, { schedule: patch.schedule })
            .pipe(Effect.mapError((e) => e.message))
        }
      } else {
        const fields: {
          schedule?: string
          enabled?: boolean
          nextRunAt?: number | null
          retryAttempt?: number
          failStreak?: number
          orphanStreak?: number
          healAttempts?: number
          healState?: "ok" | "healing" | "escalated"
        } = {}
        if (patch.schedule !== undefined) fields.schedule = patch.schedule
        if (patch.enabled !== undefined) fields.enabled = patch.enabled
        if (patch.nextRunAt !== undefined) fields.nextRunAt = patch.nextRunAt
        if (patch.resetStreaks) {
          fields.retryAttempt = 0
          fields.failStreak = 0
          fields.orphanStreak = 0
          fields.healAttempts = 0
          fields.healState = "ok"
        }
        if (Object.keys(fields).length > 0) {
          yield* opts.jobs
            .setV2Fields(jobId, fields)
            .pipe(Effect.mapError((e) => e.message))
        }
      }

      if (patch.lastStatus !== undefined) {
        yield* opts.jobs
          .touch(jobId, { lastStatus: patch.lastStatus })
          .pipe(Effect.mapError((e) => e.message))
      } else if (patch.enabled === true) {
        yield* opts.jobs
          .touch(jobId, { lastStatus: "fired" })
          .pipe(Effect.catchAll(() => Effect.void))
      }

      backups.updateApplyStatus(backupId, "applied")
      const after = yield* getPatient(jobId)
      try {
        backups.writeAfter(backupId, after)
      } catch {
        /* best-effort */
      }
    })

  const restoreFromBackup: JobHealApi["restoreFromBackup"] = (backupId) =>
    Effect.gen(function* () {
      const manifest = backups.readManifest(backupId)
      if (!manifest) return yield* Effect.fail(`unknown backup: ${backupId}`)
      if (manifest.patient.kind !== "job") {
        return yield* Effect.fail(`backup is not a job patient`)
      }
      const before = backups.readBefore(backupId) as {
        job?: PersistedJob
      } | null
      if (!before?.job) return yield* Effect.fail(`backup missing before snapshot`)
      const job = before.job
      const jobId = job.id
      const existing = yield* opts.jobs.getById(jobId).pipe(
        Effect.mapError((e) => e.message),
      )
      if (existing) {
        yield* opts.jobs.remove(jobId).pipe(Effect.mapError((e) => e.message))
      }
      yield* opts.jobs
        .record({
          id: job.id,
          kind: job.kind,
          spec: job.schedule ?? job.spec,
          payload: job.payload,
          enabled: job.enabled,
          nextRunAt: job.nextRunAt,
        })
        .pipe(Effect.mapError((e) => e.message))
      // Always re-apply V2/V4 columns after record() (record defaults them).
      // Old backup snapshots may predate SCHEMA_V4 - coalesce to safe defaults.
      yield* opts.jobs
        .setV2Fields(jobId, {
          schedule: job.schedule,
          enabled: job.enabled,
          nextRunAt: job.nextRunAt,
          retryAttempt: job.retryAttempt ?? 0,
          failStreak: job.failStreak ?? 0,
          orphanStreak: job.orphanStreak ?? 0,
          healAttempts: job.healAttempts ?? 0,
          healState: job.healState ?? "ok",
        })
        .pipe(Effect.mapError((e) => e.message))
      if (job.lastStatus) {
        yield* opts.jobs
          .touch(jobId, { lastStatus: job.lastStatus })
          .pipe(Effect.catchAll(() => Effect.void))
      }
      backups.updateApplyStatus(backupId, "rolled_back", "restored from before snapshot")
    })

  const escalate: JobHealApi["escalate"] = (jobId, report) =>
    Effect.gen(function* () {
      yield* opts.jobs
        .setV2Fields(jobId, { enabled: false, healState: "escalated" })
        .pipe(Effect.mapError((e) => e.message))
      yield* opts.jobs
        .touch(jobId, { lastStatus: "errored" })
        .pipe(Effect.catchAll(() => Effect.void))
      if (opts.notes) {
        const summary = [
          `Job heal escalation: ${jobId}`,
          `Intent: ${report.intent}`,
          `Diagnosis: ${report.diagnosis}`,
          `Attempts: ${report.healAttempts}`,
          `Tried: ${report.attemptedFixes.join("; ") || "(none)"}`,
          `Backups: ${report.backupIds.join(", ") || "(none)"}`,
        ].join(" | ")
        yield* opts.notes
          .record({
            sessionId: `doctor:${jobId}`,
            kind: "job_heal_escalation",
            summary,
            payload: report,
          })
          .pipe(Effect.catchAll(() => Effect.void))
      }
    })

  return {
    getPatient,
    backupPatient,
    patchPatient,
    restoreFromBackup,
    escalate,
  }
}
