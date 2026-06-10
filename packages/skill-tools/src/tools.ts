/**
 * skill_load — the tier-2 half of progressive disclosure (PRD Part B §11).
 *
 * The system prompt carries a one-line INDEX of enabled skills (the
 * registry's "index" disclosure mode); when the agent decides a skill is
 * relevant it calls this tool to pull the full body into context. Disabled
 * or unknown ids error — the operator's toggle is authoritative and a
 * disabled skill's body must never disclose through this side door.
 */
import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import { SkillRegistry } from "@luna/core"

const SKILL_TOOL_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Load the full instructions of one of your skills by id, as listed in the Skills index of your system prompt.",
} as const

const skillLoadShape = {
  id: z
    .string()
    .min(1)
    .describe(
      "The skill id exactly as it appears in your Skills index, e.g. 'clear-writing'.",
    ),
}

export const makeSkillTools = (
  registry: (typeof SkillRegistry)["Service"],
) => {
  const skillLoad = defineTool({
    name: "skill_load",
    description:
      "Load the full instructions of an enabled skill. Your system prompt " +
      "lists enabled skills as one-line index entries (id — description — " +
      "when to use); call this with a skill's id BEFORE applying it so you " +
      "work from its actual instructions, not a guess. Returns the complete " +
      "skill body. Errors for unknown or disabled skills.",
    inputSchema: skillLoadShape,
    ...SKILL_TOOL_DISCOVERY,
    handler: (args) =>
      registry.body(args.id).pipe(
        Effect.map((body) => ({ id: args.id, body })),
        Effect.mapError(
          (e) =>
            new ToolError({
              tool: "skill_load",
              op: "skill.load",
              cause: e.message,
            }),
        ),
      ),
  })

  return [skillLoad] as const
}
