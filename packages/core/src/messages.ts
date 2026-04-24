/**
 * SDK message types — tagged unions matching the Claude Agent SDK shapes per
 * DESIGN.md §12 (SDK Adapter Contract). Kept deliberately minimal here: the
 * adapter package will refine/extend these when Phase 3 lands, but the core
 * shapes are stable enough that every downstream service (SessionStore, Hooks,
 * Teams) can import them today.
 *
 * We import *only* types from the SDK — no runtime dependency — to keep
 * `@experiment-agent/core` dependency-free at runtime.
 */

// ── Content block shapes ─────────────────────────────────────────────────────

export interface TextBlock {
  readonly type: "text"
  readonly text: string
}

export interface ImageBlockSource {
  readonly type: "base64" | "url"
  readonly media_type?: string
  readonly data?: string
  readonly url?: string
}

export interface ImageBlock {
  readonly type: "image"
  readonly source: ImageBlockSource
}

export interface ToolUseBlock {
  readonly type: "tool_use"
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface ToolResultBlock {
  readonly type: "tool_result"
  readonly tool_use_id: string
  readonly content: string | ReadonlyArray<TextBlock | ImageBlock>
  readonly is_error?: boolean
}

export interface ThinkingBlock {
  readonly type: "thinking"
  readonly thinking: string
  readonly signature?: string
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock

// ── Top-level message tagged union ───────────────────────────────────────────

export interface SDKUserMessage {
  readonly type: "user"
  readonly session_id: string
  readonly parent_tool_use_id?: string | null
  readonly message: {
    readonly role: "user"
    readonly content: string | ReadonlyArray<ContentBlock>
  }
}

export interface SDKAssistantMessage {
  readonly type: "assistant"
  readonly session_id: string
  readonly parent_tool_use_id?: string | null
  readonly message: {
    readonly id: string
    readonly role: "assistant"
    readonly model: string
    readonly content: ReadonlyArray<ContentBlock>
    readonly stop_reason?: string | null
    readonly stop_sequence?: string | null
    readonly usage?: {
      readonly input_tokens: number
      readonly output_tokens: number
      readonly cache_creation_input_tokens?: number
      readonly cache_read_input_tokens?: number
    }
  }
}

export interface SDKSystemMessage {
  readonly type: "system"
  readonly subtype: string
  readonly session_id: string
  readonly data?: unknown
}

export interface SDKResultMessage {
  readonly type: "result"
  readonly subtype: "success" | "error_max_turns" | "error_during_execution"
  readonly session_id: string
  readonly is_error: boolean
  readonly duration_ms: number
  readonly duration_api_ms: number
  readonly num_turns: number
  readonly total_cost_usd?: number
  readonly result?: string
  readonly usage?: {
    readonly input_tokens: number
    readonly output_tokens: number
    readonly cache_creation_input_tokens?: number
    readonly cache_read_input_tokens?: number
  }
}

export interface SDKPartialAssistantMessage {
  readonly type: "stream_event"
  readonly session_id: string
  readonly parent_tool_use_id?: string | null
  readonly event: unknown // Anthropic RawMessageStreamEvent — opaque here
}

export type SDKMessage =
  | SDKUserMessage
  | SDKAssistantMessage
  | SDKSystemMessage
  | SDKResultMessage
  | SDKPartialAssistantMessage

// ── Narrowing helpers ────────────────────────────────────────────────────────

export const isUserMessage = (m: SDKMessage): m is SDKUserMessage =>
  m.type === "user"
export const isAssistantMessage = (m: SDKMessage): m is SDKAssistantMessage =>
  m.type === "assistant"
export const isSystemMessage = (m: SDKMessage): m is SDKSystemMessage =>
  m.type === "system"
export const isResultMessage = (m: SDKMessage): m is SDKResultMessage =>
  m.type === "result"
export const isPartialAssistantMessage = (
  m: SDKMessage,
): m is SDKPartialAssistantMessage => m.type === "stream_event"

/**
 * Monotonic sequence-numbered envelope we store in SessionStore.
 * Unlike raw SDK messages, this guarantees an ordering we control —
 * one of the §12.2 invariants (we don't trust the SDK's transcript view).
 */
export interface StoredMessage {
  readonly id: string
  readonly sessionId: string
  readonly seq: number
  readonly ts: number
  readonly parentId: string | null
  readonly kind: SDKMessage["type"]
  readonly payload: SDKMessage
}
