import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "../jobs/jobs-store.js"
import {
  isDoctorExemptKind,
  isDoctorWorkflowJob,
  maybeEnqueueDoctor,
  patientIdFromDoctorJob,
  resolveDoctorEnqueueConfig,
} from "./doctor-enqueue.js"
import type { PersistedJob } from "../jobs/jobs-store-types.js"

const baseJob = (over: Partial<PersistedJob> = {}): PersistedJob => ({
  id: "sched-x",
  kind: "prompt",
  spec: "0 0 * * *",
  payload: { label: "x" },
  nextRun: null,
  lastRun: null,
  lastStatus: null,
  createdAt: 1,
  updatedAt: 1,
  schedule: "0 0 * * *",
  enabled: true,
  nextRunAt: 0,
  retryAttempt: 0,
  failStreak: 5,
  orphanStreak: 0,
  healAttempts: 0,
  healState: "ok",
  ...over,
})

describe("doctor-enqueue helpers", () => {
  it("isDoctorExemptKind covers dream/wake only", () => {
    expect(isDoctorExemptKind("dream")).toBe(true)
    expect(isDoctorExemptKind("wake")).toBe(true)
    expect(isDoctorExemptKind("prompt")).toBe(false)
    expect(isDoctorExemptKind("workflow")).toBe(false)
  })

  it("isDoctorWorkflowJob matches source and id prefix", () => {
    expect(
      isDoctorWorkflowJob(
        baseJob({
          id: "doctor-job-a1-x",
          kind: "workflow",
          payload: { label: "doctor", source: "doctor-workflow" },
        }),
      ),
    ).toBe(true)
    expect(
      isDoctorWorkflowJob(
        baseJob({
          id: "other",
          payload: { label: "d", source: "doctor-workflow" },
        }),
      ),
    ).toBe(true)
    expect(isDoctorWorkflowJob(baseJob())).toBe(false)
  })

  it("patientIdFromDoctorJob reads finding.patient.id", () => {
    expect(
      patientIdFromDoctorJob(
        baseJob({
          payload: {
            label: "doctor",
            source: "doctor-workflow",
            finding: { patient: { kind: "job", id: "patient-1" } },
          },
        }),
      ),
    ).toBe("patient-1")
    expect(patientIdFromDoctorJob(baseJob())).toBeNull()
  })

  it("resolveDoctorEnqueueConfig defaults enabled to true", () => {
    const cfg = resolveDoctorEnqueueConfig({})
    expect(cfg.enabled).toBe(true)
    expect(resolveDoctorEnqueueConfig({ enabled: false }).enabled).toBe(false)
  })

  it("maybeEnqueueDoctor records a one-shot and disables the patient", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({
        id: "sched-x",
        kind: "prompt",
        spec: "0 0 * * *",
        payload: { label: "x" },
      })
      const job = (yield* store.getById("sched-x"))!
      const withStreak = { ...job, failStreak: 5 }
      const result = yield* maybeEnqueueDoctor(
        store,
        withStreak,
        "worker_failed: boom",
        resolveDoctorEnqueueConfig({
          failStreakThreshold: 5,
          cliPath: "/tmp/luna-doctor-workflow.ts",
        }),
        1_700_000_000_000,
      )
      expect(result.enqueued).toBe(true)
      expect(result.attempt).toBe(1)

      const patient = yield* store.getById("sched-x")
      expect(patient?.enabled).toBe(false)
      expect(patient?.healState).toBe("healing")
      expect(patient?.healAttempts).toBe(1)

      const all = yield* store.listAll()
      const docs = all.filter((j) => j.id.startsWith("doctor-"))
      expect(docs).toHaveLength(1)
      expect(docs[0]?.kind).toBe("workflow")
      expect(docs[0]?.payload.source).toBe("doctor-workflow")
    })
    await Effect.runPromise(
      program.pipe(
        Effect.provide(JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))),
      ),
    )
  })

  it("maybeEnqueueDoctor skips when below threshold", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      const result = yield* maybeEnqueueDoctor(
        store,
        baseJob({ failStreak: 1, orphanStreak: 0 }),
        "err",
        resolveDoctorEnqueueConfig({ failStreakThreshold: 5 }),
        Date.now(),
      )
      expect(result.enqueued).toBe(false)
      expect(result.reason).toBe("below_threshold")
    })
    await Effect.runPromise(
      program.pipe(
        Effect.provide(JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))),
      ),
    )
  })
})
