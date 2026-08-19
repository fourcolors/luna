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
import type { ObsEvent, ChatMessage, SessionSummary, SurveyItem, SurveyVerdict, ArtifactKind } from "@luna/core"
import type { Artifact } from "@luna/chat-service"

// Re-export the SINGLE source of truth for ArtifactKind (@luna/core) rather
// than redeclaring an identical union here — so the wire type and the store
// type can never silently drift (widget-tools' WidgetSummonerPort.openArtifact
// types `kind` from @luna/core; this re-export keeps the ui-ws bridge's match
// exact by construction).
export type { ArtifactKind }

import type { ServerKind, OperationName, ServerDescriptorCapability, ServerDescriptor } from "@luna/tools/protocol-descriptor"
export type { ServerKind, OperationName, ServerDescriptorCapability, ServerDescriptor }
import { UI_WS_PROTOCOL_VERSION } from "@luna/tools/protocol-descriptor"
export { UI_WS_PROTOCOL_VERSION }
// The client-selectable effort vocabulary, previously hand-inlined as the
// bare literal union in FIVE places in this file (#462). Re-exported so
// existing `import type { ... } from "@luna/ui-ws"` consumers keep working;
// browser code must import from "@luna/tools/protocol-descriptor" directly,
// since this package's single "." export also re-exports server.js.
import type { EffortOption } from "@luna/tools/protocol-descriptor"
export type { EffortOption }

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
  /**
   * Semver of the running server release (e.g. "0.1.0"), sourced from
   * `LUNA_BUILD_VERSION` env → `git describe --tags --match 'server-v*'` →
   * graceful fallback. OPTIONAL and additive — older servers omit it and
   * older clients ignore it. Enables update-available comparison without
   * SHA-only heuristics. Same additive pattern as `buildSha`.
   */
  readonly serverVersion?: string
  /**
   * Models the operator can pick for new threads. OPTIONAL and additive —
   * absent on older servers; the client falls back to its own hardcoded list
   * when this field is missing. The FIRST entry is the recommended default
   * (server/operator-preferred, not necessarily the highest-capability model).
   *
   * No protocol bump needed: additive field, same pattern as `buildSha`.
   * The server includes it when `availableModels` is threaded into
   * `startUIWebSocketServer`; older/setup-mode servers omit it entirely.
   */
  readonly availableModels?: ReadonlyArray<{
    readonly id: string
    readonly label: string
    /**
     * Effort OPTIONS valid for THIS model, server-computed. Absent on older
     * servers; empty array = model takes no effort param (e.g. Haiku). Clients
     * never compute the matrix — always defer to this field when present.
     *
     * NOTE: not every entry is a real SDK effort level — "ultracode" is a
     * pseudo-token (xhigh + standing workflow orchestration) that the server
     * demuxes into SDK settings. Treat this as a display/wire list, not a list
     * of SDK effort levels.
     */
    readonly efforts?: ReadonlyArray<EffortOption>
    /**
     * Effort a fresh thread should DEFAULT to for this model when the client
     * persists none - server-computed via defaultEffortForModel(). OPTIONAL
     * and additive: absent on older servers and on models with no opinion;
     * clients then fall back to the weakest supported level. When present it
     * is always a member of `efforts` and never the "ultracode" pseudo-token.
     */
    readonly defaultEffort?: EffortOption
  }>
  /** Capability flags so older clients can negotiate down. */
  readonly capabilities: {
    readonly chat: boolean
    readonly streamingDeltas: boolean
    readonly localShell: boolean
    readonly setup: boolean
    /**
     * Server emits the additive `turn-complete` frame on the SDK terminal
     * `result` (true whenever chat is bound). Clients that group consecutive
     * assistant turns into one activity timeline (the moon) gate that grouping
     * on this flag: an older server omits it, so the client falls back to a
     * per-turn timeline instead of waiting on a turn-complete that never comes.
     */
    readonly turnComplete: boolean
    /**
     * Server accepts `set-thread-config` frames and computes the effort-validity
     * matrix per-model (advertised in the `availableModels.efforts` array).
     * Clients hide effort controls when this flag is absent or false.
     * OPTIONAL/additive — no protocol bump.
     */
    readonly effortSelection?: boolean
    /**
     * PRD Part B (Skills): the server has a SkillRegistry bound — it sends a
     * `skill-catalog` frame after `hello` and routes `skill-toggle`. OPTIONAL
     * and additive (no protocol bump): older servers omit it, and clients
     * hide the Skills settings tab when the flag is absent/false.
     */
    readonly skills?: boolean
    /**
     * PRD Part A (Connectors): connector catalog/instances + the
     * client-brokered OAuth handshake are available. OPTIONAL/additive —
     * clients hide the Connectors settings tab when absent/false.
     */
    readonly connectors?: boolean
    /**
     * Agent sidebar S1: the server has an agent roster bound — it sends an
     * `agent-list` frame after `hello` (metadata only: name + description,
     * never prompts/tools). OPTIONAL/additive (no protocol bump): older
     * servers omit it, and clients hide the mention menu and the grouped
     * sidebar when the flag is absent/false.
     */
    readonly agents?: boolean
    /**
     * PRD Part C (Widgets/W1): the server has an ArtifactStore bound — it
     * sends an `artifact-list` after `hello`, routes `artifact-pin`/`-unpin`,
     * and broadcasts `artifact-update`. OPTIONAL/additive: older servers omit
     * it and clients hide the artifact panel's "Pinned" section.
     */
    readonly artifacts?: boolean
    /**
     * PRD Part C (W3): the server exposes a read-only workflow gallery over the
     * jobs store (workflow-list after hello, routes workflow-runs-request and
     * workflow-refresh). OPTIONAL/additive — clients hide the Workflows view
     * when absent/false.
     */
    readonly workflows?: boolean
    /**
     * Suggested Actions: the server has a SuggestedActions service bound — it
     * pushes `suggested-action-set` per thread (on subscribe + on change),
     * `suggested-action-update` deltas, and routes `suggested-action-respond`.
     * OPTIONAL/additive — clients hide the inline chip + Actions panel when
     * absent/false. Mirrors packages/ui-shared/src/wire.ts — keep in sync.
     */
    readonly suggestedActions?: boolean
    /**
     * Conversation forking (#221): server stages fork markers via
     * `fork-proposal-set/update` and routes `fork-proposal-respond`. Accept
     * creates a resume-fork sibling thread and opens a chat panel. OPTIONAL.
     */
    readonly threadForks?: boolean
    /**
     * Luna Vault (V1): the server has a VaultService bound — it pushes a
     * `vault-list` frame after `hello` and routes `vault-put` /
     * `vault-delete` / `vault-sync-config` / `vault-import`. OPTIONAL/additive
     * — clients hide the Vault settings section when absent/false.
     */
    readonly vault?: boolean
    /**
     * MCP Apps host relay (widget-system.md Phase 7): the server has an
     * McpAppHost bound — it routes `mcp-resource-read` / `mcp-tool-call`
     * and replies `mcp-resource-result` / `mcp-tool-result` on the same
     * connection. OPTIONAL/additive: clients show an honest "not supported"
     * notice for kind `mcp-app` artifacts when absent/false.
     */
    readonly mcpApps?: boolean
    /**
     * Subagents: chat threads expose the SDK Task tool (wire tool name
     * "Agent"), and tool-call / tool-result frames may carry the additive
     * `parentToolUseId` linkage for activity that ran inside a subagent.
     * OPTIONAL/additive — older servers omit it; older clients ignore both
     * the flag and the field and render subagent steps flat.
     */
    readonly subagents?: boolean
    /**
     * Model routing settings (PR 1): the server has a ProviderSettingsStore
     * bound — it sends `model-routing-list` after `hello` and routes
     * `model-routing-save`. OPTIONAL/additive — older servers omit it; clients
     * hide the Models settings tab when absent/false.
     */
    readonly modelRouting?: boolean
    /**
     * Capability layer (backend-advertised commands): the server has a
     * capabilityRegistry bound — it sends a `capability-catalog` frame after
     * `hello` and routes `capability-execute`. OPTIONAL/additive (no protocol
     * bump): older servers omit it, and clients fall back to their built-in
     * command set when the flag is absent/false. Mirrors `skills`.
     */
    readonly commands?: boolean
    /**
     * Point-at-the-UI feedback: the server has a feedbackSink bound — it
     * accepts `feedback-submit` frames and replies with `feedback-ack`.
     * OPTIONAL/additive (no protocol bump): older servers omit it, and clients
     * hide the feedback button when the flag is absent/false so a
     * `feedback-submit` is never sent. Mirrors `commands`/`skills`.
     */
    readonly feedback?: boolean
  }
  /**
   * Additive server descriptor (no protocol bump). Built fresh per connection
   * so issuedAt and generation are always current. Older clients ignore it.
   */
  readonly descriptor?: ServerDescriptor
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

