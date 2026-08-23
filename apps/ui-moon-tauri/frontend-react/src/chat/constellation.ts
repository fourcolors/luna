/**
 * constellation.ts - the star map under a turn's activity timeline.
 *
 * One star per top-level tool call, tinted by what that call did, replacing the
 * "Worked for N steps" count. The shape carries the count, the kinds AND the
 * failure, which the number never did.
 *
 * NO ANIMATION DRIVER. A settled constellation is completely still, and the one
 * moving part (the newest star, while the turn runs) is a CSS keyframe. So this
 * renders declaratively from the reducer's own data on the reducer's own cadence
 * - there is no rAF loop and nothing to tear down.
 *
 * The data already existed: `ToolSegment` carries `name` and `result.ok`, and
 * the timeline has rendered pending/ok/error dots from them since before this.
 * A star is a second reading of segments the reducer already produces.
 */
import type { MergedStep } from "./chatModel"

/** Colour is kind, size is significance, red is failure. Three encodings, no more. */
export type StarKind = "read" | "write" | "run" | "web" | "agent" | "bad"

export interface Star {
  readonly kind: StarKind
  /** Tooltip text: what this step actually was. */
  readonly label: string
}

/** Stars are pinned this far apart and never move once placed. A star records
 *  something that already happened, so if the strip tracked its container the
 *  whole constellation would stretch and the past would appear to rearrange. */
export const STAR_GAP = 22
export const STAR_MAX = 6
const PAD = 14
const H = 12

const KIND_BY_TOOL: Record<string, StarKind> = {
  Read: "read", Grep: "read", Glob: "read", NotebookRead: "read", LS: "read",
  Write: "write", Edit: "write", MultiEdit: "write", NotebookEdit: "write",
  Bash: "run", BashOutput: "run", KillShell: "run",
  WebFetch: "web", WebSearch: "web",
  Task: "agent", Agent: "agent",
}

/**
 * Verb tokens, checked in this order. Order is precedence: a tool that both
 * delegates and writes is an agent call first, and one that both writes and
 * runs is a write, because the write is the part with consequences.
 *
 * These are VERBS only, never namespaces. `shell` looked like a run verb and is
 * deliberately absent: `local_shell_list_roots` is a read that happens to live
 * on the shell server, and tinting it amber would say a command ran when none
 * did.
 */
const VERB_KINDS: ReadonlyArray<readonly [StarKind, ReadonlySet<string>]> = [
  ["agent", new Set(["agent", "task", "subagent", "delegate", "orchestrate", "workflow"])],
  ["write", new Set([
    "write", "edit", "create", "update", "delete", "remove", "set", "put",
    "patch", "add", "insert", "send", "post", "upsert", "save", "rename",
    "move", "apply", "commit", "publish", "upload",
  ])],
  ["run", new Set([
    "run", "exec", "execute", "command", "cmd", "bash", "kill", "spawn",
    "restart", "start", "stop", "deploy", "install", "build", "script",
  ])],
  ["web", new Set([
    "web", "fetch", "http", "https", "url", "browse", "browser", "navigate",
    "crawl", "scrape", "download", "page",
  ])],
]

/**
 * Split a tool name into lowercase word tokens.
 *
 * MUST be tokens, not substrings. `list_threads` contains the substring "read"
 * and a substring match would classify it as a read for the wrong reason;
 * worse, the same trick misfires silently and only on real tool names, which is
 * exactly the class of bug that shipped in 0.0.73.
 */
export function toolTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")   // camelCase -> two tokens
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
}

/**
 * Strip the `mcp__<server>__` prefix, returning the tool half.
 *
 * The separator is a DOUBLE underscore, and server names contain single ones
 * (`local_shell`), so this splits on `__` rather than guessing at `_`.
 */
export function stripMcpPrefix(name: string): string {
  const parts = name.split("__")
  return parts[0] === "mcp" && parts.length >= 3 ? parts.slice(2).join("__") : name
}

/**
 * Classify a tool call for tinting.
 *
 * WHY THIS IS NOT JUST A LOOKUP: 0.0.73 shipped a bare `KIND_BY_TOOL[name] ??
 * "read"`, which meant every tool Luna actually calls - all of them MCP, all
 * named `mcp__<server>__<tool>` - missed the table and came out neutral. The
 * whole constellation rendered in one colour in the real app while the tests,
 * which used built-in names like `Bash`, showed the full palette. Verb tokens
 * are what make this work against tool names nobody has written down yet.
 */
