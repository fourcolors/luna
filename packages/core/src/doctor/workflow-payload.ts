/**
 * buildDoctorWorkflowPayload — single source of truth for the doctor
 * kind=workflow step pipeline (manual run + auto-enqueue).
 *
 * Steps (halt_on_failure=true):
 *   0 diagnose  — classify remedy (CLI)
 *   1 backup    — always for patch/unstuck (CLI)
 *   2 plan      — optional LLM plan for patch (prompt step; no DB writes)
 *   3 apply     — backup-gated mutate (CLI)
 *   4 verify    — re-probe (CLI)
 *   5 finalize  — success / rollback / escalate (CLI)
 */
import { join } from "node:path"
import { homedir } from "node:os"
import type {
  DoctorFinding,
  DoctorWorkflowPayload,
  DoctorWorkflowStep,
} from "./types.js"
import { DOCTOR_WORKFLOW_LABEL, DOCTOR_WORKFLOW_SOURCE } from "./types.js"

export interface BuildDoctorWorkflowOptions {
  /** Absolute path to the luna-doctor-workflow CLI entry (bun script). */
  readonly cliPath: string
  /** Luna home for state dir (default LUNA_HOME or ~/.luna). */
  readonly lunaHome?: string
  /** bun executable (default process.execPath or "bun"). */
  readonly bunBin?: string
}

const resolveLunaHome = (override?: string): string =>
  override?.trim() ||
  process.env["LUNA_HOME"]?.trim() ||
  join(homedir(), ".luna")

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * Deterministic state directory for one doctor run (finding id + attempt).
 * Shared across steps via filesystem handoff.
 */
export const doctorRunStateDir = (
  finding: DoctorFinding,
  attempt: number,
  lunaHome?: string,
): string =>
  join(
    resolveLunaHome(lunaHome),
    "doctor-runs",
    `${finding.patient.kind}_${finding.patient.id}_a${attempt}_${finding.id}`.replace(
      /[^a-zA-Z0-9._-]+/g,
      "_",
    ),
  )

export const buildDoctorWorkflowPayload = (
  finding: DoctorFinding,
  doctorAttempt: number,
  opts: BuildDoctorWorkflowOptions,
): DoctorWorkflowPayload => {
  const attempt = Math.max(1, Math.trunc(doctorAttempt) || 1)
  const stateDir = doctorRunStateDir(finding, attempt, opts.lunaHome)
  const bun = opts.bunBin ?? process.env["BUN_BIN"]?.trim() ?? "bun"
  const cli = opts.cliPath
  const findingJson = JSON.stringify(finding)
  // Seed finding.json then run subcommands that read/write the state dir.
  const seed = [
    `mkdir -p ${shellQuote(stateDir)}`,
    `cat > ${shellQuote(join(stateDir, "finding.json"))} <<'LUNADOCTOR_EOF'`,
    findingJson,
    `LUNADOCTOR_EOF`,
  ].join("\n")

  const runCli = (sub: string, extra = ""): string =>
    `${shellQuote(bun)} ${shellQuote(cli)} ${sub} --state-dir ${shellQuote(stateDir)} --attempt ${attempt}${extra ? ` ${extra}` : ""}`

  const steps: DoctorWorkflowStep[] = [
    {
      kind: "shell",
      timeout_ms: 60_000,
      cmd: `${seed}\n${runCli("diagnose")}`,
    },
    {
      kind: "shell",
      timeout_ms: 60_000,
      cmd: runCli("backup"),
    },
    {
      kind: "prompt",
      max_turns: 12,
      timeout_ms: 600_000,
      allowed_tools: ["Read", "Grep", "Glob", "Bash"],
      system_prompt:
        "You are Luna's Job Doctor planner. You do NOT write the jobs database. " +
        "Read the diagnosis and patient snapshot under the state directory if needed. " +
        "Output ONLY a single JSON object for the patch plan (no markdown fences): " +
        '{"intent":"...","diagnosis":"...","patch":{"max_turns"?:number,"timeout_ms"?:number,"user_prompt"?:string,"allowed_tools"?:string[]},"rationale":"..."}. ' +
        "Preserve the original mission. Prefer fixing max_turns/tools/timeouts over inventing new work. " +
        "If intent is unclear, set patch to {} and put escalate:true.",
      user_prompt:
        `Doctor attempt ${attempt} for patient ${finding.patient.kind}:${finding.patient.id}.\n` +
        `Summary: ${finding.summary}\n` +
        `State dir: ${stateDir}\n` +
        `Read ${join(stateDir, "diagnosis.json")} and ${join(stateDir, "before.json")} if present, ` +
        `then write your plan JSON to stdout only.`,
    },
    {
      kind: "shell",
      timeout_ms: 60_000,
      cmd: runCli("apply"),
    },
    {
      kind: "shell",
      timeout_ms: 60_000,
      cmd: runCli("verify"),
    },
    {
      kind: "shell",
      timeout_ms: 60_000,
      cmd: runCli("finalize"),
    },
  ]

  return {
    label: DOCTOR_WORKFLOW_LABEL,
    source: DOCTOR_WORKFLOW_SOURCE,
    halt_on_failure: true,
    finding,
    doctor_attempt: attempt,
    steps,
  }
}

/** Build a unique one-shot job id for a doctor workflow run. */
export const doctorWorkflowJobId = (
  finding: DoctorFinding,
  attempt: number,
): string => {
  const rand = Math.random().toString(36).slice(2, 8)
  return `doctor-${finding.patient.kind}-${finding.patient.id}-a${attempt}-${rand}`.replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  )
}
