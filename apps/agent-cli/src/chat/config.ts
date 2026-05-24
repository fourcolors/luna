import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ChatArgs, StartMode } from "./args.js"

export interface ChatConfig {
  readonly url: string
  readonly token: string | null
  readonly threadId: string | null
  readonly newThread: boolean
  readonly localShellInitial: boolean
  readonly startMode: StartMode
  readonly startCommand: string | null
  readonly startSsh: string | null
  readonly startTimeoutMs: number
  readonly cwd: string
  readonly validationErrors: ReadonlyArray<string>
}

export interface LoadChatConfigInput {
  readonly args: ChatArgs
  readonly env: Record<string, string | undefined>
  readonly dotenv: Record<string, string | undefined>
  readonly homeDir: string
  readonly cwd: string
}

export const parseDotEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1")
    if (key.length > 0) out[key] = value
  }
  return out
}

export const readLunaDotEnv = (homeDir: string): Record<string, string> => {
  const path = join(homeDir, ".luna", ".env")
  if (!existsSync(path)) return {}
  return parseDotEnv(readFileSync(path, "utf8"))
}

const pick = (
  flagValue: string | undefined,
  envValue: string | undefined,
  dotenvValue: string | undefined,
  fallback: string,
): string => flagValue ?? envValue ?? dotenvValue ?? fallback

const parseStartMode = (value: string): StartMode =>
  value === "local" || value === "ssh" || value === "none" ? value : "none"

export const loadChatConfig = (input: LoadChatConfigInput): ChatConfig => {
  const url = pick(
    input.args.url,
    input.env["LUNA_WS_URL"],
    input.dotenv["LUNA_WS_URL"],
    "ws://127.0.0.1:4753/ui",
  )
  const token =
    input.args.token ??
    input.env["LUNA_UI_WS_TOKEN"] ??
    input.env["UI_WS_TOKEN"] ??
    input.dotenv["LUNA_UI_WS_TOKEN"] ??
    input.dotenv["UI_WS_TOKEN"] ??
    null
  const startMode = parseStartMode(
    pick(
      input.args.startMode,
      input.env["LUNA_START_MODE"],
      input.dotenv["LUNA_START_MODE"],
      "none",
    ),
  )
  const timeoutRaw = pick(
    input.args.startTimeoutMs?.toString(),
    input.env["LUNA_START_TIMEOUT_MS"],
    input.dotenv["LUNA_START_TIMEOUT_MS"],
    "30000",
  )
  const startTimeoutMs = Math.max(1, Number.parseInt(timeoutRaw, 10) || 30_000)
  const startCommand =
    input.args.startCommand ??
    input.env["LUNA_START_COMMAND"] ??
    input.dotenv["LUNA_START_COMMAND"] ??
    null
  const startSsh =
    input.args.startSsh ??
    input.env["LUNA_START_SSH"] ??
    input.dotenv["LUNA_START_SSH"] ??
    null
  const threadId = input.args.threadId ?? null
  const errors: string[] = []
  if (token === null || token.length === 0) errors.push("missing LUNA_UI_WS_TOKEN")
  if (startMode === "local" && (startCommand === null || startCommand.length === 0)) {
    errors.push("LUNA_START_COMMAND is required when LUNA_START_MODE=local")
  }
  if (startMode === "ssh") {
    if (startCommand === null || startCommand.length === 0) {
      errors.push("LUNA_START_COMMAND is required when LUNA_START_MODE=ssh")
    }
    if (startSsh === null || startSsh.length === 0) {
      errors.push("LUNA_START_SSH is required when LUNA_START_MODE=ssh")
    }
  }
  return {
    url,
    token,
    threadId,
    newThread: input.args.newThread ?? threadId === null,
    localShellInitial: input.args.localShell ?? false,
    startMode,
    startCommand,
    startSsh,
    startTimeoutMs,
    cwd: input.cwd,
    validationErrors: errors,
  }
}

export const redactedConfigSummary = (cfg: ChatConfig): string =>
  [
    `url=${cfg.url}`,
    `token=${cfg.token === null ? "missing" : "present"}`,
    `startMode=${cfg.startMode}`,
    `localShell=${cfg.localShellInitial ? "on" : "off"}`,
  ].join(" ")
