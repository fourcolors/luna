import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

export interface LocalShellState {
  readonly enabled: boolean
  readonly cwd: string
  readonly clientId: string
  readonly platform: NodeJS.Platform
}

export interface LocalCommandRequest {
  readonly command: string
}

export interface LocalCommandResult {
  readonly command: string
  readonly approved: boolean
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface ExecuteLocalCommandOptions {
  readonly cwd: string
  readonly approve: (command: string) => boolean | Promise<boolean>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

export interface MakeLocalShellStateOptions {
  readonly enabled: boolean
  readonly cwd: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

export const makeLocalShellState = (
  options: MakeLocalShellStateOptions,
): LocalShellState => ({
  enabled: options.enabled,
  cwd: options.cwd,
  clientId: `cli_${randomUUID().replaceAll("-", "")}`,
  platform: process.platform,
})

export const setLocalShellEnabled = (
  state: LocalShellState,
  enabled: boolean,
): LocalShellState => ({
  ...state,
  enabled,
})

export const truncateOutput = (output: string, maxBytes: number): string => {
  const bytes = Buffer.byteLength(output)
  if (bytes <= maxBytes) return output

  const truncated = Buffer.from(output).subarray(0, maxBytes).toString("utf8")
  return `${truncated}\n[truncated ${bytes - maxBytes} bytes]`
}

const killChild = (pid: number | undefined): void => {
  if (pid === undefined) return
  try {
    if (process.platform === "win32") {
      process.kill(pid)
    } else {
      process.kill(-pid, "SIGTERM")
    }
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already exited */
    }
  }
}

export const executeLocalCommand = async (
  request: LocalCommandRequest,
  options: ExecuteLocalCommandOptions,
): Promise<LocalCommandResult> => {
  const approved = await options.approve(request.command)
  if (!approved) {
    return {
      command: request.command,
      approved: false,
      exitCode: null,
      stdout: "",
      stderr: "denied by user",
      timedOut: false,
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return await new Promise<LocalCommandResult>((resolve) => {
    const child = spawn(request.command, {
      shell: true,
      cwd: options.cwd,
      env: process.env,
      detached: process.platform !== "win32",
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    let settled = false

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        command: request.command,
        approved: true,
        exitCode: timedOut ? null : exitCode,
        stdout: truncateOutput(Buffer.concat(stdout).toString("utf8"), maxOutputBytes),
        stderr: truncateOutput(Buffer.concat(stderr).toString("utf8"), maxOutputBytes),
        timedOut,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killChild(child.pid)
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message))
      finish(null)
    })

    child.on("close", (code) => {
      finish(code)
    })
  })
}
