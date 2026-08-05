#!/usr/bin/env bun
/**
 * luna-doctor-workflow — CLI steps for the doctor kind=workflow pipeline.
 *
 * Subcommands (each takes --state-dir):
 *   diagnose  — classify remedy from finding.json
 *   backup    — snapshot patient via JobHealApi (requires job patient)
 *   apply     — backup-gated patch from plan.json (or diagnosis defaults)
 *   verify    — check patient still enabled / parseable
 *   finalize  — mark success or rollback+exit non-zero for retry budget
 *
 * State dir files:
 *   finding.json, diagnosis.json, backup.json, plan.json (optional),
 *   before.json (optional copy), finalize.json
 *
 * Usage:
 *   bun run apps/ui-web/scripts/luna-doctor-workflow.ts diagnose --state-dir /path
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import {
  Clock,
  JobsStoreService,
  makeJobHealApi,
  DoctorBackupStore,
  type DoctorFinding,
  type RemedyClass,
} from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { resolveRuntimePaths } from "../src/runtime-paths.js"

const args = process.argv.slice(2)
const cmd = args[0] ?? ""
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  return args[i + 1]
}
const stateDir = flag("--state-dir")
const attempt = Math.max(1, Number(flag("--attempt") ?? "1") || 1)

if (!cmd || !stateDir) {
  console.error(
    "usage: luna-doctor-workflow <diagnose|backup|apply|verify|finalize> --state-dir <dir> [--attempt N]",
  )
  process.exit(2)
}

const readJson = <T>(name: string): T => {
  const p = join(stateDir, name)
  if (!existsSync(p)) throw new Error(`missing ${p}`)
  return JSON.parse(readFileSync(p, "utf8")) as T
}

const writeJson = (name: string, value: unknown): void => {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, name), JSON.stringify(value, null, 2), "utf8")
}

const classify = (finding: DoctorFinding): RemedyClass => {
  if (!finding.autoEligible) return "escalate"
  if (finding.suggestedRemedy !== "auto") return finding.suggestedRemedy
  if (finding.patient.kind === "job") return "patch"
  if (finding.patient.kind === "service") return "restart"
  return "unstuck"
}

const makeHeal = () => {
  const paths = resolveRuntimePaths()
  const clockL = Clock.Default
  const jobsL = JobsStoreService.makeLayer(paths.lunaDbPath).pipe(
    Layer.provide(clockL),
    Layer.provide(LunaSqliteBootstrapLive),
  )
  const rt = ManagedRuntime.make(jobsL)
  return {
    rt,
    run: <A>(eff: Effect.Effect<A, string, JobsStoreService>) =>
      rt.runPromise(eff.pipe(Effect.provide(jobsL))),
  }
}

const main = async (): Promise<void> => {
  if (cmd === "diagnose") {
    const finding = readJson<DoctorFinding>("finding.json")
    const remedy = classify(finding)
    writeJson("diagnosis.json", {
      remedyClass: remedy,
      patient: finding.patient,
      summary: finding.summary,
      at: Date.now(),
    })
    console.log(JSON.stringify({ ok: true, remedyClass: remedy }))
    return
  }

  if (cmd === "backup") {
    const finding = readJson<DoctorFinding>("finding.json")
    const diagnosis = existsSync(join(stateDir, "diagnosis.json"))
      ? readJson<{ remedyClass: RemedyClass }>("diagnosis.json")
      : { remedyClass: "patch" as RemedyClass }
    if (finding.patient.kind !== "job") {
      writeJson("backup.json", {
        skipped: true,
        reason: "non-job patient — no jobs-table backup",
      })
      console.log(JSON.stringify({ ok: true, skipped: true }))
      return
    }
    if (diagnosis.remedyClass === "escalate") {
      writeJson("backup.json", { skipped: true, reason: "escalate" })
      console.log(JSON.stringify({ ok: true, skipped: true }))
      return
    }
    const { rt, run } = makeHeal()
    try {
      const jobs = await rt.runPromise(
        Effect.gen(function* () {
          return yield* JobsStoreService
        }),
      )
      const backups = new DoctorBackupStore()
      const heal = makeJobHealApi({ jobs, backups })
      const backupId = await run(
        heal.backupPatient(finding.patient.id, {
          finding,
          attempt,
          remedyClass: diagnosis.remedyClass,
        }),
      )
      const before = backups.readBefore(backupId)
      writeJson("backup.json", { backupId, at: Date.now() })
      if (before) writeJson("before.json", before)
      console.log(JSON.stringify({ ok: true, backupId }))
    } finally {
      await rt.dispose()
    }
    return
  }

  if (cmd === "apply") {
    const finding = readJson<DoctorFinding>("finding.json")
    const diagnosis = readJson<{ remedyClass: RemedyClass }>("diagnosis.json")
    const backup = existsSync(join(stateDir, "backup.json"))
      ? readJson<{ backupId?: string; skipped?: boolean }>("backup.json")
      : {}
    if (finding.patient.kind !== "job") {
      console.error("apply only supports job patients in B0")
      process.exit(1)
    }
    if (diagnosis.remedyClass === "escalate") {
      console.log(JSON.stringify({ ok: true, skipped: true, reason: "escalate" }))
      return
    }
    if (diagnosis.remedyClass === "restart") {
      console.error(
        "restart remedy not auto-applied in B0 — escalate or run manually",
      )
      process.exit(1)
    }
    if (!backup.backupId) {
      console.error("apply refused: no backupId (backup step must succeed first)")
      process.exit(1)
    }

    // Prefer plan.json from prompt step if present; else default max_turns bump.
    let plan: {
      patch?: Record<string, unknown>
      escalate?: boolean
      intent?: string
      diagnosis?: string
    } = {}
    if (existsSync(join(stateDir, "plan.json"))) {
      plan = readJson("plan.json")
    } else {
      // Heuristic default when LLM plan was not captured to disk:
      // raise max_turns if evidence suggests turn exhaustion.
      const evidence = finding.evidence ?? {}
      const err = String(evidence["last_error"] ?? finding.summary)
      if (/max(?:imum)?\s*turns|max_turns/i.test(err)) {
        plan = {
          intent: "recover scheduled work",
          diagnosis: "max_turns too low",
          patch: { max_turns: 20 },
        }
      } else {
        plan = {
          intent: finding.summary,
          diagnosis: "generic chronic failure",
          patch: { max_turns: 15 },
        }
      }
    }
    if (plan.escalate) {
      console.error("plan requested escalate")
      process.exit(1)
    }

    const { rt, run } = makeHeal()
    try {
      const jobs = await rt.runPromise(
        Effect.gen(function* () {
          return yield* JobsStoreService
        }),
      )
      const heal = makeJobHealApi({
        jobs,
        backups: new DoctorBackupStore(),
      })
      const payloadPatch = plan.patch ?? {}
      await run(
        heal.patchPatient(finding.patient.id, backup.backupId, {
          payload: payloadPatch,
          enabled: true,
          nextRunAt: Date.now() + 5_000,
          resetStreaks: true,
          lastStatus: "fired",
        }),
      )
      writeJson("apply.json", {
        ok: true,
        backupId: backup.backupId,
        patch: payloadPatch,
        at: Date.now(),
      })
      console.log(JSON.stringify({ ok: true, patch: payloadPatch }))
    } finally {
      await rt.dispose()
    }
    return
  }

  if (cmd === "verify") {
    const finding = readJson<DoctorFinding>("finding.json")
    if (finding.patient.kind !== "job") {
      writeJson("verify.json", { ok: true, skipped: true })
      console.log(JSON.stringify({ ok: true, skipped: true }))
      return
    }
    const { rt } = makeHeal()
    try {
      const job = await rt.runPromise(
        Effect.gen(function* () {
          const jobs = yield* JobsStoreService
          return yield* jobs.getById(finding.patient.id)
        }),
      )
      if (!job) {
        writeJson("verify.json", { ok: false, reason: "missing" })
        console.error("verify failed: job missing")
        process.exit(1)
      }
      if (!job.enabled) {
        writeJson("verify.json", { ok: false, reason: "disabled" })
        console.error("verify failed: job still disabled")
        process.exit(1)
      }
      // Payload must still parse (it is an object if we got here).
      writeJson("verify.json", {
        ok: true,
        enabled: job.enabled,
        max_turns: (job.payload as { max_turns?: number }).max_turns,
      })
      console.log(JSON.stringify({ ok: true }))
    } finally {
      await rt.dispose()
    }
    return
  }

  if (cmd === "finalize") {
    const finding = readJson<DoctorFinding>("finding.json")
    const verifyOk =
      existsSync(join(stateDir, "verify.json")) &&
      (readJson<{ ok?: boolean }>("verify.json").ok === true)
    const backup = existsSync(join(stateDir, "backup.json"))
      ? readJson<{ backupId?: string }>("backup.json")
      : {}

    if (verifyOk) {
      writeJson("finalize.json", { ok: true, at: Date.now() })
      console.log(JSON.stringify({ ok: true, result: "healed" }))
      return
    }

    // Rollback if we have a backup
    if (backup.backupId && finding.patient.kind === "job") {
      const { rt, run } = makeHeal()
      try {
        const jobs = await rt.runPromise(
          Effect.gen(function* () {
            return yield* JobsStoreService
          }),
        )
        const heal = makeJobHealApi({
          jobs,
          backups: new DoctorBackupStore(),
        })
        await run(heal.restoreFromBackup(backup.backupId))
        writeJson("finalize.json", {
          ok: false,
          rolled_back: true,
          backupId: backup.backupId,
          at: Date.now(),
        })
      } finally {
        await rt.dispose()
      }
    } else {
      writeJson("finalize.json", { ok: false, rolled_back: false, at: Date.now() })
    }
    // Non-zero so halt_on_failure / attempt budget can react on auto path.
    console.error("finalize: verify failed; rolled back if backup present")
    process.exit(1)
  }

  console.error(`unknown subcommand: ${cmd}`)
  process.exit(2)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