export function kindForTool(name: string): StarKind {
  const exact = KIND_BY_TOOL[name]
  if (exact) return exact
  const tokens = toolTokens(stripMcpPrefix(name))
  for (const [kind, verbs] of VERB_KINDS) {
    for (const t of tokens) if (verbs.has(t)) return kind
  }
  // Genuinely unrecognised: neutral is still the honest answer, but now it
  // means "no verb we know", not "not a built-in".
  return "read"
}

/** Vertical jitter, deterministic so a star never moves between renders. */
export function starOffset(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return ((x - Math.floor(x)) - 0.5) * 5.4
}

/**
 * Derive the stars for one activity timeline.
 *
 * TOP-LEVEL ONLY. A segment with a `parentToolUseId` happened inside a subagent
 * and is folded into that Agent's own star; without this an agentic turn
 * produces forty stars and says nothing.
 */
export function starsFor(merged: readonly MergedStep[], lastToolIndex: number): Star[] {
  const out: Star[] = []
  for (let i = 0; i <= lastToolIndex && i < merged.length; i++) {
    const seg = merged[i]?.seg
    if (!seg || seg.kind !== "tool") continue
    if (seg.parentToolUseId) continue
    const failed = seg.result !== null && !seg.result.ok
    out.push({
      kind: failed ? "bad" : kindForTool(seg.name),
      label: failed ? `${seg.name} failed` : seg.name,
    })
    if (out.length >= STAR_MAX) break
  }
  return out
}

/** Width of the strip for `n` stars. Self-sized, never container-sized. */
export function constellationWidth(n: number): number {
  return PAD + (Math.max(1, Math.min(n, STAR_MAX)) - 1) * STAR_GAP + PAD
}

export const STAR_PATH = "M0 -10Q1.6 -1.6 10 0Q1.6 1.6 0 10Q-1.6 1.6 -10 0Q-1.6 -1.6 0 -10Z"
export const STRIP_HEIGHT = H

/** Where star `i` sits. Pure, so the link path and the stars cannot disagree. */
export function starPos(i: number): { x: number; y: number } {
  return { x: PAD + i * STAR_GAP, y: H / 2 + starOffset(i) }
}

/** The polyline joining the stars, as an SVG `d`. */
export function linkPath(n: number): string {
  let d = ""
  for (let i = 0; i < n; i++) {
    const p = starPos(i)
    d += `${i ? "L" : "M"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`
  }
  return d
}

/**
 * Every top-level tool call, UNCAPPED, so the announcement can be honest about
 * work the strip had to truncate.
 *
 * `starsFor` stops at STAR_MAX to keep the strip bounded, which means a failure
 * in call seven is invisible AND, if the label counted only drawn stars, would
 * go unannounced too. The screen-reader text is the one place that costs
 * nothing to be complete, so it counts everything.
 */
export function toolStats(
  merged: readonly MergedStep[],
  lastToolIndex: number,
): { total: number; failed: number } {
  let total = 0
  let failed = 0
  for (let i = 0; i <= lastToolIndex && i < merged.length; i++) {
    const seg = merged[i]?.seg
    if (!seg || seg.kind !== "tool" || seg.parentToolUseId) continue
    total++
    if (seg.result !== null && !seg.result.ok) failed++
  }
  return { total, failed }
}

/**
 * What a screen reader hears instead of the removed step count.
 *
 * `total` and `failed` come from `toolStats`, NOT from `stars.length` and not
 * from `lastToolIndex + 1`. The first undercounts past the cap; the second is a
 * row index into `merged`, so it counts intermediate narration as a step - the
 * exact meaning this feature deliberately moved away from.
 */
export function constellationLabel(
  stars: readonly Star[],
  total: number,
  failed: number,
): string {
  if (total === 0) return "No tool steps"
  const head = `${total} step${total === 1 ? "" : "s"}`
  const tail = failed ? `, ${failed} failed` : ""
  const shown = stars.length < total ? ` (first ${stars.length} shown)` : ""
  return `${head}${tail}${shown}: ${stars.map((s) => s.label).join(", ")}`
}
