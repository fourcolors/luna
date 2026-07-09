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
 *   - Each step gets a default wall-clock deadline (shell 5 min, prompt
 *     10 min) that either kind can override via `timeout_ms`. A prompt step
 *     that exceeds it is recorded `status:"timeout"` and its SDK subprocess
 *     is aborted - a hung turn cannot wedge the single-fiber V2 ticker. A
 *     shell step past its deadline, OR whose dispatch is interrupted
 *     (ticker backstop), is killed by process GROUP (issue #277 Seam B,
 *     `detached: true` + `process.kill(-pid, …)`) so a grandchild it spawned
 *     (e.g. `ssh` under `git push`) cannot outlive it.
 *
 * Security note: shell steps execute arbitrary commands via the
 * chat-server's own privileges. Operators MUST treat workflow payloads as
 * code with full execution power. Payload injection from agent output is
 * the obvious risk vector — for V1, payloads can only be set via direct
 * `INSERT INTO jobs` or `schedule_create`, both of which are operator-
 * controlled paths.
 */
import { spawn } from "node:child_process"
import { Effect, Layer, Option } from "effect"
import {
  AgentNotesService,
  WorkerRegistry,
  WorkerError,
  type AgentNotesApi,
  type Worker,
  type WorkerResult,
} from "@luna/core"
import { SDKClient, type SDKClientService } from "./sdk-client.js"
import { runBoundedQuery, DEFAULT_QUERY_TIMEOUT_MS } from "./bounded-query.js"
import {
  JobRunToolsProviderTag,
  type JobRunToolsBinding,
  type JobRunToolsProvider,
} from "./job-run-tools.js"

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
  /**
   * Wall-clock ceiling for the whole agent turn(s), mirroring `ShellStep`.
   * On expiry the step is recorded `status:"timeout"` and the SDK subprocess
   * is aborted. Defaults to `DEFAULT_QUERY_TIMEOUT_MS` (10 min) when omitted — a
   * hung turn must not be able to wedge the single-fiber V2 ticker.
   */
  readonly timeout_ms?: number
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
  readonly status: "success" | "failed" | "timeout"
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
      if (
        typeof s["timeout_ms"] === "number" &&
        Number.isFinite(s["timeout_ms"])
      ) {
        out.timeout_ms = Math.max(1, Math.trunc(s["timeout_ms"] as number))
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

// job-ticker-oban-deadlines (Seam 2 boot wiring) — the whole-dispatch ceiling
// registered with the WorkerRegistry (see WorkflowWorkerLayer below), NOT a
// per-step timeout. A workflow's payload is a step list whose individual
// `timeout_ms` overrides (prompt steps up to DEFAULT_QUERY_TIMEOUT_MS=10min,
// shell steps up to DEFAULT_SHELL_TIMEOUT_MS=5min each) can sum past 10
// minutes across several steps, so the registered default is wider than a
// single prompt worker's. A per-payload top-level `timeout_ms` still
// overrides this at dispatch time (job-ticker.ts's Seam-1 resolution).
const WORKFLOW_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000 // 20 min

/**
 * issue #277 (Seam B): `signal`, when passed, aborts the shell step in
 * response to the caller's dispatch being interrupted (the ticker backstop,
 * or a future producer/executor split) - see the `Effect.async` wrapper at
 * the call site below. Optional (defaults to no signal) so the existing
 * unit tests that call this function directly keep working unchanged.
 */
function runShellStep(
  step: ShellStep,
  signal?: AbortSignal,
): Promise<ShellStepResult> {
  return new Promise((resolve) => {
    const timeoutMs = step.timeout_ms ?? DEFAULT_SHELL_TIMEOUT_MS
    const startMs = Date.now()
    let stdoutBuf = ""
    let stderrBuf = ""
    let timedOut = false
    let aborted = false
    // `settled` guards every kill path (timeout timer, escalation timer,
    // abort listener) against firing AFTER the child has already been
    // reaped ('close'/'error'). Without it, a kill scheduled just before
    // reap can run just after - and `-pid` targets a process GROUP id that
    // the OS is free to recycle onto an unrelated process the instant ours
    // exits, so a late group-kill risks signalling a stranger, not just
    // throwing ESRCH.
    let settled = false

    // shell=true via /bin/sh -c so the operator's quoting works.
    // detached:true gives the shell its OWN process group (pgid === its own
    // pid), which is what makes `process.kill(-child.pid, sig)` below safe:
    // a grandchild spawned by the shell (e.g. `ssh` under `git push`) is a
    // member of that group and dies with it. LOUD WARNING: `-pid` group-kill
    // is correct ONLY because of `detached: true` here - WITHOUT it the
    // child shares node's OWN process group, and a `-pid` kill would signal
    // the ticker's own group (suicide). Never issue a `-pid` kill on a
    // non-detached child.
    const child = spawn("/bin/sh", ["-c", step.cmd], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...step.env },
      detached: true,
    })

    // Signal the whole process group, not just the immediate child, so a
    // long-lived grandchild (git's ssh, a pushed-through subprocess) cannot
    // outlive a killed/timed-out/aborted step. Guarded by `settled` and
    // wrapped in try/catch: ESRCH (already reaped) is expected and benign; on
    // ANY throw we fall back to `child.kill()` rather than propagate, since
    // this always runs from a timer or abort callback with no caller to
    // report to.
    const killGroup = (sig: NodeJS.Signals) => {
      if (settled) return
      if (child.pid === undefined) {
        try { child.kill(sig) } catch { /* already dead */ }
        return
      }
      try {
        process.kill(-child.pid, sig)
      } catch {
        try { child.kill(sig) } catch { /* already dead */ }
      }
    }

    const killTimer = setTimeout(() => {
      timedOut = true
      killGroup("SIGTERM")
      const escalate = setTimeout(() => killGroup("SIGKILL"), 2000)
      escalate.unref()
    }, timeoutMs)
    killTimer.unref()

    // Abort wiring (issue #277 Seam B): when the caller's dispatch is
    // interrupted (ticker backstop / Fiber.interrupt), kill the group the
    // same way the timeout path does - mirroring bounded-query.ts's
    // onInterrupt→abort pattern so a hung shell command cannot outlive its
    // dispatch the way it could before this seam (only push-through's own
    // LOCK_DIR saved it).
    const onAbort = () => {
      if (settled) return
      aborted = true
      killGroup("SIGTERM")
      const escalate = setTimeout(() => killGroup("SIGKILL"), 2000)
      escalate.unref()
    }
    signal?.addEventListener("abort", onAbort)

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
      settled = true
      clearTimeout(killTimer)
      signal?.removeEventListener("abort", onAbort)
      const exitCode = code
      const duration = Date.now() - startMs
      if (aborted) {
        // Keep the wire shape stable (no new status value) so existing
        // steps_json consumers (the UI gallery) keep rendering it - a
        // failed step with a distinguishing stderr prefix.
        resolve({
          kind: "shell",
          status: "failed",
          cmd: step.cmd,
          exit_code: null,
          duration_ms: duration,
          stdout: stdoutBuf,
          stderr: `aborted: dispatch interrupted\n${stderrBuf}`,
        })
      } else if (timedOut) {
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
      settled = true
      clearTimeout(killTimer)
      signal?.removeEventListener("abort", onAbort)
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

// ── Prompt step executor ────────────────────────────────────────────────────

function runPromptStep(
  step: PromptStep,
  sdk: SDKClientService,
  binding: JobRunToolsBinding | null = null,
): Effect.Effect<PromptStepResult, never> {
  return Effect.gen(function* () {
    const startMs = Date.now()
    // Per-run tool wiring (request_input): the addendum joins the step's
    // own system text; tools/server are spliced into the options below.
    const systemText = [
      ...(step.system_prompt ? [step.system_prompt] : []),
      ...(binding ? [binding.systemPromptAddendum] : []),
    ].join("\n\n")
    const prompt = systemText
      ? `${systemText}\n\n${step.user_prompt}`
      : step.user_prompt
    const allowedTools = [
      ...(step.allowed_tools ?? []),
      ...(binding ? binding.allowedTools : []),
    ]

    // INVARIANT: the effective timeout MUST stay well under push-through's
    // worktree-lock staleness (`LOCK_STALE_S`, 3600s). A timed-out prompt step
    // is non-success → with `halt_on_failure` the workflow stops BEFORE the
    // gate/ship steps that release the lock, so the lock falls to the staleness
    // reclaim. The 10-min default leaves a 6× margin. See
    // apps/ui-web/scripts/push-through-install.ts.
    const timeoutMs = step.timeout_ms ?? DEFAULT_QUERY_TIMEOUT_MS

    const outcome = yield* runBoundedQuery(
      sdk,
      {
        prompt,
        options: {
          maxTurns: step.max_turns ?? 1,
          ...(allowedTools.length > 0 ? { allowedTools } : {}),
          ...(binding
            ? { mcpServers: { [binding.serverName]: binding.server } }
            : {}),
          ...(step.model ? { model: step.model } : {}),
        },
      },
      timeoutMs,
    )

    const duration = Date.now() - startMs
    const base = {
      kind: "prompt",
      user_prompt: step.user_prompt,
      duration_ms: duration,
    } as const

    switch (outcome._tag) {
      case "result":
        return {
          ...base,
          status: "success",
          output_text: outcome.text,
        } satisfies PromptStepResult
      case "timeout":
        return {
          ...base,
          status: "timeout",
          error: `prompt step exceeded timeout_ms=${outcome.timeoutMs}`,
        } satisfies PromptStepResult
      case "error":
        return {
          ...base,
          status: "failed",
          error: `sdk error: ${String(outcome.cause)}`,
        } satisfies PromptStepResult
      case "empty":
        return {
          ...base,
          status: "failed",
          error: "sdk stream produced no type:result/subtype:success message",
        } satisfies PromptStepResult
    }
  })
}

// ── Closure builder ─────────────────────────────────────────────────────────

export const buildWorkflowWorker = (
  sdk: SDKClientService,
  _notes: AgentNotesApi | null,
  jobTools: JobRunToolsProvider | null = null,
): Worker<never> => {
  return (rawPayload, ctx) =>
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

      // Per-run tool wiring (request_input, widget-system.md Phase 5). One
      // binding per dispatch — the steps run sequentially, so every prompt
      // step shares the run-scoped server (the bridge enforces one pending
      // input request per run anyway).
      const label = (rawPayload as { label?: unknown } | null)?.label
      const binding = jobTools
        ? jobTools.forRun({
            jobId: ctx.jobId,
            runId: ctx.runId,
            jobName:
              typeof label === "string" && label.length > 0
                ? label
                : ctx.jobId,
          })
        : null

      const stepResults: StepResult[] = []
      let haltedAt: number | null = null

      for (let i = 0; i < parsed.steps.length; i++) {
        const step = parsed.steps[i]!
        let result: StepResult
        if (step.kind === "shell") {
          // issue #277 (Seam B): `Effect.promise` is a plain, uninterruptible
          // Promise wrapper - the Effect runtime cannot cancel it, so a
          // ticker backstop interrupting THIS dispatch left the shell
          // running headless in the background (a retry could then start
          // while the orphan still ran; only push-through's own LOCK_DIR
          // saved it). `Effect.async` gives the runtime a canceler: on
          // interruption it fires `controller.abort()`, which `runShellStep`
          // wires to a process-GROUP kill (see its `onAbort`/`killGroup`).
          // The inner promise never rejects (runShellStep always resolves,
          // even on spawn error) - the `.catch` below is defensive only, so
          // a future edit that introduces a reject path can't hang this fiber.
          result = yield* Effect.async<ShellStepResult>((resume) => {
            const controller = new AbortController()
            void runShellStep(step, controller.signal)
              .then((r) => resume(Effect.succeed(r)))
              .catch((err: unknown) =>
                resume(
                  Effect.succeed({
                    kind: "shell",
                    status: "failed",
                    cmd: step.cmd,
                    exit_code: null,
                    duration_ms: 0,
                    stdout: "",
                    stderr: `internal error: ${String(err)}`,
                  } satisfies ShellStepResult),
                ),
              )
            return Effect.sync(() => controller.abort())
          })
        } else {
          result = yield* runPromptStep(step, sdk, binding)
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
      // Optional per-run tool wiring (request_input) — serviceOption keeps
      // the layer's R unchanged; absent provider = tool-free worker.
      const jobTools = yield* Effect.serviceOption(JobRunToolsProviderTag)
      const worker = buildWorkflowWorker(sdk, notes, Option.getOrNull(jobTools))
      yield* reg.register(kind, { run: worker, defaultTimeoutMs: WORKFLOW_DEFAULT_TIMEOUT_MS })
    }),
  )
}
