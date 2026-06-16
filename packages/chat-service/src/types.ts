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
import type { ChatMessage, SessionSummary, SuggestedActionView } from "@luna/core"
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

/** A tool the agent invoked, surfaced live when the assistant turn lands.
 *  `toolCallId` equals the SDK `tool_use.id` and links to its result. */
export interface ChatToolCall {
  readonly type: "tool-call"
  readonly threadId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly name: string
  readonly input: unknown
  /** Set when this call happened INSIDE a subagent: the `tool_use.id` of the
   *  parent Agent/Task call it nests under. Absent for top-level calls —
   *  additive, so pre-subagent clients render these as ordinary steps. */
  readonly parentToolUseId?: string
}

/** The result of a previously-announced tool call. `toolCallId` equals the
 *  SDK `tool_result.tool_use_id`. `output` is normalized text, truncated. */
export interface ChatToolResult {
  readonly type: "tool-result"
  readonly threadId: string
  readonly toolCallId: string
  readonly status: "ok" | "error"
  readonly output: string
  readonly truncated: boolean
  /** Mirror of ChatToolCall.parentToolUseId for results produced inside a
   *  subagent. Absent for top-level results. */
  readonly parentToolUseId?: string
}

/**
 * Marks the true end of an agentic turn — published once when the SDK emits
 * its terminal `result` message, after every intermediate tool step. An
 * agentic turn is N SDK assistant messages (each its own `turnId` → its own
 * `assistant-done`); per-message done can't signal "the whole turn is over".
 * Clients that group consecutive assistant turns into one view (the moon's
 * activity timeline) use this to settle that group. Carries no turnId — it
 * settles whatever the client's trailing in-flight turn is.
 */
export interface ChatTurnComplete {
  readonly type: "turn-complete"
  readonly threadId: string
}

/**
 * Suggested Actions (per-thread). `set` carries the full non-terminal set for a
 * thread (initial paint on subscribe / replay-on-open); `update` carries a
 * single action's status/execution delta. ui-ws maps these 1:1 to the
 * matching ServerFrames. The carried view is wire-safe (no payload).
 */
export interface ChatSuggestedActionSet {
  readonly type: "suggested-action-set"
  readonly threadId: string
  readonly actions: ReadonlyArray<SuggestedActionView>
}
export interface ChatSuggestedActionUpdate {
  readonly type: "suggested-action-update"
  readonly threadId: string
  readonly action: SuggestedActionView
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
  | ChatToolCall
  | ChatToolResult
  | ChatTurnComplete
  | ChatSuggestedActionSet
  | ChatSuggestedActionUpdate

/**
 * A background/job/scheduled result that was delivered into a thread (issue
 * #124). ChatService emits one of these on its `deliveries` stream every time
 * `deliverResult` posts a result; the WS layer broadcasts it to ALL connected
 * clients as a "Luna finished X" toast — so the user is notified even when the
 * target thread is not the one on screen. Distinct from the per-thread
 * ChatFrame stream (which only reaches subscribers of that one thread).
 */
export interface DeliveryNotification {
  /** The thread the result landed in. Clicking the toast can open it. */
  readonly threadId: string
  /** Where the result came from, e.g. "suggested-action", "background-job". */
  readonly source: string
  /** Human label for what finished, e.g. the job/action title. */
  readonly label: string
  /** Short excerpt of the result text for the toast body. */
  readonly preview: string
  /** Wall-clock ms when delivered. */
  readonly ts: number
}

/** Options accepted by `createThread`. Mirrors the subset of SessionOptions
 *  a chat caller cares about; ChatService overlays the chat-required fields
 *  (disableIdleTimeout: true, sdkOptions.includePartialMessages: true). */
export interface CreateThreadOptions {
  /** Model for the thread's SDK session. Omitted ⇒ the broker's "default"
   *  lane + the SDK's own default model (used by restart-recovery, where the
   *  original model is unknown — a hardcoded one would silently switch the
   *  resumed conversation's model/provider). */
  readonly model?: string
  /**
   * Effort level for this thread's SDK session. Controls how much reasoning
   * the model applies. Only valid for models that support effort (e.g.
   * Sonnet 4.6, Fable 5, Opus 4.8) — ignored silently on models that do not.
   * Persisted in thread-session-map.json for cross-restart recovery.
   *
   * `"ultracode"` is a pseudo-level: not a real SDK effort, but the dropdown
   * token for the SDK's ultracode mode (xhigh + standing workflow
   * orchestration). chat-service demuxes it into SDK `Settings` + the Workflow
   * tool (see effort.ts `ultracodeFlagSettings`); it never reaches
   * `Options.effort`.
   */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"
  readonly title?: string
  readonly tags?: ReadonlyArray<string>
  readonly parentSessionId?: string
  readonly systemPrompt?: string
  /** Working directory for the agent's filesystem tools. Defaults to
   *  `LUNA_REPO_ROOT` env var if set, else `process.cwd()`. */
  readonly cwd?: string
  /** Which filesystem setting sources the SDK should load (skills, plugins,
   *  MCP servers, CLAUDE.md, hooks). Defaults to SDK isolation mode (`[]`) so
   *  Luna does not inherit Claude Code user/project/local presets. Pass
   *  explicit sources only for a thread that should opt into that config. */
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
  /**
   * Use this thread id instead of generating a fresh one. Used by the
   * subscribe-cache-miss recovery path so a resumed thread keeps its
   * original id from the client's perspective. Caller must ensure the id
   * is well-formed (`thr_<base36>_<rand>`); a collision with an existing
   * thread fails the create.
   */
  readonly threadIdOverride?: string
  /**
   * When set, the underlying SDK call resumes the conversation history
   * persisted under this SDK session UUID (the SDK keeps history as JSONL
   * indexed by its own session id). Used together with `threadIdOverride`
   * to restore a thread after the chat-server's in-memory state was wiped
   * by a restart.
   */
  readonly resumeFromSessionId?: string
}

/**
 * The per-thread tool config a ThreadToolsProvider produces. ChatService
 * applies this to EVERY thread creation — new threads and threads restored
 * by the subscribe()-restart-recovery path alike — so a resumed thread can
 * never come back without its tools.
 */
export interface ThreadToolsBinding {
  /** MCP servers merged into the thread's `sdkOptions.mcpServers`. */
  readonly mcpServers: Readonly<Record<string, unknown>>
  /** Fully-merged system prompt (identity + metadata + tool addenda +
   *  caller prompt). When present it replaces the caller's systemPrompt;
   *  the provider is responsible for folding the caller's prompt in. */
  readonly systemPrompt?: string
  /** Run after the session row exists, with its id — for per-session
   *  bindings (obs tagging, local-shell attach, sandbox re-attach). */
  readonly onBound: (sessionId: string) => void
  /** Run when the thread's scope closes, with its id — the symmetric
   *  teardown for `onBound`. Releases any per-session state the provider
   *  registered at bind time (e.g. sandbox re-attach closures, tool
   *  session cells) so a long-lived server doesn't accumulate one entry
   *  per historical thread. Optional for back-compat: providers that hold
   *  no per-session state omit it. */
  readonly onUnbound?: (sessionId: string) => void
}

/**
 * Injected, optional. When provided, ChatService calls `decorate(opts)`
 * once per thread creation to obtain the thread's MCP servers, merged
 * system prompt, and post-create binding callback. This replaces the old
 * app-level createThread wrapper, which could not intercept the internal
 * resume path and so left resumed threads tool-less.
 */
export interface ThreadToolsProvider {
  readonly decorate: (opts: CreateThreadOptions) => ThreadToolsBinding
}
