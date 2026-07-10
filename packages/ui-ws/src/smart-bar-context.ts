import { execFile } from "node:child_process"
import * as path from "node:path"
import type { LocalShellBridge } from "./local-shell-bridge.js"
import type { SmartBarItem } from "./protocol.js"

const GIT_TIMEOUT_MS = 3_000
const DEFAULT_FRESHNESS_MS = 1_000
const MAX_CACHED_WORKTREES = 64

export interface SmartBarContext {
  readonly threadId: string
  readonly model: string | undefined
  readonly accountLabel: string | undefined
  readonly workspaceSlug: string | undefined
  readonly localShellBridge: LocalShellBridge | null
}

interface GitContext {
  readonly toplevel: string | null
  readonly branch: string | null
  readonly status: string | null
}

interface CachedGitContext {
  readonly sampledAt: number
  readonly context: GitContext
}

/** Internal seam used by the production child-process adapter and deterministic tests. */
export type GitCommandRunner = (
  cwd: string,
  args: ReadonlyArray<string>,
  preserveEmpty?: boolean,
) => Promise<string | null>

export interface SmartBarContextModule {
  /** Return current display items. Git failures degrade to non-Git context. */
  readonly getItems: (context: SmartBarContext) => Promise<ReadonlyArray<SmartBarItem>>
}

export interface SmartBarContextModuleOptions {
  readonly freshnessMs?: number
  readonly now?: () => number
  /** Internal adapter override for tests. Production callers should omit it. */
  readonly runGitCommand?: GitCommandRunner
}

const defaultGitCommandRunner: GitCommandRunner = (
  cwd,
  args,
  preserveEmpty = false,
) => new Promise((resolve) => {
  execFile(
    "git",
    ["-C", cwd, ...args],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    },
    (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const output = stdout.trim()
      resolve(output || (preserveEmpty ? "" : null))
    },
  )
})

const resolveGitCwd = (context: SmartBarContext): string => {
  const capability = context.localShellBridge?.getCapability(context.threadId)
  if (capability !== null && capability !== undefined) {
    const roots = capability.roots ?? [capability.cwd]
    if (roots.length > 0 && roots[0]) return roots[0]
  }
  return process.env["LUNA_REPO_ROOT"]?.trim() || process.cwd()
}

const assembleItems = (
  context: SmartBarContext,
  git: GitContext,
): ReadonlyArray<SmartBarItem> => {
  const items: SmartBarItem[] = []

  if (git.toplevel !== null) {
    items.push({
      id: "git.worktree",
      kind: "info",
      label: "worktree",
      value: path.basename(git.toplevel),
      icon: "⎇",
      group: "git",
      priority: 0,
      tooltip: git.toplevel,
    })
  }
  if (git.branch !== null && git.branch !== "HEAD") {
    items.push({
      id: "git.branch",
      kind: "info",
      label: "branch",
      value: git.branch,
      icon: "⎇",
      group: "git",
      priority: 1,
    })
  }
  if ((git.toplevel !== null || git.branch !== null) && git.status !== null) {
    const isClean = git.status.length === 0
    items.push({
      id: "git.status",
      kind: "info",
      label: "git",
      value: isClean ? "clean" : "dirty",
      icon: "●",
      tone: isClean ? "good" : "warn",
      group: "git",
      priority: 2,
    })
  }

  if (context.workspaceSlug) {
    items.push({
      id: "workspace",
      kind: "info",
      label: "workspace",
      value: context.workspaceSlug,
      icon: "▫",
      group: "context",
      priority: 0,
    })
  }
  if (context.model) {
    items.push({
      id: "model",
      kind: "info",
      label: "model",
      value: context.model,
      icon: "✶",
      group: "context",
      priority: 1,
    })
  }
  if (context.accountLabel) {
    items.push({
      id: "account",
      kind: "info",
      label: "account",
      value: context.accountLabel,
      icon: "◴",
      group: "context",
      priority: 2,
    })
  }

  return items
}

export const createSmartBarContextModule = (
  options: SmartBarContextModuleOptions = {},
): SmartBarContextModule => {
  const freshnessMs = Math.max(0, options.freshnessMs ?? DEFAULT_FRESHNESS_MS)
  const now = options.now ?? Date.now
  const runGitCommand = options.runGitCommand ?? defaultGitCommandRunner
  const cache = new Map<string, CachedGitContext>()
  const inFlight = new Map<string, Promise<GitContext>>()

  const runSafely = async (
    cwd: string,
    args: ReadonlyArray<string>,
    preserveEmpty = false,
  ): Promise<string | null> => {
    try {
      return await runGitCommand(cwd, args, preserveEmpty)
    } catch {
      return null
    }
  }

  const sampleGit = async (cwd: string): Promise<GitContext> => {
    // Preserve the former independent failure semantics (important for an
    // unborn repository whose worktree exists but whose HEAD is unresolved),
    // while running all three commands concurrently off the event loop.
    const [toplevel, branch, status] = await Promise.all([
      runSafely(cwd, ["rev-parse", "--show-toplevel"]),
      runSafely(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runSafely(cwd, ["status", "--porcelain"], true),
    ])
    return { toplevel, branch, status }
  }

  const remember = (cwd: string, context: GitContext): void => {
    if (!cache.has(cwd) && cache.size >= MAX_CACHED_WORKTREES) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, cached] of cache) {
        if (cached.sampledAt < oldestAt) {
          oldestKey = key
          oldestAt = cached.sampledAt
        }
      }
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
    cache.set(cwd, { sampledAt: now(), context })
  }

  const getGitContext = (cwd: string): Promise<GitContext> => {
    const cached = cache.get(cwd)
    if (cached !== undefined && now() - cached.sampledAt < freshnessMs) {
      return Promise.resolve(cached.context)
    }

    const existing = inFlight.get(cwd)
    if (existing !== undefined) return existing

    let pending!: Promise<GitContext>
    pending = sampleGit(cwd)
      .then((context) => {
        remember(cwd, context)
        return context
      })
      .finally(() => {
        if (inFlight.get(cwd) === pending) inFlight.delete(cwd)
      })
    inFlight.set(cwd, pending)
    return pending
  }

  return {
    getItems: async (context) => {
      const git = await getGitContext(resolveGitCwd(context))
      return assembleItems(context, git)
    },
  }
}
