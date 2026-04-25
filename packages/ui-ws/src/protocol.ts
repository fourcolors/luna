/**
 * UI WebSocket wire protocol — v2 (chat semantics).
 *
 * v1 was broadcast-only obs events. v2 adds chat:
 *   - subscriptions: `Set<threadId>` per connection (multi-thread sidebar
 *     can stay live while the user reads one)
 *   - chat client→server: subscribe / unsubscribe / new-thread / user-message
 *     / interrupt / list-threads
 *   - chat server→client: thread-list / thread-snapshot / user-accepted /
 *     assistant-delta / assistant-done / assistant-error / thread-created
 *
 * Existing obs frames (`event` / `drop`) are unchanged and broadcast — every
 * connection sees them regardless of subscriptions.
 *
 * Dedupe model: `thread-snapshot` carries `throughSeq`. Live chat frames
 * carry their own `seq`. Clients drop `seq <= throughSeq` after reconnect.
 *
 * Tagged-union error kind matches `ChatErrorKind` in @experiment-agent/chat-service.
 */
import type { ObsEvent, ChatMessage, SessionSummary } from "@experiment-agent/core"
import type { Artifact } from "@experiment-agent/chat-service"

export const UI_WS_PROTOCOL_VERSION = 2 as const

/* -------------------------------------------------------------------------- */
/* Server → client                                                            */
/* -------------------------------------------------------------------------- */

export interface HelloFrame {
  readonly type: "hello"
  readonly protocolVersion: typeof UI_WS_PROTOCOL_VERSION
  /** ObsEvent kinds advertised. */
  readonly kinds: ReadonlyArray<string>
  /** Capability flags so older clients can negotiate down. */
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

/* Chat-specific server frames (v2) */

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

export type ChatErrorKind =
  | "sdk"
  | "idle"
  | "interrupted"
  | "unknown-thread"

export interface AssistantErrorFrame {
  readonly type: "assistant-error"
  readonly threadId: string
  readonly turnId: string | null
  readonly error: {
    readonly kind: ChatErrorKind
    readonly message: string
  }
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

/* -------------------------------------------------------------------------- */
/* Client → server                                                            */
/* -------------------------------------------------------------------------- */

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
