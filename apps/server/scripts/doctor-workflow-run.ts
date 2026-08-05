#!/usr/bin/env bun
/**
 * doctor-workflow-run — enqueue a one-shot doctor workflow for a patient.
 *
 * Usage:
 *   bun run apps/ui-web/scripts/doctor-workflow-run.ts --patient job:<id>
 *   bun run apps/ui-web/scripts/doctor-workflow-run.ts --patient job:sched-xxx --attempt 1
 *   bun run apps/ui-web/scripts/doctor-workflow-run.ts --patient job:sched-xxx --summary "max turns"
 *
 * Creates a durable one-shot kind=workflow row (empty schedule) due now.
 * The JobTicker will claim it on the next tick. Force with the server running.
 *
 * Env: LUNA_DB_PATH / LUNA_HOME (same as chat-server).
 */
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  Clock,
  JobsStoreService,
  buildDoctorWorkflowPayload,
  doctorWorkflowJobId,
  type DoctorFinding,
} from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { resolveRuntimePaths } from "../src/runtime-paths.js"

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  return args[i + 1]
}

const patientRaw = flag("--patient")
if (!patientRaw || !patientRaw.includes(":")) {
  console.error(
    "usage: doctor-workflow-run --patient job:<id> [--attempt N] [--summary text]",
  )
  process.exit(2)
}

const [pKind, ...rest] = patientRaw.split(":")
const patientId = rest.join(":")
if (pKind !== "job" || !patientId) {
  console.error("B0 only supports --patient job:<id>")
  process.exit(2)
}

const attempt = Math.max(1, Number(flag("--attempt") ?? "1") || 1)
const summary =
  flag("--summary") ??
  `Manual doctor run for job:${patientId} (attempt ${attempt})`

const finding: DoctorFinding = {
  id: `manual-${Date.now().toString(36)}`,
  source: "manual",
  severity: "error",
  summary,
  patient: { kind: "job", id: patientId },
  evidence: { source: "doctor-workflow-run" },
  suggestedRemedy: "auto",
  autoEligible: true,
}

const paths = resolveRuntimePaths()
const here = dirname(fileURLToPath(import.meta.url))
const cliPath = resolve(here, "luna-doctor-workflow.ts")
const lunaHome =
  process.env["LUNA_HOME"]?.trim() ||
  join(process.env["HOME"] ?? "/root", ".luna")

const payload = buildDoctorWorkflowPayload(finding, attempt, {
  cliPath,
  lunaHome,
  bunBin: process.execPath.includes("bun") ? process.execPath : "bun",
})

const jobId = doctorWorkflowJobId(finding, attempt)

const clockL = Clock.Default
const jobsL = JobsStoreService.makeLayer(paths.lunaDbPath).pipe(
  Layer.provide(clockL),
  Layer.provide(LunaSqliteBootstrapLive),
)

const rt = ManagedRuntime.make(jobsL)

const prog = Effect.gen(function* () {
  const store = yield* JobsStoreService
  const existing = yield* store.getById(patientId)
  if (!existing) {
    return yield* Effect.fail(`patient job not found: ${patientId}`)
  }
  // Pause patient while doctor runs (manual path mirrors auto).
  yield* store.setV2Fields(patientId, { enabled: false })
  yield* store.touch(patientId, { lastStatus: "errored" })

  const job = yield* store.record({
    id: jobId,
    kind: "workflow",
    spec: "", // one-shot
    payload: {
      ...payload,
      label: "doctor",
      source: "doctor-workflow",
    },
    enabled: true,
    nextRunAt: Date.now(),
  })
  return job
})

rt.runPromise(prog)
  .then((job) => {
    console.log(
      JSON.stringify(
        {
          ok: true,
          doctorJobId: job.id,
          patientId,
          attempt,
          findingId: finding.id,
          nextRunAt: job.nextRunAt,
          hint: "ensure chat-server / JobTicker is running to claim the one-shot",
        },
        null,
        2,
      ),
    )
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    void rt.dispose()
  })
