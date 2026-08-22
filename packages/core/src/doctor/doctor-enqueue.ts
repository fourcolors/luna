/**
 * Phase B1 — auto-enqueue the doctor workflow for chronically failing jobs.
 *
 * Called from JobTicker after a non-exempt dispatch failure (or after a
 * doctor workflow itself fails and the patient still has heal budget).
 * Always on when JobTicker is wired; tests can pass `doctor: { enabled: false }`.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import type { JobsStoreApi, PersistedJob } from "../jobs/jobs-store-types.js"
import type { DoctorFinding } from "./types.js"
import { DOCTOR_WORKFLOW_SOURCE } from "./types.js"
import {
  buildDoctorWorkflowPayload,
  doctorWorkflowJobId,
} from "./workflow-payload.js"

export interface DoctorEnqueueConfig {
  readonly enabled: boolean
  readonly failStreakThreshold: number
  readonly orphanStreakThreshold: number
  readonly maxHealAttempts: number
  readonly cliPath: string
  readonly bunBin?: string | undefined
  readonly lunaHome?: string | undefined
}

export const isDoctorWorkflowJob = (job: PersistedJob): boolean => {
  if (job.id.startsWith("doctor-")) return true
  const src = job.payload?.source
  return src === DOCTOR_WORKFLOW_SOURCE || src === "doctor-workflow"
}

export const isDoctorExemptKind = (kind: PersistedJob["kind"]): boolean =>
  kind === "dream" || kind === "wake"

export const resolveDoctorCliPath = (override?: string): string => {
  if (override?.trim()) return override.trim()
  const fromEnv = process.env["LUNA_DOCTOR_CLI"]?.trim()
  if (fromEnv) return fromEnv
  // Deliberately cwd, NOT LUNA_REPO_ROOT: this locates CODE in the running
  // tree, and on releases-layout hosts .env pins LUNA_REPO_ROOT at the deploy
  // root (mirror + releases/) where no source exists, while the unit's
  // WorkingDirectory is the `current` release tree. State paths anchor to
  // LUNA_REPO_ROOT; code paths anchor to the tree actually running.
  // NO dual-path fallback needed here (unlike the shell-side sd-notify/launcher
  // probes): packages/core ships in the SAME release commit as the daemon it
  // configures, so an old release always pairs this default with an old
  // checkout (pre-move path) and a new release always pairs it with a new
  // checkout (post-move path) - the two can never skew against each other.
  return join(process.cwd(), "apps/server/scripts/luna-doctor-workflow.ts")
}

/** True when the doctor CLI entrypoint is on disk (gate before pausing patients). */
export const doctorCliReachable = (cliPath: string): boolean => {
  try {
    return existsSync(cliPath)
  } catch {
    return false
  }
}

export const resolveDoctorEnqueueConfig = (opts?: {
  readonly enabled?: boolean
  readonly failStreakThreshold?: number
  readonly orphanStreakThreshold?: number
  readonly maxHealAttempts?: number
  readonly cliPath?: string
  readonly bunBin?: string
  readonly lunaHome?: string
}): DoctorEnqueueConfig => ({
  enabled: opts?.enabled ?? true,
  failStreakThreshold: opts?.failStreakThreshold ?? 5,
  orphanStreakThreshold: opts?.orphanStreakThreshold ?? 5,
  maxHealAttempts: opts?.maxHealAttempts ?? 3,
  cliPath: resolveDoctorCliPath(opts?.cliPath),
  bunBin: opts?.bunBin,
  lunaHome: opts?.lunaHome,
})

export const patientIdFromDoctorJob = (job: PersistedJob): string | null => {
  const finding = (job.payload as { finding?: { patient?: { id?: unknown } } })
    .finding
  const id = finding?.patient?.id
  return typeof id === "string" && id.length > 0 ? id : null
}

const buildAutoFinding = (
  job: PersistedJob,
  lastError: string,
): DoctorFinding => ({
  id: `auto-${job.id}-${Date.now().toString(36)}`,
  source: "job_ticker",
  severity: "error",
  summary: lastError.slice(0, 500) || `chronic failure on job ${job.id}`,
  patient: { kind: "job", id: job.id },
  evidence: {
    fail_streak: job.failStreak,
    orphan_streak: job.orphanStreak,
    heal_attempts: job.healAttempts,
    last_error: lastError,
    kind: job.kind,
  },
  suggestedRemedy: "auto",
  autoEligible: true,
})

export interface EnqueueDoctorResult {
  readonly enqueued: boolean
  readonly doctorJobId?: string
  readonly attempt?: number
  readonly reason?: string
}

/**
 * Maybe pause a chronically-failing patient and enqueue a one-shot doctor
 * workflow (same envelope as manual `doctor-workflow-run`).
 */
