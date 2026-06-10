/**
 * Wire-format types for the ui-ws protocol — v2 (chat semantics).
 *
 * IMPORTANT: keep in sync with
 *   - packages/core/src/observability/types.ts (ObsEvent shape)
 *   - packages/ui-ws/src/protocol.ts (ServerFrame / ClientFrame)
 *   - packages/chat-service/src/types.ts (ChatFrame, ChatMessage)
 *
 * We DON'T import from `@luna/core` directly: its package
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

/**
 * File attachment on a user turn. `data` is raw base64 (no `data:` prefix).
 * Images use the four base64 image media types; PDFs use `application/pdf`
 * (the Anthropic `document` content-block path).
 */
export interface ChatAttachment {
  readonly mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "application/pdf"
  readonly data: string
}

export interface ChatMessage {
  readonly id: string
  readonly seq: number
  readonly ts: number
  readonly role: "user" | "assistant"
  readonly text: string
  readonly toolUses: ReadonlyArray<ChatToolUse>
  /** Image attachments. Non-empty only on user turns. */
  readonly attachments: ReadonlyArray<ChatAttachment>
}

export interface SessionSummary {
  readonly id: string
  readonly parentId: string | null
  readonly title: string | null
  readonly tags: ReadonlyArray<string>
  readonly createdAt: number
  readonly endedAt: number | null
  readonly model: string
  readonly status: "active" | "idle" | "closed" | "errored"
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
    readonly setup: boolean
    /**
     * PRD Part B (Skills): server sends `skill-catalog` after hello and
     * routes `skill-toggle`. OPTIONAL/additive — absent on older servers;
     * clients hide the Skills settings section when missing. Mirrors
     * packages/ui-ws/src/protocol.ts — keep in sync.
     */
    readonly skills?: boolean
    /** PRD Part A (Connectors): connector catalog/instances + OAuth
     *  handshake available. OPTIONAL/additive. */
    readonly connectors?: boolean
    /** PRD Part C (Widgets/W1): server persists pinned artifacts and routes
     *  artifact-pin/unpin + artifact-list/update. OPTIONAL/additive — covers
     *  the artifact panel, pop-out widgets, and the workflow gallery. */
    readonly artifacts?: boolean
    /** PRD Part C (W3): server exposes the read-only workflow gallery over the
     *  jobs store (workflow-list + workflow-runs). OPTIONAL/additive. */
    readonly workflows?: boolean
  }
  /**
   * Models the operator can pick for new threads. OPTIONAL and additive —
   * absent on older servers; clients fall back to their own hardcoded list.
   * The FIRST entry is the recommended default.  Mirrors the same field in
   * packages/ui-ws/src/protocol.ts — keep in sync.
   */
  readonly availableModels?: ReadonlyArray<{ readonly id: string; readonly label: string }>
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

export interface AccountListFrame {
  readonly type: "account-list"
  readonly accounts: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly kind: string
    readonly health: string
  }>
}

/**
 * One skill row for the settings catalog — METADATA ONLY by construction
 * (no `body` field: skill bodies are agent prompt content and never cross
 * the wire to clients). Mirrors packages/ui-ws/src/protocol.ts — keep in sync.
 */
export interface SkillCatalogItem {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  readonly category: string
  readonly tags: ReadonlyArray<string>
  readonly source: string
  readonly enabled: boolean
}

/** Server→client: the skill catalog (sent after hello; re-sent after a toggle). */
export interface SkillCatalogFrame {
  readonly type: "skill-catalog"
  readonly skills: ReadonlyArray<SkillCatalogItem>
}

/** Server→client: ack for a `skill-toggle` (ok:false carries a short reason). */
export interface SkillStatusFrame {
  readonly type: "skill-status"
  readonly id: string
  readonly enabled: boolean
  readonly ok: boolean
  readonly message?: string
}

