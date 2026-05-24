import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

export interface LocalShellState {
  readonly enabled: boolean
  readonly cwd: string
  readonly clientId: string
  readonly platform: NodeJS.Platform
}

export interface LocalCommandRequest {
  readonly requestId: string
  readonly threadId: string
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface LocalCommandResult {
  readonly type: "local-shell-result"
  readonly requestId: string
  readonly threadId: string
  readonly approved: boolean
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

export interface ExecuteLocalCommandOptions {
  readonly request: LocalCommandRequest
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly approve: (command: string) => Promise<boolean>
  readonly signal?: AbortSignal
}

export interface MakeLocalShellStateOptions {
  readonly enabled: boolean
  readonly cwd: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const FORCE_KILL_GRACE_MS = 250

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
  const buffer = Buffer.from(output)
  if (buffer.byteLength <= maxBytes) return output

  return formatCapturedOutput([buffer.subarray(0, maxBytes)], buffer.byteLength - maxBytes)
}

class BoundedOutputBuffer {
  private readonly chunks: Buffer[] = []
  private retainedBytes = 0
  private omittedBytes = 0

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remaining = this.maxBytes - this.retainedBytes
    if (remaining <= 0) {
      this.omittedBytes += buffer.byteLength
      return
    }

    if (buffer.byteLength <= remaining) {
      this.chunks.push(buffer)
      this.retainedBytes += buffer.byteLength
      return
    }

    this.chunks.push(buffer.subarray(0, remaining))
    this.retainedBytes += remaining
    this.omittedBytes += buffer.byteLength - remaining
  }

  toString(): string {
    return formatCapturedOutput(this.chunks, this.omittedBytes)
  }
}

const formatCapturedOutput = (
  chunks: ReadonlyArray<Buffer>,
  omittedBytes: number,
): string => {
  const output = Buffer.concat(chunks).toString("utf8")
  if (omittedBytes === 0) return output
  return `${output}\n[truncated ${omittedBytes} bytes]`
}

const signalChild = (
  pid: number | undefined,
  signal: NodeJS.Signals,
): void => {
  if (pid === undefined) return
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal)
    } else {
      process.kill(-pid, signal)
    }
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* already exited */
    }
  }
}

export const executeLocalCommand = async (
  options: ExecuteLocalCommandOptions,
): Promise<LocalCommandResult> => {
  const request = options.request
  const cwd = request.cwd ?? options.cwd
  const timeoutMs = request.timeoutMs ?? options.timeoutMs
  const signal = options.signal
  const startedAt = Date.now()

  const baseResult = (): Omit<LocalCommandResult, "approved" | "exitCode" | "stdout" | "stderr" | "timedOut"> => ({
    type: "local-shell-result",
    requestId: request.requestId,
    threadId: request.threadId,
    durationMs: Date.now() - startedAt,
  })

  const abortedResult = (approved: boolean): LocalCommandResult => ({
    ...baseResult(),
    approved,
    exitCode: null,
    stdout: "",
    stderr: "aborted",
    timedOut: true,
  })

  if (signal?.aborted === true) {
    return abortedResult(false)
  }

  let cleanupApprovalAbort = (): void => undefined
  const abortPromise = signal === undefined
    ? null
    : new Promise<"aborted">((resolve) => {
        const onAbort = (): void => resolve("aborted")
        cleanupApprovalAbort = () => signal.removeEventListener("abort", onAbort)
        signal.addEventListener("abort", onAbort, { once: true })
      })
  const approvedOrAborted = await (abortPromise === null
    ? options.approve(request.command)
    : Promise.race([options.approve(request.command), abortPromise]))
  cleanupApprovalAbort()
  if (approvedOrAborted === "aborted") {
    return abortedResult(false)
  }
  const approved = approvedOrAborted

  if (!approved) {
    return {
      ...baseResult(),
      approved: false,
      exitCode: null,
      stdout: "",
      stderr: "denied by user",
      timedOut: false,
    }
  }

  return await new Promise<LocalCommandResult>((resolve) => {
    if (signal?.aborted === true) {
      resolve(abortedResult(true))
      return
    }

    const child = spawn(request.command, {
      shell: true,
      cwd,
      env: process.env,
      detached: process.platform !== "win32",
    })

    const stdout = new BoundedOutputBuffer(options.maxOutputBytes)
    const stderr = new BoundedOutputBuffer(options.maxOutputBytes)
    let timedOut = false
    let settled = false
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      timeoutTimer = undefined
      forceKillTimer = undefined
    }

    const removeAbortListener = (): void => {
      if (signal !== undefined) {
        signal.removeEventListener("abort", abort)
      }
    }

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimers()
      removeAbortListener()
      resolve({
        ...baseResult(),
        approved: true,
        exitCode: timedOut ? null : exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
      })
    }

    const abort = (): void => {
      if (settled) return
      timedOut = true
      stderr.append("aborted")
      clearTimers()
      signalChild(child.pid, "SIGTERM")
      signalChild(child.pid, "SIGKILL")
      finish(null)
    }

    signal?.addEventListener("abort", abort, { once: true })

    timeoutTimer = setTimeout(() => {
      if (settled) return
      timedOut = true
      signalChild(child.pid, "SIGTERM")
      forceKillTimer = setTimeout(() => {
        signalChild(child.pid, "SIGKILL")
        finish(null)
      }, FORCE_KILL_GRACE_MS)
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.append(chunk)
    })

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.append(chunk)
    })

    child.on("error", (error) => {
      stderr.append(error.message)
      finish(null)
    })

    child.on("close", (code) => {
      finish(code)
    })
  })
}