/**
 * Sent when a `new-thread` request failed before a thread row could be
 * created (e.g. the session store INSERT threw). Without this the client
 * waits forever for a `thread-created` that never arrives. The message is a
 * short, human-readable reason; the server logs the full cause.
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
  /** Present when the call ran INSIDE a subagent: the tool_use id of the
   *  spawning Agent/Task call. OPTIONAL/additive — old clients ignore it
   *  and render the step flat. */
  readonly parentToolUseId?: string
}

export interface ToolResultFrame {
  readonly type: "tool-result"
  readonly threadId: string
  readonly toolCallId: string
  readonly status: "ok" | "error"
  readonly output: string
  readonly truncated: boolean
  /** Mirror of ToolCallFrame.parentToolUseId for subagent-internal results.
   *  OPTIONAL/additive. */
  readonly parentToolUseId?: string
}

/** Marks the true end of an agentic turn (SDK `result`), after every
 *  intermediate tool step. Lets clients that group consecutive assistant
 *  turns (the moon timeline) settle that group. Carries no turnId. */
export interface TurnCompleteFrame {
  readonly type: "turn-complete"
  readonly threadId: string
}

/**
 * A background/job/scheduled result was delivered into a thread (issue #124).
 * BROADCAST to every connected client (not scoped to one thread's subscribers)
 * so a "Luna finished X" toast surfaces even when that thread is not the one on
 * screen. The result message itself also lands in the thread via the normal
 * assistant-done frame (carrying ChatMessage.delivery); this frame is purely
 * the cross-thread notification.
 */
