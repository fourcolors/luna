/**
 * SandboxRuntime — public types (Phase 13a).
 *
 * Isolated execution for untrusted scripts and skills.
 * Per DESIGN §2.2.4: "Isolated execution for untrusted scripts/skills."
 * Per DESIGN §4 topology: SandboxRuntime is in the Runtime layer.
 */
import type { Effect } from "effect"
import type { SandboxError } from "./errors.js"

export interface SandboxJob {
  /** Executable or interpreter command (e.g. "node", "python3", "bash"). */
  readonly command: string
  /** Arguments to pass to the command. */
  readonly args?: ReadonlyArray<string>
  /** Script/code to pass via stdin or as a temp file. */
  readonly script?: string
  /** Environment variables to inject. */
  readonly env?: Readonly<Record<string, string>>
  /** Timeout in ms. Default: 10_000. */
  readonly timeoutMs?: number
  /** Max stdout buffer size in bytes. Default: 1_048_576 (1 MB). */
  readonly maxOutputBytes?: number
}

export interface SandboxResult {
  /** Exit code from the subprocess. */
  readonly exitCode: number
  /** Combined stdout output (truncated to maxOutputBytes). */
  readonly stdout: string
  /** Combined stderr output (truncated to maxOutputBytes). */
  readonly stderr: string
  /** Actual elapsed time in ms. */
  readonly elapsedMs: number
  /** Whether output was truncated due to maxOutputBytes. */
  readonly truncated: boolean
}

export interface SandboxRuntimeApi {
  /**
   * Execute a job in an isolated subprocess. Returns the result when the
   * subprocess exits. Throws SandboxError on timeout, spawn failure, or
   * if the process exits with a non-zero code (configurable via
   * `allowNonZero`).
   */
  readonly exec: (
    job: SandboxJob,
    opts?: { allowNonZero?: boolean },
  ) => Effect.Effect<SandboxResult, SandboxError>
}
