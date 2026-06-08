// packages/core/src/wake/plan-actions.ts
//
// Path-B step 1: turn the wake reasoner's *proposed* actions into rows that are
// safe to file into the workspace.db `next_actions` table.
//
// Before this, `runWake` produced `digest.proposedActions` and only LOGGED them
// (wake_log.artifacts) — they evaporated every cycle, so observation never
// became actionable work. This module is the pure planner that decides what to
// actually file, guarding the three hazards of writing autonomously-proposed
// rows into a live table:
//   1. DEDUP — wake re-proposes similar things each */30 tick; filing blindly
//      would grow next_actions unboundedly. Drop a proposal whose (normalized)
//      action text already exists among the open actions.
//   2. FK SAFETY — next_actions.goal_slug REFERENCES goals(slug) with
//      foreign_keys=ON. A proposal pointing at an unknown slug would throw.
//      Null out any goalSlug that isn't a currently-known goal.
//   3. PRIORITY BOUNDS — clamp to the documented 1..5 range.
//
// Pure + unit-tested; the impure INSERT lives in WakeLogStore.appendNextActions.
import type { WakeProposedAction } from "./types.js"

export interface PlannedAction {
  readonly action: string
  /** Clamped to 1..5. */
  readonly priority: number
  /** Validated against known goal slugs; null when unknown / unattached. */
  readonly goalSlug: string | null
}

/** Normalize action text for dedup: lowercase, collapse whitespace, trim. */
export const normalizeAction = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim()

const clampPriority = (p: number): number => {
  if (!Number.isFinite(p)) return 1
  return Math.max(1, Math.min(5, Math.round(p)))
}

/**
 * Decide which proposed actions to file. `existingOpenActions` are the open
 * (todo/doing) next_actions the reasoner already saw; `knownGoalSlugs` are the
 * goal slugs that currently exist (so a null-out keeps the FK valid).
 *
 * Also dedups WITHIN the proposal batch (the reasoner can repeat itself in a
 * single digest).
 */
export const planNextActions = (
  proposed: ReadonlyArray<WakeProposedAction>,
  existingOpenActions: ReadonlyArray<{ readonly action: string }>,
  knownGoalSlugs: ReadonlyArray<string>,
): ReadonlyArray<PlannedAction> => {
  const seen = new Set(existingOpenActions.map((a) => normalizeAction(a.action)))
  const goals = new Set(knownGoalSlugs)
  const out: PlannedAction[] = []
  for (const p of proposed) {
    const action = p.action.trim()
    if (action.length === 0) continue
    const norm = normalizeAction(action)
    if (seen.has(norm)) continue // already an open action (or a dup within this batch)
    seen.add(norm)
    out.push({
      action,
      priority: clampPriority(p.priority),
      goalSlug: p.goalSlug !== null && goals.has(p.goalSlug) ? p.goalSlug : null,
    })
  }
  return out
}