export interface ResultDeliveredFrame {
  readonly type: "result-delivered"
  /** Thread the result landed in (clicking the toast can open it). */
  readonly threadId: string
  /** Where the result came from, e.g. "suggested-action", "background-job". */
  readonly source: string
  /** Human label for what finished, e.g. the job/action title. */
  readonly label: string
  /** Short excerpt of the result for the toast body. */
  readonly preview: string
  /** Wall-clock ms when delivered. */
  readonly ts: number
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
 * Agent sidebar S1: the mentionable-agent roster, sent once after `hello`
 * when the server advertises `capabilities.agents`. METADATA ONLY by
 * construction (see ui-ws/src/agent-roster.ts): full agent definitions
 * carry system prompts, tool allowlists, and MCP references, and none of
 * that may reach the wire. Additive — older clients ignore it.
 */
export interface AgentListFrame {
  readonly type: "agent-list"
  readonly agents: ReadonlyArray<{
    readonly name: string
    readonly description: string
  }>
}

/**
 * Server→client: outcome of an `account-add` or `account-rm`. `ok:false`
 * carries a short, non-sensitive reason. NEVER echoes secret-ref values —
 * the message is operator-actionable diagnostic text only. Additive — no
 * protocol bump (older clients ignore unknown frames).
 */
export interface AccountStatusFrame {
  readonly type: "account-status"
  readonly requestId: string
  readonly ok: boolean
  readonly message: string
}

/**
 * Client→server: register a provider account in AccountBroker / `luna.db`.
 * `secretRef` is a POINTER (`claude-code:login`, `env:VAR`, `op://…`,
 * `luna-op://…`) — never a resolved credential. Same validation as
 * `luna account add`. `requestId` correlates the `account-status` reply.
 * On success the server also re-broadcasts `account-list`.
 */
export interface AccountAddFrame {
  readonly type: "account-add"
  readonly requestId: string
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly secretRef: string
}

/**
 * Client→server: remove one account by id. `requestId` correlates the
 * `account-status` reply. On success the server re-broadcasts `account-list`.
 */
export interface AccountRmFrame {
  readonly type: "account-rm"
  readonly requestId: string
  readonly id: string
}

/**
 * One skill row for the settings catalog — METADATA ONLY, by construction.
 *
 * There is deliberately no `body` field on this type: skill bodies are
 * prompt content for the agent, not the UI, and they never cross the wire
 * to clients (PRD §12 "metadata-only on the wire"). `category`/`source`
 * are plain strings on the wire (forward-compatible with new categories).
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

/**
 * Server→client: the full skill catalog. Sent once after `hello` (same
 * fire-and-forget pattern as `account-list`) so the Skills settings tab can
 * render on connect, and re-sent to the toggling client after a successful
 * `skill-toggle` so its list state confirms. Additive — no protocol bump.
 */
export interface SkillCatalogFrame {
  readonly type: "skill-catalog"
  readonly skills: ReadonlyArray<SkillCatalogItem>
}

/**
 * Server→client ack for a `skill-toggle`. `ok:false` carries a
 * non-sensitive reason (unknown id, registry failure). On `ok:true`,
 * `enabled` is the now-live state — effective for the NEXT thread (the
 * registry snapshot is rebuilt synchronously on toggle).
 */
export interface SkillStatusFrame {
  readonly type: "skill-status"
  readonly id: string
  readonly enabled: boolean
  readonly ok: boolean
  readonly message?: string
}

/* -------------------------------------------------------------------------- */
/* Capability layer — backend-advertised commands (capability catalog)        */
/* -------------------------------------------------------------------------- */

/**
 * One backend-advertised capability — METADATA ONLY, by construction. The
 * adapter builds this literally (no internal-state spread), mirroring the
 * skill-catalog body-strip discipline: nothing executable crosses the wire.
 * `executor` tells the client WHERE the capability runs ('server' = the
 * server invokes it on `capability-execute`; 'client' = the client owns it).
 * `kind` is a plain string (forward-compatible with new kinds, e.g.
 * 'command'/'skill'). `schemaVersion` lets a client reject a descriptor whose
 * `detail` shape it does not understand.
 */
export interface WireCapabilityDescriptor {
  readonly kind: string
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly argHint?: string
  readonly enabled?: boolean
  readonly executor: "client" | "server"
  readonly schemaVersion: number
  readonly detail?: Record<string, unknown>
}

/**
 * The full capability catalog. `generation` bumps when the set changes;
 * `agreedSchema` is the catalog-level schema the server and client agree on.
 * v1 is a STATIC catalog (no live `changes` hook) — sent once after `hello`.
 */
export interface WireCapabilityCatalog {
  readonly generation: number
  readonly agreedSchema: number
  readonly capabilities: ReadonlyArray<WireCapabilityDescriptor>
}

/**
 * Server→client: the full capability catalog. Sent once after `hello` (same
 * fire-and-forget pattern as `skill-catalog`) so the client can render
 * backend-advertised commands on connect. Additive — no protocol bump.
 */
export interface CapabilityCatalogFrame {
  readonly type: "capability-catalog"
  readonly catalog: WireCapabilityCatalog
}

/**
 * Server→client RESPONSE to a `capability-execute`. UNICAST to the requesting
 * socket only — it echoes the client's `requestId` and is never broadcast
 * (one client's execute result must not leak to others). `ok:false` carries a
 * non-sensitive reason (malformed frame, unknown id, registry failure).
 */
export interface CapabilityExecuteResultFrame {
  readonly type: "capability-execute-result"
  readonly requestId: string
  readonly ok: boolean
  readonly message?: string
}

/**
 * Server→client RESPONSE to a `feedback-submit`. UNICAST to the requesting
 * socket only — it echoes the client's `requestId` and is never broadcast.
 * `ok:false` carries a non-sensitive reason (malformed frame, sink failure).
 * Shape mirrors `capability-execute-result` (the sole `{requestId, ok,
 * message?}` precedent). Additive — gated on the `feedback` capability.
 */
export interface FeedbackAckFrame {
  readonly type: "feedback-ack"
  readonly requestId: string
  readonly ok: boolean
  readonly message?: string
}

/* PRD Part A — connector frames (§18). All additive, gated on the hello
 * `connectors` capability. NO frame in either direction ever carries a
 * token or credential: the catalog is definition metadata, instances
 * carry status + a secret POINTER, and the OAuth handshake moves only the
 * authorization CODE (worthless without the server-held PKCE verifier). */

/** One catalog card for the settings UI — definition metadata only. */
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
  /** PRD §23 — present only for oauth2 per-operator-client connectors;
   *  `configured` flips true once the operator's client id is stored. No
   *  secret values cross the wire. */
  readonly clientSetup?: {
    readonly configured: boolean
  }
}

/** One connection row — status + pointer, never credential material. */
export interface ConnectorInstanceItem {
  readonly id: string
  readonly definitionId: string
  readonly label: string
  readonly status: "connected" | "needs-reauth" | "error" | "disconnected"
  readonly grantedScopes: ReadonlyArray<string>
  readonly createdAt: number
  readonly lastHealthyAt: number | null
}

/** Server→client: the connector catalog (sent after hello, like account-list). */
export interface ConnectorCatalogFrame {
  readonly type: "connector-catalog"
  readonly connectors: ReadonlyArray<ConnectorCatalogItem>
}

/** Server→client: current connections (after hello + broadcast on change). */
export interface ConnectorListFrame {
  readonly type: "connector-list"
  readonly instances: ReadonlyArray<ConnectorInstanceItem>
}

/**
 * Client→server: start the client-brokered OAuth flow (PRD §09). The
 * client has ALREADY bound 127.0.0.1:<loopbackPort> and will capture the
 * provider's redirect there (RFC 8252 — the browser runs client-side).
 */
export interface ConnectorOauthBeginFrame {
  readonly type: "connector-oauth-begin"
  readonly requestId: string
  readonly definitionId: string
  readonly label: string
  readonly capabilityIds?: ReadonlyArray<string>
  readonly loopbackPort: number
}

/** Server→client: the consent URL for the client to open in the real browser. */
export interface ConnectorOauthRedirectFrame {
  readonly type: "connector-oauth-redirect"
  readonly requestId: string
  readonly pendingId: string
  readonly authUrl: string
}

/** Client→server: the captured authorization code + echoed state. */
export interface ConnectorOauthCodeFrame {
  readonly type: "connector-oauth-code"
  /** Echoed back on the completeAuth `connector-status` so the panel can
   *  attribute the completion to the exact OAuth flow it started. */
  readonly requestId?: string
  readonly pendingId: string
  readonly code: string
  readonly state: string
}

/** Client→server: non-OAuth connect (api-key already stored, or auth none). */
export interface ConnectorConnectFrame {
  readonly type: "connector-connect"
  readonly requestId: string
  readonly definitionId: string
  readonly label: string
  readonly secretRef?: string
  readonly capabilityIds?: ReadonlyArray<string>
}

/** Client→server: remove a connection (server revokes best-effort). */
export interface ConnectorDisconnectFrame {
  readonly type: "connector-disconnect"
  readonly instanceId: string
}
/** Client→server: persist the operator's per-operator OAuth client creds
 *  (PRD §23). Values go UP only — never echoed back; the server writes them via
 *  the same secret sink the refresh token uses. */
export interface ConnectorSetClientFrame {
  readonly type: "connector-set-client"
  readonly requestId: string
  readonly definitionId: string
  readonly clientId: string
  readonly clientSecret?: string
}

/**
 * Server→client: outcome of begin/code/connect/disconnect. `ok:false`
 * carries a short, non-sensitive reason (e.g. which env var is missing
 * for the per-operator OAuth client).
 */
export interface ConnectorStatusFrame {
  readonly type: "connector-status"
  readonly requestId?: string
  readonly ok: boolean
  readonly message?: string
  readonly instance?: ConnectorInstanceItem
}

/* PRD Part C (W1) — artifact frames. The ephemeral `Artifact` (above) is
 * recomputed per session; a PINNED artifact is the durable form persisted in
 * luna.db (artifacts + artifact_versions). Mirrors ui-shared/wire.ts.
 * `mcp-app` (widget-system.md Phase 7): content is a `ui://` resource URI —
 * the host fetches the app HTML via `mcp-resource-read` and renders it as an
 * MCP App (raw JSON-RPC over postMessage), never as inline widget HTML.
 * ArtifactKind is re-exported from @luna/core (see the top of this file). */

