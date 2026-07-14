import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Clock } from "../clock.js"
import { JobsStoreService } from "../jobs/jobs-store.js"
import { makeJobHealApi } from "./job-heal.js"
import { DoctorBackupStore } from "./backup-store.js"
import type { DoctorFinding } from "./types.js"

const findingFor = (jobId: string): DoctorFinding => ({
  id: `f-${jobId}`,
  source: "manual",
  severity: "error",
  summary: "chronic fail",
  patient: { kind: "job", id: jobId },
  evidence: {},
  suggestedRemedy: "patch",
  autoEligible: true,
})

const withStore = <A>(prog: Effect.Effect<A, unknown, JobsStoreService>) =>
  prog.pipe(
    Effect.provide(JobsStoreService.Memory.pipe(Layer.provide(Clock.Default))),
  )

describe("JobHealApi", () => {
  it("refuses patch without a valid backupId", async () => {
    await Effect.runPromise(
      withStore(
        Effect.gen(function* () {
          const jobs = yield* JobsStoreService
          yield* jobs.record({
            id: "j1",
            kind: "prompt",
            spec: "0 9 * * 1",
            payload: { label: "x", max_turns: 1 },
            enabled: true,
          })
          const root = mkdtempSync(join(tmpdir(), "heal-"))
          const heal = makeJobHealApi({
            jobs,
            backups: new DoctorBackupStore({ rootDir: root }),
          })
          const exit = yield* Effect.either(
            heal.patchPatient("j1", "no-such-backup", {
              payload: { max_turns: 15 },
            }),
          )
          expect(exit._tag).toBe("Left")
          rmSync(root, { recursive: true, force: true })
        }),
      ),
    )
  })

  it("backup then patch max_turns and restore", async () => {
    await Effect.runPromise(
      withStore(
        Effect.gen(function* () {
          const jobs = yield* JobsStoreService
          yield* jobs.record({
            id: "j2",
            kind: "prompt",
            spec: "0 9 * * 1",
            payload: { label: "weekly", max_turns: 1, user_prompt: "review" },
            enabled: true,
          })
          const root = mkdtempSync(join(tmpdir(), "heal-"))
          const heal = makeJobHealApi({
            jobs,
            backups: new DoctorBackupStore({ rootDir: root }),
          })
          const backupId = yield* heal.backupPatient("j2", {
            finding: findingFor("j2"),
            attempt: 1,
            remedyClass: "patch",
          })
          yield* heal.patchPatient("j2", backupId, {
            payload: { max_turns: 20 },
            enabled: true,
            nextRunAt: Date.now(),
          })
          const after = yield* heal.getPatient("j2")
          expect((after.job.payload as { max_turns?: number }).max_turns).toBe(
            20,
          )
          yield* heal.restoreFromBackup(backupId)
          const restored = yield* heal.getPatient("j2")
          expect(
            (restored.job.payload as { max_turns?: number }).max_turns,
          ).toBe(1)
          rmSync(root, { recursive: true, force: true })
        }),
      ),
    )
  })
})
