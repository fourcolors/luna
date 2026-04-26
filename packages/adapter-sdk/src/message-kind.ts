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
