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

/** Provenance for an assistant turn delivered by a background job (#124). */
export interface ChatMessageDelivery {
  readonly source: string
  readonly label?: string
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
  /** Present only when this turn was delivered by a background job (#124).
   *  The UI renders it "from a background task" rather than a live reply. */
  readonly delivery?: ChatMessageDelivery
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
  /**
   * Git short-SHA of the running server build. OPTIONAL and additive — older
   * servers omit it; older clients ignore it. Mirrors
   * `packages/ui-ws/src/protocol.ts HelloFrame.buildSha` — keep in sync.
   */
  readonly buildSha?: string
  /**
   * Semver of the running server release (e.g. "0.1.0"). OPTIONAL and additive
   * — older servers omit it; older clients ignore it. Enables update-available
   * comparison. Mirrors `packages/ui-ws/src/protocol.ts HelloFrame.serverVersion`
   * — keep in sync.
   */
  readonly serverVersion?: string
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
    /** Suggested Actions: server routes suggested-action-respond and pushes
     *  suggested-action-set/update per thread. OPTIONAL/additive — absent on
     *  older servers; clients hide the inline chip + Actions panel when missing.
     *  Mirrors packages/ui-ws/src/protocol.ts — keep in sync. */
    readonly suggestedActions?: boolean
    /** Luna Vault (V1): server routes vault-put/delete/sync-config/import and
     *  pushes vault-list after hello. OPTIONAL/additive. */
    readonly vault?: boolean
    /**
     * Server accepts `set-thread-config` frames and computes the effort-validity
     * matrix per-model (advertised in `availableModels.efforts`). Clients hide
     * effort controls when absent/false. OPTIONAL/additive.
     */
    readonly effortSelection?: boolean
    /** Chat threads can spawn SDK Task subagents; tool frames may carry the
     *  additive `parentToolUseId` linkage. OPTIONAL/additive. Mirrors
     *  packages/ui-ws/src/protocol.ts — keep in sync. */
    readonly subagents?: boolean
    /** Model-routing settings (PR 1): server sends `model-routing-list` after
     *  hello and routes `model-routing-save`. OPTIONAL/additive — absent on
     *  older servers. Mirrors packages/ui-ws/src/protocol.ts — keep in sync. */
    readonly modelRouting?: boolean
    /** PRD Part C (Apps): server resolves `ui://` app resources + routes
     *  mcp-resource-read/mcp-tool-call. Lets a client render kind="mcp-app"
     *  artifacts live (vs source). OPTIONAL/additive — mirrors protocol.ts. */
    readonly mcpApps?: boolean
  }
  /**
   * Models the operator can pick for new threads. OPTIONAL and additive —
   * absent on older servers; clients fall back to their own hardcoded list.
   * The FIRST entry is the recommended default.  Mirrors the same field in
   * packages/ui-ws/src/protocol.ts — keep in sync.
   */
  readonly availableModels?: ReadonlyArray<{
    readonly id: string
    readonly label: string
    /**
     * Effort OPTIONS valid for THIS model, server-computed. Absent on older
     * servers; empty array = model takes no effort param (e.g. Haiku). Not every
     * entry is a real SDK effort level — "ultracode" is a pseudo-token the
     * server demuxes into SDK settings (display/wire list).
     */
    readonly efforts?: ReadonlyArray<"low" | "medium" | "high" | "xhigh" | "max" | "ultracode">
  }>
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
/**
 * Sent when a `new-thread` request failed before a thread row could be
 * created. Without it the client waits forever for a `thread-created` that
 * never arrives.
 */
