/**
 * ship-guard — idempotency / already-merged pre-flight for Luna's autonomous
 * "push-through" shipper.
 *
 * WHY THIS EXISTS
 * The autonomous loop once spent 11 consecutive wake cycles trying to push ~14
 * local branches whose changes were ALL already merged into `dev` (every commit
 * patch-identical to an upstream one — `git cherry` returned only `-` lines). It
 * could not tell its work was already done, so re-enabling its git auth would
 * have converted 11 silent failures into 14 duplicate PRs. This guard is the
 * fix: BEFORE the shipper opens a PR it must ask "is this work already merged,
 * and is there already an open PR for it?" and skip if so.
 *
 * The decision logic (`parseCherry`, `decideShip`) is pure and unit-tested; the
 * probes (`cherryAgainst`, `openPrCountForHead`) are thin `spawn` wrappers in
 * the same style as workflow-worker's shell executor. The consumer (Path-B
 * job-creator) calls `guardShip` and only proceeds on `{ action: "ship" }`.
 */
import { spawn } from "node:child_process"

export interface CherrySummary {
  /** `+ <sha>` lines: commits whose patch is NOT yet in the base branch. */
  readonly newCommits: number
  /** `- <sha>` lines: commits whose patch is ALREADY in the base (patch-equal). */
  readonly mergedCommits: number
}

export type SkipCause = "already-merged" | "no-commits" | "open-pr"

export type ShipVerdict =
  | { readonly action: "ship"; readonly reason: string }
  | { readonly action: "skip"; readonly cause: SkipCause; readonly reason: string }

/* -------------------------------------------------------------------------- */
/* Pure decision logic (unit-tested in test/ship-guard.test.ts)               */
/* -------------------------------------------------------------------------- */

/**
 * Parse `git cherry <base> <ref>` output. Each line is `+ <sha>` (patch not in
 * base) or `- <sha>` (equivalent patch already in base). Patch-identity, not
 * SHA — this is exactly what catches a squash/merge-renamed duplicate.
 */
export const parseCherry = (output: string): CherrySummary => {
  let newCommits = 0
  let mergedCommits = 0
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd()
    if (line.startsWith("+ ")) newCommits++
    else if (line.startsWith("- ")) mergedCommits++
  }
  return { newCommits, mergedCommits }
}

/**
 * Pure verdict: should the autonomous shipper open a PR for this work?
 * - 0 new commits → SKIP (already-merged if there were `-` lines, else no-commits).
 * - new commits but an open PR already exists for the head → SKIP (open-pr).
 * - new commits and no open PR → SHIP.
 */
export const decideShip = (input: {
  readonly cherry: CherrySummary
  readonly openPrCount: number
}): ShipVerdict => {
  const { cherry, openPrCount } = input
  if (cherry.newCommits === 0) {
    return cherry.mergedCommits > 0
      ? {
          action: "skip",
          cause: "already-merged",
          reason: `all ${cherry.mergedCommits} commit(s) are already merged into base (git cherry: no '+' lines)`,
        }
      : { action: "skip", cause: "no-commits", reason: "branch has no commits ahead of base" }
  }
  if (openPrCount > 0) {
    return {
      action: "skip",
      cause: "open-pr",
      reason: `${openPrCount} open PR(s) already exist for this head — refusing to open a duplicate`,
    }
  }
  return {
    action: "ship",
    reason: `${cherry.newCommits} new commit(s) not yet in base and no open PR — safe to ship`,
  }
}

/* -------------------------------------------------------------------------- */
/* Impure probes (thin spawn wrappers — match workflow-worker's style)        */
/* -------------------------------------------------------------------------- */

interface RunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
}

const run = (cmd: string, args: ReadonlyArray<string>): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")))
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")))
    child.once("close", (code) => resolve({ ok: code === 0, stdout, stderr }))
    child.once("error", (e: Error) => resolve({ ok: false, stdout, stderr: `spawn error: ${e.message}` }))
  })

/** `git cherry <base> <ref>` → CherrySummary. Throws on git failure (bad ref, no repo). */
export const cherryAgainst = async (base: string, ref: string, cwd = "."): Promise<CherrySummary> => {
  const r = await run("git", ["-C", cwd, "cherry", base, ref])
  if (!r.ok) throw new Error(`git cherry ${base} ${ref} failed: ${r.stderr.trim() || "unknown error"}`)
  return parseCherry(r.stdout)
}

/** Count OPEN PRs whose head branch is `head` (idempotency). Throws on gh failure. */
export const openPrCountForHead = async (head: string): Promise<number> => {
  const r = await run("gh", ["pr", "list", "--head", head, "--state", "open", "--json", "number"])
  if (!r.ok) throw new Error(`gh pr list --head ${head} failed: ${r.stderr.trim() || "unknown error"}`)
  try {
    const parsed: unknown = JSON.parse(r.stdout.trim() || "[]")
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

/**
 * Full pre-flight the autonomous shipper MUST run before opening a PR.
 * Short-circuits: if the content is already merged we never even query gh.
 */
export const guardShip = async (input: {
  /** Base branch the work would merge into, e.g. "origin/dev". */
  readonly base: string
  /** Ref holding the candidate work (local branch / commit-ish). */
  readonly ref: string
  /** Head branch a PR would be opened from (for the open-PR idempotency check). */
  readonly head: string
  readonly cwd?: string
}): Promise<ShipVerdict> => {
  const cherry = await cherryAgainst(input.base, input.ref, input.cwd ?? ".")
  if (cherry.newCommits === 0) return decideShip({ cherry, openPrCount: 0 })
  const openPrCount = await openPrCountForHead(input.head)
  return decideShip({ cherry, openPrCount })
}