export interface PinnedArtifactItem {
  readonly id: string
  readonly kind: ArtifactKind
  readonly title: string
  readonly lang: string | null
  readonly content: string
  readonly origin: string | null
  readonly version: number
  readonly pinnedAt: number
  readonly updatedAt: number
  readonly bridgeCaps?: ReadonlyArray<string> | null
}

/** Server→client: all pinned artifacts (sent after hello, re-sent on change). */
export interface ArtifactListFrame {
  readonly type: "artifact-list"
  readonly artifacts: ReadonlyArray<PinnedArtifactItem>
}
/** Server→client: a pinned artifact gained a new version → live re-render. */
export interface ArtifactUpdateFrame {
  readonly type: "artifact-update"
  readonly artifact: PinnedArtifactItem
}
/** Client→server: pin an artifact by value (idempotent on `id`). */
export interface ArtifactPinFrame {
  readonly type: "artifact-pin"
  readonly id: string
  readonly title: string
  readonly content: string
  readonly lang?: string | null
  readonly kind?: ArtifactKind
  readonly origin?: string | null
}
/** Client→server: drop a pinned artifact and its version ledger. */
export interface ArtifactUnpinFrame {
  readonly type: "artifact-unpin"
  readonly id: string
}
/** Client→server: edit an existing artifact's content. Routes through the
 *  store's `update` (appends a version, PRESERVES the ledger, leaves bridgeCaps
 *  untouched) — never unpin+re-pin, which would destroy history + reset caps. */
export interface ArtifactEditFrame {
  readonly type: "artifact-edit"
  readonly id: string
  readonly content: string
}

/* PRD Part C (W3) — workflow gallery frames. A read-only, wire-safe view over
 * the persisted jobs store. Mirrors ui-shared/wire.ts. */
export interface WorkflowGalleryItem {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly source: string | null
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
  readonly error: string | null
}
/** Server→client: the unified gallery (sent after hello, re-sent on refresh). */
export interface WorkflowListFrame {
  readonly type: "workflow-list"
  readonly workflows: ReadonlyArray<WorkflowGalleryItem>
}
/** Server→client: run history for one job. */
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

/* Suggested Actions — Luna proposes actions inline in a thread; they collect in
 * a per-thread Actions panel. PER-THREAD scope: every action carries its owning
 * threadId. `set` = full per-thread replace (initial paint + replay-on-open +
 * re-sent on change); `update` = single-action status/execution delta. Accept
 * auto-executes server-side as a durable job. All additive, gated on the hello
 * `suggestedActions` capability. Mirrors packages/ui-shared/src/wire.ts. */
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
  readonly executionId?: string | null
  readonly error?: string | null
}
/** Server→client: the full set of a thread's non-terminal actions. */
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

/* Conversation forking (#221) — propose-mode markers, click-to-enter.
 * Seed text never crosses the wire; accept creates the sibling server-side. */
export type ForkProposalStatus = "pending" | "accepting" | "accepted" | "dismissed"
export interface ForkProposalWire {
  readonly id: string
  readonly parentThreadId: string
  readonly title: string
  readonly summary: string
  readonly status: ForkProposalStatus
  readonly createdAt: number
  readonly childThreadId?: string
}
export interface ForkProposalSetFrame {
  readonly type: "fork-proposal-set"
  readonly threadId: string
  readonly proposals: ReadonlyArray<ForkProposalWire>
}
export interface ForkProposalUpdateFrame {
  readonly type: "fork-proposal-update"
  readonly threadId: string
  readonly proposal: ForkProposalWire
}
/** Client→server: accept (create sibling + open) or dismiss a fork marker. */
export interface ForkProposalRespondFrame {
  readonly type: "fork-proposal-respond"
  readonly threadId: string
  readonly proposalId: string
  readonly decision: "accept" | "dismiss"
}

/* Luna Vault (V1) — credential registry frames. All additive, gated on the
 * hello `vault` capability. The registry is METADATA + POINTERS ONLY — no
 * frame in either direction ever carries a secret VALUE. `vault-list` and
 * `vault-status` are explicitly designed to be wire-safe:
 *   - `vault-list` carries identifiers, labels, kind badges, and opaque `ref`
 *     pointers (e.g. "env:OPENAI_API_KEY", "luna-op://my-label") but never
 *     the credential material they point at.
 *   - `vault-status` carries a boolean outcome and a short human-readable
 *     `message` — never echoes the value from a `vault-put` or `vault-import`.
 *   - `vault-put` and `vault-import` carry values UPWARD ONLY (client→server),
 *     matching the connector-set-client contract; they are never stored in
 *     transcripts or logs. */

/**
 * One vault registry row projected for the wire — METADATA + POINTER ONLY.
 * `ref` is an opaque pointer to where the credential lives (e.g.
 * "env:OPENAI_API_KEY", "luna-op://my-label"), never the credential value.
 * `synced` = the row was confirmed in the configured 1Password vault.
 * `shadowed` = the env var was present in `.env` at boot (before the vault
 * registry was wired) and was skipped by the env loader to avoid overwriting
 * a live value — the UI should badge it "shadowed".
 */
export interface VaultWireItem {
  readonly id: string
  readonly name: string
  readonly kind: "env-secret" | "op-token" | "op-item"
  /** Opaque back-pointer — pointer to storage location, never a secret value. */
  readonly ref: string
  readonly source: "manual" | "agent" | "1password" | "apple-import"
  readonly description: string | null
  readonly createdAt: number
  readonly updatedAt: number
  /** true = row was confirmed present in the configured 1Password vault. */
  readonly synced: boolean
  /** true = a pre-existing .env value shadowed this entry at boot. */
  readonly shadowed: boolean
}

/** Sync configuration and health for the 1Password integration (slice V3). */
export interface VaultSyncWire {
  readonly enabled: boolean
  readonly opLabel: string | null
  readonly opVault: string | null
  /** Unix ms of the last successful inbound sync, or null if never synced. */
  readonly lastSyncedAt: number | null
  /** Short diagnostic from the last sync failure, or null if last sync was ok. */
  readonly lastError: string | null
  /** How often to poll 1Password, in seconds (minimum 60). Mirrors the
   *  `pollSeconds` stored in the sync config so the UI can reflect the live
   *  value without a separate round-trip. */
  readonly pollSeconds: number
}

/**
 * Tiered-storage status snapshot (W2 vault redesign). METADATA ONLY -
 * `envResidue` is a COUNT of non-reserved names still present in `.env` (never
 * a name, never a value). Mirrors ui-shared's VaultStorageWire.
 */
