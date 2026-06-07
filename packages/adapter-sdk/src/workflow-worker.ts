/**
 * WorkflowWorker — second payload-bearing Phase-12b worker (DESIGN §5.3).
 *
 * Where `prompt` is a single-turn query() invocation, `workflow` runs an
 * explicit LINEAR sequence of typed steps with per-step durable status.
 * The shape mirrors a deploy pipeline:
 *
 *   { "kind": "workflow",
 *     "steps": [
 *       { "kind": "shell",  "cmd": "git fetch origin",  "timeout_ms": 30000 },
 *       { "kind": "shell",  "cmd": "git push origin dev:master" },
 *       { "kind": "prompt", "user_prompt": "Verify deploy ok", "max_turns": 1 }
 *     ],
 *     "halt_on_failure": true
 *   }
 *
 * Result lands in `job_runs.steps_json` so the operator can inspect each
 * step's stdout/stderr/exit-code/duration after the fact.
 *
 * V1 step kinds:
 *   - `shell`  — exec a command (no shell=true; argv split via /bin/sh -c
 *                so quoting is the operator's job)
 *   - `prompt` — reuse the prompt-worker's SDK query path inline
 *
 * V1 limits:
 *   - Linear sequence ONLY — no branches, no joins (DAG is Phase 13+).
 *   - halt_on_failure: true (default) stops at first non-zero exit / SDK
 *     fail; false continues and records each step's outcome.
 *   - Each step gets a 5-min default deadline; shell steps can override
 *     via `timeout_ms`.
 *
 * Security note: shell steps execute arbitrary commands via the
 * chat-server's own privileges. Operators MUST treat workflow payloads as
 * code with full execution power. Payload injection from agent output is
 * the obvious risk vector — for V1, payloads can only be set via direct
 * `INSERT INTO jobs` or `schedule_create`, both of which are operator-
 * controlled paths.
 */
import { spawn } from "node:child_process"
import { Effect, Layer, Stream } from "effect"
import {
  AgentNotesService,
  WorkerRegistry,
  WorkerError,
  type AgentNotesApi,
  type Worker,
  type WorkerResult,
} from "@luna/core"
import { SDKClient, type SDKClientService, type SDKMessage } from "./sdk-client.js"

// ── Step types ──────────────────────────────────────────────────────────────

export interface ShellStep {
  readonly kind: "shell"
  readonly cmd: string
  readonly timeout_ms?: number
  readonly env?: Record<string, string>
}

export interface PromptStep {
  readonly kind: "prompt"
  readonly user_prompt: string
  readonly system_prompt?: string
  readonly model?: string
  readonly allowed_tools?: ReadonlyArray<string>
  readonly max_turns?: number
}

export type WorkflowStep = ShellStep | PromptStep

export interface WorkflowPayload {
  readonly steps: ReadonlyArray<WorkflowStep>
  readonly halt_on_failure?: boolean
}

// ── Step result shapes (what shows up in job_runs.steps_json) ───────────────

export interface ShellStepResult {
  readonly kind: "shell"
  readonly status: "success" | "failed" | "timeout"
  readonly cmd: string
  readonly exit_code: number | null
  readonly duration_ms: number
  readonly stdout: string
  readonly stderr: string
}

export interface PromptStepResult {
  readonly kind: "prompt"
  readonly status: "success" | "failed"
  readonly user_prompt: string
  readonly duration_ms: number
  readonly output_text?: string
  readonly error?: string
}

export type StepResult = ShellStepResult | PromptStepResult

export interface WorkflowResult {
  readonly steps: ReadonlyArray<StepResult>
  readonly halted_at: number | null
}

// ── Payload parser (pure, exported for tests) ───────────────────────────────

