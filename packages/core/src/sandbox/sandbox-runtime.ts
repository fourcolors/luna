/**
 * SandboxRuntime — isolated subprocess execution (Phase 13a).
 *
 * Runs scripts/commands in child processes with timeout, output limits,
 * and clean teardown. Uses Node.js `child_process.spawn` wrapped in Effect.
 *
 * Invariants:
 *   - §3.4 #4 interruption cascades: if the Effect is interrupted (e.g.
 *     parent scope closes), the child process is killed via SIGTERM/SIGKILL.
 *   - §3.4 #1 no cross-Scope references: subprocess handle is purely internal.
 *   - Output is capped at maxOutputBytes to prevent memory exhaustion.
 *   - Timeout is enforced via Effect.timeout so the fiber is cleanly interrupted
 *     and the child process is killed.
 *   - Non-zero exit codes surface as SandboxError(reason="non_zero_exit") by
 *     default; pass `allowNonZero: true` to get the result regardless.
 */
import { spawn } from "node:child_process"
import { Effect, Layer } from "effect"
import { SandboxError } from "./errors.js"
import type { SandboxJob, SandboxResult, SandboxRuntimeApi } from "./types.js"

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 1_048_576 // 1 MB

function spawnToEffect(
  job: SandboxJob,
  opts?: { allowNonZero?: boolean },
): Effect.Effect<SandboxResult, SandboxError> {
  const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = job.maxOutputBytes ?? DEFAULT_MAX_BYTES
  const allowNonZero = opts?.allowNonZero ?? false

  const runEffect = Effect.async<SandboxResult, SandboxError>((resume) => {
    const startMs = Date.now()
    let stdoutBuf = ""
    let stderrBuf = ""
    let truncated = false

    const child = spawn(job.command, (job.args as string[] | undefined) ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...job.env },
      shell: false,
    })

    // Cleanup function to kill the process
    const kill = () => {
      try {
        child.kill("SIGTERM")
        setTimeout(() => {
          try { child.kill("SIGKILL") } catch { /* already dead */ }
        }, 500)
      } catch { /* already exited */ }
    }

    // Write script to stdin if provided
    if (job.script !== undefined) {
      try {
        child.stdin.write(job.script)
        child.stdin.end()
      } catch {
        // stdin may be closed if spawn failed
      }
    } else {
      child.stdin.end()
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxBytes - stdoutBuf.length
      if (remaining <= 0) { truncated = true; return }
      const text = chunk.toString("utf8")
      stdoutBuf += remaining < text.length ? text.slice(0, remaining) : text
      if (stdoutBuf.length >= maxBytes) truncated = true
    })

    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = maxBytes - stderrBuf.length
      if (remaining <= 0) return
      const text = chunk.toString("utf8")
      stderrBuf += remaining < text.length ? text.slice(0, remaining) : text
    })

    child.on("error", (err) => {
      resume(
        Effect.fail(
          new SandboxError({
            reason: "spawn_failed",
            command: job.command,
            message: `Failed to spawn process: ${String(err)}`,
            cause: err,
          }),
        ),
      )
    })

    child.on("close", (code) => {
      const exitCode = code ?? 1
      const elapsedMs = Date.now() - startMs
      if (!allowNonZero && exitCode !== 0) {
        resume(
          Effect.fail(
            new SandboxError({
              reason: "non_zero_exit",
              command: job.command,
              message: `Process exited with code ${exitCode}: ${stderrBuf.slice(0, 200)}`,
              exitCode,
            }),
          ),
        )
        return
      }
      resume(
        Effect.succeed({
          exitCode,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          elapsedMs,
          truncated,
        } satisfies SandboxResult),
      )
    })

    // Return cleanup function for Effect.async interrupt handling
    return Effect.sync(kill)
  })

  return Effect.timeout(
    runEffect,
    `${timeoutMs} millis`,
  ).pipe(
    Effect.mapError((e) => {
      if (e._tag === "TimeoutException") {
        return new SandboxError({
          reason: "timeout",
          command: job.command,
          message: `Process timed out after ${timeoutMs}ms`,
        })
      }
      return e as SandboxError
    }),
  )
}

export class SandboxRuntime extends Effect.Tag(
  "luna/SandboxRuntime",
)<SandboxRuntime, SandboxRuntimeApi>() {
  static readonly Default: Layer.Layer<SandboxRuntime> = Layer.succeed(
    SandboxRuntime,
    {
      exec: (job, opts) => spawnToEffect(job, opts),
    } satisfies SandboxRuntimeApi,
  )
}
