// Boot preflight for the Claude Code executable.
//
// The SDK spawns a `claude` subprocess; chat threads pin it via
// LUNA_CLAUDE_CODE_EXECUTABLE (the SDK's default lookup picks the wrong
// musl binary on a glibc container — see adapter-sdk dream-reasoner.ts).
// If that pin is missing / blank / points at a non-existent or non-executable
// path, `query()` throws ENOENT on EVERY new thread (the new-chat-panel
// incident: a container whose /usr/local/bin/claude was never provisioned).
//
// This module heals the pin ONCE at boot: keep a valid pin, else auto-detect a
// working, version-matched glibc binary and rewrite process.env in place. It
// NEVER throws — a "none" result is logged loud and left as-is so the server
// still boots (and the per-thread failure is now legible via SDKError.message).
import { accessSync, constants as fsConstants, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { delimiter, dirname, join } from "node:path"

/** True iff `p` resolves to an executable file. fs-backed; injectable in tests. */
export const isExecutableFile = (p: string): boolean => {
  try {
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface ClaudeResolution {
  readonly path: string | null
  readonly source: "env" | "detected" | "none"
  /** The broken pin we replaced/abandoned, for logging (omitted when none). */
  readonly previous?: string
}

/**
 * Pure decision core (no I/O): given the current pin, an executability
 * predicate, and a detector, decide the effective executable.
 *   - pin set AND executable      → keep it            (source "env")
 *   - pin missing/blank/non-exec  → detect()
 *       found    → use it                              (source "detected")
 *       not found→ null                                (source "none")
 */
export const resolveClaudeExecutable = (args: {
  readonly envValue: string | undefined
  readonly isExecutable: (p: string) => boolean
  readonly detect: () => string | null
}): ClaudeResolution => {
  const pin = args.envValue?.trim()
  if (pin && args.isExecutable(pin)) {
    return { path: pin, source: "env" }
  }
  const detected = args.detect()
  if (detected) {
    return pin
      ? { path: detected, source: "detected", previous: pin }
      : { path: detected, source: "detected" }
  }
  return pin ? { path: null, source: "none", previous: pin } : { path: null, source: "none" }
}

/** Scan one node_modules dir for the GLIBC (never -musl) sdk binary, newest first. */
const scanNodeModulesForGlibcClaude = (
  nodeModulesDir: string,
  isExecutable: (p: string) => boolean,
): string | null => {
  // npm/hoisted layout.
  const hoisted = join(
    nodeModulesDir,
    "@anthropic-ai",
    "claude-agent-sdk-linux-x64",
    "claude",
  )
  if (isExecutable(hoisted)) return hoisted
  // bun isolated-store layout: .bun/@anthropic-ai+claude-agent-sdk-linux-x64@<ver>/…
  let entries: string[]
  try {
    entries = readdirSync(join(nodeModulesDir, ".bun"))
  } catch {
    return null
  }
  const candidates = entries
    .filter(
      (e) =>
        e.startsWith("@anthropic-ai+claude-agent-sdk-linux-x64@") &&
        !e.includes("-musl"),
    )
    .sort()
    .reverse() // newest version first (lexical is good enough for the fallback)
  for (const e of candidates) {
    const bin = join(
      nodeModulesDir,
      ".bun",
      e,
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk-linux-x64",
      "claude",
    )
    if (isExecutable(bin)) return bin
  }
  return null
}

/**
 * The SDK's glibc platform-package `claude` binary, version-matched and
 * layout-agnostic via Node resolution (never the -musl twin). Resolves only on
 * linux-x64; returns null elsewhere or when the package restricts subpaths.
 * Extracted (and injectable) so the detector is deterministic in tests across
 * platforms.
 */
export const defaultResolveGlibcPackageBin = (): string | null => {
  try {
    const req = createRequire(import.meta.url)
    const pkg = req.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")
    return join(dirname(pkg), "claude")
  } catch {
    return null
  }
}

/**
 * Detect a working `claude` binary:
 *   1. The SDK's glibc platform package (version-matched, never the -musl twin).
 *   2. A node_modules scan (hoisted + bun store) walking up from cwd.
 *   3. `claude` on PATH.
 * Returns the first executable found, else null.
 */
export const detectClaudeExecutable = (
  isExecutable: (p: string) => boolean = isExecutableFile,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  resolveGlibcPackageBin: () => string | null = defaultResolveGlibcPackageBin,
): string | null => {
  // (1) version-matched glibc platform package.
  const pkgBin = resolveGlibcPackageBin()
  if (pkgBin && isExecutable(pkgBin)) return pkgBin
  // (2) node_modules scan, walking up a few levels from cwd (monorepo-friendly).
  let dir = cwd
  for (let i = 0; i < 6; i++) {
    const found = scanNodeModulesForGlibcClaude(join(dir, "node_modules"), isExecutable)
    if (found) return found
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // (3) `claude` on PATH.
  for (const d of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const cand = join(d, "claude")
    if (isExecutable(cand)) return cand
  }
  return null
}

type LogLevel = "info" | "warn" | "error"
const defaultLog = (level: LogLevel, msg: string): void => {
  if (level === "error") console.error(msg)
  else if (level === "warn") console.warn(msg)
  else console.log(msg)
}

/**
 * Boot wrapper: heal `env.LUNA_CLAUDE_CODE_EXECUTABLE` in place. Never throws.
 *   - healthy pin → no change, no log.
 *   - broken pin, detected → rewrite env, WARN.
 *   - broken pin, nothing found → ERROR (loud); leave env as-is.
 */
export const applyClaudeExecutablePreflight = (
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    readonly isExecutable?: (p: string) => boolean
    readonly detect?: () => string | null
    readonly log?: (level: LogLevel, msg: string) => void
  } = {},
): ClaudeResolution => {
  const isExecutable = opts.isExecutable ?? isExecutableFile
  const detect = opts.detect ?? (() => detectClaudeExecutable(isExecutable, env))
  const log = opts.log ?? defaultLog
  const res = resolveClaudeExecutable({
    envValue: env["LUNA_CLAUDE_CODE_EXECUTABLE"],
    isExecutable,
    detect,
  })
  if (res.source === "detected" && res.path) {
    env["LUNA_CLAUDE_CODE_EXECUTABLE"] = res.path
    log(
      "warn",
      `[claude-preflight] LUNA_CLAUDE_CODE_EXECUTABLE ${
        res.previous ? `("${res.previous}") ` : "(unset) "
      }was missing or not executable — auto-detected "${res.path}"`,
    )
  } else if (res.source === "none") {
    log(
      "error",
      `[claude-preflight] LUNA_CLAUDE_CODE_EXECUTABLE ${
        res.previous ? `("${res.previous}") ` : "(unset) "
      }is not executable and no fallback \`claude\` binary was found — new chat threads will fail at SDK spawn until this is fixed`,
    )
  }
  return res
}