export interface VaultStorageWire {
  readonly mode: string
  readonly writeTier: string
  readonly onePassword: "absent" | "detected" | "active"
  readonly osKeychain: boolean
  readonly lunaVault: boolean
  readonly envResidue: number
}

/**
 * Server→client: the current vault registry. Sent after `hello` (like
 * `connector-catalog`) and after every successful mutation. Contains METADATA
 * AND POINTERS ONLY — never secret values. `sync` is omitted when no sync
 * config exists (slice V3 not yet configured). `storage` is additive (W2) and
 * omitted by pre-W2 servers.
 */
export interface VaultListFrame {
  readonly type: "vault-list"
  readonly items: ReadonlyArray<VaultWireItem>
  /** 1Password sync state, when configured (slice V3). Absent on V1 servers. */
  readonly sync?: VaultSyncWire
  /** Tiered-storage status snapshot (W2). Absent on pre-W2 servers. */
  readonly storage?: VaultStorageWire
}

/**
 * Server→client: outcome of a `vault-put`, `vault-delete`, `vault-sync-config`,
 * or `vault-import`. `ok:false` carries a short, non-sensitive reason in
 * `message` (e.g. "label not in LUNA_OP_ACCOUNTS", "env var name invalid").
 *
 * NEVER echoes the value from a `vault-put` or `vault-import` frame — the
 * message is operator-actionable diagnostic text only.
 */
export interface VaultStatusFrame {
  readonly type: "vault-status"
  readonly requestId: string
  readonly ok: boolean
  readonly message: string
}

/**
 * Client→server: register or update a credential in the vault. `value` is the
 * SENSITIVE credential — it travels UP ONLY and is never echoed back in any
 * server frame or logged. Mirrors the connector-set-client value-up-only contract.
 *
 * For `kind:'env-secret'`, `varName` is required (the env var name, e.g.
 * "OPENAI_API_KEY"). For `kind:'op-token'`, `label` is required (must match an
 * entry in LUNA_OP_ACCOUNTS). `requestId` correlates the `vault-status` reply.
 */
export interface VaultPutFrame {
  readonly type: "vault-put"
  readonly requestId: string
  readonly name: string
  readonly kind: "env-secret" | "op-token"
  /** Required when kind='env-secret': the env var name to store. */
  readonly varName?: string
  /** Required when kind='op-token': the 1Password account label. */
  readonly label?: string
  /** The credential value — sensitive, NEVER echoed back or logged. */
  readonly value: string
  readonly description?: string
}

/**
 * Client→server: remove a vault registry row (and, for env-secret/op-token,
 * the underlying stored credential). `id` is the registry row id from
 * `vault-list`. For `op-item` rows the registry row is removed but the item
 * inside 1Password is intentionally NOT deleted. `requestId` correlates the
 * `vault-status` reply.
 */
export interface VaultDeleteFrame {
  readonly type: "vault-delete"
  readonly requestId: string
  readonly id: string
}

/**
 * Client→server: configure the 1Password two-way sync (slice V3). Enables or
 * disables the sync, and optionally sets the account label + vault name and
 * poll interval. The server type-checks the optional fields (string labels,
 * finite `pollSeconds`) and rejects a malformed frame with a `vault-status`
 * error. `requestId` correlates the `vault-status` reply.
 */
export interface VaultSyncConfigFrame {
  readonly type: "vault-sync-config"
  readonly requestId: string
  readonly enabled: boolean
  readonly opLabel?: string
  readonly opVault?: string
  readonly pollSeconds?: number
}

/**
 * Client→server: import Apple Passwords CSV export items into the 1Password
 * sync vault (slice V3). The server creates LOGIN items in the configured vault
 * + inserts registry rows (source='apple-import'). Requires sync to be enabled
 * with a configured vault. `items` is limited to ≤20 per frame (server enforces
 * this; the client should chunk larger imports). `requestId` correlates the
 * `vault-status` reply.
 *
 * `password` in each item is SENSITIVE — travels UP ONLY and is never echoed
 * back or included in any server→client frame or log.
 */
