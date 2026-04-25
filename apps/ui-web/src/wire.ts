/**
 * Wire-format types for the ui-ws protocol — v2 (chat semantics).
 *
 * IMPORTANT: keep in sync with
 *   - packages/core/src/observability/types.ts (ObsEvent shape)
 *   - packages/ui-ws/src/protocol.ts (ServerFrame / ClientFrame)
 *   - packages/chat-service/src/types.ts (ChatFrame, ChatMessage)
 *
 * We DON'T import from `@experiment-agent/core` directly: its package
 * barrel pulls node-only deps (fs, path, etc.) that would explode a Vite
 * browser bundle. Mirroring the wire types here is the standard solve;
 * the server-side Schema validator catches drift at the emit boundary.
 */

export type ObsEventLevel = "info" | "warn" | "error"

export type ObsEventKind =
  | "SessionStart"
  | "SessionEnd"
  | "ToolCall"
  | "HookFire"
  | "PermissionDecision"
  | "TeammateStart"
  | "TeammateIdle"
  | "TeammateStop"
  | "WorkflowTransition"
  | "AccountSwitch"
  | "CostAccrued"
  | "Error"

export interface ObsEventBase {
  readonly ts: string
  readonly kind: ObsEventKind
  readonly level: ObsEventLevel
  readonly [key: string]: unknown
}

export type ObsEvent = ObsEventBase

export const UI_WS_PROTOCOL_VERSION = 2 as const

/* Chat-shaped types mirrored from chat-service/types.ts + core projection. */

export interface ChatToolUse {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export interface ChatMessage {
  readonly id: string
  readonly seq: number
  readonly ts: number
  readonly role: "user" | "assistant"
  readonly text: string
  readonly toolUses: ReadonlyArray<ChatToolUse>
}

export interface SessionSummary {
  readonly id: string
  readonly parentId: string | null
  readonly title: string | null
  readonly tags: ReadonlyArray<string>
  readonly createdAt: number
  readonly endedAt: number | null
  readonly model: string
  readonly status: "active" | "closed" | "errored"
  readonly lastMessageAt: number | null
  readonly lastMessagePreview: string | null
}

export type ChatErrorKind =
  | "sdk"
  | "idle"
  | "interrupted"
  | "unknown-thread"

/* Server → client frames */

export interface HelloFrame {
  readonly type: "hello"
  readonly protocolVersion: 2
  readonly kinds: ReadonlyArray<string>
  readonly capabilities: {
    readonly chat: boolean
    readonly streamingDeltas: boolean
  }
}
export interface EventFrame {
  readonly type: "event"
  readonly event: ObsEvent
}
export interface DropFrame {
  readonly type: "drop"
  readonly n: number
  readonly since: string
}
export interface PingFrame {
  readonly type: "ping"
  readonly ts: string
}
export interface ByeFrame {
  readonly type: "bye"
  readonly reason: string
}
export interface ThreadListFrame {
  readonly type: "thread-list"
  readonly threads: ReadonlyArray<SessionSummary>
}
export interface ThreadCreatedFrame {
  readonly type: "thread-created"
  readonly thread: SessionSummary
}
export interface ThreadSnapshotFrame {
  readonly type: "thread-snapshot"
  readonly threadId: string
  readonly throughSeq: number
  readonly messages: ReadonlyArray<ChatMessage>
}
export interface UserAcceptedFrame {
  readonly type: "user-accepted"
  readonly threadId: string
  readonly seq: number
  readonly message: ChatMessage
}
export interface AssistantDeltaFrame {
  readonly type: "assistant-delta"
  readonly threadId: string
  readonly turnId: string
  readonly text: string
}
export interface AssistantDoneFrame {
  readonly type: "assistant-done"
  readonly threadId: string
  readonly turnId: string
  readonly seq: number
  readonly message: ChatMessage
}
export interface AssistantErrorFrame {
  readonly type: "assistant-error"
  readonly threadId: string
  readonly turnId: string | null
  readonly error: { readonly kind: ChatErrorKind; readonly message: string }
}

export type ArtifactSource = "code-fence" | "tool-write"

export interface Artifact {
  readonly id: string
  readonly source: ArtifactSource
  readonly path: string | null
  readonly lang: string | null
  readonly title: string
  readonly content: string
}

export interface ArtifactsExtractedFrame {
  readonly type: "artifacts-extracted"
  readonly threadId: string
  readonly messageId: string
  readonly messageSeq: number
  readonly artifacts: ReadonlyArray<Artifact>
}

export type ServerFrame =
  | HelloFrame
  | EventFrame
  | DropFrame
  | PingFrame
  | ByeFrame
  | ThreadListFrame
  | ThreadCreatedFrame
  | ThreadSnapshotFrame
  | UserAcceptedFrame
  | AssistantDeltaFrame
  | AssistantDoneFrame
  | AssistantErrorFrame
  | ArtifactsExtractedFrame

/* Client → server frames */

export interface PongFrame {
  readonly type: "pong"
  readonly ts: string
}
export interface SubscribeThreadFrame {
  readonly type: "subscribe"
  readonly threadId: string
}
export interface UnsubscribeThreadFrame {
  readonly type: "unsubscribe"
  readonly threadId: string
}
export interface ListThreadsFrame {
  readonly type: "list-threads"
  readonly limit?: number
}
export interface NewThreadFrame {
  readonly type: "new-thread"
  readonly model: string
  readonly title?: string
  readonly tags?: ReadonlyArray<string>
  readonly systemPrompt?: string
}
export interface UserMessageFrame {
  readonly type: "user-message"
  readonly threadId: string
  readonly text: string
}
export interface InterruptFrame {
  readonly type: "interrupt"
  readonly threadId: string
}

export type ClientFrame =
  | PongFrame
  | ByeFrame
  | SubscribeThreadFrame
  | UnsubscribeThreadFrame
  | ListThreadsFrame
  | NewThreadFrame
  | UserMessageFrame
  | InterruptFrame
