import { afterEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { JobsStoreService } from "../jobs/jobs-store.js"
import {
  isDoctorExemptKind,
  isDoctorWorkflowJob,
  maybeEnqueueDoctor,
  patientIdFromDoctorJob,
  resolveDoctorCliPath,
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
  const savedEnv = {
    LUNA_DOCTOR_CLI: process.env["LUNA_DOCTOR_CLI"],
    LUNA_REPO_ROOT: process.env["LUNA_REPO_ROOT"],
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

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

  describe("resolveDoctorCliPath", () => {
    it("prefers an explicit override over any env var", () => {
      process.env["LUNA_DOCTOR_CLI"] = "/env/luna-doctor-workflow.ts"
      process.env["LUNA_REPO_ROOT"] = "/repo/root"
      expect(resolveDoctorCliPath("/override/luna-doctor-workflow.ts")).toBe(
        "/override/luna-doctor-workflow.ts",
      )
    })

    it("falls back to LUNA_DOCTOR_CLI when no override is given", () => {
      process.env["LUNA_DOCTOR_CLI"] = "/env/luna-doctor-workflow.ts"
      expect(resolveDoctorCliPath()).toBe("/env/luna-doctor-workflow.ts")
    })

    it("resolves from cwd when neither override nor LUNA_DOCTOR_CLI is set (the running tree, never LUNA_REPO_ROOT)", () => {
      delete process.env["LUNA_DOCTOR_CLI"]
      // On releases-layout hosts LUNA_REPO_ROOT is the deploy root, where no
      // source exists; a value here must have no effect on code-path lookup.
      process.env["LUNA_REPO_ROOT"] = "/deploy/root"
      expect(resolveDoctorCliPath()).toBe(
        join(process.cwd(), "apps/server/scripts/luna-doctor-workflow.ts"),
      )
      // Guards the S08 incident itself: if a future relocation moves the CLI
      // without correcting this default, doctorCliReachable() silently
      // degrades to warn+skip - so the resolved default must actually exist
      // on disk (run from the repo root, as CI and the unit both do).
      expect(existsSync(resolveDoctorCliPath())).toBe(true)
    })
  })

  it("maybeEnqueueDoctor skips when CLI path is missing (does not disable patient)", async () => {
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({
        id: "sched-cli-miss",
        kind: "prompt",
        spec: "0 0 * * *",
        payload: { label: "x" },
      })
      const job = (yield* store.getById("sched-cli-miss"))!
      const result = yield* maybeEnqueueDoctor(
        store,
        { ...job, failStreak: 5 },
        "boom",
        resolveDoctorEnqueueConfig({
          failStreakThreshold: 5,
          cliPath: "/no/such/luna-doctor-workflow.ts",
        }),
        Date.now(),
      )
      expect(result.enqueued).toBe(false)
      expect(result.reason).toBe("cli_unreachable")
      const patient = yield* store.getById("sched-cli-miss")
      expect(patient?.enabled).toBe(true)
      expect(patient?.healState).toBe("ok")
    })
    await Effect.runPromise(
      program.pipe(
        Effect.provide(JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))),
      ),
    )
  })

  it("maybeEnqueueDoctor short-circuits when the env-resolved CLI path is missing (reason recorded, no enqueue, no pause)", async () => {
    process.env["LUNA_DOCTOR_CLI"] = "/no/such/luna-doctor-workflow.ts"
    const program = Effect.gen(function* () {
      const store = yield* JobsStoreService
      yield* store.record({
        id: "sched-repo-root-miss",
        kind: "prompt",
        spec: "0 0 * * *",
        payload: { label: "x" },
      })
      const job = (yield* store.getById("sched-repo-root-miss"))!
      const result = yield* maybeEnqueueDoctor(
        store,
        { ...job, failStreak: 5 },
        "boom",
        resolveDoctorEnqueueConfig({ failStreakThreshold: 5 }),
        Date.now(),
      )
      expect(result.enqueued).toBe(false)
      expect(result.reason).toBe("cli_unreachable")
      const patient = yield* store.getById("sched-repo-root-miss")
      expect(patient?.enabled).toBe(true)
      expect(patient?.healState).toBe("ok")
      const all = yield* store.listAll()
      expect(all.filter((j) => j.id.startsWith("doctor-"))).toHaveLength(0)
    })
    await Effect.runPromise(
      program.pipe(
        Effect.provide(JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))),
      ),
    )
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
          cliPath: process.cwd() + "/apps/server/scripts/luna-doctor-workflow.ts",
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