/* PRD Part A — connector frames (mirror packages/ui-ws/src/protocol.ts). */
export interface ConnectorCatalogItem {
  readonly id: string
  readonly name: string
  readonly blurb: string
  readonly category: string
  readonly authKind: "oauth2" | "api-key" | "none"
  readonly capabilities: ReadonlyArray<{
    readonly id: string
    readonly label: string
    readonly scopes: ReadonlyArray<string>
    readonly defaultGranted: boolean
  }>
  /** PRD §23 — present only for oauth2 connectors using a per-operator OAuth
   *  client. `configured` = the operator's client id is set; when false the UI
   *  shows an inline "set up your OAuth client" form. No secret values here. */
  readonly clientSetup?: {
    readonly configured: boolean
  }
}
export interface ConnectorInstanceItem {
  readonly id: string
  readonly definitionId: string
  readonly label: string
  readonly status: "connected" | "needs-reauth" | "error" | "disconnected"
  readonly grantedScopes: ReadonlyArray<string>
  readonly createdAt: number
  readonly lastHealthyAt: number | null
}
export interface ConnectorCatalogFrame {
  readonly type: "connector-catalog"
  readonly connectors: ReadonlyArray<ConnectorCatalogItem>
}
export interface ConnectorListFrame {
  readonly type: "connector-list"
  readonly instances: ReadonlyArray<ConnectorInstanceItem>
}
export interface ConnectorOauthRedirectFrame {
  readonly type: "connector-oauth-redirect"
  readonly requestId: string
  readonly pendingId: string
  readonly authUrl: string
}
export interface ConnectorStatusFrame {
  readonly type: "connector-status"
  readonly requestId?: string
  readonly ok: boolean
  readonly message?: string
  readonly instance?: ConnectorInstanceItem
}
export interface ConnectorOauthBeginFrame {
  readonly type: "connector-oauth-begin"
  readonly requestId: string
  readonly definitionId: string
  readonly label: string
  readonly capabilityIds?: ReadonlyArray<string>
  readonly loopbackPort: number
}
export interface ConnectorOauthCodeFrame {
  readonly type: "connector-oauth-code"
  readonly pendingId: string
  readonly code: string
  readonly state: string
}
export interface ConnectorConnectFrame {
  readonly type: "connector-connect"
  readonly requestId: string
  readonly definitionId: string
  readonly label: string
  readonly secretRef?: string
  readonly capabilityIds?: ReadonlyArray<string>
}
export interface ConnectorDisconnectFrame {
  readonly type: "connector-disconnect"
  readonly instanceId: string
}
/** Client→server: persist the operator's per-operator OAuth client creds
 *  (PRD §23) so the consent flow runs without hand-editing ~/.luna/.env. The
 *  values go UP only (like register-op-token's token) — never echoed back. */
export interface ConnectorSetClientFrame {
  readonly type: "connector-set-client"
  readonly requestId: string
  readonly definitionId: string
  readonly clientId: string
  readonly clientSecret?: string
}

/* PRD Part C (W1) — artifact frames (mirror packages/ui-ws/src/protocol.ts).
 * The ephemeral `Artifact` above evaporates per session; a PINNED artifact is
 * the durable form persisted in luna.db (artifacts + artifact_versions). */
export type ArtifactKind = "code" | "markdown" | "html" | "widget"

export interface PinnedArtifactItem {
  readonly id: string
  readonly kind: ArtifactKind
  readonly title: string
  readonly lang: string | null
  readonly content: string
  readonly origin: string | null
  /** Head version number (starts at 1; bumps on every agent edit/revert). */
  readonly version: number
  readonly pinnedAt: number
  readonly updatedAt: number
  /** Widget-only luna.* bridge allowlist (§16); optional/forward-compat (W4). */
  readonly bridgeCaps?: ReadonlyArray<string> | null
}

/** Server→client: all pinned artifacts (sent after hello, re-sent on change). */
export interface ArtifactListFrame {
  readonly type: "artifact-list"
  readonly artifacts: ReadonlyArray<PinnedArtifactItem>
}
/** Server→client: a single pinned artifact gained a new version → open
 *  widgets re-render live. Also broadcast so panels update in place. */
export interface ArtifactUpdateFrame {
  readonly type: "artifact-update"
  readonly artifact: PinnedArtifactItem
}
/** Client→server: pin an artifact by VALUE (the client already holds the
 *  ephemeral artifact it rendered). Idempotent on `id` server-side. */
export interface ArtifactPinFrame {
  readonly type: "artifact-pin"
  readonly id: string
  readonly title: string
  readonly content: string
  readonly lang?: string | null
  readonly kind?: ArtifactKind
  readonly origin?: string | null
}
/** Client→server: drop a pinned artifact (and its version ledger). */
export interface ArtifactUnpinFrame {
  readonly type: "artifact-unpin"
  readonly id: string
}

