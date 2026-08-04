/**
 * Tool-allowlist wiring - split out of chat-service.ts along the seam its own
 * doc comments already named: the fixed set of Luna MCP tools every thread
 * pre-approves, and the injection point (`ThreadToolsProviderTag`) an app
 * uses to hand ChatService per-thread MCP servers + a merged system prompt +
 * a post-create binding callback.
 *
 * Moved verbatim from chat-service.ts - no behavior change. `chat-service.ts`
 * re-exports `ThreadToolsProviderTag` so existing consumers (`@luna/chat-
 * service` barrel, ui-web's chat-server) see no import-path change.
 */
import { Context } from "effect"
import { type ThreadToolsProvider } from "./types.js"

export const LUNA_ALLOWED_MCP_TOOLS = [
  "mcp__memory__*",
  "mcp__scheduler__*",
  "mcp__observability__*",
  "mcp__local_shell__*",
  "mcp__secret_tools__*",
  // skill_tools (skill_load) + widget_tools (widget_write) are mounted into
  // every thread's mcpServers by decorate(), so the agent SEES them — but
  // without pre-approval each first call stalls on the SDK permission prompt
  // in a headless server ("the skill needs permission — skip it"). Pre-approve
  // them so the agent can load skills + author widgets autonomously.
  "mcp__skill_tools__*",
  "mcp__widget_tools__*",
  // suggest_action — same pre-approval rationale (mounted by decorate()).
  "mcp__suggested_actions__*",
] as const

/**
 * Optional injection point for per-thread tool wiring. When provided, the
 * app supplies MCP servers + a merged system prompt + a post-create binding
 * callback that ChatService applies to EVERY thread creation. Resolved via
 * `Effect.serviceOption`, so omitting it leaves ChatService's prior
 * tool-free behavior intact (and existing consumers/tests need no change).
 *
 * This exists because tool wiring used to be an app-level wrapper around the
 * public `createThread`, which the internal subscribe()-restart-recovery
 * path bypassed — leaving resumed threads with `allowedTools` set but zero
 * MCP servers. Wiring at the service seam covers both paths.
 */
export const ThreadToolsProviderTag = Context.GenericTag<ThreadToolsProvider>(
  "luna/ThreadToolsProvider",
)
