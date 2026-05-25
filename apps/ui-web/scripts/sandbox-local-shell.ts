import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, posix as pathPosix } from "node:path"
import type {
  LocalShellBridge,
  LocalShellRequestFrame,
  LocalShellResultFrame,
  SendLocalShellFrame,
} from "@luna/ui-ws"

const DEFAULT_SANDBOX_ROOT = "/root/luna"
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const FORCE_KILL_GRACE_MS = 250
const SECRET_ENV_KEY = /(TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i

export interface SandboxLocalShellDecision {
  readonly enabled: boolean
  readonly reason: string
  readonly profileName: string
  readonly markerPath: string
  readonly sandboxRoot: string
}

export interface ResolveSandboxLocalShellOptions {
  readonly env?: Record<string, string | undefined>
  readonly homeDir?: string
  readonly cwd?: string
  readonly markerExists?: (path: string) => boolean
  readonly sandboxRoot?: string
}

export interface SandboxLocalShellOptions {
  readonly bridge: LocalShellBridge
  readonly threadId: string
  readonly cwd: string
  readonly sandboxRoot: string
  readonly env?: Record<string, string | undefined>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly clientIdPrefix?: string
}

const isTruthy = (value: string | undefined): boolean =>
  value === "1" || value === "true" || value === "yes" || value === "on"

const normalizeProfileName = (value: string | undefined): string =>
  (value?.trim() || "stable").toLowerCase()

const profileEnvPrefix = (profileName: string): string =>
  `LUNA_${profileName.toUpperCase().replace(/-/g, "_")}`

export const isUnderSandboxRoot = (cwd: string, root: string): boolean => {
  if (!cwd.startsWith("/") || !root.startsWith("/")) return false
  const normalizedCwd = pathPosix.normalize(cwd)
  const normalizedRoot = pathPosix.normalize(root)
  return normalizedCwd === normalizedRoot
    || normalizedCwd.startsWith(`${normalizedRoot}/`)
}

export const resolveSandboxLocalShell = (
  options: ResolveSandboxLocalShellOptions = {},
): SandboxLocalShellDecision => {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const sandboxRoot = options.sandboxRoot ?? env["LUNA_REPO_ROOT"] ?? DEFAULT_SANDBOX_ROOT
  const profileName = normalizeProfileName(env["LUNA_PROFILE"])
  const profilePrefix = profileEnvPrefix(profileName)
  const markerPath = join(home, ".luna", "allow-dangerous-local-shell")
  const markerExists = options.markerExists ?? existsSync
  const requested =
    isTruthy(env[`${profilePrefix}_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL`]) ||
    isTruthy(env["LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL"]) ||
    isTruthy(env["LUNA_SANDBOX_LOCAL_SHELL"])

  if (!requested) {
    return {
      enabled: false,
      reason: "sandbox local shell not requested",
      profileName,
      markerPath,
      sandboxRoot,
    }
  }
  if (env["LUNA_RUNTIME_SCOPE"] !== "incus-container") {
    return {
      enabled: false,
      reason: "LUNA_RUNTIME_SCOPE is not incus-container",
      profileName,
      markerPath,
      sandboxRoot,
    }
  }
  if (!markerExists(markerPath)) {
    return {
      enabled: false,
      reason: "dangerous local shell marker is missing",
      profileName,
      markerPath,
      sandboxRoot,
    }
  }
  if (!isUnderSandboxRoot(cwd, sandboxRoot)) {
    return {
      enabled: false,
      reason: `cwd is outside ${sandboxRoot}`,
      profileName,
      markerPath,
      sandboxRoot,
    }
  }

  return {
    enabled: true,
    reason: "enabled",
    profileName,
    markerPath,
    sandboxRoot,
  }
}

export const sanitizeSandboxCommandEnv = (
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
    const output = Buffer.concat(this.chunks).toString("utf8")
    if (this.omittedBytes === 0) return output
    return `${output}\n[truncated ${this.omittedBytes} bytes]`
  }
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

const deniedResult = (
  request: LocalShellRequestFrame,
  stderr: string,
  startedAt: number,
): LocalShellResultFrame => ({
  type: "local-shell-result",
  requestId: request.requestId,
  threadId: request.threadId,
  approved: false,
  exitCode: null,
  stdout: "",
  stderr,
  durationMs: Date.now() - startedAt,
  timedOut: false,
})

export const executeSandboxLocalShellRequest = async (
  request: LocalShellRequestFrame,
  options: Omit<SandboxLocalShellOptions, "bridge" | "threadId">,
): Promise<LocalShellResultFrame> => {
  const startedAt = Date.now()
  const cwd = request.cwd ?? options.cwd
  const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  if (!isUnderSandboxRoot(cwd, options.sandboxRoot)) {
    return deniedResult(
      request,
      "local shell cwd outside approved sandbox root",
      startedAt,
    )
  }

  return await new Promise<LocalShellResultFrame>((resolve) => {
    const child = spawn(request.command, {
      shell: true,
      cwd,
      env: sanitizeSandboxCommandEnv(options.env ?? process.env),
      detached: process.platform !== "win32",
    })

    const stdout = new BoundedOutputBuffer(maxOutputBytes)
    const stderr = new BoundedOutputBuffer(maxOutputBytes)
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

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimers()
      resolve({
        type: "local-shell-result",
        requestId: request.requestId,
        threadId: request.threadId,
        approved: true,
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    }

    child.stdout?.on("data", (chunk) => stdout.append(chunk))
    child.stderr?.on("data", (chunk) => stderr.append(chunk))
    child.on("error", (error) => {
      stderr.append(error instanceof Error ? error.message : String(error))
      finish(null)
    })
    child.on("close", (code) => finish(code))

    timeoutTimer = setTimeout(() => {
      timedOut = true
      signalChild(child.pid, "SIGTERM")
      forceKillTimer = setTimeout(() => {
        signalChild(child.pid, "SIGKILL")
      }, FORCE_KILL_GRACE_MS)
    }, timeoutMs)
  })
}

export const attachSandboxLocalShell = (
  options: SandboxLocalShellOptions,
): void => {
  const clientId =
    `${options.clientIdPrefix ?? "server_sandbox"}_${options.threadId}`
  const send: SendLocalShellFrame = (frame) => {
    if (frame.type !== "local-shell-request") return
    void executeSandboxLocalShellRequest(frame, options)
      .then((result) => options.bridge.acceptResult(result))
      .catch((error) => {
        options.bridge.acceptResult({
          type: "local-shell-result",
          requestId: frame.requestId,
          threadId: frame.threadId,
          approved: true,
          exitCode: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          durationMs: 0,
          timedOut: false,
        })
      })
  }

  options.bridge.setCapability(
    {
      type: "local-shell-capability",
      threadId: options.threadId,
      enabled: true,
      approvalMode: "auto",
      replaceable: true,
      clientId,
      platform: process.platform,
      cwd: options.cwd,
    },
    send,
  )
}