/* PRD Part C (W3) — workflow gallery frames (mirror ui-ws/protocol.ts). A
 * read-only, wire-safe view over the persisted jobs store: every job is a
 * gallery tile, badged `onDemand` (no schedule) vs scheduled (a cron string).
 * Run history is fetched on demand. No secrets/large output cross the wire. */
export interface WorkflowGalleryItem {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly source: string | null
  /** Cron/spec string when scheduled; null for on-demand jobs. */
  readonly schedule: string | null
  readonly onDemand: boolean
  readonly enabled: boolean
  readonly nextRunAt: number | null
  readonly lastRun: number | null
  readonly lastStatus: string | null
  readonly createdAt: number
}
export interface WorkflowRunItem {
  readonly id: number
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly status: string
  readonly attempt: number
  /** Short, truncated diagnostic — never the full output (large/sensitive). */
  readonly error: string | null
}
/** Server→client: the unified gallery (sent after hello, re-sent on refresh). */
export interface WorkflowListFrame {
  readonly type: "workflow-list"
  readonly workflows: ReadonlyArray<WorkflowGalleryItem>
}
/** Server→client: run history for one job (response to a runs request). */
export interface WorkflowRunsFrame {
  readonly type: "workflow-runs"
  readonly jobId: string
  readonly runs: ReadonlyArray<WorkflowRunItem>
}
/** Client→server: ask for one job's run history. */
export interface WorkflowRunsRequestFrame {
  readonly type: "workflow-runs-request"
  readonly jobId: string
  readonly limit?: number
}
/** Client→server: ask the server to re-send the gallery list. */
export interface WorkflowRefreshFrame {
  readonly type: "workflow-refresh"
}

/** Marks the true end of an agentic turn (SDK `result`). Consumed by clients
 *  that group consecutive assistant turns (the moon timeline); ui-web is
 *  seq-keyed and treats it as a no-op. */
export interface TurnCompleteFrame {
  readonly type: "turn-complete"
  readonly threadId: string
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
  | AccountListFrame
  | SkillCatalogFrame
  | SkillStatusFrame
  | ConnectorCatalogFrame
  | ConnectorListFrame
  | ConnectorOauthRedirectFrame
  | ConnectorStatusFrame
  | ArtifactListFrame
  | ArtifactUpdateFrame
  | WorkflowListFrame
  | WorkflowRunsFrame
  | TurnCompleteFrame
  | PtyOutputFrame

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
  readonly accountId?: string    // pins this thread to a specific account
  readonly title?: string
  readonly tags?: ReadonlyArray<string>
  readonly systemPrompt?: string
}
/**
 * Small identity blob clients attach to each user-message so the server (and
 * Luna) can tell which surface the operator is typing through. Mirrors the
 * `ClientInfo` interface in `@luna/ui-ws/protocol`. Additive / optional.
 */
export interface ClientInfo {
  readonly name: string
  readonly version?: string
  readonly platform?: string
}

export interface UserMessageFrame {
  readonly type: "user-message"
  readonly threadId: string
  readonly text: string
  /**
   * Optional image attachments. Base64-encoded, max 4MB raw per image
   * (≈5.4MB base64). Only image/jpeg|png|gif|webp accepted — PDF is out of
   * scope for v1. The server validates media types and rejects unknowns.
   */
  readonly attachments?: ReadonlyArray<ChatAttachment>
  /** See @luna/ui-ws ClientInfo. Mirrored here to keep ui-shared standalone. */
  readonly client?: ClientInfo
}
export interface InterruptFrame {
  readonly type: "interrupt"
  readonly threadId: string
}

/**
 * Client→server: flip one skill from the Skills settings section (PRD Part
 * B §12). Carries ONLY id + enabled — the catalog is server-authored.
 * Mirrors packages/ui-ws/src/protocol.ts — keep in sync.
 */
export interface SkillToggleFrame {
  readonly type: "skill-toggle"
  readonly id: string
  readonly enabled: boolean
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
  | SkillToggleFrame
  | ConnectorOauthBeginFrame
  | ConnectorOauthCodeFrame
  | ConnectorConnectFrame
  | ConnectorDisconnectFrame
  | ConnectorSetClientFrame
  | ArtifactPinFrame
  | ArtifactUnpinFrame
  | WorkflowRunsRequestFrame
  | WorkflowRefreshFrame
  | PtyInputFrame
  | PtyResizeFrame
