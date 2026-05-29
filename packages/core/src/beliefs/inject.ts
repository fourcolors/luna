import type { MemoryRecord } from "@luna/memory"
import { BELIEF_CAP, isActiveBelief, readBelief } from "./types.js"
import { rankByStrength } from "./scoring.js"

/**
 * Render the ranked active belief set as a system-prompt section — the
 * SQLite-backed analogue of DNA.md (spec §3.2). Returns "" when there are
 * no active beliefs so the caller's `.filter(Boolean)` drops it cleanly.
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
      return `- (${c.confidence.toFixed(2)}, ${c.domain}) ${c.statement}`
    })

  return [
    "## What I believe about Operator",
    "A validated, evolving model of Operator. Weight these but stay open to correction.",
    ...lines,
  ].join("\n")
}
