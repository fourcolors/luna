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
 * Tagged-union error kind matches `ChatErrorKind` in @luna/chat-service.
 */
import type { ObsEvent, ChatMessage, SessionSummary, SurveyItem, SurveyVerdict } from "@luna/core"
import type { Artifact } from "@luna/chat-service"

export const UI_WS_PROTOCOL_VERSION = 2 as const

/* -------------------------------------------------------------------------- */
/* Server → client                                                            */
/* -------------------------------------------------------------------------- */

export interface HelloFrame {
  readonly type: "hello"
  readonly protocolVersion: typeof UI_WS_PROTOCOL_VERSION
  /** ObsEvent kinds advertised. */
  readonly kinds: ReadonlyArray<string>
  /**
   * Git short-SHA of the running server build (e.g. "ae44d29"). OPTIONAL and
   * additive — older servers omit it and older clients ignore it, so no
   * protocol bump is needed. Lets a client display which build it's talking to.
   */
  readonly buildSha?: string
  /** Capability flags so older clients can negotiate down. */
  readonly capabilities: {
    readonly chat: boolean
    readonly streamingDeltas: boolean
    readonly localShell: boolean
    readonly setup: boolean
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

export interface ToolCallFrame {
  readonly type: "tool-call"
  readonly threadId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly name: string
  readonly input: unknown
}

export interface ToolResultFrame {
  readonly type: "tool-result"
  readonly threadId: string
  readonly toolCallId: string
  readonly status: "ok" | "error"
  readonly output: string
  readonly truncated: boolean
}

export interface AccountListFrame {
  readonly type: "account-list"
  readonly accounts: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: string
    readonly health: string
  }>
}

export interface LocalShellRequestFrame {
  readonly type: "local-shell-request"
  readonly requestId: string
  readonly threadId: string
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
}

export interface LocalShellStatusFrame {
  readonly type: "local-shell-status"
  readonly threadId: string
  readonly enabled: boolean
  readonly accepted: boolean
  readonly message: string
}

/**
 * Server→client ack for a `register-op-token` request (Moon secure-entry).
 * Additive and optional — no protocol bump. `ok:true` means the token was
 * verified and persisted (the server typically then restarts to pick it up);
 * `ok:false` carries a non-sensitive reason in `message`. The token itself is
 * NEVER echoed back here.
 */
export interface RegisterOpTokenStatusFrame {
  readonly type: "register-op-token-status"
  readonly requestId: string
  readonly ok: boolean
  readonly message: string
}

/* ── memory search ──────────────────────────────────────────────────── */

export interface MemorySearchHit {
  readonly id: string
  readonly kind: string
  readonly content: string
  readonly score: number
}

export interface MemorySearchResultFrame {
  readonly type: "memory-search-result"
  readonly queryText: string
  readonly hits: ReadonlyArray<MemorySearchHit>
}

export type MemorySearchErrorKind = "no-vector-backend" | "internal"

export interface MemorySearchErrorFrame {
  readonly type: "memory-search-error"
  readonly queryText: string
  readonly message: string
  readonly kind: MemorySearchErrorKind
}

/* ── alignment survey (Phase 3 D3) ──────────────────────────────────── */

/**
 * Server-pushed check-in (spec §3.3). Sent after `hello` when a survey is due
 * (connection-time due-check, D-LOCK-1). `issuedAt` is the stable idempotency
 * anchor — the client echoes it on every verdict's `at` (D-LOCK-5) so a
 * re-delivered answer never double-moves the EWMA. The server also pins `at`
 * server-side as defence-in-depth.
 *
 * `surveyId` uniquely identifies this survey instance on the wire (used to
 * correlate a SurveyResponseFrame back to its originating push). It is minted
 * by the server at push time (derived from `issuedAt`); T3 boot wiring can
 * ignore or log it — `issuedAt` is the idempotency key used by processVerdict.
 *
 * NOTE: There is NO dismiss/snooze frame (Execution Correction #1). Dismiss is
 * a client-side no-op — an unanswered survey simply re-surfaces on the next
 * connection-time due-check. Only an answered survey (which always carries the
 * mandatory task_quality item) advances the schedule via getLastSurveyAt.
 */
export interface SurveyRequestFrame {
  readonly type: "survey-request"
  /** Unique survey instance id (minted server-side from issuedAt). */
  readonly surveyId: string
  /** Server clock at issue. The idempotency anchor for all verdicts (D-LOCK-5). */
  readonly issuedAt: number
  /** Items to present: ALWAYS one task_quality item, then ≤3 belief items (D-LOCK-3/4). */
  readonly items: ReadonlyArray<SurveyItem>
}

/** Server→client: a chunk of pty stdout, base64-encoded (raw bytes, may include control codes). */
export interface PtyOutputFrame {
  readonly type: "pty-output"
  readonly data: string
}
/** Client→server: keystrokes for the pty stdin, base64-encoded. */
export interface PtyInputFrame {
  readonly type: "pty-input"
  readonly data: string
}
/** Client→server: terminal resize. */
export interface PtyResizeFrame {
  readonly type: "pty-resize"
  readonly cols: number
  readonly rows: number
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
  | ToolCallFrame
  | ToolResultFrame
  | AccountListFrame
  | LocalShellRequestFrame
  | LocalShellStatusFrame
  | RegisterOpTokenStatusFrame
  | MemorySearchResultFrame
  | MemorySearchErrorFrame
  | SurveyRequestFrame
  | PtyOutputFrame

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
  readonly accountId?: string    // pins this thread to a specific account
  readonly title?: string
  readonly tags?: ReadonlyArray<string>
  readonly systemPrompt?: string
}

/**
 * File attachment on a user turn. `data` is raw base64 (no `data:` prefix).
 * Images use the four base64 image media types; PDFs (`application/pdf`) ride
 * the Anthropic `document` content-block path (verified to pass through the
 * Agent SDK to the model). Mirrors `ChatAttachment` in @luna/ui-shared and
 * @luna/core.
 */
export interface WireAttachment {
  readonly mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "application/pdf"
  readonly data: string
}

/**
 * Small identity blob clients attach to each user-message so the server (and
 * Luna) can see *which* surface the operator is typing through — e.g. the
 * agent-cli TUI, the web UI, the Tauri "moon" client, etc.
 *
 * Additive and optional: older clients omit it; older servers ignore it.
 * No protocol bump required.
 *
 * Conventions for `name`:
 *   - "luna-tui"     — apps/agent-cli TUI
 *   - "luna-web"     — apps/ui-web (browser)
 *   - "luna-moon"    — apps/ui-moon-tauri (desktop)
 *   - "luna-tauri"   — apps/ui-tauri (legacy wrapper)
 * Anything else is accepted; the server treats it as a string.
 */
export interface ClientInfo {
  readonly name: string
  /** Semver, git short-sha, or build id. */
  readonly version?: string
  /** "darwin" | "linux" | "win32" | "browser" | "ios" | "android" | etc. */
  readonly platform?: string
}

export interface UserMessageFrame {
  readonly type: "user-message"
  readonly threadId: string
  readonly text: string
  /**
   * Optional image/PDF attachments. Validated server-side (images ≤10MB,
   * PDFs ≤20MB, turn total ≤20MB decoded); unknown mediaTypes are rejected
   * with `assistant-error{kind:"sdk"}`.
   */
  readonly attachments?: ReadonlyArray<WireAttachment>
  /**
   * Optional client-identity hint (see `ClientInfo`). When present, the
   * server prepends a one-line `[client: …]` marker to the user text before
   * handing it to the model so Luna can see which surface the operator is
   * using. Absent → server passes text through unmodified.
   */
  readonly client?: ClientInfo
}

export interface InterruptFrame {
  readonly type: "interrupt"
  readonly threadId: string
}

export interface LocalShellCapabilityFrame {
  readonly type: "local-shell-capability"
  readonly threadId: string
  readonly enabled: boolean
  readonly approvalMode?: "prompt" | "auto"
  readonly replaceable?: boolean
  readonly clientId: string
  readonly platform: string
  /**
   * Back-compat default working directory. Always present (= `roots[0]` when a
   * client attaches multiple roots, else the single attached directory). Older
   * clients send only this; newer clients also send `roots`/`fullAccess`.
   */
  readonly cwd: string
  /**
   * The set of attached folders the client exposes to the server (absolute
   * paths). When omitted, treat as `[cwd]` (a single-root client). Use
   * `capabilityRoots()` from "./local-shell-bridge.js" to normalize.
   */
  readonly roots?: ReadonlyArray<string>
  /**
   * Full-machine access — the client lets the server run commands in any
   * working directory (semantically root `/`). When true, `roots` is advisory
   * (the agent may still be told about attached folders) but no scope gate
   * applies. When omitted, treat as `false`.
   */
  readonly fullAccess?: boolean
}

export interface LocalShellResultFrame {
  readonly type: "local-shell-result"
  readonly requestId: string
  readonly threadId: string
  readonly approved: boolean
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly timedOut: boolean
}

export interface MemorySearchRequestFrame {
  readonly type: "memory-search-request"
  readonly queryText: string
  readonly topK?: number
}

/**
 * Client→server: register a 1Password service-account token for an account
 * label (Moon secure-entry form). Additive and optional — older servers
 * ignore it (unknown-frame path logs only the type, never the token).
 *
 * `token` is the `ops_…` service-account token. It is SENSITIVE: the server
 * validates + persists it but must never log it or persist it to chat
 * history. `requestId` correlates the `register-op-token-status` reply.
 */
export interface RegisterOpTokenFrame {
  readonly type: "register-op-token"
  readonly requestId: string
  readonly label: string
  readonly token: string
}

/**
 * The operator's answers to one survey (client→server, Phase 3 D3).
 *
 * `surveyId` MUST match the SurveyRequestFrame.surveyId. `issuedAt` MUST
 * equal the SurveyRequestFrame's `issuedAt` — the server stamps every
 * verdict's `at` to `frame.issuedAt` (D-LOCK-5), overriding whatever the
 * client sends, so a replaying client cannot double-move the EWMA.
 * `via` is always "survey" for these verdicts.
 *
 * There is NO survey-dismiss frame (Execution Correction #1): dismiss is a
 * client-side no-op — the modal closes, nothing is sent, and the next
 * connection-time due-check re-surfaces the unanswered survey.
 */
export interface SurveyResponseFrame {
  readonly type: "survey-response"
  /** Echoes back SurveyRequestFrame.surveyId for correlation. */
  readonly surveyId: string
  /** Must match the corresponding SurveyRequestFrame.issuedAt (D-LOCK-5). */
  readonly issuedAt: number
  /** The operator's answers. Server pins each verdict.at to this issuedAt. */
  readonly verdicts: ReadonlyArray<SurveyVerdict>
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
  | LocalShellCapabilityFrame
  | LocalShellResultFrame
  | MemorySearchRequestFrame
  | RegisterOpTokenFrame
  | SurveyResponseFrame
  | PtyInputFrame
  | PtyResizeFrame
