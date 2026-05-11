/**
 * ChatService domain types — the wire-shape ChatService emits through its
 * `subscribe(threadId)` Stream. ui-ws (Commit 2b) translates these 1:1 to
 * `ServerFrame`s; the Tauri shell will consume the same Stream directly.
 *
 * Why these live in chat-service (not ui-ws): Per advisor verdict (Commit 2),
 * the WS layer is a dumb adapter over `ChatService.subscribe`. Keeping the
 * frame shape here means Tauri (and any future transport) gets the same
 * stream without depending on ui-ws.
 */
import type { ChatMessage, SessionSummary } from "@luna/core"
import type { Artifact } from "./artifacts.js"

/**
 * Tagged error kind. UI renders different visuals for each; persistence
 * (when we add it) keys retry policy off this.
 */
export type ChatErrorKind =
  | "sdk" // SDK / network / subprocess failure
  | "idle" // idle-timeout fired (should be impossible for chat threads,
  //                  which set disableIdleTimeout: true — but keeps the
  //                  taxonomy complete)
  | "interrupted" // user pressed Stop
  | "unknown-thread" // user-message arrived for a threadId ChatService doesn't own

export interface ChatError {
  readonly kind: ChatErrorKind
  readonly message: string
}

/**
 * One assistant turn rendered as it streams. `seq` matches the SessionStore
 * envelope seq for the assistant message — clients dedupe by `seq <= throughSeq`
 * after a snapshot replay (see ChatSnapshot below).
 *
 * `text` is cumulative — every delta carries the full assistant text so far.
 * (Cheaper to ship than diffs; SDK partial messages already give us
 * monotonically-growing text per turn.)
 */
export interface ChatAssistantDelta {
  readonly type: "assistant-delta"
  readonly threadId: string
  /** Stable id for the in-flight assistant turn. Stays the same across deltas. */
  readonly turnId: string
  readonly text: string
}

/** Final assistant turn, persisted, with definitive seq. */
export interface ChatAssistantDone {
  readonly type: "assistant-done"
  readonly threadId: string
  readonly turnId: string
  readonly seq: number
  /** The complete projected ChatMessage; clients can render with no further work. */
  readonly message: ChatMessage
}

export interface ChatAssistantError {
  readonly type: "assistant-error"
  readonly threadId: string
  readonly turnId: string | null
  readonly error: ChatError
}

/** Echoed back when ChatService accepts a user-message offer (mirrors what
 *  was persisted, including its seq — lets the client position it in the
 *  transcript without round-tripping through the snapshot). */
export interface ChatUserAccepted {
  readonly type: "user-accepted"
  readonly threadId: string
  readonly seq: number
  readonly message: ChatMessage
}

/**
 * Full thread replay sent on first `subscribe(threadId)`. Live frames after
 * this carry monotonic seq; client drops `seq <= throughSeq` to avoid
 * double-rendering the in-flight turn that was already in the snapshot.
 */
export interface ChatSnapshot {
  readonly type: "snapshot"
  readonly threadId: string
  readonly throughSeq: number
  readonly messages: ReadonlyArray<ChatMessage>
}

/** Server-pushed sidebar view. ChatService recomputes lazily on demand
 *  (`listThreads`) — there is no "live thread list" stream in v1. */
export type ChatThreadList = ReadonlyArray<SessionSummary>

/**
 * Emitted after `assistant-done` whenever the finalized turn carries
 * artifact-worthy payloads (substantial code fences or filesystem-write
 * tool uses). Always tied to a specific assistant message via `messageSeq`
 * so the UI can pin them to the right bubble.
 */
export interface ChatArtifactsExtracted {
  readonly type: "artifacts-extracted"
  readonly threadId: string
  readonly messageId: string
  readonly messageSeq: number
  readonly artifacts: ReadonlyArray<Artifact>
}

/**
 * Union of every frame the per-thread subscribe Stream emits. ui-ws maps
 * this 1:1 to its ServerFrame chat variants.
 */
export type ChatFrame =
  | ChatSnapshot
  | ChatAssistantDelta
  | ChatAssistantDone
  | ChatAssistantError
  | ChatUserAccepted
  | ChatArtifactsExtracted

/** Options accepted by `createThread`. Mirrors the subset of SessionOptions
 *  a chat caller cares about; ChatService overlays the chat-required fields
 *  (disableIdleTimeout: true, sdkOptions.includePartialMessages: true). */
export interface CreateThreadOptions {
  readonly model: string
  readonly title?: string
  readonly tags?: ReadonlyArray<string>
  readonly parentSessionId?: string
  readonly systemPrompt?: string
  /** Working directory for the agent's filesystem tools. Defaults to
   *  `LUNA_REPO_ROOT` env var if set, else `process.cwd()`. */
  readonly cwd?: string
  /** Which filesystem setting sources the SDK should load (skills, plugins,
   *  MCP servers, CLAUDE.md, hooks). Defaults to `["user", "project"]` so
   *  ~/.claude/skills + <cwd>/.claude/skills + project CLAUDE.md all load.
   *  Pass `[]` to opt out of all filesystem-discovered config. */
  readonly settingSources?: ReadonlyArray<"user" | "project" | "local">
  /** Permission mode for the SDK. Default is `"default"` (canUseTool prompts
   *  for sensitive ops). When the `LUNA_TRUSTED_LOCAL=1` env var is set, the
   *  default flips to `"bypassPermissions"` — the agent runs unrestricted.
   *  Caller-supplied value always wins over the env-derived default.
   *
   *  WARNING: `bypassPermissions` lets the agent run arbitrary Bash, write
   *  any file, etc. Only use on a trusted local machine. */
  readonly permissionMode?:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan"
  /**
   * MCP servers to register on the thread's underlying SDK session. The
   * map is merged into `sdkOptions.mcpServers`. Phase 30 added this so
   * memory tools (and any future tool packages) can be wired in by the
   * caller without subclassing ChatService. Values are opaque to chat-
   * service — they pass through to the SDK adapter.
   */
  readonly mcpServers?: Readonly<Record<string, unknown>>
  /**
   * §0.2 sticky-pin: if set, the adapter requests this specific account.
   * Passed through SessionOptions → QueryRequest.boundAccountId.
   */
  readonly boundAccountId?: string
}
