/**
 * Map the SDK's SDKMessage variant to the coarse `MessageKind` we store in
 * the envelope. This is the adapter's job — core doesn't know the SDK
 * union.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { MessageKind } from "@luna/core"

export const sdkMessageKind = (m: SDKMessage): MessageKind => {
  // SDK messages all have a `type` discriminator, but some variants use
  // finer-grained tags (e.g. "stream_event"). Map to our coarse bins.
  const t = (m as { type?: string }).type
  switch (t) {
    case "user":
      return "user"
    case "assistant":
      return "assistant"
    case "system":
      return "system"
    case "result":
      return "result"
    case "stream_event":
      return "stream_event"
    default:
      // Hook/status/notification/* all go through "other" unless explicitly
      // named — we prefer "other" over guessing.
      if (t && t.startsWith("hook_")) return "hook"
      if (t && t.startsWith("status")) return "status"
      return "other"
  }
}

export const sdkMessageId = (m: SDKMessage): string => {
  // Most messages carry `uuid`; fall back to a synthesized id for those
  // that don't (result messages always do; partials might not).
  const mm = m as { uuid?: string; session_id?: string; type?: string }
  return mm.uuid ?? `${mm.session_id ?? "unknown"}:${mm.type ?? "?"}:${Date.now()}`
}

export const sdkMessageSessionId = (m: SDKMessage): string | null => {
  const mm = m as { session_id?: string }
  return mm.session_id ?? null
}

export const sdkMessageParentId = (m: SDKMessage): string | null => {
  const mm = m as { parent_tool_use_id?: string | null }
  return mm.parent_tool_use_id ?? null
}

type ContentBlocks = {
  message?: {
    content?: ReadonlyArray<{
      type?: string
      id?: string
      name?: string
      tool_use_id?: string
    }>
  }
}

/**
 * tool_use ids of subagent-spawn calls in an assistant message. The SDK's
 * subagent tool is named "Agent" on emitted tool_use blocks ("Task" is the
 * options-layer alias — matched too, defensively). Used by the adapter's
 * inactivity watchdog to widen its window while a subagent is outstanding.
 */
export const sdkAgentSpawnIds = (m: SDKMessage): ReadonlyArray<string> => {
  if ((m as { type?: string }).type !== "assistant") return []
  const blocks = (m as ContentBlocks).message?.content ?? []
  const ids: string[] = []
  for (const b of blocks) {
    if (
      b.type === "tool_use" &&
      (b.name === "Agent" || b.name === "Task") &&
      typeof b.id === "string"
    ) {
      ids.push(b.id)
    }
  }
  return ids
}

/** tool_use ids settled by tool_result blocks in a user message. */
export const sdkToolResultIds = (m: SDKMessage): ReadonlyArray<string> => {
  if ((m as { type?: string }).type !== "user") return []
  const blocks = (m as ContentBlocks).message?.content ?? []
  const ids: string[] = []
  for (const b of blocks) {
    if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      ids.push(b.tool_use_id)
    }
  }
  return ids
}