export const maybeEnqueueDoctor = (
  store: JobsStoreApi,
  job: PersistedJob,
  lastError: string,
  cfg: DoctorEnqueueConfig,
  nowMs: number,
): Effect.Effect<EnqueueDoctorResult> =>
  Effect.gen(function* () {
    if (!cfg.enabled) {
      return { enqueued: false, reason: "disabled" } as const
    }
    if (isDoctorExemptKind(job.kind)) {
      return { enqueued: false, reason: "exempt_kind" } as const
    }
    if (isDoctorWorkflowJob(job)) {
      return { enqueued: false, reason: "doctor_job" } as const
    }
    if (job.healState === "healing" || job.healState === "escalated") {
      return { enqueued: false, reason: `heal_state_${job.healState}` } as const
    }
    if (job.healAttempts >= cfg.maxHealAttempts) {
      return { enqueued: false, reason: "max_heal_attempts" } as const
    }
    const failOk = job.failStreak >= cfg.failStreakThreshold
    const orphanOk = job.orphanStreak >= cfg.orphanStreakThreshold
    if (!failOk && !orphanOk) {
      return { enqueued: false, reason: "below_threshold" } as const
    }

    // Do not pause the patient if doctor CLI is unreachable — that would
    // permanently disable schedules when deploy layout is wrong.
    if (!doctorCliReachable(cfg.cliPath)) {
      yield* Effect.logWarning(
        `[luna/sched] doctor skipped patient=${job.id}: CLI not reachable at ${cfg.cliPath}`,
      )
      return { enqueued: false, reason: "cli_unreachable" } as const
    }

    const attempt = job.healAttempts + 1
    const finding = buildAutoFinding(
      { ...job, healAttempts: attempt, healState: "healing" },
      lastError,
    )
    const payload = buildDoctorWorkflowPayload(finding, attempt, {
      cliPath: cfg.cliPath,
      bunBin: cfg.bunBin,
      lunaHome: cfg.lunaHome,
    })
    const doctorJobId = doctorWorkflowJobId(finding, attempt)

    // Record doctor job FIRST; only then pause patient. If record fails,
    // leave the patient enabled so a bad deploy cannot soft-delete schedules.
    const recorded = yield* store
      .record({
        id: doctorJobId,
        kind: "workflow",
        spec: "",
        payload: {
          ...payload,
          label: "doctor",
          source: DOCTOR_WORKFLOW_SOURCE,
        },
        enabled: true,
        nextRunAt: nowMs,
      })
      .pipe(
        Effect.map((j) => j.id),
        Effect.catch((err) =>
          Effect.as(
            Effect.logWarning(
              `[luna/sched] doctor enqueue failed patient=${job.id}: ${err.message}`,
            ),
            null as string | null,
          ),
        ),
      )

    if (!recorded) {
      return { enqueued: false, reason: "record_failed" } as const
    }

    yield* store
      .setV2Fields(job.id, {
        healAttempts: attempt,
        healState: "healing",
        enabled: false,
      })
      .pipe(Effect.catch(() => Effect.succeed(false)))

    yield* Effect.logInfo(
      `[luna/sched] doctor enqueued job=${recorded} patient=${job.id} attempt=${attempt}`,
    )
    return {
      enqueued: true,
      doctorJobId: recorded,
      attempt,
    } as const
  })

/**
 * After a doctor workflow fails: re-enqueue (heal_attempts < max) or escalate.
 * Never treats the doctor job itself as a patient (no doctor-for-doctor).
 */
export const handleDoctorWorkflowFailure = (
  store: JobsStoreApi,
  doctorJob: PersistedJob,
  lastError: string,
  cfg: DoctorEnqueueConfig,
  nowMs: number,
): Effect.Effect<EnqueueDoctorResult> =>
  Effect.gen(function* () {
    if (!cfg.enabled) {
      return { enqueued: false, reason: "disabled" } as const
    }
    const patientId = patientIdFromDoctorJob(doctorJob)
    if (!patientId) {
      return { enqueued: false, reason: "no_patient" } as const
    }
    const patient = yield* store
      .getById(patientId)
      .pipe(Effect.catch(() => Effect.succeed(null)))
    if (!patient) {
      return { enqueued: false, reason: "patient_missing" } as const
    }

    if (patient.healAttempts >= cfg.maxHealAttempts) {
      yield* store
        .setV2Fields(patientId, {
          enabled: false,
          healState: "escalated",
        })
        .pipe(Effect.catch(() => Effect.succeed(false)))
      yield* store
        .touch(patientId, { lastStatus: "errored" })
        .pipe(Effect.catch(() => Effect.void))
      yield* Effect.logWarning(
        `[luna/sched] doctor escalated patient=${patientId} heal_attempts=${patient.healAttempts} last_error=${lastError.slice(0, 200)}`,
      )
      return { enqueued: false, reason: "escalated" } as const
    }

    if (patient.healState !== "healing") {
      return { enqueued: false, reason: `patient_state_${patient.healState}` } as const
    }

    // Still under budget and healing: start the next doctor attempt.
    const attempt = patient.healAttempts + 1
    yield* store
      .setV2Fields(patientId, {
        healAttempts: attempt,
        healState: "healing",
        enabled: false,
      })
      .pipe(Effect.catch(() => Effect.succeed(false)))

    const finding = buildAutoFinding(
      {
        ...patient,
        healAttempts: attempt,
        healState: "healing",
      },
      lastError,
    )
    const payload = buildDoctorWorkflowPayload(finding, attempt, {
      cliPath: cfg.cliPath,
      bunBin: cfg.bunBin,
      lunaHome: cfg.lunaHome,
    })
    const doctorJobId = doctorWorkflowJobId(finding, attempt)

    const recorded = yield* store
      .record({
        id: doctorJobId,
        kind: "workflow",
        spec: "",
        payload: {
          ...payload,
          label: "doctor",
          source: DOCTOR_WORKFLOW_SOURCE,
        },
        enabled: true,
        nextRunAt: nowMs,
      })
      .pipe(
        Effect.map((j) => j.id),
        Effect.catch((err) =>
          Effect.as(
            Effect.logWarning(
              `[luna/sched] doctor re-enqueue failed patient=${patientId}: ${err.message}`,
            ),
            null as string | null,
          ),
        ),
      )

    if (!recorded) {
      return { enqueued: false, reason: "record_failed" } as const
    }

    yield* Effect.logInfo(
      `[luna/sched] doctor enqueued job=${recorded} patient=${patientId} attempt=${attempt}`,
    )
    return {
      enqueued: true,
      doctorJobId: recorded,
      attempt,
    } as const
  })
