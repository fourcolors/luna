import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { posix as pathPosix } from "node:path"

export type LocalShellApprovalMode = "prompt" | "auto"

export interface LocalShellState {
  readonly enabled: boolean
  /**
   * Explicitly attached auto-approve folders (absolute paths). MAY be empty:
   * auto-approval is opt-in, so a plain `--local-shell` with no attached folder
   * prompts for every command. roots[0], when present, is the default cwd.
   */
  readonly roots: ReadonlyArray<string>
  /** When true, commands may run in any directory (no scope gate). */
  readonly fullAccess: boolean
  /** Default working directory for a request that omits cwd (= roots[0] ?? launch cwd). */
  readonly cwd: string
  readonly approvalMode: LocalShellApprovalMode
  readonly clientId: string
  readonly platform: NodeJS.Platform
}

/** True when `cwd` is `root` or a descendant of it (posix subtree match). */
export const isCwdWithinRoot = (cwd: string, root: string): boolean => {
  if (!cwd.startsWith("/") || !root.startsWith("/")) return false
  // path.posix.normalize PRESERVES a trailing slash, so strip it (mapping the
  // filesystem root back to "/") before comparing — otherwise "/work/" never
  // matches "/work".
  const strip = (p: string): string => pathPosix.normalize(p).replace(/\/+$/, "") || "/"
  const normalizedCwd = strip(cwd)
  const normalizedRoot = strip(root)
  if (normalizedRoot === "/") return true // root "/" contains everything
  return normalizedCwd === normalizedRoot
    || normalizedCwd.startsWith(`${normalizedRoot}/`)
}

/**
 * True when a requested `cwd` falls within any attached root. An undefined cwd
 * means "use the client default" (roots[0] when attached, else the launch cwd):
 * that default is in-scope only when at least one root is attached, so an empty
 * scope is never auto-approved (auto-approval is opt-in).
 */
export const isCwdWithinRoots = (
  cwd: string | undefined,
  roots: ReadonlyArray<string>,
): boolean => {
  if (cwd === undefined) return roots.length > 0
  return roots.some((root) => isCwdWithinRoot(cwd, root))
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
  readonly env?: Record<string, string | undefined>
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly approve: (command: string) => Promise<boolean>
  readonly signal?: AbortSignal
}

export interface MakeLocalShellStateOptions {
  readonly enabled: boolean
  /** Explicitly attached auto-approve folders. MAY be empty (default: prompt). */
  readonly roots: ReadonlyArray<string>
  readonly fullAccess: boolean
  /** Launch/default working directory used when no root is attached (= cfg.cwd). */
  readonly cwd: string
  readonly approvalMode: LocalShellApprovalMode
}

const DEFAULT_TIMEOUT_MS = 30_000
const FORCE_KILL_GRACE_MS = 250
const SECRET_ENV_KEY = /(TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i

export const makeLocalShellState = (
  options: MakeLocalShellStateOptions,
): LocalShellState => ({
  enabled: options.enabled,
  roots: options.roots,
  fullAccess: options.fullAccess,
  // Default working directory: the first attached root if any, else the launch cwd.
  cwd: options.roots[0] ?? options.cwd,
  approvalMode: options.approvalMode,
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

/** Replace the attached roots (may be empty). cwd follows roots[0], else stays. */
export const setLocalShellRoots = (
  state: LocalShellState,
  roots: ReadonlyArray<string>,
): LocalShellState => ({
  ...state,
  roots,
  cwd: roots[0] ?? state.cwd,
})

/** Add a root (deduped). */
export const addLocalShellRoot = (
  state: LocalShellState,
  root: string,
): LocalShellState =>
  state.roots.includes(root)
    ? state
    : setLocalShellRoots(state, [...state.roots, root])

/** Remove a root; the attached set may become empty (auto-approval is opt-in). */
export const removeLocalShellRoot = (
  state: LocalShellState,
  root: string,
): LocalShellState =>
  setLocalShellRoots(
    state,
    state.roots.filter((existing) => existing !== root),
  )

/** Toggle full-machine access. */
export const setLocalShellFullAccess = (
  state: LocalShellState,
  fullAccess: boolean,
): LocalShellState => ({
  ...state,
  fullAccess,
})

export const truncateOutput = (output: string, maxBytes: number): string => {
  const buffer = Buffer.from(output)
  if (buffer.byteLength <= maxBytes) return output

  return formatCapturedOutput([buffer.subarray(0, maxBytes)], buffer.byteLength - maxBytes)
}

export const sanitizeLocalCommandEnv = (
  env: Record<string, string | undefined>,
): NodeJS.ProcessEnv => {
  const sanitized: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (SECRET_ENV_KEY.test(key)) continue
    sanitized[key] = value
  }
  return sanitized
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
      env: options.env ?? process.env,
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