export function parseWorkflowPayload(raw: unknown): WorkflowPayload | string {
  if (typeof raw !== "object" || raw === null) {
    return "payload must be an object"
  }
  const p = raw as Record<string, unknown>

  const stepsRaw = p["steps"]
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    return "steps must be a non-empty array"
  }
  const steps: WorkflowStep[] = []
  for (let i = 0; i < stepsRaw.length; i++) {
    const s = stepsRaw[i] as Record<string, unknown>
    if (typeof s !== "object" || s === null) {
      return `steps[${i}] must be an object`
    }
    if (s["kind"] === "shell") {
      if (typeof s["cmd"] !== "string" || (s["cmd"] as string).length === 0) {
        return `steps[${i}].cmd must be a non-empty string`
      }
      const out: { -readonly [K in keyof ShellStep]: ShellStep[K] } = {
        kind: "shell",
        cmd: s["cmd"] as string,
      }
      if (
        typeof s["timeout_ms"] === "number" &&
        Number.isFinite(s["timeout_ms"])
      ) {
        out.timeout_ms = Math.max(1, Math.trunc(s["timeout_ms"] as number))
      }
      if (typeof s["env"] === "object" && s["env"] !== null) {
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries(s["env"])) {
          if (typeof v === "string") env[k] = v
        }
        out.env = env
      }
      steps.push(out)
    } else if (s["kind"] === "prompt") {
      if (
        typeof s["user_prompt"] !== "string" ||
        (s["user_prompt"] as string).length === 0
      ) {
        return `steps[${i}].user_prompt must be a non-empty string`
      }
      const out: { -readonly [K in keyof PromptStep]: PromptStep[K] } = {
        kind: "prompt",
        user_prompt: s["user_prompt"] as string,
      }
      if (typeof s["system_prompt"] === "string") {
        out.system_prompt = s["system_prompt"] as string
      }
      if (typeof s["model"] === "string") {
        out.model = s["model"] as string
      }
      if (Array.isArray(s["allowed_tools"])) {
        const tools: string[] = []
        for (const t of s["allowed_tools"]) {
          if (typeof t === "string") tools.push(t)
        }
        out.allowed_tools = tools
      }
      if (
        typeof s["max_turns"] === "number" &&
        Number.isFinite(s["max_turns"])
      ) {
        out.max_turns = Math.max(1, Math.trunc(s["max_turns"] as number))
      }
      steps.push(out)
    } else {
      return `steps[${i}].kind must be "shell" or "prompt" (got ${JSON.stringify(s["kind"])})`
    }
  }

  const haltOnFailure =
    p["halt_on_failure"] === undefined ? true : !!p["halt_on_failure"]
  return { steps, halt_on_failure: haltOnFailure }
}

// ── Shell step executor ─────────────────────────────────────────────────────

const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60 * 1000 // 5 min
const SHELL_MAX_BYTES = 1_048_576 // 1 MB per stream

function runShellStep(step: ShellStep): Promise<ShellStepResult> {
  return new Promise((resolve) => {
    const timeoutMs = step.timeout_ms ?? DEFAULT_SHELL_TIMEOUT_MS
    const startMs = Date.now()
    let stdoutBuf = ""
    let stderrBuf = ""
    let timedOut = false

    // shell=true via /bin/sh -c so the operator's quoting works.
    const child = spawn("/bin/sh", ["-c", step.cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...step.env },
    })

    const killTimer = setTimeout(() => {
      timedOut = true
      try {
        child.kill("SIGTERM")
        setTimeout(() => {
          try { child.kill("SIGKILL") } catch { /* dead */ }
        }, 2000).unref()
      } catch { /* already dead */ }
    }, timeoutMs)
    killTimer.unref()

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      const remaining = SHELL_MAX_BYTES - stdoutBuf.length
      if (remaining <= 0) return
      stdoutBuf += remaining < text.length ? text.slice(0, remaining) : text
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      const remaining = SHELL_MAX_BYTES - stderrBuf.length
      if (remaining <= 0) return
      stderrBuf += remaining < text.length ? text.slice(0, remaining) : text
    })

    child.once("close", (code) => {
      clearTimeout(killTimer)
      const exitCode = code
      const duration = Date.now() - startMs
      if (timedOut) {
        resolve({
          kind: "shell",
          status: "timeout",
          cmd: step.cmd,
          exit_code: exitCode,
          duration_ms: duration,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        })
      } else if (exitCode === 0) {
        resolve({
          kind: "shell",
          status: "success",
          cmd: step.cmd,
          exit_code: 0,
          duration_ms: duration,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        })
      } else {
        resolve({
          kind: "shell",
          status: "failed",
          cmd: step.cmd,
          exit_code: exitCode,
          duration_ms: duration,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        })
      }
    })

    child.once("error", (err) => {
      clearTimeout(killTimer)
      resolve({
        kind: "shell",
        status: "failed",
        cmd: step.cmd,
        exit_code: null,
        duration_ms: Date.now() - startMs,
        stdout: stdoutBuf,
        stderr: `spawn error: ${err.message}\n${stderrBuf}`,
      })
    })
  })
}

// ── Prompt step executor (reuses SDK pattern from prompt-worker) ───────────

