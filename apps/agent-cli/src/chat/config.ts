import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, posix as pathPosix, resolve } from "node:path"
import type { ChatArgs, StartMode } from "./args.js"

const LAST_THREAD_VALID = /^[A-Za-z0-9_-]{4,128}$/

/**
 * Path where the last-active thread id is persisted per profile, so a
 * vanilla `luna chat` (no --thread, no --new) resumes where you left off.
 */
export const lastThreadPath = (homeDir: string, profileName: string): string =>
  join(homeDir, ".luna", `.last-thread-${profileName}`)

export const readLastThread = (
  homeDir: string,
  profileName: string,
): string | null => {
  const path = lastThreadPath(homeDir, profileName)
  if (!existsSync(path)) return null
  const raw = readFileSync(path, "utf8").trim()
  if (!LAST_THREAD_VALID.test(raw)) return null
  return raw
}

export const writeLastThread = (
  homeDir: string,
  profileName: string,
  threadId: string,
): void => {
  if (!LAST_THREAD_VALID.test(threadId)) return
  const path = lastThreadPath(homeDir, profileName)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, threadId, { mode: 0o600 })
}

export const clearLastThread = (homeDir: string, profileName: string): void => {
  const path = lastThreadPath(homeDir, profileName)
  if (existsSync(path)) rmSync(path, { force: true })
}

export interface ChatConfig {
  readonly profileName: string
  readonly url: string
  readonly urls: ReadonlyArray<string>
  readonly token: string | null
  readonly threadId: string | null
  readonly newThread: boolean
  /**
   * True when `threadId` was sourced from the persisted last-thread file
   * (not from an explicit `--thread <id>` flag). The CLI uses this to
   * decide whether `unknown-thread` errors should silently fall back to
   * creating a new thread, vs. surfacing the error to the user.
   */
  readonly threadIdAutoResumed: boolean
  readonly localShellInitial: boolean
  /**
   * Explicitly attached local-shell auto-approve roots (absolute). Sourced from
   * `--dir`/`LUNA_LOCAL_SHELL_DIRS`. MAY be empty — auto-approval is opt-in, so a
   * plain `--local-shell` prompts per command. Commands whose cwd is inside a
   * root are auto-approved; others prompt. See isCwdWithinRoots in local-shell.ts.
   */
  readonly roots: ReadonlyArray<string>
  /** Grant full-machine local-shell access (`--full-access`). */
  readonly fullAccess: boolean
  readonly dangerouslyAutoApproveLocalShell: boolean
  readonly dangerousLocalShellRoot: string
  readonly startMode: StartMode
  readonly startCommand: string | null
  readonly startSsh: string | null
  readonly startSshTargets: ReadonlyArray<string>
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
  readonly dangerousLocalShellRoot?: string
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

type SettingCandidate = {
  readonly name: string
  readonly value: string | undefined
}

const selectSetting = (
  candidates: ReadonlyArray<SettingCandidate>,
): SettingCandidate | undefined =>
  candidates.find((candidate) => candidate.value !== undefined)

const splitListSetting = (value: string | undefined): ReadonlyArray<string> =>
  value
    ?.split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0) ?? []

const uniqueList = (values: ReadonlyArray<string>): ReadonlyArray<string> => {
  const out: string[] = []
  for (const value of values) {
    if (!out.includes(value)) out.push(value)
  }
  return out
}

const parseStartMode = (value: string): StartMode =>
  value === "local" || value === "ssh" || value === "none" ? value : "none"

const isPositiveInteger = (value: string): boolean => /^[1-9]\d*$/.test(value)

const isTruthy = (value: string | undefined): boolean =>
  value === "1" || value === "true" || value === "yes" || value === "on"

const DEFAULT_DANGEROUS_LOCAL_SHELL_ROOT = "/root/luna"

const isUnderDangerousLocalShellRoot = (cwd: string, root: string): boolean => {
  if (!cwd.startsWith("/") || !root.startsWith("/")) return false
  const normalizedCwd = pathPosix.normalize(cwd)
  const normalizedRoot = pathPosix.normalize(root)
  return normalizedCwd === normalizedRoot
    || normalizedCwd.startsWith(`${normalizedRoot}/`)
}

