import { Effect, Layer } from "effect"
import { defineToolPackage } from "@luna/tools"
import { SuggestedActions } from "@luna/core"
import type { SuggestedActionsApi } from "@luna/core"
import type {
  AnyZodRawShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk"
import { makeSuggestedActionTools } from "./tools.js"

export interface SuggestedActionToolsSessionConfig {
  readonly serverName: "suggested_actions"
  readonly server: McpSdkServerConfigWithInstance
  readonly systemPromptAddendum: string
  readonly bindSession: (sessionId: string) => void
  readonly clearSession: (sessionId: string) => void
}

export interface SuggestedActionToolsConfig extends SuggestedActionToolsSessionConfig {
  readonly createSessionBinding: () => SuggestedActionToolsSessionConfig
}

export class SuggestedActionToolsService extends Effect.Tag(
  "luna/SuggestedActionToolsService",
)<SuggestedActionToolsService, SuggestedActionToolsConfig>() {}

export const SUGGESTED_ACTION_TOOLS_SYSTEM_PROMPT_ADDENDUM =
  "You have a suggested-actions MCP server (`suggested_actions`) with the tool " +
  "`mcp__suggested_actions__suggest_action(action_type, title, rationale?, detail?, prompt?, job_id?)`. " +
  "Use this fully-qualified name exactly; do not call the bare name. When, in the " +
  "course of helping, you notice a substantive follow-up worth doing — a task, a " +
  "new skill, some research, or a workflow to create or run — call suggest_action " +
  "to PROPOSE it rather than doing it unprompted. It appears inline in the chat and " +
  "in the user's Actions panel; if they accept, Luna runs it automatically as a " +
  "tracked background job. Provide a `prompt` (a self-contained instruction for the " +
  "background subagent — it has no chat context) for task/research/create_skill/" +
  "create_workflow; provide `job_id` for run_workflow. Propose sparingly and only " +
  "for genuinely useful follow-ups — do not propose trivial things you can just do now."

const createConfig = (
  service: SuggestedActionsApi,
): SuggestedActionToolsSessionConfig => {
  const sessionCell: { value: string | null } = { value: null }
  const currentThreadId = () => sessionCell.value
  const bindSession = (sessionId: string) => {
    sessionCell.value = sessionId
  }
  const clearSession = (sessionId: string) => {
    if (sessionCell.value === sessionId) {
      sessionCell.value = null
    }
  }

  const tools = makeSuggestedActionTools(
    service,
    currentThreadId,
  ) as unknown as ReadonlyArray<SdkMcpToolDefinition<AnyZodRawShape>>
  const config = defineToolPackage({
    name: "suggested_actions",
    tools,
    addendum: SUGGESTED_ACTION_TOOLS_SYSTEM_PROMPT_ADDENDUM,
  })

  return { ...config, serverName: "suggested_actions", bindSession, clearSession }
}

/**
 * Provides `SuggestedActionToolsService`. Requires the `SuggestedActions`
 * service (the resolved value is captured into the per-session tool config, so
 * the tool handler can call `propose()` with `R = never`).
 */
export const SuggestedActionToolsLayer: Layer.Layer<
  SuggestedActionToolsService,
  never,
  SuggestedActions
> = Layer.scoped(
  SuggestedActionToolsService,
  Effect.gen(function* () {
    const service = yield* SuggestedActions
    return {
      ...createConfig(service),
      createSessionBinding: () => createConfig(service),
    }
  }),
)
