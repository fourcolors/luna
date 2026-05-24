import { spawn } from "node:child_process"
import type { StartMode } from "./args.js"

const MAX_STDERR_BYTES = 64 * 1024
const FORCE_KILL_GRACE_MS = 500

export interface RecoveryCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly shell: boolean
}

export interface BuildRecoveryCommandInput {
  readonly mode: StartMode
  readonly command: string | null
  readonly target?: string | null
}

export interface RunRecoveryInput extends BuildRecoveryCommandInput {
  readonly timeoutMs: number
}

export interface RecoveryResult {
  readonly ran: boolean
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stderr: string
}

export const buildRecoveryCommand = (
  input: BuildRecoveryCommandInput,
): RecoveryCommand | null => {
  if (input.mode === "none") return null
  if (input.command === null || input.command.length === 0) {
    throw new Error("recovery command is required")
  }
  if (input.mode === "local") {
    return { command: input.command, args: [], shell: true }
  }
  if (input.target === null || input.target === undefined || input.target.length === 0) {
    throw new Error("recovery ssh target is required")
  }
  return { command: "ssh", args: [input.target, input.command], shell: false }
}

const appendBounded = (
  retained: Buffer<ArrayBufferLike>,
  omittedBytes: number,
  chunk: Buffer<ArrayBufferLike>,
): { readonly retained: Buffer<ArrayBufferLike>; readonly omittedBytes: number } => {
  const remaining = MAX_STDERR_BYTES - retained.length
  if (remaining <= 0) {
    return { retained, omittedBytes: omittedBytes + chunk.length }
  }
  if (chunk.length <= remaining) {
    return { retained: Buffer.concat([retained, chunk]), omittedBytes }
  }
  return {
    retained: Buffer.concat([retained, chunk.subarray(0, remaining)]),
    omittedBytes: omittedBytes + chunk.length - remaining,
  }
}

const formatStderr = (retained: Buffer<ArrayBufferLike>, omittedBytes: number): string => {
  const stderr = retained.toString("utf8")
  if (omittedBytes === 0) return stderr
  return `${stderr}\n[truncated ${omittedBytes} bytes]`
}

export const runRecovery = async (input: RunRecoveryInput): Promise<RecoveryResult> => {
  const recovery = buildRecoveryCommand(input)
  if (recovery === null) {
    return { ran: false, exitCode: null, timedOut: false, stderr: "" }
  }

  return await new Promise<RecoveryResult>((resolve, reject) => {
    let retainedStderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let omittedStderrBytes = 0
    let timedOut = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let killTimeout: ReturnType<typeof setTimeout> | undefined
    const useProcessGroup = recovery.shell && process.platform !== "win32"

    const child = spawn(recovery.command, [...recovery.args], {
      detached: useProcessGroup,
      shell: recovery.shell,
      stdio: ["ignore", "ignore", "pipe"],
    })

    const cleanup = (): void => {
      if (timeout !== undefined) {
        clearTimeout(timeout)
        timeout = undefined
      }
      if (killTimeout !== undefined) {
        clearTimeout(killTimeout)
        killTimeout = undefined
      }
    }

    const stderr = (): string => formatStderr(retainedStderr, omittedStderrBytes)

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        ran: true,
        exitCode: timedOut ? null : exitCode,
        timedOut,
        stderr: stderr(),
      })
    }

    const killChild = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try {
        if (useProcessGroup) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ESRCH") throw error
      }
    }

    timeout = setTimeout(() => {
      timedOut = true
      killChild("SIGTERM")
      killTimeout = setTimeout(() => {
        killChild("SIGKILL")
        finish(null)
      }, FORCE_KILL_GRACE_MS)
    }, input.timeoutMs)

    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendBounded(retainedStderr, omittedStderrBytes, chunk)
      retainedStderr = next.retained
      omittedStderrBytes = next.omittedBytes
    })

    child.once("error", (error) => {
      if (settled) return
      cleanup()
      reject(error)
    })

    child.once("close", (code) => finish(code))
  })
}