export interface VaultImportFrame {
  readonly type: "vault-import"
  readonly requestId: string
  readonly items: ReadonlyArray<{
    readonly title: string
    readonly url?: string
    readonly username?: string
    /** The credential to import — sensitive, NEVER echoed back or logged. */
    readonly password: string
    readonly notes?: string
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

/* ── agent-summoned secure secret entry ─────────────────────────────── */

/**
 * Server→client: the chat agent (via the `request_secret` tool) is asking the
 * operator to type a secret into a secure field, inline in the conversation.
 * Additive and optional — gated by handler presence; older clients ignore it.
 *
 * The wire carries ONLY a human `prompt` ("Paste your OpenAI API key") and a
 * human-readable `destinationLabel` ("Store as env:OPENAI_API_KEY") shown for
 * CONSENT. The structured destination descriptor never crosses the wire — the
 * server holds it server-side, keyed by `requestId`. The secret VALUE comes
 * back on `secret-result`; this request frame carries no secret.
 */
export interface SecretRequestFrame {
  readonly type: "secret-request"
  readonly requestId: string
  /**
   * Luna thread that summoned the secret entry. Carried on the wire so
   * Studio/Moon notification banners can focus-regain the right thread
   * (issue #362). The bridge already routes the frame to this thread's
   * registered client; the field is for the consumer, not for delivery.
   */
  readonly threadId: string
  /** What to enter - shown above the secure field. */
  readonly prompt: string
  /** Human-readable destination for operator consent (never the raw descriptor). */
  readonly destinationLabel: string
}

/**
 * Server→client ack for a completed `secret-result` (Moon secure-entry panel).
 * `ok:true` means the secret was stored (the server then defers a restart to
 * turn-end so discovery/broker re-run); `ok:false` carries a non-sensitive
 * reason. The secret VALUE is NEVER echoed back here.
 */
export interface SecretStatusFrame {
  readonly type: "secret-status"
  readonly requestId: string
  readonly ok: boolean
  readonly message: string
}

/* ── job-summoned operator input (widget-system.md Phase 5) ─────────── */

/**
 * Server→client: a RUNNING JOB (via the `request_input` tool) is asking the
 * operator for a piece of input — e.g. "Which of these drafts should I
 * send?". Additive and optional; older clients ignore it.
 *
 * BROADCAST: unlike `secret-request` (which targets the thread's registered
 * client), this frame goes to EVERY connected client — a job has no owning
 * thread, so any surface may answer. First `job-input-result` wins.
 *
 * `runId`/`jobId`/`jobName` identify the waiting run (the run's
 * `job_runs.status` is `waiting` while this is pending — the workflow
 * gallery shows the same state). `timeoutMs` is the wall-clock the operator
 * has before the request resolves failed; clients should dismiss the prompt
 * when it elapses. The answer is OPERATOR INPUT, not a secret — but the
 * server still never logs it.
 */
export interface JobInputRequestFrame {
  readonly type: "job-input-request"
  readonly requestId: string
  readonly runId: number
  readonly jobId: string
  readonly jobName: string
  /** What the job is asking — shown above the input field. */
  readonly prompt: string
  readonly timeoutMs: number
}

/**
 * Client→server: the operator's answer to a `job-input-request`. `answer` is
 * the typed reply (delivered verbatim to the waiting job's model turn; never
 * logged). When `cancelled` is true the operator dismissed the prompt and
 * `answer` is absent. `requestId` correlates back to the request.
 */
export interface JobInputResultFrame {
  readonly type: "job-input-result"
  readonly requestId: string
  readonly answer?: string
  readonly cancelled?: boolean
}

/**
 * Server→client ack for a `job-input-result` (and the broadcast dismissal on
 * timeout). The winning sender gets `ok:true`; a late/duplicate answer gets
 * `ok:false, "already answered"` so its UI can settle. The answer value is
 * NEVER echoed back here.
 */
export interface JobInputStatusFrame {
  readonly type: "job-input-status"
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

/**
 * One entry of a client's widget directory (widget-system.md
 * "Summon-by-name"). `kind` is the addressable name (e.g. "settings.voice");
 * `description` is written for the agent to pick the right widget from a
 * user request. The DIRECTORY comes from the client — the server never
 * hardcodes a host's widget list, so a different host can offer a different
 * directory and a different server can ignore it entirely.
 */
export interface WidgetDirectoryEntry {
  readonly kind: string
  readonly title: string
  readonly description: string
}

/**
 * Server→client: open (or focus) the widget registered under `kind`. Sent in
 * response to the agent's open_widget tool; the host resolves the kind
 * through ITS OWN registry and ignores unknown kinds — the frame can never
 * conjure a window the host didn't already ship.
 */
export interface WidgetOpenFrame {
  readonly type: "widget-open"
  readonly kind: string
  /**
   * Optional instance params (Phase 8 direct lines / parameterized panels):
   * scalar key→value pairs the host appends to the page URL — e.g.
   * {thread: "thr_…"} opens a chat window PINNED to that thread, its own
   * window per distinct params. The host validates keys fail-closed.
   */
  readonly params?: Readonly<Record<string, string | number | boolean>>
}

/**
 * Server→client: open (or focus) a CONTENT artifact as its own widget window —
 * the content-tier sibling of `widget-open`. Sent by the agent's
 * `open_artifact` tool, auto-fired when `widget_write`/`mcp_app_write` CREATE a
 * new artifact, and emitted when the user reopens a closed artifact by asking.
 *
 * The host resolves `artifactId` against its own pinned-artifact set and renders
 * it in the sandboxed widget.html cage (kind `widget` = inline HTML, kind
 * `mcp-app` = MCP Apps relay) — it can NEVER open a system panel this way, so
 * the system/content trust split is preserved. Distinct from `open_artifact_widget`
 * the Tauri command: this is the WS-frame path that lets the SERVER initiate the
 * open. Additive, gated on the `artifacts` capability; a host without artifact
 * support ignores it.
 */
export interface OpenArtifactWidgetFrame {
  readonly type: "open-artifact-widget"
  readonly artifactId: string
  readonly title: string
  /** The artifact kind, so a host can fail-closed on a kind it can't render. */
  readonly kind: ArtifactKind
}

/* ── live subagent tree (S4 "Agents" panel) ─────────────────────────────
 * When a chat turn delegates to subagents, the server-side SubagentTreeBridge
 * folds the `parentToolUseId`-tagged tool frames into a per-thread tree and
 * BROADCASTS it, so the read-only Agents panel renders without subscribing the
 * thread (subscribing would steal the chat window's secret/interactive
 * bindings — the one-window-per-thread rule). Additive, gated on the existing
 * `subagents` hello capability. */

/** One node in the live subagent tree — a spawned Agent/Task and its activity.
 *  METADATA ONLY (no tool output, no full prompt) — wire-safe + context-cheap. */
export interface SubagentNode {
  readonly id: string
  /** The spawning Agent's tool_use id when nested, else null (top-level). */
  readonly parentId: string | null
  /** The subagent type (e.g. "Explore") or "Agent" when untyped. */
  readonly name: string
  /** A short human label from the spawn (description, else a prompt prefix). */
  readonly description: string
  readonly status: "running" | "done" | "error"
  /** The subagent's current/last tool, or null before it runs one. */
  readonly tool: string | null
  readonly toolCount: number
}

/** Server→client: the live subagent tree for a thread. Broadcast on change and
 *  sent in reply to a `subagent-tree-request`. */
export interface SubagentTreeFrame {
  readonly type: "subagent-tree"
  readonly threadId: string
  readonly agents: ReadonlyArray<SubagentNode>
}

/** Client→server: the Agents panel asks for a thread's current tree on open,
 *  so a panel summoned mid-turn paints immediately (not on the next change). */
export interface SubagentTreeRequestFrame {
  readonly type: "subagent-tree-request"
  readonly threadId: string
}

/* ── MCP Apps host relay (widget-system.md Phase 7, SEP-1865) ───────────
 * The Moon is an MCP Apps HOST; the Luna server owns every MCP session
 * (single session authority). v1 serves an in-process CoreAppRegistry —
 * the server is the first app provider — but the frames are deliberately
 * provider-agnostic so an external-MCP-server relay rides the same seam.
 * All four are additive, gated on the hello `mcpApps` capability. */

/** Client→server: resolve a `ui://` app resource (the app's HTML template). */
export interface McpResourceReadFrame {
  readonly type: "mcp-resource-read"
  readonly requestId: string
  readonly uri: string
}

/**
 * Server→client: the resource read outcome. `text` is the app HTML
 * (mimeType `text/html;profile=mcp-app`); `ok:false` carries a short,
 * non-sensitive reason (unknown uri, provider failure).
 */
export interface McpResourceResultFrame {
  readonly type: "mcp-resource-result"
  readonly requestId: string
  readonly ok: boolean
  readonly mimeType?: string
  readonly text?: string
  readonly message?: string
}

/**
 * Client→server: a rendered MCP app called `tools/call`. `appUri` is the
 * `ui://` resource the calling app was rendered from — the server enforces
 * the spec's same-server rule (an app may ONLY call its own app's tools).
 * `args` is the tool's arguments object (any JSON value).
 */
export interface McpToolCallFrame {
  readonly type: "mcp-tool-call"
  readonly requestId: string
  readonly appUri: string
  readonly tool: string
  readonly args: unknown
}

/**
 * Server→client: the tool call outcome. `result` is the tool's content
 * (any JSON value — spec-shaped CallToolResult for core apps). It is the
 * app's data: this package NEVER logs it. `ok:false` carries a short,
 * non-sensitive reason (unknown app, tool not on that app, handler failure).
 */
export interface McpToolResultFrame {
  readonly type: "mcp-tool-result"
  readonly requestId: string
  readonly ok: boolean
  readonly result?: unknown
  readonly message?: string
}

/* ── Smart Bar (v1 info-only, dynamically server-assembled) ────────────────
 * Server resolves context and PUSHES a ready-made ordered list of typed
 * items; the client is a dumb renderer. v1 emits/renders `kind:"info"` only;
 * all other kinds are reserved in the union for forward-compat (unknown kinds
 * are silently skipped client-side). Additive — no protocol bump.
 *
 * Re-pushed on: thread subscribe/snapshot, turn-complete, local-shell-
 * capability change, and a low-frequency background interval. */

export type SmartBarItemKind =
  | "info"       // v1: read-only label + value chip
  // ── Phase 2+ (schema reserved; renderer added incrementally) ──
  | "button"     // value=caption; emits smart-bar-interaction on click
  | "toggle"     // boolean; emits smart-bar-interaction on flip
  | "slider"     // + min/max/step; emits smart-bar-interaction on change
  | "select"     // + options[]; dropdown; emits smart-bar-interaction on change
  | "sparkline"  // + points[]; small inline graph

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

/**
 * Server→client: the current smart bar item list for a thread. Re-pushed
 * whenever context changes (see re-push triggers above). `version` is always
 * 1; it is present so a future schema revision can introduce `version:2`
 * items without a protocol bump. An empty `items` array means hide the bar.
 * Additive — no hello capability gate; unknown frame types are tolerated by
 * old clients and are a no-op in the ui-shared reducer.
 */
export interface SmartBarFrame {
  readonly type: "smart-bar"
  readonly threadId: string
  readonly version: 1
  readonly items: ReadonlyArray<SmartBarItem>
}

/**
 * Server→client: ack for a `set-thread-config` request. Sent only to the
 * requesting connection (not broadcast — the change is per-thread not
 * per-session, and other connections can detect the diff on next message).
 *
 * `applied` lists the fields that were accepted and are effective NOW for the
 * in-flight SDK session. `deferred` lists fields accepted but queued for the
 * NEXT thread creation (e.g. cross-lane model switch — cannot hot-swap mid-
 * conversation). `rejected` lists fields that were invalid or unsupported,
 * with a short non-sensitive reason.
 *
 * Effort semantic for `"max"`: the ack reports the accepted THREAD-LEVEL
 * preference, and `effort` echoes the value the server actually accepted
 * (clamping may adjust it). A mid-thread switch to "max" runs the current
 * thread's live query at the closest live level ("xhigh" — the SDK's
 * Settings.effortLevel has no "max") and applies exactly as "max" on the
 * next rebuild (recovery or new thread, which use Options.effort).
 */
export interface ThreadConfigFrame {
  readonly type: "thread-config"
  readonly threadId: string
  readonly model?: string
  readonly effort?: EffortOption
  readonly applied: ReadonlyArray<"model" | "effort">
  readonly deferred: ReadonlyArray<"model" | "effort">
  readonly rejected?: ReadonlyArray<{ readonly field: "model" | "effort"; readonly reason: string }>
}

/* ── Provider / model routing settings (PR 1: config surface) ───────────────
 * Additive, gated on hello capability `modelRouting`. No protocol bump.
 * SECURITY: no secret values ever cross the wire — only metadata + opaque
 * credentialRef pointers (same contract as connectors/vault). */

/** One configured provider for the settings UI. */
export interface ProviderSettingsItem {
  readonly kind: string
  readonly enabled: boolean
  /** Opaque credential pointer — never the raw secret. */
  readonly credentialRef?: string
  /** Monthly spend ceiling in USD. Stored; NOT enforced in PR 1.
   *  The UI MUST label this "not yet enforced (coming in next update)". */
  readonly monthlyCapUsd?: number
}

/** One role-binding row for the settings UI. */
export interface RoleBindingItem {
  readonly role: string
  readonly preferenceList: ReadonlyArray<{ readonly provider: string; readonly model: string }>
}

/**
 * Server→client: current model-routing settings. Sent after `hello` and after
 * each successful mutation. Wire-safe — no secret values, only metadata +
 * opaque refs.
 */
export interface ModelRoutingListFrame {
  readonly type: "model-routing-list"
  readonly providers: ReadonlyArray<ProviderSettingsItem>
  readonly roleBindings: ReadonlyArray<RoleBindingItem>
}

/**
 * Server→client: ack for a `model-routing-save`. `ok:false` carries a
 * short, non-sensitive reason (validation failure message). Never echoes
 * credential values.
 */
export interface ModelRoutingStatusFrame {
  readonly type: "model-routing-status"
  readonly requestId: string
  readonly ok: boolean
  readonly message: string
}

/**
 * Client→server: save the complete model-routing settings payload.
 * The server validates then persists; responds with `model-routing-status`
 * followed by a fresh `model-routing-list` on success.
 *
 * `providers[].credentialRef` is an OPAQUE POINTER (e.g. "env:ANTHROPIC_API_KEY")
 * — never the raw credential value. Credential entry uses the existing
 * `request_secret` flow (SecretRequestBridge).
 */
export interface ModelRoutingSaveFrame {
  readonly type: "model-routing-save"
  readonly requestId: string
  readonly providers: ReadonlyArray<ProviderSettingsItem>
  readonly roleBindings: ReadonlyArray<RoleBindingItem>
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
  | ToolCallFrame
  | ToolResultFrame
  | TurnCompleteFrame
  | ResultDeliveredFrame
  | AccountListFrame
  | AgentListFrame
  | AccountStatusFrame
  | SkillCatalogFrame
  | SkillStatusFrame
  | CapabilityCatalogFrame
  | CapabilityExecuteResultFrame
  | FeedbackAckFrame
  | ConnectorCatalogFrame
  | ConnectorListFrame
  | ConnectorOauthRedirectFrame
  | ConnectorStatusFrame
  | ArtifactListFrame
  | ArtifactUpdateFrame
  | WorkflowListFrame
  | WorkflowRunsFrame
  | SuggestedActionSetFrame
  | SuggestedActionUpdateFrame
  | ForkProposalSetFrame
  | ForkProposalUpdateFrame
  | LocalShellRequestFrame
  | LocalShellStatusFrame
  | RegisterOpTokenStatusFrame
  | SecretRequestFrame
  | SecretStatusFrame
  | JobInputRequestFrame
  | JobInputStatusFrame
  | MemorySearchResultFrame
  | MemorySearchErrorFrame
  | SurveyRequestFrame
  | PtyOutputFrame
  | VaultListFrame
  | VaultStatusFrame
  | WidgetOpenFrame
  | OpenArtifactWidgetFrame
  | SubagentTreeFrame
  | McpResourceResultFrame
  | McpToolResultFrame
  | ThreadConfigFrame
  | SmartBarFrame
  | ModelRoutingListFrame
  | ModelRoutingStatusFrame
  | ThreadArchivedFrame
  | ThreadUnarchivedFrame
  | ThreadArchiveErrorFrame

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
  /**
   * Phase 3: filter by status. Omit for default (active-only) list.
   * Pass 'archived' to get the archive panel contents.
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

/** Phase 3: Server confirmation of an archive/unarchive operation. */
export interface ThreadArchivedFrame {
  readonly type: "thread-archived"
  readonly threadId: string
}

export interface ThreadUnarchivedFrame {
  readonly type: "thread-unarchived"
  readonly threadId: string
}

/**
 * Phase 3: Sent when archive-thread / unarchive-thread failed because the
 * thread was not found in ThreadRegistry (registry absent or threadId unknown).
 * The client should treat this as a no-op / stale-UI situation and refresh.
 */
export interface ThreadArchiveErrorFrame {
  readonly type: "thread-archive-error"
  readonly threadId: string
  /** Human-readable reason — 'not-found' when registry returned false. */
  readonly reason: "not-found" | "registry-unavailable"
}

export interface NewThreadFrame {
  readonly type: "new-thread"
  /** Optional; omitted routes through the broker default lane (prefers Sonnet 5 when Anthropic is available, else the configured default overflow chain). */
  readonly model?: string
  readonly accountId?: string    // pins this thread to a specific account
  readonly title?: string
  readonly tags?: ReadonlyArray<string>
  readonly systemPrompt?: string
  /** Additive effort level for this thread. Older servers ignore it. */
  readonly effort?: EffortOption
  /**
   * Agent sidebar S2: file the new thread under this agent section (the
   * sidebar section's "+"). Validated server-side against the bound
   * agentRoster — unknown/invalid names are DROPPED (thread lands in the
   * general section) because client input is never trusted and a roster
   * race must degrade, not fail the create. Additive — older servers
   * ignore it.
   */
  readonly agent?: string
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
 * Client→server: the operator's answer to a `secret-request` (Moon secure
 * panel). Additive and optional. `secret` is the SENSITIVE value the operator
 * typed — the server validates/persists it but MUST never log it or persist it
 * to chat history. When `cancelled` is true, the operator dismissed the panel
 * and `secret` is absent. `requestId` correlates back to the `secret-request`.
 */
export interface SecretResultFrame {
  readonly type: "secret-result"
  readonly requestId: string
  readonly secret?: string
  readonly cancelled?: boolean
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

/**
 * Client→server: flip one skill on/off from the Skills settings tab
 * (PRD Part B §12). Server persists the delta (skill_preferences), flips
 * the live registry, and acks with `skill-status` + a fresh `skill-catalog`.
 * Idempotent: re-sending the current state is a no-op server-side.
 */
/**
 * Client→server: the host's widget directory (sent once after hello by hosts
 * that can open widgets). Replaces any previously announced directory for
 * this connection.
 */
export interface WidgetDirectoryFrame {
  readonly type: "widget-directory"
  readonly widgets: ReadonlyArray<WidgetDirectoryEntry>
}

export interface SkillToggleFrame {
  readonly type: "skill-toggle"
  readonly id: string
  readonly enabled: boolean
}

/**
 * Client→server: invoke a backend-advertised capability (capability layer).
 * `requestId` correlates the unicast `capability-execute-result`; `kind`/`id`
 * identify the capability from the `capability-catalog`. Additive — gated on
 * the `commands` capability; older servers route this to the unknown-frame log
 * and ignore it.
 */
export interface CapabilityExecuteFrame {
  readonly type: "capability-execute"
  readonly requestId: string
  readonly kind: string
  readonly id: string
  readonly args?: Record<string, unknown>
}

/**
 * Client→server: update the model and/or effort for an existing thread.
 * Additive — gated on the `effortSelection` capability; older servers route
 * this to the unknown-frame log and ignore it. At most one of model/effort
 * is required; omitting both is a no-op (server replies with empty applied[]).
 */
export interface SetThreadConfigFrame {
  readonly type: "set-thread-config"
  readonly threadId: string
  readonly model?: string
  readonly effort?: EffortOption
}

/**
 * Client→server: point-at-the-UI feedback. The operator pointed at an element
 * in the Moon window and typed a note about what should change. `requestId`
 * correlates the unicast `feedback-ack`; `target` describes the pointed-at
 * element (best-effort selector + context) so the note is actionable. Additive
 * — gated on the `feedback` capability; older servers route this to the
 * unknown-frame log and ignore it. `note` is free text and MUST be length-
 * capped server-side (unbounded user input). The richer capture context
 * (anchor / route / appearance / viewport) travels in `target` as-is; only
 * `target.selector` is hard-required.
 */
export interface FeedbackSubmitFrame {
  readonly type: "feedback-submit"
  readonly requestId: string
  readonly threadId?: string
  readonly note: string
  readonly target: {
    readonly selector: string
    readonly tag?: string
    readonly id?: string
    readonly classes?: ReadonlyArray<string>
    readonly text?: string
    readonly rect?: {
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }
    /** Full best-effort capture context (anchor/route/appearance/viewport),
     * stored verbatim after the server enforces the aggregate target-size cap. */
    readonly context?: Record<string, unknown>
  }
  readonly page: string
  readonly appVersion?: string
  readonly appearance?: string
  readonly clientTs: number
  /** Best-effort base64-encoded PNG (NO `data:` URI prefix) of the picked
   *  element, captured via native macOS window capture and cropped/downscaled
   *  client-side (see FeedbackEngine._captureScreenshot in chat.html). Omitted
   *  when capture failed, permission was denied, or the platform/build doesn't
   *  support it — screenshot is always best-effort, never blocking. Server-side
   *  SCREENSHOT_MAX_BASE64_CHARS bounds this independently of the socket's
   *  32MB maxPayload ceiling; an oversized or non-string value is silently
   *  dropped (the note still submits) rather than rejecting the whole frame. */
  readonly screenshot?: string
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
  | SecretResultFrame
  | JobInputResultFrame
  | SurveyResponseFrame
  | SkillToggleFrame
  | CapabilityExecuteFrame
  | ConnectorOauthBeginFrame
  | ConnectorOauthCodeFrame
  | ConnectorConnectFrame
  | ConnectorDisconnectFrame
  | ConnectorSetClientFrame
  | ArtifactPinFrame
  | ArtifactUnpinFrame
  | ArtifactEditFrame
  | WorkflowRunsRequestFrame
  | WorkflowRefreshFrame
  | SuggestedActionRespondFrame
  | ForkProposalRespondFrame
  | WidgetDirectoryFrame
  | SubagentTreeRequestFrame
  | McpResourceReadFrame
  | McpToolCallFrame
  | PtyInputFrame
  | PtyResizeFrame
  | VaultPutFrame
  | VaultDeleteFrame
  | VaultSyncConfigFrame
  | VaultImportFrame
  | AccountAddFrame
  | AccountRmFrame
  | SetThreadConfigFrame
  | ModelRoutingSaveFrame
  | ArchiveThreadFrame
  | UnarchiveThreadFrame
  | FeedbackSubmitFrame
