import { Effect } from "effect"
import { z } from "zod"
import { defineTool, ToolError } from "@luna/tools"
import type { SuggestedActionsApi, SuggestedActionPayload } from "@luna/core"

const SUGGEST_ACTION_DISCOVERY = {
  alwaysLoad: true,
  searchHint:
    "Propose a follow-up action to the user (do a task, create a skill, do research, create or run a workflow). It appears inline in the chat and in the per-thread Actions panel; the user accepts (Luna auto-runs it as a background job) or dismisses it.",
} as const

const suggestActionShape = {
  action_type: z
    .enum(["task", "research", "create_skill", "create_workflow", "run_workflow"])
    .describe(
      "What kind of action to propose. 'task'/'research'/'create_skill'/" +
        "'create_workflow' spawn a background subagent driven by `prompt`. " +
        "'run_workflow' dispatches an EXISTING saved workflow job by `job_id`.",
    ),
  title: z
    .string()
    .min(1)
    .describe("Short label shown on the inline chip and panel row, e.g. 'Research LiveKit pricing'."),
  rationale: z
    .string()
    .optional()
    .describe("One sentence on WHY this is worth doing — shown to the user."),
  detail: z
    .string()
    .optional()
    .describe("Optional longer description of the action."),
  prompt: z
    .string()
    .optional()
    .describe(
      "Required for task/research/create_skill/create_workflow: the full " +
        "instruction the spawned subagent will follow when the user accepts. " +
        "Be self-contained — the subagent has no chat context.",
    ),
  job_id: z
    .string()
    .optional()
    .describe("Required for run_workflow: the id of an existing saved workflow job to run."),
}

/**
 * `makeSuggestedActionTools(service, currentThreadId)` — one agent tool,
 * `suggest_action`, that stages a proposal via the shared SuggestedActions
 * service. Mirrors secret-tools: the dependency (the resolved service) and the
 * thread-id accessor are captured at construction; the handler reads the bound
 * thread id at call time.
 */
export const makeSuggestedActionTools = (
  service: SuggestedActionsApi,
  currentThreadId: () => string | null,
) => {
  const suggestAction = defineTool({
    name: "suggest_action",
    description:
      "Propose a follow-up action you think the user should consider. It " +
      "surfaces inline in the chat ('Luna suggested an action…') and in the " +
      "per-thread Actions panel. If the user accepts, Luna runs it " +
      "automatically as a tracked background job. Use this for substantive " +
      "follow-ups (a task, a new skill, research, a workflow) — not for " +
      "trivial things you can just do now.",
    inputSchema: suggestActionShape,
    ...SUGGEST_ACTION_DISCOVERY,
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = currentThreadId()
        if (!threadId) {
          return yield* Effect.fail(
            new ToolError({
              tool: "suggest_action",
              op: "suggest",
              cause: "no chat session is bound",
            }),
          )
        }

        let payload: SuggestedActionPayload
        if (args.action_type === "run_workflow") {
          if (args.job_id === undefined || args.job_id.trim() === "") {
            return yield* Effect.fail(
              new ToolError({
                tool: "suggest_action",
                op: "suggest",
                cause: "action_type 'run_workflow' requires a `job_id`",
              }),
            )
          }
          payload = { jobId: args.job_id }
        } else {
          if (args.prompt === undefined || args.prompt.trim() === "") {
            return yield* Effect.fail(
              new ToolError({
                tool: "suggest_action",
                op: "suggest",
                cause: `action_type '${args.action_type}' requires a \`prompt\``,
              }),
            )
          }
          payload = { prompt: args.prompt }
        }

        const row = yield* service
          .propose({
            threadId,
            source: "agent",
            actionType: args.action_type,
            title: args.title,
            ...(args.detail !== undefined ? { detail: args.detail } : {}),
            ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
            payload,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ToolError({ tool: "suggest_action", op: "suggest", cause }),
            ),
          )

        return { ok: true, actionId: row.id } as const
      }),
  })

  return [suggestAction] as const
}
