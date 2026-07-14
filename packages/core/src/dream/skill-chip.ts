/**
 * skill-chip.ts — pure mapping from skill_improvement DreamOps to
 * SuggestedActions.propose inputs. No I/O. Dream applyOps owns emission.
 *
 * Policy (operator decision A, 2026-07-14):
 *   - mode=create → actionType create_skill (quarantined disabled on accept)
 *   - mode=update → actionType task (rewrite existing user skill under ~/.luna/skills)
 *   - NEVER auto-apply skill files from dream
 */
import type { ProposeInput } from "../suggested-actions/types.js"
import type { DreamOp, SkillImprovementAfter } from "./types.js"

/** Hard cap on skill chips emitted per dream cycle (not per chunk). */
export const MAX_SKILL_IMPROVEMENT_CHIPS = 3

/**
 * Single-segment skill slug: no path separators, no `..`, no whitespace.
 * Rejects model-emitted values that would poison `~/.luna/skills/<id>/…` prefaces.
 */
export const isSafeSkillId = (id: string): boolean =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)

/** True when after looks like a SkillImprovementAfter payload. */
export const isSkillImprovementAfter = (
  after: unknown,
): after is SkillImprovementAfter => {
  if (after === null || typeof after !== "object") return false
  const a = after as Record<string, unknown>
  if (!(a["mode"] === "create" || a["mode"] === "update")) return false
  if (typeof a["title"] !== "string" || a["title"].length === 0) return false
  if (typeof a["prompt"] !== "string" || a["prompt"].length === 0) return false
  if (!(a["detail"] === null || typeof a["detail"] === "string" || a["detail"] === undefined)) {
    return false
  }
  const skillId = a["skillId"]
  if (skillId === null || skillId === undefined) {
    // create may omit skillId; update requires a safe slug (checked below).
    if (a["mode"] === "update") return false
    return true
  }
  if (typeof skillId !== "string" || !isSafeSkillId(skillId)) return false
  return true
}

/**
 * Map one held skill_improvement op to a ProposeInput.
 * Returns null when the op is the wrong kind or the payload is malformed.
 */
export const skillImprovementToPropose = (
  op: DreamOp,
  threadId: string,
): ProposeInput | null => {
  if (op.kind !== "skill_improvement") return null
  if (!isSkillImprovementAfter(op.after)) return null
  const after = op.after
  const mode = after.mode
  // Defense in depth: never interpolate an unsafe skillId into a path preface.
  if (mode === "update") {
    if (!after.skillId || !isSafeSkillId(after.skillId)) return null
  }
  const actionType = mode === "update" ? "task" : "create_skill"
  const detail =
    after.detail ??
    (mode === "update" && after.skillId
      ? `Update skill \`${after.skillId}\``
      : null)
  const preface =
    mode === "update" && after.skillId
      ? `Update the EXISTING Luna user skill at ~/.luna/skills/${after.skillId}/SKILL.md. ` +
        `Do not create a parallel skill unless the existing file is missing. ` +
        `Leave the skill enabled-state alone (do not force-enable).\n\n`
      : `Create a new Luna skill under ~/.luna/skills/<slug>/SKILL.md. ` +
        `It will register DISABLED until the operator enables it.\n\n`

  const base = {
    threadId,
    source: "dream" as const,
    actionType: actionType as "task" | "create_skill",
    title: after.title,
    rationale: op.rationale,
    payload: {
      prompt: `${preface}${after.prompt}\n\nWhy (from dream): ${op.rationale}`,
    },
  }
  // exactOptionalPropertyTypes: omit detail rather than assign undefined.
  if (detail != null && detail.length > 0) {
    return { ...base, detail }
  }
  return base
}

/**
 * Stable synthetic targetId for create-mode skill improvements (no skill id yet).
 * FNV-1a 32-bit hex-ish base36, same family as suggested-actions deriveActionId.
 */
export const deriveSkillImprovementTargetId = (
  title: string,
  prompt: string,
): string => {
  const s = `skill-imp|${title.trim().toLowerCase()}|${prompt.trim().toLowerCase()}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `skill-imp-${(h >>> 0).toString(36)}`
}