export interface ThreadCreateErrorFrame {
  readonly type: "thread-create-error"
  readonly message: string
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
export type ArtifactKind = "code" | "markdown" | "html" | "widget" | "mcp-app"

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

/* Widget summon-by-name (mirror packages/ui-ws/src/protocol.ts). A host that
 * can open panels announces its directory after hello (widget-directory); the
 * agent's open_widget / open_artifact tools then push widget-open /
 * open-artifact-widget frames back to it. ui-web is such a host (it summons
 * board panels), so it carries these too — additive, ignored by older clients. */
export interface WidgetDirectoryEntry {
  readonly kind: string
  readonly title: string
  readonly description: string
}
/** Server→client: open (or focus) the panel registered under `kind`. The host
 *  resolves the kind through ITS OWN registry — can't conjure an unshipped one. */
export interface WidgetOpenFrame {
  readonly type: "widget-open"
  readonly kind: string
  readonly params?: Readonly<Record<string, string | number | boolean>>
}
/** Server→client: open (or focus) a pinned CONTENT artifact as its own panel —
 *  the content-tier sibling of widget-open. Fired by open_artifact / the
 *  widget_write/mcp_app_write/show_artifact auto-open. Gated on `artifacts`. */
export interface OpenArtifactWidgetFrame {
  readonly type: "open-artifact-widget"
  readonly artifactId: string
  readonly title: string
  readonly kind: ArtifactKind
}
/** Client→server: this connection announces it can host panels (sent once after
 *  hello). Replaces any directory previously announced for this connection. */
export interface WidgetDirectoryFrame {
  readonly type: "widget-directory"
  readonly widgets: ReadonlyArray<WidgetDirectoryEntry>
}

/* MCP Apps relay (mirror packages/ui-ws/src/protocol.ts). A kind="mcp-app"
 * artifact renders live via these: the host fetches a `ui://` template
 * (resource-read) and routes the app's tools/call over the wire. All four are
 * additive, gated on the hello `mcpApps` capability. */
/** Client→server: resolve a `ui://` app resource (the app's HTML template). */
export interface McpResourceReadFrame {
  readonly type: "mcp-resource-read"
  readonly requestId: string
  readonly uri: string
}
/** Server→client: the resource read outcome (`text` = app HTML). */
export interface McpResourceResultFrame {
  readonly type: "mcp-resource-result"
  readonly requestId: string
  readonly ok: boolean
  readonly mimeType?: string
  readonly text?: string
  readonly message?: string
}
/** Client→server: a rendered MCP app called `tools/call`. `appUri` scopes the
 *  call so the server enforces the same-server rule + curated allowlist. */
export interface McpToolCallFrame {
  readonly type: "mcp-tool-call"
  readonly requestId: string
  readonly appUri: string
  readonly tool: string
  readonly args: unknown
}
/** Server→client: the tool call outcome (`result` = the app's data — never
 *  logged). `ok:false` carries a short non-sensitive reason. */
export interface McpToolResultFrame {
  readonly type: "mcp-tool-result"
  readonly requestId: string
  readonly ok: boolean
  readonly result?: unknown
  readonly message?: string
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

/* Suggested Actions — Luna proposes actions ("do a task", "create a skill", …)
 * inline in a thread; they collect in a per-thread Actions panel. PER-THREAD
 * scope: every action carries its owning threadId. `set` is a full per-thread
 * replace (initial paint + replay-on-open); `update` is a single-action delta
 * (status/execution transition). Accept auto-executes server-side. Mirror
 * packages/ui-ws/src/protocol.ts — keep in sync. */
export type SuggestedActionType =
  | "task"
  | "research"
  | "create_skill"
  | "create_workflow"
  | "run_workflow"
export type SuggestedActionStatus =
  | "proposed"
  | "accepted"
  | "in_progress"
  | "completed"
  | "failed"
  | "dismissed"
/** One suggested action, wire-safe (no payloads/secrets cross the wire). */
export interface SuggestedActionWire {
  readonly id: string
  readonly threadId: string
  readonly actionType: SuggestedActionType
  readonly title: string
  readonly detail?: string
  readonly rationale?: string
  readonly status: SuggestedActionStatus
  readonly source: "agent" | "dream"
  readonly createdAt: number
  /** Set once accepted — the durable job/workflow id driving execution. */
  readonly executionId?: string | null
  /** Short diagnostic when status === "failed". */
  readonly error?: string | null
}
/** Server→client: the full set of a thread's non-terminal actions. Sent on
 *  subscribe (replay) and re-sent wholesale on change. */
export interface SuggestedActionSetFrame {
  readonly type: "suggested-action-set"
  readonly threadId: string
  readonly actions: ReadonlyArray<SuggestedActionWire>
}
/** Server→client: a single action changed (status/execution delta). */
export interface SuggestedActionUpdateFrame {
  readonly type: "suggested-action-update"
  readonly threadId: string
  readonly action: SuggestedActionWire
}
/** Client→server: accept (auto-execute) or dismiss one suggested action. */
export interface SuggestedActionRespondFrame {
  readonly type: "suggested-action-respond"
  readonly threadId: string
  readonly actionId: string
  readonly decision: "accept" | "dismiss"
}

/** Marks the true end of an agentic turn (SDK `result`). Consumed by clients
 *  that group consecutive assistant turns (the moon timeline); ui-web is
 *  seq-keyed and treats it as a no-op. */
export interface TurnCompleteFrame {
  readonly type: "turn-complete"
  readonly threadId: string
}

/**
 * Server→client: a background/job result was delivered into a thread (#124).
 * Broadcast to every client as a "Luna finished X" toast (surfaces even when
 * that thread is not on screen). The message itself arrives via assistant-done.
 */
export interface ResultDeliveredFrame {
  readonly type: "result-delivered"
  readonly threadId: string
  readonly source: string
  readonly label: string
  readonly preview: string
  readonly ts: number
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

/* Luna Vault (V1) — credential registry frames (mirror packages/ui-ws/src/protocol.ts).
 * The registry is METADATA + POINTERS ONLY — no frame carries secret values.
 * `vault-list` and `vault-status` are explicitly wire-safe:
 *   - `vault-list` items carry opaque `ref` pointers, never credential values.
 *   - `vault-status` carries only a boolean outcome + short diagnostic text. */

/**
 * One vault registry row projected for the wire — METADATA + POINTER ONLY.
 * `ref` is an opaque storage pointer (e.g. "env:OPENAI_API_KEY"); never a value.
 * `shadowed` = a pre-existing .env value shadowed this entry at boot.
 * `synced` = row confirmed in the configured 1Password vault.
 */
export interface VaultWireItem {
  readonly id: string
  readonly name: string
  readonly kind: "env-secret" | "op-token" | "op-item"
  /** Opaque back-pointer to storage location, never a secret value. */
  readonly ref: string
  readonly source: "manual" | "agent" | "1password" | "apple-import"
  readonly description: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly synced: boolean
  readonly shadowed: boolean
}

/** 1Password sync state + health (slice V3). */
export interface VaultSyncWire {
  readonly enabled: boolean
  readonly opLabel: string | null
  readonly opVault: string | null
  readonly lastSyncedAt: number | null
  readonly lastError: string | null
  /** How often to poll 1Password, in seconds (minimum 60). Mirrors the
   *  `pollSeconds` stored in the sync config so the UI can reflect the live
   *  value without a separate round-trip. */
  readonly pollSeconds: number
}

/**
 * Server→client: the current vault registry (metadata + pointers only; no
 * credential values). Sent after hello and after every successful mutation.
 */
export interface VaultListFrame {
  readonly type: "vault-list"
  readonly items: ReadonlyArray<VaultWireItem>
  readonly sync?: VaultSyncWire
}

/**
 * Server→client: outcome of a vault mutation. NEVER echoes a secret value —
 * `message` is short operator-actionable diagnostic text only.
 */
export interface VaultStatusFrame {
  readonly type: "vault-status"
  readonly requestId: string
  readonly ok: boolean
  readonly message: string
}

/**
 * Client→server: register/update a credential in the vault. `value` is
 * SENSITIVE — travels UP ONLY, never echoed back or logged server-side.
 */
export interface VaultPutFrame {
  readonly type: "vault-put"
  readonly requestId: string
  readonly name: string
  readonly kind: "env-secret" | "op-token"
  readonly varName?: string
  readonly label?: string
  /** Sensitive — never echoed back or logged. */
  readonly value: string
  readonly description?: string
}

/** Client→server: remove a vault registry row (and its underlying credential). */
export interface VaultDeleteFrame {
  readonly type: "vault-delete"
  readonly requestId: string
  readonly id: string
}

/** Client→server: configure 1Password two-way sync (slice V3). */
export interface VaultSyncConfigFrame {
  readonly type: "vault-sync-config"
  readonly requestId: string
  readonly enabled: boolean
  readonly opLabel?: string
  readonly opVault?: string
  readonly pollSeconds?: number
}

/**
 * Client→server: bulk import Apple Passwords CSV items into the sync vault
 * (slice V3). ≤20 items per frame; server enforces the limit. `password` in
 * each item is SENSITIVE — travels UP ONLY, never echoed back or logged.
 */
export interface VaultImportFrame {
  readonly type: "vault-import"
  readonly requestId: string
  readonly items: ReadonlyArray<{
    readonly title: string
    readonly url?: string
    readonly username?: string
    readonly password: string
    readonly notes?: string
  }>
}

/* ── Model routing settings (PR 1) — mirrors packages/ui-ws/src/protocol.ts.
 * Wire-safe: no secret values cross the wire; credentialRef is an opaque
 * pointer only. Keep in sync with packages/ui-ws/src/protocol.ts. */

/** One configured provider for the model-routing settings UI. */
export interface ProviderSettingsItem {
  readonly kind: string
  readonly enabled: boolean
  /** Opaque credential pointer — never the raw secret value. */
  readonly credentialRef?: string
  /** Monthly spend ceiling in USD. Stored; NOT enforced in PR 1. */
  readonly monthlyCapUsd?: number
}

/** One role-binding row for the model-routing settings UI. */
export interface RoleBindingItem {
  readonly role: string
  readonly preferenceList: ReadonlyArray<{ readonly provider: string; readonly model: string }>
}

/**
 * Server→client: current model-routing settings. Sent after `hello` and after
 * each successful `model-routing-save`. Wire-safe — metadata + opaque refs only.
 * Mirrors packages/ui-ws/src/protocol.ts — keep in sync.
 */
export interface ModelRoutingListFrame {
  readonly type: "model-routing-list"
  readonly providers: ReadonlyArray<ProviderSettingsItem>
  readonly roleBindings: ReadonlyArray<RoleBindingItem>
}

/**
 * Server→client: ack for a `model-routing-save`. `ok:false` carries a short,
 * non-sensitive reason. Never echoes credential values.
 * Mirrors packages/ui-ws/src/protocol.ts — keep in sync.
 */
export interface ModelRoutingStatusFrame {
  readonly type: "model-routing-status"
  readonly requestId: string
  readonly ok: boolean
  readonly message: string
}

/**
 * Client→server: save the complete model-routing settings payload. The server
 * validates, persists, acks with `model-routing-status`, then re-broadcasts
 * a fresh `model-routing-list` on success.
 *
 * `credentialRef` is an OPAQUE POINTER — never the raw credential value.
 * Mirrors packages/ui-ws/src/protocol.ts — keep in sync.
 */
export interface ModelRoutingSaveFrame {
  readonly type: "model-routing-save"
  readonly requestId: string
  readonly providers: ReadonlyArray<ProviderSettingsItem>
  readonly roleBindings: ReadonlyArray<RoleBindingItem>
}

/**
 * Server→client: ack for a `set-thread-config` request. `applied` = effective
 * NOW; `deferred` = queued for next thread creation (e.g. cross-lane model
 * switch); `rejected` = invalid/unsupported fields with a short reason.
 *
 * Effort semantic for `"max"`: the ack reports the accepted THREAD-LEVEL
 * preference, and `effort` echoes the value the server actually accepted
 * (clamping may adjust it). A mid-thread switch to "max" runs the current
 * thread's live query at the closest live level ("xhigh" — the SDK's
 * Settings.effortLevel has no "max") and applies exactly as "max" on the
 * next rebuild (recovery or new thread, which use Options.effort).
 * Mirrors packages/ui-ws/src/protocol.ts — keep in sync.
 */
export interface ThreadConfigFrame {
  readonly type: "thread-config"
  readonly threadId: string
  readonly model?: string
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"
  readonly applied: ReadonlyArray<"model" | "effort">
  readonly deferred: ReadonlyArray<"model" | "effort">
  readonly rejected?: ReadonlyArray<{ readonly field: "model" | "effort"; readonly reason: string }>
}

/* ── Smart Bar (v1 info-only) ── mirrors packages/ui-ws/src/protocol.ts ─── */

export type SmartBarItemKind =
  | "info"
  | "button"
  | "toggle"
  | "slider"
  | "select"
  | "sparkline"

export interface SmartBarItem {
  readonly id: string
  readonly kind: SmartBarItemKind
  readonly label?: string
  readonly value?: string
  readonly icon?: string
  readonly tone?: "default" | "muted" | "good" | "warn"
  readonly group?: string
  readonly priority?: number
  readonly tooltip?: string
}

export interface SmartBarFrame {
  readonly type: "smart-bar"
  readonly threadId: string
  readonly version: 1
  readonly items: ReadonlyArray<SmartBarItem>
}

/**
 * Client→server: update model and/or effort for an existing thread.
 * Gated on the `effortSelection` capability. Older servers ignore it.
 * Mirrors packages/ui-ws/src/protocol.ts — keep in sync.
 */
export interface SetThreadConfigFrame {
  readonly type: "set-thread-config"
  readonly threadId: string
  readonly model?: string
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"
}

export type ServerFrame =
  | HelloFrame
  | EventFrame
  | DropFrame
  | PingFrame
  | ByeFrame
  | ThreadListFrame
  | ThreadCreatedFrame
  | ThreadCreateErrorFrame
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
  | WidgetOpenFrame
  | OpenArtifactWidgetFrame
  | McpResourceResultFrame
  | McpToolResultFrame
  | WorkflowListFrame
  | WorkflowRunsFrame
  | SuggestedActionSetFrame
  | SuggestedActionUpdateFrame
  | TurnCompleteFrame
  | ResultDeliveredFrame
  | PtyOutputFrame
  | VaultListFrame
  | VaultStatusFrame
  | ModelRoutingListFrame
  | ModelRoutingStatusFrame
  | ThreadConfigFrame
  | SmartBarFrame
  | ThreadArchivedFrame
  | ThreadUnarchivedFrame
  | ThreadArchiveErrorFrame

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
  /**
   * Phase 3: filter by status. Omit for default (active-only) list.
   * Pass 'archived' to get the archive panel contents.
   * Mirrors packages/ui-ws/src/protocol.ts — keep in sync.
   */
  readonly status?: "active" | "archived"
}
/** Phase 3: Archive a thread (active->archived). NEVER deletes row or jsonl. */
export interface ArchiveThreadFrame {
  readonly type: "archive-thread"
  readonly threadId: string
}

/** Phase 3: Unarchive a thread (archived->active). Clears archived_at. */
export interface UnarchiveThreadFrame {
  readonly type: "unarchive-thread"
  readonly threadId: string
}

/** Phase 3: Server confirmation of an archive operation. */
export interface ThreadArchivedFrame {
  readonly type: "thread-archived"
  readonly threadId: string
}

/** Phase 3: Server confirmation of an unarchive operation. */
export interface ThreadUnarchivedFrame {
  readonly type: "thread-unarchived"
  readonly threadId: string
}

/**
 * Phase 3: Sent when archive-thread / unarchive-thread failed (thread not
 * found in registry, or registry not wired). Client should refresh its state.
 */
export interface ThreadArchiveErrorFrame {
  readonly type: "thread-archive-error"
  readonly threadId: string
  readonly reason: "not-found" | "registry-unavailable"
}

export interface NewThreadFrame {
  readonly type: "new-thread"
  readonly model: string
  readonly accountId?: string    // pins this thread to a specific account
  readonly title?: string
  readonly tags?: ReadonlyArray<string>
  readonly systemPrompt?: string
  /** Additive effort level for this thread. Older servers ignore it. */
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"
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
  | WidgetDirectoryFrame
  | McpResourceReadFrame
  | McpToolCallFrame
  | WorkflowRunsRequestFrame
  | WorkflowRefreshFrame
  | SuggestedActionRespondFrame
  | PtyInputFrame
  | PtyResizeFrame
  | VaultPutFrame
  | VaultDeleteFrame
  | VaultSyncConfigFrame
  | VaultImportFrame
  | ModelRoutingSaveFrame
  | SetThreadConfigFrame
  | ArchiveThreadFrame
  | UnarchiveThreadFrame