function runPromptStep(
  step: PromptStep,
  sdk: SDKClientService,
): Effect.Effect<PromptStepResult, never> {
  return Effect.gen(function* () {
    const startMs = Date.now()
    const prompt = step.system_prompt
      ? `${step.system_prompt}\n\n${step.user_prompt}`
      : step.user_prompt

    const result = yield* sdk
      .query({
        prompt,
        options: {
          maxTurns: step.max_turns ?? 1,
          ...(step.allowed_tools
            ? { allowedTools: [...step.allowed_tools] }
            : {}),
          ...(step.model ? { model: step.model } : {}),
        },
      })
      .pipe(
        Effect.flatMap((query) =>
          Stream.fromAsyncIterable(query, (cause) => cause).pipe(
            Stream.runFold(
              null as string | null,
              (acc: string | null, msg: SDKMessage) => {
                const m = msg as {
                  type?: string
                  subtype?: string
                  result?: string
                }
                if (
                  m.type === "result" &&
                  m.subtype === "success" &&
                  typeof m.result === "string"
                ) {
                  return m.result
                }
                return acc
              },
            ),
          ),
        ),
        Effect.either,
      )

    const duration = Date.now() - startMs
    if (result._tag === "Right" && result.right !== null) {
      return {
        kind: "prompt",
        status: "success",
        user_prompt: step.user_prompt,
        duration_ms: duration,
        output_text: result.right,
      } satisfies PromptStepResult
    }
    return {
      kind: "prompt",
      status: "failed",
      user_prompt: step.user_prompt,
      duration_ms: duration,
      error:
        result._tag === "Left"
          ? `sdk error: ${String(result.left)}`
          : "sdk stream produced no type:result/subtype:success message",
    } satisfies PromptStepResult
  })
}

// ── Closure builder ─────────────────────────────────────────────────────────

export const buildWorkflowWorker = (
  sdk: SDKClientService,
  _notes: AgentNotesApi | null,
): Worker<never> => {
  return (rawPayload, _ctx) =>
    Effect.gen(function* () {
      const parsed = parseWorkflowPayload(rawPayload)
      if (typeof parsed === "string") {
        return yield* Effect.fail(
          new WorkerError({
            reason: "bad_payload",
            kind: "workflow",
            message: parsed,
          }),
        )
      }

      const stepResults: StepResult[] = []
      let haltedAt: number | null = null

      for (let i = 0; i < parsed.steps.length; i++) {
        const step = parsed.steps[i]!
        let result: StepResult
        if (step.kind === "shell") {
          result = yield* Effect.promise(() => runShellStep(step))
        } else {
          result = yield* runPromptStep(step, sdk)
        }
        stepResults.push(result)
        if (result.status !== "success" && parsed.halt_on_failure) {
          haltedAt = i
          break
        }
      }

      const workflowResult: WorkflowResult = {
        steps: stepResults,
        halted_at: haltedAt,
      }

      // Roll up: if any step failed AND halt_on_failure was true, the worker
      // itself fails so the ticker records job_runs.status='failed'. If
      // halt_on_failure was false, the worker returns success even if some
      // steps failed — the operator sees per-step status in steps_json.
      const anyFailed = stepResults.some((r) => r.status !== "success")
      if (anyFailed && parsed.halt_on_failure) {
        return yield* Effect.fail(
          new WorkerError({
            reason: "worker_failed",
            kind: "workflow",
            message: `workflow halted at step ${haltedAt} (status=${stepResults[haltedAt!]?.status})`,
            cause: workflowResult,
            // Pass the partial per-step record through the error channel so
            // the ticker can still persist `job_runs.steps_json` on halt.
            // Without this the operator loses the per-step audit trail
            // exactly when they most need it (a failed run).
            stepsJson: JSON.stringify(workflowResult),
          }),
        )
      }

      return {
        outputText:
          stepResults
            .map((r, i) =>
              r.kind === "shell"
                ? `[${i}] shell exit=${r.exit_code} (${r.status})`
                : `[${i}] prompt (${r.status}, ${r.duration_ms}ms)`,
            )
            .join("\n") || null,
        stepsJson: JSON.stringify(workflowResult),
      } satisfies WorkerResult
    })
}

// ── Layer ───────────────────────────────────────────────────────────────────

export interface WorkflowWorkerLayerOptions {
  readonly kind?: string
}

export const WorkflowWorkerLayer = (
  opts?: WorkflowWorkerLayerOptions,
): Layer.Layer<never, never, SDKClient | WorkerRegistry | AgentNotesService> => {
  const kind = opts?.kind ?? "workflow"
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const sdk = yield* SDKClient
      const reg = yield* WorkerRegistry
      const notes = yield* AgentNotesService
      const worker = buildWorkflowWorker(sdk, notes)
      yield* reg.register(kind, worker)
    }),
  )
}
