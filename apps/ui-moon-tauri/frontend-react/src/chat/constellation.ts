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

/** An unknown or MCP tool is a read until it proves otherwise: neutral is the
 *  honest default, and mis-tinting a tool is worse than not tinting it. */
export function kindForTool(name: string): StarKind {
  return KIND_BY_TOOL[name] ?? "read"
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

/** What a screen reader hears instead of the removed step count. */
export function constellationLabel(stars: readonly Star[], total: number): string {
  if (total === 0) return "No tool steps"
  const failed = stars.filter((s) => s.kind === "bad").length
  const head = `${total} step${total === 1 ? "" : "s"}`
  const tail = failed ? `, ${failed} failed` : ""
  return `${head}${tail}: ${stars.map((s) => s.label).join(", ")}`
}
