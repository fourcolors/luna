import type { MemoryRecord } from "@luna/memory"
import { BELIEF_CAP, isActiveBelief, readBelief } from "./types.js"
import { rankByStrength } from "./scoring.js"

/**
 * Format a compact date label for a belief record, e.g. "2026-06-14".
 * Falls back to empty string on invalid input (fail-open).
 */
function beliefDateLabel(updatedAt: number | undefined): string {
  if (!updatedAt || !Number.isFinite(updatedAt)) return ""
  try {
    return new Date(updatedAt).toISOString().slice(0, 10)
  } catch {
    return ""
  }
}

/**
 * Render the ranked active belief set as a system-prompt section — the
 * SQLite-backed analogue of DNA.md (spec §3.2). Returns "" when there are
 * no active beliefs so the caller's `.filter(Boolean)` drops it cleanly.
 *
 * Each belief line carries a compact date stamp (YYYY-MM-DD from updatedAt)
 * so the agent can judge recency at read time. Fail-open: date is omitted
 * if updatedAt is missing or invalid.
 */
export function composeBeliefsSection(
  records: ReadonlyArray<MemoryRecord>,
  now: number,
  opts?: { topN?: number },
): string {
  const topN = opts?.topN ?? BELIEF_CAP
  const active = records.filter(isActiveBelief)
  if (active.length === 0) return ""

  const lines = rankByStrength(active, now)
    .slice(0, topN)
    .map((r) => {
      const c = readBelief(r)
      const statement = c.statement.replace(/\s+/g, " ").trim()
      const dl = beliefDateLabel(r.updatedAt)
      const datePart = dl ? ` [${dl}]` : ""
      return `- (${c.confidence.toFixed(2)}, ${c.domain})${datePart} ${statement}`
    })
  if (lines.length === 0) return ""

  return [
    "## What I believe about Operator",
    "An evolving model of Operator from observed sessions. Weight these but stay open to correction.",
    ...lines,
  ].join("\n")
}