export const isValidProfileName = (value: string): boolean => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)

export const normalizeProfileName = (value: string): string => value.toLowerCase()

export const profileEnvPrefix = (profileName: string): string =>
  `LUNA_${profileName.toUpperCase().replace(/-/g, "_")}`

export const loadChatConfig = (input: LoadChatConfigInput): ChatConfig => {
  const errors: string[] = []
  const profileSetting = selectSetting([
    { name: "--profile", value: input.args.profile },
    { name: "LUNA_PROFILE", value: input.env["LUNA_PROFILE"] },
    { name: "LUNA_PROFILE", value: input.dotenv["LUNA_PROFILE"] },
  ])
  const profileRaw = profileSetting?.value ?? "stable"
  const profileName = isValidProfileName(profileRaw)
    ? normalizeProfileName(profileRaw)
    : "stable"
  if (!isValidProfileName(profileRaw)) {
    errors.push(`${profileSetting?.name ?? "LUNA_PROFILE"} must start with a letter and contain only letters, numbers, hyphens, or underscores`)
  }
  const profilePrefix = profileEnvPrefix(profileName)
  const profiled = (suffix: string): string => `${profilePrefix}_${suffix}`

  const dangerousAutoSetting = selectSetting([
    { name: "--dangerously-auto-approve-local-shell", value: input.args.dangerouslyAutoApproveLocalShell === true ? "1" : undefined },
    { name: profiled("DANGEROUS_AUTO_APPROVE_LOCAL_SHELL"), value: input.env[profiled("DANGEROUS_AUTO_APPROVE_LOCAL_SHELL")] },
    { name: profiled("DANGEROUS_AUTO_APPROVE_LOCAL_SHELL"), value: input.dotenv[profiled("DANGEROUS_AUTO_APPROVE_LOCAL_SHELL")] },
    { name: "LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL", value: input.env["LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL"] },
    { name: "LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL", value: input.dotenv["LUNA_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL"] },
  ])
  const dangerousRequested = dangerousAutoSetting !== undefined && isTruthy(dangerousAutoSetting.value)
  const dangerousLocalShellRoot = input.dangerousLocalShellRoot ?? DEFAULT_DANGEROUS_LOCAL_SHELL_ROOT
  const runtimeScope = selectSetting([
    { name: "LUNA_RUNTIME_SCOPE", value: input.env["LUNA_RUNTIME_SCOPE"] },
    { name: "LUNA_RUNTIME_SCOPE", value: input.dotenv["LUNA_RUNTIME_SCOPE"] },
  ])?.value
  const dangerousMarkerPath = join(input.homeDir, ".luna", "allow-dangerous-local-shell")
  let dangerouslyAutoApproveLocalShell = false
  if (dangerousRequested) {
    if (runtimeScope !== "incus-container") {
      errors.push("dangerous local shell auto approval requires LUNA_RUNTIME_SCOPE=incus-container")
    }
    if (!existsSync(dangerousMarkerPath)) {
      errors.push("dangerous local shell auto approval requires ~/.luna/allow-dangerous-local-shell")
    }
    if (!isUnderDangerousLocalShellRoot(input.cwd, dangerousLocalShellRoot)) {
      errors.push(`dangerous local shell auto approval requires cwd under ${dangerousLocalShellRoot}`)
    }
    dangerouslyAutoApproveLocalShell =
      runtimeScope === "incus-container" &&
      existsSync(dangerousMarkerPath) &&
      isUnderDangerousLocalShellRoot(input.cwd, dangerousLocalShellRoot)
  }

  // Attached local-shell scope (desktop/operator model, distinct from the
  // heavily-gated container auto-approve above). `--dir` (repeatable) and the
  // LOCAL_SHELL_DIRS env give the working-directory roots; default to [cwd] so
  // existing single-dir behavior is preserved. `--full-access` / *_FULL_ACCESS
  // grants any-directory access.
  const fullAccessSetting = selectSetting([
    { name: "--full-access", value: input.args.fullAccess === true ? "1" : undefined },
    { name: profiled("LOCAL_SHELL_FULL_ACCESS"), value: input.env[profiled("LOCAL_SHELL_FULL_ACCESS")] },
    { name: profiled("LOCAL_SHELL_FULL_ACCESS"), value: input.dotenv[profiled("LOCAL_SHELL_FULL_ACCESS")] },
    { name: "LUNA_LOCAL_SHELL_FULL_ACCESS", value: input.env["LUNA_LOCAL_SHELL_FULL_ACCESS"] },
    { name: "LUNA_LOCAL_SHELL_FULL_ACCESS", value: input.dotenv["LUNA_LOCAL_SHELL_FULL_ACCESS"] },
  ])
  const fullAccess = fullAccessSetting !== undefined && isTruthy(fullAccessSetting.value)
  const dirsFromEnv = splitListSetting(
    selectSetting([
      { name: profiled("LOCAL_SHELL_DIRS"), value: input.env[profiled("LOCAL_SHELL_DIRS")] },
      { name: profiled("LOCAL_SHELL_DIRS"), value: input.dotenv[profiled("LOCAL_SHELL_DIRS")] },
      { name: "LUNA_LOCAL_SHELL_DIRS", value: input.env["LUNA_LOCAL_SHELL_DIRS"] },
      { name: "LUNA_LOCAL_SHELL_DIRS", value: input.dotenv["LUNA_LOCAL_SHELL_DIRS"] },
    ])?.value,
  )
  const requestedDirs = [...(input.args.dirs ?? []), ...dirsFromEnv]
  // Attached auto-approve roots — explicitly opted in via --dir/LOCAL_SHELL_DIRS.
  // MAY be empty: a plain `--local-shell` keeps prompting per command (the
  // default working directory is still input.cwd; see makeLocalShellState).
  const roots = uniqueList(requestedDirs.map((dir) => resolve(input.cwd, dir)))

  const urlSetting = selectSetting([
    { name: "--url", value: input.args.url },
    { name: profiled("WS_URL"), value: input.env[profiled("WS_URL")] },
    { name: profiled("WS_URL"), value: input.dotenv[profiled("WS_URL")] },
    { name: "LUNA_WS_URL", value: input.env["LUNA_WS_URL"] },
    { name: "LUNA_WS_URL", value: input.dotenv["LUNA_WS_URL"] },
  ])
  const url = urlSetting?.value ?? "ws://127.0.0.1:4753/ui"
  const explicitUrl = input.args.url !== undefined
  const fallbackUrlSetting = selectSetting(explicitUrl
    ? [
      { name: "--fallback-url", value: input.args.fallbackUrl },
    ]
    : [
      { name: "--fallback-url", value: input.args.fallbackUrl },
      { name: profiled("FALLBACK_WS_URLS"), value: input.env[profiled("FALLBACK_WS_URLS")] },
      { name: profiled("FALLBACK_WS_URLS"), value: input.dotenv[profiled("FALLBACK_WS_URLS")] },
      { name: profiled("FALLBACK_WS_URL"), value: input.env[profiled("FALLBACK_WS_URL")] },
      { name: profiled("FALLBACK_WS_URL"), value: input.dotenv[profiled("FALLBACK_WS_URL")] },
      { name: "LUNA_FALLBACK_WS_URLS", value: input.env["LUNA_FALLBACK_WS_URLS"] },
      { name: "LUNA_FALLBACK_WS_URLS", value: input.dotenv["LUNA_FALLBACK_WS_URLS"] },
      { name: "LUNA_FALLBACK_WS_URL", value: input.env["LUNA_FALLBACK_WS_URL"] },
      { name: "LUNA_FALLBACK_WS_URL", value: input.dotenv["LUNA_FALLBACK_WS_URL"] },
    ])
  const urls = uniqueList([url, ...splitListSetting(fallbackUrlSetting?.value)])

  // Token resolution chain (finding #6 naming map). Highest precedence first:
  //   --token                        explicit flag.
  //   LUNA_<PROFILE>_UI_WS_TOKEN     the per-profile secret to PRESENT to that
  //                                  server (env, then dotenv). On a REMOTE setup
  //                                  the stable/dev tokens differ and live here.
  //   LUNA_UI_WS_TOKEN / UI_WS_TOKEN generic fallbacks (env, then dotenv). The
  //                                  trailing UI_WS_TOKEN dotenv entry is what lets
  //                                  a single-box install resolve the SAME canonical
  //                                  UI_WS_TOKEN the server reads — so the installer
  //                                  need not also write LUNA_STABLE_UI_WS_TOKEN.
  // Do NOT remove any candidate: existing ~/.luna/.env files rely on every name.
  const tokenSetting = selectSetting([
    { name: "--token", value: input.args.token },
    { name: profiled("UI_WS_TOKEN"), value: input.env[profiled("UI_WS_TOKEN")] },
    { name: profiled("UI_WS_TOKEN"), value: input.dotenv[profiled("UI_WS_TOKEN")] },
    { name: "LUNA_UI_WS_TOKEN", value: input.env["LUNA_UI_WS_TOKEN"] },
    { name: "UI_WS_TOKEN", value: input.env["UI_WS_TOKEN"] },
    { name: "LUNA_UI_WS_TOKEN", value: input.dotenv["LUNA_UI_WS_TOKEN"] },
    { name: "UI_WS_TOKEN", value: input.dotenv["UI_WS_TOKEN"] },
  ])
  const token = tokenSetting?.value ?? null

  const startModeSetting = selectSetting([
    { name: "--start-mode", value: input.args.startMode },
    { name: profiled("START_MODE"), value: input.env[profiled("START_MODE")] },
    { name: profiled("START_MODE"), value: input.dotenv[profiled("START_MODE")] },
    { name: "LUNA_START_MODE", value: input.env["LUNA_START_MODE"] },
    { name: "LUNA_START_MODE", value: input.dotenv["LUNA_START_MODE"] },
  ])
  const startModeRaw = startModeSetting?.value ?? "none"
  const startMode = parseStartMode(startModeRaw)
  if (startModeRaw !== startMode) {
    errors.push(`${startModeSetting?.name ?? "LUNA_START_MODE"} must be local, ssh, or none`)
  }

  const timeoutSetting = selectSetting([
    { name: "--start-timeout-ms", value: input.args.startTimeoutMs?.toString() },
    { name: profiled("START_TIMEOUT_MS"), value: input.env[profiled("START_TIMEOUT_MS")] },
    { name: profiled("START_TIMEOUT_MS"), value: input.dotenv[profiled("START_TIMEOUT_MS")] },
    { name: "LUNA_START_TIMEOUT_MS", value: input.env["LUNA_START_TIMEOUT_MS"] },
    { name: "LUNA_START_TIMEOUT_MS", value: input.dotenv["LUNA_START_TIMEOUT_MS"] },
  ])
  const timeoutRaw = timeoutSetting?.value
  const startTimeoutMs =
    timeoutRaw === undefined || isPositiveInteger(timeoutRaw) ? Number(timeoutRaw ?? "30000") : 30_000
  if (timeoutRaw !== undefined && !isPositiveInteger(timeoutRaw)) {
    errors.push(`${timeoutSetting?.name ?? "LUNA_START_TIMEOUT_MS"} must be a positive integer`)
  }
  const startCommand =
    selectSetting([
      { name: "--start-command", value: input.args.startCommand },
      { name: profiled("START_COMMAND"), value: input.env[profiled("START_COMMAND")] },
      { name: profiled("START_COMMAND"), value: input.dotenv[profiled("START_COMMAND")] },
      { name: "LUNA_START_COMMAND", value: input.env["LUNA_START_COMMAND"] },
      { name: "LUNA_START_COMMAND", value: input.dotenv["LUNA_START_COMMAND"] },
    ])?.value ?? null
  const startSsh =
    selectSetting([
      { name: "--start-ssh", value: input.args.startSsh },
      { name: profiled("START_SSH"), value: input.env[profiled("START_SSH")] },
      { name: profiled("START_SSH"), value: input.dotenv[profiled("START_SSH")] },
      { name: "LUNA_START_SSH", value: input.env["LUNA_START_SSH"] },
      { name: "LUNA_START_SSH", value: input.dotenv["LUNA_START_SSH"] },
    ])?.value ?? null
  const explicitStartSsh = input.args.startSsh !== undefined
  const fallbackStartSshSetting = selectSetting(explicitStartSsh
    ? [
      { name: "--fallback-start-ssh", value: input.args.fallbackStartSsh },
    ]
    : [
      { name: "--fallback-start-ssh", value: input.args.fallbackStartSsh },
      { name: profiled("FALLBACK_START_SSHS"), value: input.env[profiled("FALLBACK_START_SSHS")] },
      { name: profiled("FALLBACK_START_SSHS"), value: input.dotenv[profiled("FALLBACK_START_SSHS")] },
      { name: profiled("FALLBACK_START_SSH"), value: input.env[profiled("FALLBACK_START_SSH")] },
      { name: profiled("FALLBACK_START_SSH"), value: input.dotenv[profiled("FALLBACK_START_SSH")] },
      { name: "LUNA_FALLBACK_START_SSHS", value: input.env["LUNA_FALLBACK_START_SSHS"] },
      { name: "LUNA_FALLBACK_START_SSHS", value: input.dotenv["LUNA_FALLBACK_START_SSHS"] },
      { name: "LUNA_FALLBACK_START_SSH", value: input.env["LUNA_FALLBACK_START_SSH"] },
      { name: "LUNA_FALLBACK_START_SSH", value: input.dotenv["LUNA_FALLBACK_START_SSH"] },
    ])
  const startSshTargets = uniqueList([
    ...(startSsh === null || startSsh.length === 0 ? [] : [startSsh]),
    ...splitListSetting(fallbackStartSshSetting?.value),
  ])
  // Auto-resume the most-recently-active thread when neither --thread nor
  // --new was passed. Keeps sessions continuous instead of every `luna chat`
  // landing on a fresh empty thread. `--new` is the explicit opt-out.
  const explicitNew = input.args.newThread === true
  const resumedThreadId =
    input.args.threadId === undefined && !explicitNew
      ? readLastThread(input.homeDir, profileName)
      : null
  const threadId = input.args.threadId ?? resumedThreadId ?? null
  const threadIdAutoResumed = input.args.threadId === undefined && resumedThreadId !== null
  if (token === null || token.length === 0) errors.push("missing LUNA_UI_WS_TOKEN")
  if (startMode === "local" && (startCommand === null || startCommand.length === 0)) {
    errors.push("LUNA_START_COMMAND is required when LUNA_START_MODE=local")
  }
  if (startMode === "ssh") {
    if (startCommand === null || startCommand.length === 0) {
      errors.push("LUNA_START_COMMAND is required when LUNA_START_MODE=ssh")
    }
    if (startSshTargets.length === 0) {
      errors.push("LUNA_START_SSH is required when LUNA_START_MODE=ssh")
    }
  }
  return {
    profileName,
    url,
    urls,
    token,
    threadId,
    threadIdAutoResumed,
    newThread: input.args.newThread ?? threadId === null,
    localShellInitial: input.args.localShell ?? false,
    roots,
    fullAccess,
    dangerouslyAutoApproveLocalShell,
    dangerousLocalShellRoot,
    startMode,
    startCommand,
    startSsh,
    startSshTargets,
    startTimeoutMs,
    cwd: input.cwd,
    validationErrors: errors,
  }
}

export const redactedConfigSummary = (cfg: ChatConfig): string =>
  [
    `profile=${cfg.profileName}`,
    `url=${cfg.url}`,
    `urls=${cfg.urls.length}`,
    `token=${cfg.token === null ? "missing" : "present"}`,
    `startMode=${cfg.startMode}`,
    `localShell=${cfg.localShellInitial ? "on" : "off"}`,
    `localShellApproval=${cfg.dangerouslyAutoApproveLocalShell ? "auto" : "prompt"}`,
    `localShellRoots=${cfg.fullAccess ? "full-access" : cfg.roots.length}`,
  ].join(" ")
