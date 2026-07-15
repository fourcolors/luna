/**
 * UIWebSocketServer — exposes UIService.subscribe over a WebSocket.
 *
 * Design (per advisor pre-flight):
 *   - Native `node:http` + `ws@8` (matches gateway/adapters/http.ts precedent;
 *     no Hono dep).
 *   - Bind `127.0.0.1` by default — never expose this to the network.
 *     Cross-machine UI runs over an SSH tunnel or reverse-proxy with TLS.
 *   - Bearer token auth: `Authorization: Bearer <token>` on the upgrade
 *     request. Token loaded out-of-band (env / 1Password) by the caller.
 *   - Per-connection bounded buffer with **drop-oldest** semantics. The shared
 *     UIService PubSub fan-out is unbounded → if we back-pressured one slow
 *     consumer it would back-pressure ALL consumers. Dropping per-connection
 *     keeps the rest healthy.
 *   - On overflow, emit a `{type:"drop", n, since}` frame so the client knows
 *     it missed events and can re-fetch from a durable source if needed.
 *   - Lifetime: server is a Layer.scoped resource; on Scope close it
 *     gracefully closes the http server + every active WebSocket + the per-
 *     connection forwarder fibers.
 *   - Each connection forks into the SERVER's scope (not the request's) so
 *     graceful shutdown can interrupt them deterministically.
 *
 * Errors:
 *   - HTTP 401 on missing/invalid bearer.
 *   - HTTP 426 on non-WS requests to the WS path.
 *   - HTTP 200 on `/healthz` (no auth — for liveness).
 *   - Anything else → HTTP 404.
 */
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Runtime,
  Schedule,
  Stream,
} from "effect"
import type * as Scope from "effect/Scope"
import * as http from "node:http"
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import * as fs from "node:fs"
import { WebSocketServer, type WebSocket } from "ws"
import { UIService } from "@luna/core"
import {
  ALLOWED_ATTACHMENT_MEDIA_TYPES as ALLOWED_ATTACH_MEDIA_TYPES,
  MAX_IMAGE_RAW_BYTES,
  MAX_PDF_RAW_BYTES,
  MAX_TURN_RAW_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
} from "@luna/core"
import type { ObsEvent } from "@luna/core"
import type {
  ChatService,
  ChatFrame,
  DeliveryNotification,
} from "@luna/chat-service"
import type { LocalShellBridge } from "./local-shell-bridge.js"
import type { SecretRequestBridge } from "./secret-request-bridge.js"
import {
  UI_WS_PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type PtyOutputFrame,
} from "./protocol.js"
import { projectLunaDescriptor } from "./descriptor.js"
import {
  createSmartBarContextModule,
  type SmartBarContext,
} from "./smart-bar-context.js"
import type { SurveyItem, SurveyVerdict } from "@luna/core"

/**
 * Resolved Survey handle for the WS server (Phase 3 D3). Passed as a plain
 * handle (NOT a Tag) so the server's environment doesn't grow a Survey
 * dependency — mirrors the accountBroker pattern exactly.
 *
 * When provided:
 *   - After `hello`, the server fire-and-forgets a `pendingSurvey(now)` call;
 *     if due it pushes a `survey-request` frame.
 *   - Inbound `survey-response` frames are routed to `submitVerdicts`, which
 *     pins every verdict's `at` to `frame.issuedAt` before calling
 *     processVerdict (D-LOCK-5 idempotency — a re-delivered answer cannot
 *     double-move the EWMA because survey.ts keys on (ref, signalKind, at)).
 *
 * NO snooze handle (Execution Correction #1): dismiss is a client-side no-op.
 */
export interface SurveyWsHandle {
  /**
   * Check whether a survey is due at `now` and return its items + issuedAt,
   * or null if not due.
   *
   * Called by the server at two moments:
   *   1. once at connection-time (right after `hello`), and
   *   2. periodically thereafter for the lifetime of the connection
   *      (default cadence: every 60s; configurable via
   *      UIWebSocketServerConfig.surveyPollIntervalMs).
   *
   * The recurring re-check exists for long-lived clients (e.g. the Moon
   * desktop app, which stays connected for hours/days): without it a
   * survey that becomes due mid-session — typically after the nightly
   * dream-cron proposes new beliefs — would never reach the operator.
   * Fire-and-forget at the call site, so backend failures here never tear
   * down the connection.
   */
  readonly pendingSurvey: (
    now: number,
  ) => import("effect").Effect.Effect<
    { readonly issuedAt: number; readonly items: ReadonlyArray<SurveyItem> } | null,
    unknown
  >
  /**
   * Process all verdicts from a single survey response. The server PINS
   * each verdict's `at` to `issuedAt` before calling this (D-LOCK-5), so
   * re-delivering the same `survey-response` frame is a no-op server-side.
   *
   * `surveyId` — the wire-level survey instance id (from SurveyResponseFrame).
   * `issuedAt` — the stable survey timestamp (from the SurveyRequestFrame);
   *   this is the idempotency anchor used by survey.ts (ref, signalKind, at).
   * `verdicts` — already-pinned: each `v.at` has been set to `issuedAt`.
   */
  readonly submitVerdicts: (
    surveyId: string,
    issuedAt: number,
    verdicts: ReadonlyArray<SurveyVerdict>,
  ) => import("effect").Effect.Effect<void, unknown>
}

export interface UIWebSocketServerConfig {
  /** TCP port. Default: 4753 (UISE). */
  readonly port?: number
  /**
   * Bind address. Default: "127.0.0.1" — DO NOT change without TLS + auth
   * hardening. The bearer token is the only auth layer.
   */
  readonly host?: string
  /**
   * Bearer token required on the upgrade `Authorization` header.
   * If unset, the server REFUSES TO START — fail-closed beats fail-open.
   */
  readonly token: string
  /**
   * Per-connection bounded buffer size (in events). Default: 256.
   * Slow consumers exceeding this see drop-oldest + a `drop` frame.
   */
  readonly perConnectionCapacity?: number
  /**
   * WS path. Default: "/ui".
   */
  readonly path?: string
  /**
   * Keep-alive ping interval (ms). 0 disables. Default: 30_000.
   */
  readonly pingIntervalMs?: number
  /**
   * Per-connection survey re-check cadence (ms). 0 disables the recurring
   * poller (the connection-time check still runs). Default: 60_000.
   *
   * Lower values reduce the latency between a survey becoming due and a
   * `survey-request` frame reaching a long-lived client (e.g. Moon), at
   * the cost of one extra alignment-store read per connection per tick.
   * Tests use a very small value (e.g. 50ms) so the poller is observable
   * within a vitest's time budget.
   */
  readonly surveyPollIntervalMs?: number
  /**
   * Kinds advertised in the `hello` frame. Should match the kind
   * whitelist configured on `UIService.makeLayer`. The server itself
   * does not filter — UIService already filtered upstream — this is
   * purely informational so clients know what to expect.
   * Default: empty.
   */
  readonly advertisedKinds?: ReadonlyArray<string>
  /**
   * Git short-SHA of the running server build. When provided, it is echoed
   * in the `hello` frame's `buildSha` field and in `/readyz` JSON so any
   * surface can tell which commit is running. Additive — absent = field
   * omitted from both (older clients/consumers ignore it).
   */
  readonly buildSha?: string
  /**
   * Semver of the running server release (e.g. "0.1.0"). When provided, it
   * is echoed in the `hello` frame's `serverVersion` field and in `/readyz`
   * JSON. Source: `LUNA_BUILD_VERSION` env → `git describe --tags --match
   * 'server-v*'` → graceful fallback (resolved in chat-server.ts and
   * threaded in here). Additive — absent = field omitted; older clients and
   * older consumers ignore it.
   */
  readonly serverVersion?: string
  /**
   * Optional live JobTicker health for `/readyz.scheduler` (additive).
   * When provided, /readyz includes a `scheduler` object. Absent → field
   * omitted (setup-mode and older boots). Default: report-only — overall
   * status stays `ok` even if scheduler is degraded unless
   * `LUNA_SCHEDULER_STRICT_READY=1` (read by the caller that supplies this
   * getter, or by server when `strictSchedulerReady` is true).
   */
  readonly getSchedulerHealth?: () => {
    readonly status: "ok" | "degraded" | "initializing"
    readonly lastTickAt: number | null
    readonly lastTickAgeMs: number | null
    readonly inFlight: number
    readonly tickIntervalMs: number
    readonly lastTick: {
      readonly considered: number
      readonly claimed: number
      readonly forked: number
      readonly skippedInFlight: number
      readonly skippedNoCapacity: number
      readonly failedInline: number
    }
  } | null
  /**
   * When true AND getSchedulerHealth().status === "degraded", /readyz top-level
   * `status` becomes `"degraded"` (HTTP still 200). Default false — chat stays
   * ready when only the scheduler is unhealthy.
   */
  readonly strictSchedulerReady?: boolean
  /**
   * Human-readable name for this server instance. Echoed in the hello frame's
   * `descriptor.identity.name` field. Additive — absent = defaults to "luna".
   */
  readonly serverName?: string
  /**
   * Operator-configured model list for the UI model-switcher dropdown.
   * When provided, the array is echoed verbatim in the `hello` frame's
   * `availableModels` field. Additive — absent = field omitted; clients
   * fall back to their own hardcoded list (graceful degradation). The FIRST
   * entry is treated by clients as the recommended default. Built by
   * `buildAvailableModels()` in chat-server.ts, which merges
   * `LUNA_UI_MODELS` overrides with the built-in base list.
   */
  readonly availableModels?: ReadonlyArray<{
    readonly id: string
    readonly label: string
    /**
     * Effort options valid for THIS model, server-computed. Absent on older
     * servers; empty array = model takes no effort param. Clients never
     * compute this matrix - always defer to this field. May include the
     * "ultracode" pseudo-token for xhigh-capable models (see
     * HelloFrame.availableModels in protocol.ts).
     */
    readonly efforts?: ReadonlyArray<"low" | "medium" | "high" | "xhigh" | "max" | "ultracode">
    /**
     * Effort a fresh thread should DEFAULT to for this model when the client
     * persists none - server-computed via defaultEffortForModel(). Absent on
     * models with no opinion; clients then fall back to the weakest level.
     */
    readonly defaultEffort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"
  }>
  /**
   * Optional ChatService binding. When provided, the server:
   *   - flips `capabilities.chat` and `capabilities.streamingDeltas` to
   *     `true` in the hello frame
   *   - parses inbound ClientFrames and routes chat ops (subscribe /
   *     unsubscribe / list-threads / new-thread / user-message /
   *     interrupt) to the supplied ChatService
   *   - per connection, forks one forwarder fiber per subscribed thread,
   *     translating ChatFrame → ServerFrame on the wire
   *
   * The base obs path (event/drop/ping) keeps working unchanged when
   * this is unset. Pass the resolved service handle (not the Tag) so
   * the server's environment doesn't grow a `ChatService` dependency.
   * Pass `null` explicitly in setup-mode (same as absent — server
   * advertises `setup:true, chat:false`).
   */
  readonly chatService?: ChatService | null
  /**
   * Optional AccountBroker handle. When provided, the server sends an
   * `account-list` frame to each client immediately after the `hello`
   * frame, populated with all "anthropic"-kind accounts. If absent, no
   * `account-list` is sent (graceful degradation).
   * Pass `null` explicitly in setup-mode (same as absent).
   */
  readonly accountBroker?: {
    readonly list: (kindFilter?: string) => import("effect").Effect.Effect<ReadonlyArray<{
      readonly id: string
      readonly label: string
      readonly kind: string
      readonly health: string
    }>>
  } | null
  /**
   * Optional skill-catalog handle (PRD Part B). When provided, the server:
   *   - advertises `capabilities.skills: true`
   *   - sends a `skill-catalog` frame after `hello` (fire-and-forget, like
   *     account-list) so the Skills settings tab renders on connect
   *   - routes inbound `skill-toggle` frames → setEnabled, acking with
   *     `skill-status` + a refreshed `skill-catalog` to the toggling client
   *
   * The handle's catalog() MUST already be wire-safe (metadata only, no
   * skill bodies) — the chat-server adapter strips bodies BEFORE this
   * package ever sees them, so a logging or serialization bug here cannot
   * leak prompt content. Structural type (not the core Tag) keeps this
   * package's dependency surface narrow — mirrors accountBroker exactly.
   * Pass `null` explicitly in setup-mode (same as absent).
   */
  readonly skillRegistry?: {
    readonly catalog: () => import("effect").Effect.Effect<
      ReadonlyArray<import("./protocol.js").SkillCatalogItem>
    >
    readonly setEnabled: (
      id: string,
      enabled: boolean,
    ) => import("effect").Effect.Effect<void, unknown>
    /**
     * Optional change-notification registration: the server passes a
     * `notify` callback; the provider calls it whenever the catalog
     * changes OUTSIDE a client toggle (the ~30s user-skills hot-load).
     * On notify, the server broadcasts a fresh `skill-catalog` to every
     * connected client — without it, a hot-loaded/removed user skill is
     * invisible to long-lived clients (the Moon) until reconnect.
     */
    readonly changes?: (notify: () => void) => void
  } | null
  /**
   * Optional capability handle (capability layer — backend-advertised
   * commands). When provided, the server:
   *   - advertises `capabilities.commands: true`
   *   - sends a `capability-catalog` frame after `hello` (fire-and-forget,
   *     like skill-catalog) so clients render advertised commands on connect
   *   - routes inbound `capability-execute` frames → execute, UNICASTing a
   *     `capability-execute-result` back to the requesting socket ONLY
   *
   * v1 is a STATIC catalog (no `changes` hook). The handle's catalog() MUST
   * already be wire-safe (metadata only — the chat-server adapter builds the
   * descriptors literally). Structural type (not the core Tag) keeps this
   * package's dependency surface narrow — mirrors skillRegistry exactly. Pass
   * `null` explicitly in setup-mode (same as absent).
   */
  readonly capabilityRegistry?: {
    readonly catalog: () => import("effect").Effect.Effect<
      import("./protocol.js").WireCapabilityCatalog
    >
    readonly execute: (req: {
      kind: string
      id: string
      args?: Record<string, unknown>
    }) => import("effect").Effect.Effect<{ ok: boolean; message?: string }>
  } | null
  /**
   * Optional thread-archive notifier (14-day auto-archive policy). The server
   * passes a `notify` callback; the provider (chat-server's runAutoArchive
   * loop) calls it with the ids it archived OUTSIDE any client request. On
   * notify, the server broadcasts a `thread-archived` frame for each id to
   * every connected client, so an actively-viewed thread that gets
   * auto-archived recovers gracefully (the client clears + re-lists). Without
   * it, server-side auto-archive is invisible to live clients until reconnect.
   * Mirrors skillRegistry.changes. Pass `null`/absent in setup-mode.
   */
  readonly threadArchiveNotifier?: {
    readonly changes: (
      notify: (threadIds: ReadonlyArray<string>) => void,
    ) => void
  } | null
  /**
   * Optional connector handle (PRD Part A §18). When provided, the server
   * advertises `capabilities.connectors`, sends `connector-catalog` +
   * `connector-list` after hello, and routes the client-brokered OAuth
   * handshake + connect/disconnect. The handle's outputs MUST already be
   * wire-safe (the chat-server adapter projects instances to status +
   * metadata; no secretRef, no tokens). Structural type — mirrors
   * accountBroker/skillRegistry. Pass `null` explicitly in setup-mode.
   */
  readonly connectorService?: {
    readonly catalog: () => import("effect").Effect.Effect<
      ReadonlyArray<import("./protocol.js").ConnectorCatalogItem>
    >
    readonly list: () => import("effect").Effect.Effect<
      ReadonlyArray<import("./protocol.js").ConnectorInstanceItem>
    >
    readonly beginAuth: (input: {
      readonly definitionId: string
      readonly label: string
      readonly capabilityIds?: ReadonlyArray<string>
      readonly loopbackPort: number
    }) => import("effect").Effect.Effect<
      { readonly pendingId: string; readonly authUrl: string },
      unknown
    >
    readonly completeAuth: (input: {
      readonly pendingId: string
      readonly code: string
      readonly state: string
    }) => import("effect").Effect.Effect<
      import("./protocol.js").ConnectorInstanceItem,
      unknown
    >
    readonly connect: (input: {
      readonly definitionId: string
      readonly label: string
      readonly secretRef?: string
      readonly capabilityIds?: ReadonlyArray<string>
    }) => import("effect").Effect.Effect<
      import("./protocol.js").ConnectorInstanceItem,
      unknown
    >
    readonly disconnect: (
      instanceId: string,
    ) => import("effect").Effect.Effect<boolean, unknown>
    /** PRD §23 (M2.6): persist the operator's per-operator OAuth client
     *  credentials so the consent flow runs without hand-editing ~/.luna/.env.
     *  Values are written server-side and never echoed. */
    readonly setClientCredentials: (input: {
      readonly definitionId: string
      readonly clientId: string
      readonly clientSecret?: string
    }) => import("effect").Effect.Effect<void, unknown>
  } | null
  /**
   * Optional pinned-artifact store handle (PRD Part C/W1 §18). When provided,
   * the server advertises `capabilities.artifacts`, sends an `artifact-list`
   * after hello, routes `artifact-pin`/`artifact-unpin`, and broadcasts a
   * fresh `artifact-list` to every client on any change. The handle's outputs
   * are already wire-safe (PinnedArtifactItem — metadata + content, no
   * secrets). Structural type — mirrors connectorService. `changes` lets
   * out-of-band edits (an agent patching an artifact, W4) re-broadcast.
   * Pass `null` explicitly in setup-mode.
   */
  readonly artifactStore?: {
    readonly list: () => import("effect").Effect.Effect<
      ReadonlyArray<import("./protocol.js").PinnedArtifactItem>
    >
    readonly pin: (input: {
      readonly id: string
      readonly title: string
      readonly content: string
      readonly lang?: string | null
      readonly kind?: import("./protocol.js").ArtifactKind
      readonly origin?: string | null
    }) => import("effect").Effect.Effect<
      import("./protocol.js").PinnedArtifactItem,
      unknown
    >
    readonly unpin: (
      id: string,
    ) => import("effect").Effect.Effect<boolean, unknown>
    /** Append a new version to an existing artifact (preserves the ledger +
     *  leaves bridgeCaps untouched). Returns null when the id isn't pinned. */
    readonly update?: (
      id: string,
      content: string,
    ) => import("effect").Effect.Effect<
      import("./protocol.js").PinnedArtifactItem | null,
      unknown
    >
    readonly changes?: (notify: () => void) => void
  } | null
  /**
   * Optional workflow-gallery handle (PRD Part C / W3). A READ-ONLY, wire-safe
   * view over the persisted jobs store: `list` returns every job projected to a
   * gallery tile (no secrets, no large output), `runs` returns one job's run
   * history. When provided, the server advertises `capabilities.workflows`,
   * sends `workflow-list` after hello, and routes `workflow-runs-request` +
   * `workflow-refresh`. Structural type — mirrors artifactStore. Pass `null`
   * in setup-mode.
   */
  readonly workflowGallery?: {
    readonly list: () => import("effect").Effect.Effect<
      ReadonlyArray<import("./protocol.js").WorkflowGalleryItem>
    >
    readonly runs: (
      jobId: string,
      limit?: number,
    ) => import("effect").Effect.Effect<
      ReadonlyArray<import("./protocol.js").WorkflowRunItem>
    >
  } | null
  /**
   * Optional Suggested Actions handle. When provided, the server advertises
   * `capabilities.suggestedActions` and routes `suggested-action-respond` to
   * `respond` (accept → auto-execute, dismiss). The resulting status/list
   * frames reach the client over the normal chat subscribe stream (the service
   * publishes onto the thread's pubsub), so this handle only needs `respond`.
   * Errors are swallowed by the adapter — `respond` never fails the caller.
   * Pass `null` in setup-mode. Structural type — mirrors workflowGallery.
   */
  readonly suggestedActions?: {
    readonly respond: (input: {
      readonly threadId: string
      readonly actionId: string
      readonly decision: "accept" | "dismiss"
    }) => import("effect").Effect.Effect<void>
  } | null
  /**
   * Optional local-shell bridge. When provided, clients may advertise
   * terminal execution capability and receive local-shell request frames
   * from MCP tools bound to the same thread.
   * Pass `null` explicitly in setup-mode (same as absent).
   */
  readonly localShellBridge?: LocalShellBridge | null
  /**
   * Fired when a local-shell client releases its slot — either by sending
   * `local-shell-capability { enabled: false }` or by disconnecting. Used
   * by the chat-server to re-attach its container-sandbox executor so the
   * agent doesn't lose `mcp__local_shell__*` access when an attached CLI
   * disables its own local-shell.
   */
  readonly onLocalShellRelease?: (threadId: string) => void
  /**
   * Optional Survey handle (Phase 3 D3). When provided, the server:
   *   - Pushes a `survey-request` frame after `hello` if a survey is due
   *     (connection-time due-check — fire-and-forget, like account-list).
   *   - Routes inbound `survey-response` frames → submitVerdicts, with
   *     every verdict's `at` pinned to `frame.issuedAt` server-side (D-LOCK-5).
   *
   * Pass the RESOLVED handle (not the Tag) so the server's env stays narrow.
   * Absent = no survey push, no routing (graceful degradation).
   * Pass `null` explicitly in setup-mode (same as absent).
   *
   * NO snooze/dismiss config (Execution Correction #1): dismiss is a client
   * no-op; only answered surveys advance the schedule via getLastSurveyAt.
   */
  readonly survey?: SurveyWsHandle | null
  /**
   * Optional point-at-the-UI feedback sink. When provided, the server:
   *   - Advertises `capabilities.feedback` in the hello frame (Moon shows the
   *     feedback button only when this is true).
   *   - Routes inbound `feedback-submit` frames → `submit`, then unicasts a
   *     `feedback-ack { requestId, ok, message? }` echoing the client's
   *     requestId (mirrors capability-execute-result).
   *
   * Pass the RESOLVED handle (not a Tag) so the server's env stays narrow —
   * mirrors `suggestedActions`. `submit` returns `{ ok, message? }`, which maps
   * straight onto the ack. Absent/`null` = no feedback button, no routing.
   */
  readonly feedbackSink?: {
    readonly submit: (input: {
      readonly note: string
      readonly target?: unknown
      readonly page?: string
      readonly threadId?: string
      readonly appVersion?: string
      readonly appearance?: string
      readonly clientTs?: number
      /** Best-effort base64 PNG (no `data:` prefix) — see FeedbackSubmitFrame.screenshot. */
      readonly screenshot?: string
    }) => import("effect").Effect.Effect<{ readonly ok: boolean; readonly message?: string }>
  } | null
  /**
   * Optional setup-mode pty factory. When provided:
   *   - The server registers an inbound message handler even when chat /
   *     localShellBridge / survey are all null (setup-mode), so the client can
   *     send pty-input and pty-resize frames.
   *   - Per connection, `onConnect` is called with a `send` callback that
   *     pushes `pty-output` frames to the client. The returned handles are used
   *     to forward inbound `pty-input` (→ write) and `pty-resize` (→ resize).
   *   - On ws close, the returned `close` handle is called to tear down the pty.
   *
   * Pass `null` explicitly when not in setup-mode.
   */
  readonly setupPty?: {
    onConnect: (send: (frame: PtyOutputFrame) => void) => {
      write: (utf8: string) => void
      resize: (cols: number, rows: number) => void
      close: () => void
    }
  } | null
  /**
   * Optional Vault service handle (Luna Vault V1). When provided, the server:
   *   - advertises `capabilities.vault: true`
   *   - pushes a `vault-list` frame after `hello` (same fire-and-forget pattern
   *     as `connector-catalog`) so the Vault settings section renders on connect
   *   - routes inbound `vault-put` / `vault-delete` / `vault-sync-config` /
   *     `vault-import` frames; after each mutation sends a `vault-status`
   *     (requestId-correlated) THEN a fresh `vault-list` to the requesting client
   *
   * The handle's `list()` output MUST be wire-safe (VaultWireItem — metadata +
   * opaque pointer refs, never credential values). Structural type — mirrors
   * connectorService / artifactStore. Pass `null` explicitly in setup-mode.
   *
   * SENSITIVE FRAME CONTRACT: `vault-put` and `vault-import` carry credential
   * values. This package NEVER logs the frame payload for those types — only
   * `frame.type` + `frame.requestId` are safe to log. The handle methods receive
   * the full frame for dispatch but are responsible for not leaking values into
   * their returned `message` strings.
   */
  readonly vaultService?: {
    readonly list: () => Promise<ReadonlyArray<import("./protocol.js").VaultWireItem>>
    readonly syncState: () => Promise<import("./protocol.js").VaultSyncWire | null>
    /**
     * Optional tiered-storage status snapshot (W2). A boot-time capability
     * summary (mode/writeTier/probes/envResidue count) attached to every
     * `vault-list` frame so the UI can render one "where secrets land" line.
     * METADATA ONLY - never a name or value. Absent on pre-W2 handles; the
     * server omits the frame field when this returns null.
     */
    readonly storage?: () => import("./protocol.js").VaultStorageWire | null
    readonly put: (
      f: import("./protocol.js").VaultPutFrame,
    ) => Promise<{ readonly ok: boolean; readonly message: string }>
    readonly remove: (
      f: import("./protocol.js").VaultDeleteFrame,
    ) => Promise<{ readonly ok: boolean; readonly message: string }>
    readonly setSyncConfig: (
      f: import("./protocol.js").VaultSyncConfigFrame,
    ) => Promise<{ readonly ok: boolean; readonly message: string }>
    readonly importItems: (
      f: import("./protocol.js").VaultImportFrame,
    ) => Promise<{ readonly ok: boolean; readonly message: string }>
    /**
     * Optional out-of-band change subscription (same contract as
     * skillRegistry.changes): the server registers a `notify` callback and,
     * on each notify, broadcasts a fresh `vault-list` to every connected
     * client. Covers registry changes no client initiated — e.g. the
     * 1Password sync poll loop adopting/removing rows.
     */
    readonly changes?: (notify: () => void) => void
  } | null
  /**
   * Optional handler for the Moon secure-entry `register-op-token` frame.
   * When provided, an inbound `register-op-token` is routed here; the handler
   * validates + persists the 1Password service-account token and resolves to a
   * status the server relays as a `register-op-token-status` frame.
   *
   * The `token` is SENSITIVE: the handler MUST NOT log it or include it in the
   * returned `message`. This package never logs the frame (the unknown-frame
   * path logs only `frame.type`). The handler should never reject — catch
   * internally and resolve `{ok:false, message}`.
   *
   * Resolving `{ok:true}` typically triggers a server restart (so token
   * discovery re-runs); that lifecycle decision belongs to the handler/
   * chat-server, NOT this package. Sequencing is safe: the server sends the
   * status frame from the resolved value, so schedule any restart with a small
   * delay after resolving. Pass `null`/absent to disable (frame ignored).
   */
  readonly registerOpToken?:
    | ((input: {
        readonly label: string
        readonly token: string
      }) => Promise<{ readonly ok: boolean; readonly message: string }>)
    | null
  /**
   * Optional bridge for the Moon agent-summoned secure-secret-entry flow. When
   * provided, the server registers each subscribing client's send-handle (so
   * the `request_secret` tool can reach it), routes inbound `secret-result`
   * frames to `acceptResult`, and signals `notifyTurnComplete` on each
   * `turn-complete` (so the bridge can fire its deferred activation). The
   * secret VALUE never passes through this package's logging — `secret-result`
   * is handed straight to the bridge. Pass `null`/absent to disable.
   */
  readonly secretBridge?: SecretRequestBridge | null
  /**
   * Optional summon-by-name bridge (widget-system.md). When provided, an
   * inbound `widget-directory` frame announces this connection as the
   * widget host; the agent's open_widget tool sends `widget-open` frames
   * back through it. Pass `null`/absent to disable (frames ignored).
   */
  readonly widgetSummoner?: import("./widget-summon-bridge.js").WidgetSummonBridge | null
  /**
   * Optional live subagent-tree bridge (S4 "Agents" panel). When provided
   * alongside `widgetSummoner`, the server folds each thread's
   * `parentToolUseId`-tagged tool frames into a tree, BROADCASTS `subagent-tree`
   * frames to every connection (the read-only Agents panel reads them without
   * subscribing the thread), summons the Agents panel on the first delegation,
   * and answers `subagent-tree-request`. Pass `null`/absent to disable.
   */
  readonly subagentTree?: import("./subagent-tree-bridge.js").SubagentTreeBridge | null
  /**
   * Optional bridge for job-summoned operator input (widget-system.md
   * Phase 5). When provided, the server registers EVERY connection's
   * send-handle with the bridge (broadcast model — a job has no owning
   * thread, so any connected surface may answer) and routes inbound
   * `job-input-result` frames to `acceptResult` with that connection's
   * send-handle as the reply target. The answer value is operator input,
   * not a secret, but it is still never logged by this package — the frame
   * is handed straight to the bridge. Pass `null`/absent to disable.
   */
  readonly jobInputBridge?: import("./job-input-bridge.js").JobInputBridge | null
  /**
   * Optional MCP Apps host (widget-system.md Phase 7, SEP-1865 v1). When
   * provided, the server advertises `capabilities.mcpApps` and routes the two
   * inbound relay frames through it, replying on the SAME connection:
   *   - `mcp-resource-read` → handleResourceRead → `mcp-resource-result`
   *   - `mcp-tool-call`     → handleToolCall     → `mcp-tool-result`
   * Pure request/response (requestId-correlated) — no per-connection
   * registration. The host contract: NEVER rejects; every failure is an
   * `ok:false` reply frame. Tool results are app data and are never logged
   * by this package. Pass `null`/absent to disable (frames ignored).
   */
  readonly mcpAppHost?: import("./mcp-app-host.js").McpAppHost | null
  /**
   * Optional model-routing settings service (PR 1). When provided, the server:
   *   - advertises `capabilities.modelRouting: true`
   *   - sends `model-routing-list` after `hello` with current settings
   *   - routes inbound `model-routing-save`, validates via the store's
   *     validateAndPrepare, persists on success, acks with `model-routing-status`,
   *     and re-broadcasts a fresh `model-routing-list` to all clients.
   *
   * Credential values NEVER cross the wire — only opaque refs. The same
   * scheduleRestart hook is called on save (activation requires restart so
   * the resolver feeds the broker). Structural type — mirrors vaultService.
   * Pass `null`/absent to disable (frames ignored).
   */
  readonly modelRoutingService?: {
    readonly list: () => import("./protocol.js").ModelRoutingListFrame
    readonly save: (input: {
      readonly providers: ReadonlyArray<import("./protocol.js").ProviderSettingsItem>
      readonly roleBindings: ReadonlyArray<import("./protocol.js").RoleBindingItem>
    }) => { readonly ok: boolean; readonly message: string }
    /** Called after a successful save so activation (restart) is scheduled. */
    readonly scheduleRestart?: () => void
  } | null
  /**
   * Optional absolute path to the pre-built SPA directory to serve statically.
   * When set, GET/HEAD requests that are not /healthz, /readyz, or the WS path
   * are handled by a built-in static file server (no extra deps — native node:http
   * + node:fs only). Absent → current behavior (all non-special paths → 404).
   *
   * Security: path-traversal protection via path.resolve + prefix-assert.
   * SPA fallback: dotless paths → index.html; dotted-missing → 404.
   * Cache-Control: /assets/** → immutable; everything else → no-cache.
   *
   * Set ONLY in normal-mode. Never set in setup-mode or tests that don't
   * need static serving.
   */
  readonly staticRoot?: string
}

export interface UIWebSocketServerHandle {
  /** Resolved listening port (useful when port: 0). */
  readonly port: number
  /** Bound host. */
  readonly host: string
}

/**
 * Defence-in-depth for the skill catalog: pick EXACTLY the wire fields.
 * The chat-server adapter already strips `body`, but the config slot's
 * structural type cannot prevent a future caller wiring the raw core
 * registry (extra fields are structurally assignable) — so this package
 * re-projects every entry before serialization. A skill body can only
 * reach a client if BOTH layers regress.
 */
const toWireSkill = (
  s: import("./protocol.js").SkillCatalogItem,
): import("./protocol.js").SkillCatalogItem => ({
  id: s.id,
  name: s.name,
  description: s.description,
  whenToUse: s.whenToUse,
  category: s.category,
  tags: s.tags,
  source: s.source,
  enabled: s.enabled,
})

/**
 * Short, non-sensitive failure text for status acks. Prefers the typed
 * failure's `.message`; defects collapse to a generic line (a stack trace
 * is not a UI message, and must never leak internals to clients).
 */
const failureMessage = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.failureOption(cause)
  if (Option.isSome(failure)) {
    const f = failure.value
    if (typeof f === "object" && f !== null && "message" in f) {
      const m = (f as { message?: unknown }).message
      if (typeof m === "string" && m.length > 0) return m
    }
    if (typeof f === "string") return f
  }
  return "request failed"
}

const send = (ws: WebSocket, frame: ServerFrame): void => {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(JSON.stringify(frame))
  } catch {
    // Best-effort send — connection will close via the error/close handler.
  }
}

/**
 * Validate inbound user-message attachments. The wire types narrow `mediaType`
 * to a literal union, but a malicious client can send arbitrary strings — TS
 * types don't run at runtime. Reject anything that isn't an allow-listed
 * image type, oversized payload, or non-string data. Returns a human-readable
 * error message on failure, or null on success.
 *
 * Limits live in @luna/core attachment-limits.ts — the single source of truth
 * shared with every other inbound surface (e.g. the Telegram channel adapter).
 */
const validateAttachments = (
  atts: ReadonlyArray<{ readonly mediaType?: unknown; readonly data?: unknown }> | undefined,
): string | null => {
  if (!atts || atts.length === 0) return null
  if (atts.length > MAX_ATTACHMENTS_PER_TURN) {
    return `too many attachments: ${atts.length} (max ${MAX_ATTACHMENTS_PER_TURN})`
  }
  let totalBytes = 0
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i]!
    if (typeof a.mediaType !== "string" || !ALLOWED_ATTACH_MEDIA_TYPES.has(a.mediaType)) {
      return `attachment[${i}]: unsupported mediaType: ${String(a.mediaType)}`
    }
    if (typeof a.data !== "string" || a.data.length === 0) {
      return `attachment[${i}]: missing or invalid data`
    }
    // base64 decoded size ≈ length * 3/4. Use a fast bound check rather
    // than actually decoding (avoids allocating the buffer just to size it).
    const approxBytes = Math.floor(a.data.length * 3 / 4)
    const cap = a.mediaType === "application/pdf" ? MAX_PDF_RAW_BYTES : MAX_IMAGE_RAW_BYTES
    if (approxBytes > cap) {
      return `attachment[${i}]: too large (${approxBytes} bytes; max ${cap})`
    }
    totalBytes += approxBytes
  }
  if (totalBytes > MAX_TURN_RAW_BYTES) {
    return `attachments total too large (${totalBytes} bytes; max ${MAX_TURN_RAW_BYTES})`
  }
  return null
}

// ── Static file serving ───────────────────────────────────────────────────────
// Dependency-free (node:http + node:fs + node:path only) static handler for the
// built SPA. Activated only when UIWebSocketServerConfig.staticRoot is provided.
//
// Security invariant: path-traversal protection via path.resolve + prefix-assert.
//   path.normalize/join are NOT sufficient (they don't collapse ../ past the root).
//   We decode the URL, reject null bytes, resolve the absolute target, and assert
//   it is still within staticRoot before any fs call.
//
// SPA history fallback:
//   - Path with NO file extension (no dot in last segment) → serve index.html (200).
//     Covers /dashboard, /settings/accounts, etc.
//   - Path WITH extension and file MISSING → 404. Never serve index.html as a fake
//     asset (that confuses browsers into treating a text/html as a .js module).
//
// Cache-Control:
//   - /assets/<name>-<hash>.<ext> → public, max-age=31536000, immutable
//     (Vite content-hashes all assets under /assets/).
//   - index.html and all other paths → no-cache (always revalidate).
//
// HEAD: same headers as GET, no body. Content-Length is set from stat() for GET.

const MIME_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
}

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return MIME_MAP[ext] ?? "application/octet-stream"
}

function serveStatic(
  staticRoot: string,
  wsPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  // Normalise the root to an absolute, separator-trimmed path. Operator-supplied
  // env vars (LUNA_UI_WEB_STATIC_ROOT) may be relative or carry a trailing slash;
  // without this the `startsWith(root + path.sep)` prefix-assert below would reject
  // every request when the root ends in a separator.
  const root = path.resolve(staticRoot)
  // Parse just the pathname (strip query string / fragment).
  // Note: node:http already normalises path traversal sequences (/../../../ → /)
  // before our handler sees req.url, so /../../../etc/passwd arrives as /etc/passwd.
  // Our path.resolve + prefix-assert below is a belt-and-suspenders guard for any
  // edge cases the normalisation does not cover (e.g., null bytes, unusual encodings).
  let rawPathname: string
  try {
    rawPathname = new URL(req.url ?? "/", "http://x").pathname
  } catch {
    res.writeHead(400)
    res.end()
    return
  }

  // Decode percent-encoding. Reject null bytes (null-byte injection).
  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(rawPathname)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (decodedPathname.includes("\0")) {
    res.writeHead(400)
    res.end()
    return
  }

  // Security: resolve to absolute path and assert it stays within the root.
  // path.resolve collapses ../ sequences; the prefix-assert rejects traversals.
  const resolved = path.resolve(root, "." + decodedPathname)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    // Path traversal attempt — respond 404 (not 403, to avoid revealing root existence).
    res.writeHead(404)
    res.end()
    return
  }

  // Also defensively skip the WS path (already handled above, but belt-and-suspenders).
  if (decodedPathname === wsPath) {
    res.writeHead(404)
    res.end()
    return
  }

  // Determine the last path segment for extension detection.
  const lastSegment = decodedPathname.split("/").pop() ?? ""
  const hasDot = lastSegment.includes(".")

  // Check if the resolved path exists as a file.
  let stat: fs.Stats | null = null
  try {
    stat = fs.statSync(resolved)
  } catch {
    stat = null
  }

  // Determine which file to serve.
  let filePath: string
  if (stat !== null && stat.isFile()) {
    // File exists — serve it directly.
    filePath = resolved
  } else if (!hasDot) {
    // No extension → SPA navigation route → fall back to index.html.
    filePath = path.join(root, "index.html")
  } else {
    // Extension present but file missing → 404 (do NOT serve index.html as a fake asset).
    res.writeHead(404)
    res.end()
    return
  }

  // Stat the actual file to get Content-Length.
  let fileStat: fs.Stats
  try {
    fileStat = fs.statSync(filePath)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }

  if (!fileStat.isFile()) {
    res.writeHead(404)
    res.end()
    return
  }

  // Cache-Control: content-hashed assets under <root>/assets/ are immutable.
  // Everything else — including the index.html SPA fallback (which a dotless
  // request like `/assets/` would otherwise hit) — must always revalidate.
  // Keyed off the file actually served, NOT the request path, so a fallback to
  // index.html never inherits an immutable header.
  const assetsPrefix = path.join(root, "assets") + path.sep
  const cacheControl = filePath.startsWith(assetsPrefix)
    ? "public, max-age=31536000, immutable"
    : "no-cache"

  const contentType = mimeFor(filePath)
  const headers: Record<string, string | number> = {
    "content-type": contentType,
    "cache-control": cacheControl,
    "content-length": fileStat.size,
  }

  if (req.method === "HEAD") {
    res.writeHead(200, headers)
    res.end()
    return
  }

  // Stream the file. Defer the 200 until the stream actually opens, so an open
  // error (file raced away, permission) still yields a real status: ENOENT → 404,
  // anything else → 500. A mid-stream error after the 200 is committed can only
  // destroy the socket (status already sent).
  const stream = fs.createReadStream(filePath)
  stream.on("error", (err) => {
    if (!res.headersSent) {
      const code = (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500
      res.writeHead(code)
      res.end()
    } else {
      res.destroy()
    }
  })
  stream.on("open", () => {
    res.writeHead(200, headers)
    stream.pipe(res)
  })
}

/**
 * Start a UIWebSocketServer. Returns a handle inside a Scope.
 *
 * The server forks all per-connection forwarders into THIS server's scope,
 * so closing the scope closes every connection deterministically.
 */
export const startUIWebSocketServer = (
  config: UIWebSocketServerConfig,
): Effect.Effect<UIWebSocketServerHandle, Error, Scope.Scope | UIService> =>
  Effect.gen(function* () {
    if (!config.token || config.token.length < 16) {
      return yield* Effect.fail(
        new Error(
          "ui-ws: refusing to start — token must be set and ≥ 16 chars",
        ),
      )
    }

    const ui = yield* UIService
    const host = config.host ?? "127.0.0.1"
    const port = config.port ?? 4753
    const path = config.path ?? "/ui"
    const cap = config.perConnectionCapacity ?? 256
    const pingMs = config.pingIntervalMs ?? 30_000
    const kindsList: ReadonlyArray<string> = config.advertisedKinds ?? []
    const chat = config.chatService ?? null
    const localShellBridge = config.localShellBridge ?? null
    const survey = config.survey ?? null
    const setupPty = config.setupPty ?? null
    const registerOpToken = config.registerOpToken ?? null
    const widgetSummoner = config.widgetSummoner ?? null
    const subagentTree = config.subagentTree ?? null
    const secretBridge = config.secretBridge ?? null
    const jobInputBridge = config.jobInputBridge ?? null
    const mcpAppHost = config.mcpAppHost ?? null
    const skillRegistry = config.skillRegistry ?? null
    const capabilityRegistry = config.capabilityRegistry ?? null
    const threadArchiveNotifier = config.threadArchiveNotifier ?? null
    const connectorService = config.connectorService ?? null
    const artifactStore = config.artifactStore ?? null
    const workflowGallery = config.workflowGallery ?? null
    const suggestedActions = config.suggestedActions ?? null
    const vaultService = config.vaultService ?? null
    const modelRoutingService = config.modelRoutingService ?? null
    const feedbackSink = config.feedbackSink ?? null
    const staticRoot = config.staticRoot
    const buildSha = config.buildSha
    const serverVersion = config.serverVersion
    const availableModels = config.availableModels
    const getSchedulerHealth = config.getSchedulerHealth
    const strictSchedulerReady = config.strictSchedulerReady === true
    // One server-owned Module shares Git work across every connection/thread.
    // Its Interface hides async process execution, freshness, single-flight,
    // and graceful degradation from the WebSocket routing Implementation.
    const smartBarContext = createSmartBarContextModule()

    const httpServer = http.createServer((req, res) => {
      // Match on the pathname only — req.url includes the query string, so an
      // exact `=== "/healthz"` would miss `/healthz?x` and (with staticRoot on)
      // fall through to the SPA handler instead of the intended endpoint.
      const reqPath = (req.url ?? "/").split("?")[0]
      if (reqPath === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("ok")
        return
      }
      if (reqPath === "/readyz") {
        // Deeper-than-liveness readiness (#28): distinguishes a NORMAL chat server
        // from a SETUP-mode server (which also answers /healthz 200). The mode is
        // derived from the boot config — chat-server starts setup-mode with
        // `setupPty` set + `chatService: null`, and normal-mode with `chatService`
        // set. credentialOk tracks normal mode (only reached past the boot-time
        // credential gate). Additive: /healthz keeps returning "ok" for liveness
        // consumers; this endpoint is what luna-update-server's gate inspects.
        const mode = setupPty != null ? "setup" : "normal"
        let scheduler: ReturnType<NonNullable<typeof getSchedulerHealth>> | undefined
        if (getSchedulerHealth) {
          try {
            const snap = getSchedulerHealth()
            if (snap != null) scheduler = snap
          } catch {
            // Health probe must never take down /readyz — omit field on throw.
          }
        }
        // Report-only by default: top-level status stays "ok" so deploy gates
        // and chat readiness are not flapped by a degraded scheduler. Opt-in
        // strictSchedulerReady flips top-level status to "degraded" (HTTP 200).
        const topStatus =
          strictSchedulerReady && scheduler?.status === "degraded"
            ? "degraded"
            : "ok"
        res.writeHead(200, { "content-type": "application/json" })
        // `buildSha` / `serverVersion` / `scheduler` are additive: included only
        // when the caller threaded them in. Absent → field omitted.
        res.end(
          JSON.stringify({
            status: topStatus,
            mode,
            credentialOk: mode === "normal",
            ...(buildSha !== undefined ? { buildSha } : {}),
            ...(serverVersion !== undefined ? { serverVersion } : {}),
            ...(scheduler !== undefined ? { scheduler } : {}),
          }),
        )
        return
      }
      if (reqPath === path) {
        // GET on the WS path without upgrade headers → 426.
        res.writeHead(426, { "content-type": "text/plain" })
        res.end("upgrade required")
        return
      }
      // ── Opt-in static file serving ────────────────────────────────────────
      // Only active when staticRoot is provided (normal-mode with a built dist/).
      // /healthz, /readyz, and the WS path are matched above — never reached here.
      if (staticRoot && (req.method === "GET" || req.method === "HEAD")) {
        serveStatic(staticRoot, path, req, res)
        return
      }
      res.writeHead(404)
      res.end()
    })

    // Cap inbound message size. Base-limit was 64KB for text-only frames.
    // Images downscale client-side, but PDFs ride through whole — a turn can
    // carry up to ~20MB decoded (≈27MB base64) plus JSON, so we raise to 32MB
    // (matching the Anthropic 32MB request ceiling; validateAttachments is the
    // real gate). Still below the ws default (100MB). Oversize frames close
    // with 1009; the UI validates pre-flight so hitting this is exceptional.
    const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })

    // Constant-time string compare for the auth check. The token is short
    // (≥16 chars) and the listener is 127.0.0.1-bound, so timing-attack
    // exposure is small — but free to add and avoids the early-exit `===`
    // pattern in case of future remote-binding mistakes.
    const tokenEq = (a: string, b: string): boolean => {
      if (a.length !== b.length) return false
      let diff = 0
      for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
      }
      return diff === 0
    }

    // Auth + upgrade gate.
    // Browsers can't set custom headers on WebSocket upgrades, so we accept
    // EITHER `Authorization: Bearer <token>` (Node clients) OR a `?token=`
    // query-string parameter (browser clients). Same token, both forms.
    //
    // Audit hardening: log failed auth attempts (source IP + no token material)
    // so ops can detect brute-force or misconfigured clients. Also emit a
    // one-time-per-source console.log on the FIRST successful connect from each
    // unique IP (de-duplication avoids log spam from long-lived Moon reconnects).
    const _firstConnectSeen = new Set<string>()

    httpServer.on("upgrade", (req, socket, head) => {
      const rawUrl = req.url ?? ""
      // Strip query string for path match.
      const qIdx = rawUrl.indexOf("?")
      const pathOnly = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx)
      if (pathOnly !== path) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n")
        socket.destroy()
        return
      }
      // Try header first (Node clients).
      const auth = req.headers["authorization"]
      let ok = typeof auth === "string" && auth.startsWith("Bearer ") &&
        tokenEq(auth.slice(7), config.token)
      if (!ok) {
        // Fall back to query-string token (browser clients).
        try {
          const u = new URL(rawUrl, "http://placeholder")
          const qToken = u.searchParams.get("token")
          if (qToken !== null && tokenEq(qToken, config.token)) {
            ok = true
          }
        } catch {
          // ignore — invalid URL → fail closed
        }
      }
      if (!ok) {
        // Audit finding: log failed auth — IP only, no token material.
        const srcIp = (socket as { remoteAddress?: string }).remoteAddress ?? "unknown"
        console.warn(`[ui-ws] auth failed — 401 sent to ${srcIp}`)
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
        socket.destroy()
        return
      }
      // First-successful-connect notice per source IP (one-time, de-duped).
      const connIp = (socket as { remoteAddress?: string }).remoteAddress ?? "unknown"
      if (!_firstConnectSeen.has(connIp)) {
        _firstConnectSeen.add(connIp)
        console.log(`[ui-ws] first connect from ${connIp}`)
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req)
      })
    })

    // Track active sockets so we can close them on shutdown.
    const activeFibers = yield* Ref.make<ReadonlyArray<Fiber.RuntimeFiber<unknown, unknown>>>([])
    const activeSockets = yield* Ref.make<ReadonlyArray<WebSocket>>([])

    // Capture the surrounding runtime — connection handlers run via this
    // runtime so they share the UIService PubSub etc.
    const runtime = yield* Effect.runtime<UIService>()

    // PRD Part B: out-of-band catalog changes (user-skills hot-load) →
    // broadcast a fresh skill-catalog to every connected client. The toggle
    // path broadcasts inline; this hook covers changes no client initiated.
    if (skillRegistry !== null && skillRegistry.changes !== undefined) {
      const reg = skillRegistry
      const registerChanges = skillRegistry.changes
      registerChanges(() => {
        Runtime.runFork(runtime)(
          Effect.gen(function* () {
            const skills = yield* reg.catalog()
            const wire = skills.map(toWireSkill)
            const sockets = yield* Ref.get(activeSockets)
            for (const sock of sockets) {
              send(sock, { type: "skill-catalog", skills: wire })
            }
          }).pipe(Effect.catchAllCause(() => Effect.void)),
        )
      })
    }

    // 14-day auto-archive (server-side policy, no client request) → broadcast a
    // `thread-archived` frame for each auto-archived id to every connected
    // client. The client's thread-archived handler clears + re-lists if the
    // archived thread was the one on screen, so an actively-viewed thread
    // recovers gracefully instead of silently going stale. Mirrors the
    // skill-catalog/artifact changes hooks above.
    if (
      threadArchiveNotifier !== null &&
      threadArchiveNotifier.changes !== undefined
    ) {
      const registerArchiveChanges = threadArchiveNotifier.changes
      registerArchiveChanges((threadIds) => {
        Runtime.runFork(runtime)(
          Effect.gen(function* () {
            const sockets = yield* Ref.get(activeSockets)
            for (const sock of sockets) {
              for (const threadId of threadIds) {
                send(sock, { type: "thread-archived", threadId })
              }
            }
          }).pipe(Effect.catchAllCause(() => Effect.void)),
        )
      })
    }

    // PRD Part C/W1: out-of-band artifact changes (an agent edits a pinned
    // artifact — W4) → broadcast a fresh artifact-list to every client. The
    // pin/unpin paths broadcast inline; this hook covers agent-side edits.
    if (artifactStore !== null && artifactStore.changes !== undefined) {
      const store = artifactStore
      const registerArtifactChanges = artifactStore.changes
      registerArtifactChanges(() => {
        Runtime.runFork(runtime)(
          Effect.gen(function* () {
            const artifacts = yield* store.list()
            const sockets = yield* Ref.get(activeSockets)
            for (const sock of sockets) {
              send(sock, { type: "artifact-list", artifacts })
            }
          }).pipe(Effect.catchAllCause(() => Effect.void)),
        )
      })
    }

    // Luna Vault V3: out-of-band registry changes (the 1Password sync poll
    // loop adopting/refreshing/removing rows) → broadcast a fresh vault-list
    // to every client. The mutation paths broadcast inline; this hook covers
    // changes no client initiated. Wire-safe by construction — `list()` is
    // the same metadata/pointer projection the inline path uses.
    if (vaultService !== null && vaultService.changes !== undefined) {
      const vsvc = vaultService
      const registerVaultChanges = vaultService.changes
      registerVaultChanges(() => {
        Runtime.runFork(runtime)(
          Effect.gen(function* () {
            const items = yield* Effect.promise(() => vsvc.list())
            const sync = yield* Effect.promise(() => vsvc.syncState())
            const storage = vsvc.storage?.() ?? null
            const sockets = yield* Ref.get(activeSockets)
            for (const sock of sockets) {
              send(sock, {
                type: "vault-list",
                items,
                ...(sync !== null ? { sync } : {}),
                ...(storage !== null ? { storage } : {}),
              })
            }
          }).pipe(Effect.catchAllCause(() => Effect.void)),
        )
      })
    }

    // #124: background-delivery notifications → broadcast a "Luna finished X"
    // toast to EVERY connected client. Unlike the per-thread chat frames
    // (which reach only that thread's subscribers via subscribe), this rides
    // ChatService.deliveries so the result surfaces even when its thread is not
    // the one on screen. The result message itself still lands in the thread
    // via the normal assistant-done path (carrying ChatMessage.delivery).
    // Forked into the SERVER SCOPE (not detached) so the consumer is
    // interrupted deterministically on server teardown — mirroring the
    // connector-refresh loop's `Effect.forkScoped`. (The nearby `.changes`
    // hooks use Runtime.runFork because they run inside synchronous notify
    // callbacks; this one is a long-lived runForEach in the gen body.)
    if (chat !== null) {
      yield* Effect.forkScoped(
        chat.deliveries.pipe(
          Stream.runForEach((n: DeliveryNotification) =>
            Effect.gen(function* () {
              const sockets = yield* Ref.get(activeSockets)
              for (const sock of sockets) {
                send(sock, {
                  type: "result-delivered",
                  threadId: n.threadId,
                  source: n.source,
                  label: n.label,
                  preview: n.preview,
                  ts: n.ts,
                })
              }
            }),
          ),
          Effect.catchAllCause(() => Effect.void),
        ),
      )
    }

    // The connection-handler effect: it OWNS its own scope (so we can use
    // addFinalizer for queue cleanup) but lives until the ws closes —
    // which we signal via a Deferred resolved from the ws "close" handler.
    const handleConnection = (
      ws: WebSocket,
    ): Effect.Effect<void, never, UIService | Scope.Scope> =>
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>()
        // Capture the connection scope so chat-router fibers can be
        // forked into it (NOT the per-message handler's transient
        // scope). When the connection closes, the connection scope
        // closes, and every chat forwarder fiber is interrupted with it.
        const connectionScope = yield* Effect.scope

        // Track for shutdown.
        yield* Ref.update(activeSockets, (xs) => [...xs, ws])
        yield* Effect.addFinalizer(() =>
          Ref.update(activeSockets, (xs) => xs.filter((x) => x !== ws)),
        )

        const stream = yield* ui.subscribe

        send(ws, {
          type: "hello",
          protocolVersion: UI_WS_PROTOCOL_VERSION,
          kinds: kindsList,
          // Additive build identity (no protocol bump). Conditional-spread so
          // an absent buildSha leaves the field off entirely — older clients
          // ignore it; newer clients against an old server simply see nothing.
          ...(buildSha !== undefined ? { buildSha } : {}),
          // Additive server semver (no protocol bump). Same pattern as buildSha:
          // threaded in from chat-server.ts; absent on older/setup-mode servers.
          ...(serverVersion !== undefined ? { serverVersion } : {}),
          // Additive model list (no protocol bump). When provided, the client
          // uses this list for its model-switcher dropdown instead of its own
          // hardcoded default. Absent on older/setup-mode servers — clients
          // fall back gracefully (see HelloFrame.availableModels in protocol.ts).
          ...(availableModels !== undefined ? { availableModels } : {}),
          // Additive server descriptor (no protocol bump). Built fresh per connection
          // so issuedAt and generation are always current. Mirrors the serverVersion
          // additive pattern — conditional-spread so it's omitted on older/setup paths
          // that don't provide the inputs. Older clients ignore it entirely.
          ...((() => {
            // NOTE: `isLoopback` and `timerAllowed` are intentionally NOT passed here.
            // The `administer` capability therefore remains conservatively denied for all
            // connections — which is the correct and safe default. Raw socket-loopback
            // cannot be used as the operator-identity signal: this server runs inside an
            // incus container, so all external connections arrive via the incusd :4753 proxy
            // and would appear loopback to the process, wrongly granting administer.
            // Wire these fields only as part of Phase-2 C9 (trust/token authz work).
            const descriptor = projectLunaDescriptor({
              ...(config.serverName !== undefined ? { serverName: config.serverName } : {}),
              ...(serverVersion !== undefined || buildSha !== undefined ? { version: serverVersion ?? buildSha } : {}),
              port,
              credentialOk: setupPty == null,
              setupMode: setupPty != null,
              caps: {
                chat: chat !== null,
                localShell: localShellBridge !== null,
                skills: skillRegistry !== null,
                connectors: connectorService !== null,
                artifacts: artifactStore !== null,
                workflows: workflowGallery !== null,
                suggestedActions: suggestedActions !== null,
                vault: vaultService !== null,
                mcpApps: mcpAppHost !== null,
                effortSelection: chat !== null,
                subagents: chat !== null,
                modelRouting: modelRoutingService !== null,
              },
            })
            return { descriptor }
          })()),
          // Capabilities reflect what was bound at startup. When a
          // ChatService is passed in `config.chatService`, the inbound
          // router below handles subscribe/send/interrupt and translates
          // ChatFrame → ServerFrame. Without it, the server is obs-only.
          capabilities: {
            chat: chat !== null,
            streamingDeltas: chat !== null,
            localShell: localShellBridge !== null,
            // setup-mode = started without a chat service
            setup: chat === null,
            // Emits `turn-complete` on the SDK `result` whenever chat is bound.
            // Lets grouping clients (the moon timeline) detect this server can
            // signal end-of-agentic-turn and enable the grouped/settling view.
            turnComplete: chat !== null,
            // PRD Part B: skill catalog + toggle routing available. Clients
            // gate the Skills settings tab on this flag (absent on older
            // servers → tab hidden, no errors).
            skills: skillRegistry !== null,
            // PRD Part A: connector catalog + the client-brokered OAuth
            // handshake available. Same additive gating as skills.
            connectors: connectorService !== null,
            // PRD Part C/W1: pinned-artifact persistence + pin/unpin routing.
            // Clients gate the panel's "Pinned" section on this flag.
            artifacts: artifactStore !== null,
            // PRD Part C/W3: read-only workflow gallery over the jobs store.
            workflows: workflowGallery !== null,
            suggestedActions: suggestedActions !== null,
            // Luna Vault (V1): credential registry + put/delete/sync routing.
            // Clients hide the Vault section when absent/false.
            vault: vaultService !== null,
            // MCP Apps host relay (widget-system.md Phase 7): ui:// resource
            // reads + same-app tool calls route through the bound McpAppHost.
            mcpApps: mcpAppHost !== null,
            // Model+effort switcher: server accepts set-thread-config and has
            // pre-computed the effort-validity matrix in availableModels.efforts.
            // Clients hide effort controls when absent/false.
            effortSelection: chat !== null,
            // Subagents: chat threads can spawn SDK Task subagents; tool
            // frames carry the additive parentToolUseId linkage (this is the
            // cap's documented meaning, independent of the live Agents panel).
            // In this server chat is always co-wired with the subagentTree
            // bridge, so the Agents panel's broadcasts are always available when
            // this cap is true; a hypothetical chat-without-bridge embedding is
            // not a code path here.
            subagents: chat !== null,
            // Model-routing settings (PR 1): operator-configured provider/model
            // preferences. Clients gate the Models settings tab on this flag.
            modelRouting: modelRoutingService !== null,
            // Capability layer: backend-advertised commands available — the
            // server sends a capability-catalog after hello and routes
            // capability-execute. Clients fall back to built-in commands when
            // absent/false.
            commands: capabilityRegistry !== null,
            // Point-at-the-UI feedback: a feedbackSink is bound — the server
            // accepts `feedback-submit` and replies `feedback-ack`. Clients
            // hide the feedback button when absent/false so no frame is sent.
            feedback: feedbackSink !== null,
          },
        })

        // Send account-list immediately after hello so the client can
        // populate the account-switcher dropdown on connect. Fire-and-
        // forget via runFork — connection setup must not block on OP
        // resolution.
        if (config.accountBroker) {
          const broker = config.accountBroker
          Effect.runFork(
            Effect.flatMap(broker.list("anthropic"), (accounts) =>
              Effect.sync(() => {
                send(ws, { type: "account-list", accounts })
              }),
            ),
          )
        }

        // Send skill-catalog immediately after hello so the Skills settings
        // tab can render on connect. Same fire-and-forget pattern as
        // account-list; a catalog failure must not block connection setup.
        if (skillRegistry !== null) {
          const reg = skillRegistry
          Effect.runFork(
            Effect.flatMap(reg.catalog(), (skills) =>
              Effect.sync(() => {
                send(ws, { type: "skill-catalog", skills: skills.map(toWireSkill) })
              }),
            ),
          )
        }

        // Send capability-catalog immediately after hello so the client can
        // render backend-advertised commands on connect. Pushed to the NEW
        // socket only — same fire-and-forget pattern as skill-catalog; a
        // catalog failure must not block connection setup.
        if (capabilityRegistry !== null) {
          const capReg = capabilityRegistry
          Effect.runFork(
            Effect.flatMap(capReg.catalog(), (catalog) =>
              Effect.sync(() => {
                send(ws, { type: "capability-catalog", catalog })
              }),
            ).pipe(
              // A swallowed defect here leaves the client believing the server supports
              // commands (hello said so) while no catalog ever arrives. Log it like the
              // per-message handler backstop instead of failing silently.
              Effect.tapErrorCause((c) =>
                Effect.sync(() => console.error("[ui-ws] capability-catalog send defect:", Cause.pretty(c))),
              ),
            ),
          )
        }

        // Connector catalog + current instances, same pattern (PRD A §18).
        if (connectorService !== null) {
          const svc = connectorService
          Effect.runFork(
            Effect.gen(function* () {
              const connectors = yield* svc.catalog()
              const instances = yield* svc.list()
              send(ws, { type: "connector-catalog", connectors })
              send(ws, { type: "connector-list", instances })
            }).pipe(Effect.catchAllCause(() => Effect.void)),
          )
        }

        // Pinned artifacts, same fire-and-forget pattern (PRD C/W1 §18) — the
        // artifact panel's "Pinned" section renders from this on connect.
        if (artifactStore !== null) {
          const store = artifactStore
          Effect.runFork(
            Effect.flatMap(store.list(), (artifacts) =>
              Effect.sync(() => {
                send(ws, { type: "artifact-list", artifacts })
              }),
            ).pipe(Effect.catchAllCause(() => Effect.void)),
          )
        }

        // Workflow gallery, same fire-and-forget pattern (PRD C/W3) — the
        // "Workflows" view renders from this on connect.
        if (workflowGallery !== null) {
          const gallery = workflowGallery
          Effect.runFork(
            Effect.flatMap(gallery.list(), (workflows) =>
              Effect.sync(() => {
                send(ws, { type: "workflow-list", workflows })
              }),
            ).pipe(Effect.catchAllCause(() => Effect.void)),
          )
        }

        // Model-routing settings, same fire-and-forget pattern (PR 1) — the
        // Models settings tab renders from this on connect. Contains metadata +
        // opaque refs only; no credential values cross the wire.
        if (modelRoutingService !== null) {
          const mrSvc = modelRoutingService
          Effect.runFork(
            Effect.sync(() => {
              const listFrame = mrSvc.list()
              send(ws, listFrame)
            }).pipe(Effect.catchAllCause(() => Effect.void)),
          )
        }

        // Vault registry, same fire-and-forget pattern (Luna Vault V1) — the
        // Vault settings section renders from this on connect. Contains
        // metadata + opaque pointers only; no credential values cross the wire.
        if (vaultService !== null) {
          const vsvc = vaultService
          Effect.runFork(
            Effect.promise(async () => {
              const items = await vsvc.list()
              const sync = await vsvc.syncState()
              const storage = vsvc.storage?.() ?? null
              send(ws, {
                type: "vault-list",
                items,
                ...(sync !== null ? { sync } : {}),
                ...(storage !== null ? { storage } : {}),
              })
            }).pipe(Effect.catchAllCause(() => Effect.void)),
          )
        }

        // Phase 3 D3 (D-LOCK-1) + long-lived-client survey poller.
        //
        // At connect time, push a survey check-in if one is due (the original
        // Phase 3 D3 behavior). THEN keep checking every
        // `surveyPollIntervalMs` (default 60s) for the lifetime of this
        // connection, so a survey that becomes due MID-SESSION still reaches
        // the operator without a reconnect.
        //
        // Why this matters: the TUI works fine without a poller because every
        // `luna chat` invocation creates a fresh connection (the connect-time
        // check fires every time). The Moon desktop client, by contrast,
        // stays connected for hours/days — without the poller, anything the
        // nightly dream-cron proposes is invisible until the operator
        // restarts Moon. See the dream/survey feedback-loop notes in the
        // luna workspace's processes.
        //
        // Dedup: `lastSentIssuedAt` is per-connection state. We only push
        // when `pending.issuedAt` differs from the last value we sent — so
        // the operator does not see the same panel rebuild on every tick
        // while they're still answering the current one. The client treats
        // the panel as idempotent on issuedAt anyway (PR #36's
        // SurveyEngine.show replaces the active panel only if the new
        // issuedAt differs).
        //
        // Scope: both fibers are forked into the connection scope via
        // Effect.fork, so closing the connection interrupts them. No
        // detached `Effect.runFork` here — that would let the poller
        // outlive its ws.
        //
        // Errors: pendingSurvey failures (alignment-store IO, etc.) collapse
        // to Effect.void via catchAllCause. A transient backend hiccup must
        // never tear down the connection or stop future ticks.
        if (survey !== null) {
          const s = survey
          let lastSentIssuedAt = 0

          const checkAndPush = Effect.gen(function* () {
            const pending = yield* s.pendingSurvey(Date.now())
            if (pending !== null && pending.issuedAt !== lastSentIssuedAt) {
              send(ws, {
                type: "survey-request",
                surveyId: `survey-${pending.issuedAt}`,
                issuedAt: pending.issuedAt,
                items: pending.items,
              })
              lastSentIssuedAt = pending.issuedAt
            }
          }).pipe(Effect.catchAllCause(() => Effect.void))

          // 1. Immediate connect-time check (preserves Phase 3 D3 latency).
          yield* Effect.fork(checkAndPush)

          // 2. Recurring re-check. 0 disables the poller (tests / setup-mode
          //    use this); otherwise we re-check on a fixed cadence for the
          //    lifetime of the connection scope. `Schedule.spaced` waits
          //    the interval BEFORE the first repeat, so the recurring fiber
          //    never duplicates the immediate check above on the same tick.
          const surveyPollMs = config.surveyPollIntervalMs ?? 60_000
          if (surveyPollMs > 0) {
            yield* Effect.fork(
              checkAndPush.pipe(
                Effect.repeat(Schedule.spaced(Duration.millis(surveyPollMs))),
              ),
            )
          }
        }

        // Setup-mode pty: start the pty for this connection when configured.
        // The factory hands us write/resize/close handles; we give it a send
        // callback so it can stream pty-output frames to this client.
        // setupHandle is kept in the per-connection closure so the inbound
        // message handler (pty-input / pty-resize) and the teardown finalizer
        // can reach it without any shared mutable state outside the connection.
        let setupHandle:
          | {
              write: (utf8: string) => void
              resize: (cols: number, rows: number) => void
              close: () => void
            }
          | undefined
        if (setupPty != null) {
          try {
            setupHandle = setupPty.onConnect((frame) => send(ws, frame))
          } catch (e) {
            console.error("[setup-pty] failed to start:", e)
          }
        }
        // Tear the pty down via a connection-scope finalizer (mirrors the
        // localShellBridge finalizer below). This covers ALL teardown paths —
        // normal ws close, server-shutdown scope interrupt, and defects —
        // without manual ws.on("close"/"error") handling. close() is idempotent.
        if (setupHandle != null) {
          yield* Effect.addFinalizer(() => Effect.sync(() => setupHandle?.close()))
        }

        // Per-connection chat state.
        //   - `chatFibers`: forwarder fibers, one per subscribed threadId.
        //     Interrupting the fiber releases the underlying PubSub
        //     subscription via Stream.unwrapScoped (chat-service.ts:444).
        //   - The connection's Effect.scoped wrapper owns these fibers,
        //     and we install a finalizer that interrupts the lot on
        //     close — belt-and-suspenders against any case where an
        //     individual fiber misses its cancel signal.
        const chatFibers = yield* Ref.make<
          ReadonlyMap<string, Fiber.RuntimeFiber<unknown, unknown>>
        >(new Map())
        // Per-connection mutex for subscribeChatThread. The map check + fiber
        // fork + Ref.update is NOT atomic against a `Ref<Map<...>>`; without
        // serialization, two concurrent subscribeChatThread(t) calls (e.g.
        // server auto-subscribe from `new-thread` racing with the client's
        // explicit `subscribe` frame fired from its `thread-created`
        // handler) can BOTH pass the `m.has(threadId)` check, BOTH fork a
        // PubSub-forwarding fiber, and BOTH overwrite each other in the
        // map. From then on every assistant-delta / user-accepted /
        // assistant-done is sent to the wire TWICE — the user-reported
        // "messages being processed multiple times" bug. The semaphore
        // makes check-and-stake atomic at the connection level.
        const subscribeMutex = yield* Effect.makeSemaphore(1)
        if (chat !== null) {
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const m = yield* Ref.get(chatFibers)
              yield* Fiber.interruptAll(Array.from(m.values()))
            }),
          )
        }

        // Per-connection thread model cache. Populated when we see thread-created
        // or thread-list so the smart bar can show the current model.
        const threadModelCache = new Map<string, string>()

        // Build a SmartBarContext for the given thread using per-connection state.
        const makeSmartBarCtx = (threadId: string): SmartBarContext => ({
          threadId,
          model: threadModelCache.get(threadId) ?? undefined,
          accountLabel: undefined,
          workspaceSlug: undefined,
          localShellBridge,
        })
        const smartBarGeneration = new Map<string, number>()

        // Push a fresh SmartBarFrame for `threadId` to this connection.
        // Uses a 250ms delay so smart-bar frames arrive well after the
        // synchronous chat frame burst they're triggered by (snapshot,
        // turn-complete, etc.). This keeps tests that check exact frame
        // sequences from seeing unexpected smart-bar frames mid-sequence.
        // In production the delay is imperceptible.
        // Fire-and-forget: errors must never tear down the connection.
        const sendSmartBarFor = (threadId: string): void => {
          const generation = (smartBarGeneration.get(threadId) ?? 0) + 1
          smartBarGeneration.set(threadId, generation)
          setTimeout(() => {
            const context = makeSmartBarCtx(threadId)
            void smartBarContext.getItems(context).then((items) => {
              // Git sampling is asynchronous. A cwd/model change can request a
              // newer frame while an older sample is still running; only the
              // latest requested generation may publish.
              if (smartBarGeneration.get(threadId) !== generation) return
              if (ws.readyState !== ws.OPEN) return
              send(ws, {
                type: "smart-bar",
                threadId,
                version: 1,
                items,
              })
            }).catch(() => {
              // Smart Bar context is best-effort and must never affect chat delivery.
            })
          }, 250)
        }

        // Smart-bar interval: re-push for all subscribed threads every ~20s so
        // branch / dirty status stays fresh between natural triggers. Interval is
        // kept low-frequency (20s) to avoid hammering git. Forked into the
        // connection scope so it stops when the socket closes.
        const smartBarIntervalMs = 20_000
        yield* Effect.fork(
          Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep(`${smartBarIntervalMs} millis`)
              const m = yield* Ref.get(chatFibers)
              for (const threadId of m.keys()) {
                sendSmartBarFor(threadId)
              }
            }),
          ),
        )

        const localShellClients = yield* Ref.make<ReadonlyMap<string, string>>(
          new Map(),
        )
        const onLocalShellRelease = config.onLocalShellRelease
        if (localShellBridge !== null) {
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const clients = yield* Ref.get(localShellClients)
              const releasedThreads = new Set<string>()
              for (const [threadId, clientId] of clients) {
                localShellBridge.removeClient(clientId)
                releasedThreads.add(threadId)
              }
              if (onLocalShellRelease !== undefined) {
                for (const threadId of releasedThreads) {
                  try {
                    onLocalShellRelease(threadId)
                  } catch {
                    // Callback failures must not poison connection teardown.
                  }
                }
              }
            }),
          )
        }

        // Threads this connection registered as the secret-entry target. On
        // teardown we unregister them — but only if THIS connection is still the
        // active registration (the bridge compares `secretConnId`), so a stale
        // connection closing after a reconnect can't wipe the live one.
        const secretConnId = randomUUID()
        const secretThreads = new Set<string>()
        const registerSecretClient = (threadId: string): void => {
          if (secretBridge === null) return
          secretThreads.add(threadId)
          secretBridge.registerClient(threadId, secretConnId, (out) =>
            send(ws, out),
          )
        }
        if (secretBridge !== null) {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const threadId of secretThreads) {
                secretBridge.unregisterClient(threadId, secretConnId)
              }
            }),
          )
        }

        // Summon-by-name: this connection may announce a widget directory.
        // Reuses the secret connection id for identity; the finalizer only
        // clears the bridge when THIS connection is still the active host.
        if (widgetSummoner !== null) {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              widgetSummoner.unregisterClient(secretConnId)
            }),
          )
        }

        // Job-summoned operator input (widget-system.md Phase 5): EVERY
        // connection registers with the broadcast bridge at setup (no
        // subscribe step — a job has no owning thread, so any surface may
        // answer a job-input-request). Reuses the secret connection id for
        // identity; the finalizer drops exactly this handle on teardown.
        if (jobInputBridge !== null) {
          jobInputBridge.registerClient(secretConnId, (out) => send(ws, out))
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              jobInputBridge.unregisterClient(secretConnId)
            }),
          )
        }

        // Live subagent tree (S4): EVERY connection registers at setup so it
        // can receive `subagent-tree` broadcasts for whatever thread its Agents
        // panel is watching — the panel filters by threadId and NEVER
        // subscribes the thread (so it can't steal interactive bindings).
        if (subagentTree !== null) {
          subagentTree.registerClient(secretConnId, (out) => send(ws, out))
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              subagentTree.unregisterClient(secretConnId)
            }),
          )
        }

        // Single-fiber forwarder. The pattern is: take ONE event from the
        // UIService stream, send it to the ws synchronously, repeat. ws.send
        // is fire-and-forget at the protocol level (the underlying socket
        // has its own OS-level send buffer), so we never block the upstream
        // stream more than briefly.
        //
        // Drop semantics: if ws.send fails because the socket buffer is full
        // (`ws.bufferedAmount > maxBufferedBytes`), we count the drop in a
        // local counter and skip the send. The next successful send carries
        // a leading `drop` frame. Because there's a single fiber doing both
        // accounting and sending, the count is exact — no race.
        const maxBufferedBytes = cap * 4096 // ~4KB/event budget
        let droppedSinceLast = 0
        let firstDropTs: string | null = null

        const forwarder = stream.pipe(
          Stream.runForEach((ev) =>
            Effect.sync(() => {
              if (ws.readyState !== ws.OPEN) return
              if (ws.bufferedAmount > maxBufferedBytes) {
                droppedSinceLast += 1
                if (firstDropTs === null) firstDropTs = ev.ts
                return
              }
              if (droppedSinceLast > 0 && firstDropTs !== null) {
                send(ws, {
                  type: "drop",
                  n: droppedSinceLast,
                  since: firstDropTs,
                })
                droppedSinceLast = 0
                firstDropTs = null
              }
              send(ws, { type: "event", event: ev })
            }),
          ),
        )

        // Protocol-level heartbeat (RFC 6455 ping/pong) to reap HALF-OPEN
        // connections. A laptop that sleeps or a network that drops without a
        // TCP FIN leaves the socket open server-side; its per-connection
        // forwarder + thread subscriptions then linger indefinitely holding
        // memory (a primary source of the chat-server's slow growth → OOM).
        // Browsers and WKWebView answer protocol pings AUTOMATICALLY, so this
        // is a universal liveness check — unlike the app-level {type:"ping"}
        // JSON frame below, which only the moon client auto-pongs (the web
        // client merely displays lastPingAt). If a full ping interval passes
        // with no pong, the socket is dead: terminate it so 'close' fires and
        // the connection scope tears down its subscriber queues + buffers.
        let isAlive = true
        ws.on("pong", () => {
          isAlive = true
        })
        const pinger =
          pingMs > 0
            ? Effect.forever(
                Effect.gen(function* () {
                  yield* Effect.sleep(`${pingMs} millis`)
                  if (!isAlive) {
                    try {
                      ws.terminate()
                    } catch {
                      // already gone
                    }
                    // 'close' will fire and resolve the `closed` deferred,
                    // closing the connection scope. Park until this fiber is
                    // interrupted by that teardown rather than pinging a dead
                    // socket on the next tick.
                    yield* Effect.never
                  }
                  isAlive = false
                  try {
                    ws.ping()
                  } catch {
                    // socket already closing — let the close path tear down
                  }
                  // App-level ping too: the moon client uses {type:"ping"} for
                  // its lastPingAt indicator (separate from protocol liveness).
                  send(ws, { type: "ping", ts: new Date().toISOString() })
                }),
              )
            : Effect.never

        // ── chat router ────────────────────────────────────────────────
        // Translate one ChatFrame to its ServerFrame wire shape. The only
        // rename is `snapshot` → `thread-snapshot` (advisor flagged the
        // mismatch); all other types are 1:1.
        const chatFrameToWire = (f: ChatFrame): ServerFrame => {
          if (f.type === "snapshot") {
            return {
              type: "thread-snapshot",
              threadId: f.threadId,
              throughSeq: f.throughSeq,
              messages: f.messages,
            }
          }
          return f
        }

        // Fork a forwarder fiber that subscribes to a thread and sends
        // every ChatFrame as a ServerFrame. Idempotent — a duplicate
        // subscribe to the same threadId is a no-op so we don't double
        // up snapshots or fan-out fibers.
        //
        // Snapshot frames bypass the obs drop budget intentionally:
        // they're one fat JSON blob (per advisor §E1), not a stream of
        // events, and dropping the snapshot leaves the client with
        // deltas against an empty transcript. We trust the OS-level
        // socket buffer for snapshots and accept that on a saturated
        // link a snapshot may take a moment to flush.
        const subscribeChatThread = (
          threadId: string,
        ): Effect.Effect<void, never> =>
          subscribeMutex.withPermits(1)(
          Effect.gen(function* () {
            if (chat === null) return
            const m = yield* Ref.get(chatFibers)
            if (m.has(threadId)) return // idempotent

            const stream = chat.subscribe(threadId)
            // Fork into the CONNECTION scope (not the per-message handler
            // scope) so the forwarder lives until the ws closes.
            const fiber = yield* stream.pipe(
              Stream.runForEach((f) =>
                Effect.sync(() => {
                  // A `turn-complete` marks the true end of an agentic turn —
                  // the safe moment to fire any deferred secret activation for
                  // this thread (so a restart never kills the calling turn).
                  // Fire regardless of ws state; it's a server-side signal.
                  if (f.type === "turn-complete" && secretBridge !== null) {
                    secretBridge.notifyTurnComplete(f.threadId)
                  }
                  // Smart bar: re-push on turn-complete (branch/dirty may have
                  // changed during the turn). Fire regardless of ws state —
                  // pushSmartBar checks readyState internally.
                  if (f.type === "turn-complete") {
                    sendSmartBarFor(f.threadId)
                  }
                  // Live Agents view (S4): fold this frame into the subagent
                  // tree (broadcasts to every client on change) and, on the
                  // FIRST delegation in this thread, summon the Agents panel.
                  // Server-side + ws-state-independent: the broadcast targets
                  // OTHER connections (the panel), so it must run even if this
                  // socket is mid-flush. observe() is idempotent per toolCallId.
                  if (subagentTree !== null) {
                    const { autoOpen } = subagentTree.observe(
                      f.threadId,
                      f as unknown as import("./subagent-tree-bridge.js").ObservableThreadFrame,
                    )
                    if (autoOpen && widgetSummoner !== null) {
                      // Latch announced ONLY on a successful summon — a failed
                      // open (hub not yet announced its directory) leaves the
                      // thread un-announced so the next delegation retries.
                      const opened = widgetSummoner.open("agents", { thread: f.threadId })
                      if (opened.ok) subagentTree.markAnnounced(f.threadId)
                    }
                  }
                  // Smart bar: push when a snapshot arrives — context just
                  // (re)established for this thread.
                  if (f.type === "snapshot") {
                    sendSmartBarFor(f.threadId)
                  }
                  if (ws.readyState !== ws.OPEN) return
                  send(ws, chatFrameToWire(f))
                }),
              ),
              Effect.catchAllCause(() => Effect.void),
              Effect.forkIn(connectionScope),
            )
            yield* Ref.update(chatFibers, (mm) => {
              const next = new Map(mm)
              next.set(threadId, fiber as Fiber.RuntimeFiber<unknown, unknown>)
              return next
            })
            // When the fiber finishes naturally (e.g. ChatService.subscribe
            // returned Stream.empty for an unknown thread), drop it from
            // the map so future subscribe attempts re-fork. CAS by fiber
            // identity: the observer for fiber A might fire AFTER the client
            // unsubscribed and re-subscribed under the same threadId,
            // installing a new fiber B. Without the identity check, A's
            // observer would evict B and leave it orphaned (still alive in
            // the connection scope, but unreachable from the map and from
            // unsubscribe()).
            fiber.addObserver(() => {
              Effect.runFork(
                Ref.update(chatFibers, (mm) => {
                  if (mm.get(threadId) !== fiber) return mm
                  const next = new Map(mm)
                  next.delete(threadId)
                  return next
                }),
              )
            })
          }),
          )

        const unsubscribeChatThread = (
          threadId: string,
        ): Effect.Effect<void, never> =>
          Effect.gen(function* () {
            const m = yield* Ref.get(chatFibers)
            const fiber = m.get(threadId)
            if (fiber === undefined) return
            yield* Ref.update(chatFibers, (mm) => {
              const next = new Map(mm)
              next.delete(threadId)
              return next
            })
            yield* Fiber.interrupt(fiber)
          })

        // Inbound message handler. Runs as a sync ws callback; we
        // runFork into the captured runtime so Effect ops don't block
        // the event loop.
        //
        // Bad JSON / unknown frame types are LOGGED server-side and
        // ignored — no error frame is sent (we don't have a generic
        // malformed-client-frame type, and replying could DoS-amplify
        // a buggy client). Pong is an explicit no-op so the unknown-
        // frame branch doesn't spam future protocol bumps.
        if (chat !== null || localShellBridge !== null || survey !== null || setupPty != null || registerOpToken !== null || secretBridge !== null || jobInputBridge !== null || skillRegistry !== null || capabilityRegistry !== null || connectorService !== null || artifactStore !== null || workflowGallery !== null || suggestedActions !== null || vaultService !== null || mcpAppHost !== null || subagentTree !== null || widgetSummoner !== null || modelRoutingService !== null || feedbackSink !== null) {
          ws.on("message", (raw) => {
            let frame: ClientFrame
            try {
              const parsed = JSON.parse(raw.toString())
              if (
                typeof parsed !== "object" ||
                parsed === null ||
                typeof (parsed as { type?: unknown }).type !== "string"
              ) {
                return
              }
              frame = parsed as ClientFrame
            } catch {
              return
            }

            // pushVaultList: broadcast a fresh vault-list to a set of
            // target sockets (all active sockets on mutation; only the
            // new connection on hello). Extracted so every vault mutation
            // case can broadcast without duplicating the list/syncState
            // fetch. Refresh errors are silently swallowed (isolated
            // catchAllCause) so they cannot produce a second vault-status
            // for the same requestId (finding 6).
            const pushVaultList = (
              vsvc: NonNullable<typeof vaultService>,
              targets: ReadonlyArray<WebSocket>,
            ): Effect.Effect<void, never> =>
              Effect.promise(async () => {
                const items = await vsvc.list()
                const sync = await vsvc.syncState()
                const storage = vsvc.storage?.() ?? null
                for (const sock of targets) {
                  send(sock, {
                    type: "vault-list",
                    items,
                    ...(sync !== null ? { sync } : {}),
                    ...(storage !== null ? { storage } : {}),
                  })
                }
              }).pipe(Effect.catchAllCause(() => Effect.void))

            const handle = (): Effect.Effect<void, never> =>
              Effect.gen(function* () {
                switch (frame.type) {
                  case "widget-directory": {
                    if (widgetSummoner !== null) {
                      const widgets = (frame as import("./protocol.js").WidgetDirectoryFrame).widgets
                      widgetSummoner.registerClient(secretConnId, (out) => send(ws, out), widgets)
                      console.log(
                        `[ui-ws] widget host announced ${widgetSummoner.directory().length} summonable widget(s)`,
                      )
                    }
                    break
                  }
                  case "subagent-tree-request": {
                    // The Agents panel asks for a thread's current tree on open
                    // (so a panel summoned mid-turn paints at once). Reply to
                    // THIS connection only — no broadcast, no thread subscribe.
                    if (subagentTree !== null) {
                      const tr = frame as import("./protocol.js").SubagentTreeRequestFrame
                      if (typeof tr.threadId === "string" && tr.threadId.length > 0) {
                        send(ws, {
                          type: "subagent-tree",
                          threadId: tr.threadId,
                          agents: subagentTree.treeFor(tr.threadId),
                        })
                      }
                    }
                    break
                  }
                  case "pong":
                  case "bye":
                    return
                  case "local-shell-capability": {
                    if (localShellBridge === null) return
                    const status = localShellBridge.setCapability(frame, (out) => {
                      send(ws, out)
                    })
                    send(ws, status)
                    if (status.accepted) {
                      yield* Ref.update(localShellClients, (clients) => {
                        const next = new Map(clients)
                        if (frame.enabled) {
                          next.set(frame.threadId, frame.clientId)
                        } else if (next.get(frame.threadId) === frame.clientId) {
                          next.delete(frame.threadId)
                        }
                        return next
                      })
                      // Notify the chat-server when a client vacates so it can
                      // re-attach its container-sandbox executor (otherwise the
                      // agent loses local-shell access until the next thread).
                      if (!frame.enabled && onLocalShellRelease !== undefined) {
                        try {
                          onLocalShellRelease(frame.threadId)
                        } catch {
                          // Callback failures must not poison message handling.
                        }
                      }
                      // Smart bar: re-push since the cwd/roots just changed.
                      sendSmartBarFor(frame.threadId)
                    }
                    return
                  }
                  case "local-shell-result": {
                    if (localShellBridge !== null) {
                      localShellBridge.acceptResult(frame)
                    }
                    return
                  }
                  case "secret-result": {
                    // Moon secure-entry answer. Hand the frame straight to the
                    // bridge — the secret value is never logged or echoed here.
                    if (secretBridge !== null) {
                      secretBridge.acceptResult(frame)
                    }
                    return
                  }
                  case "job-input-result": {
                    // Operator's answer to a job-input-request. Hand the frame
                    // straight to the bridge with THIS connection's send-handle
                    // as the reply target (win / already-answered ack). The
                    // answer value is never logged or echoed here.
                    if (jobInputBridge !== null) {
                      jobInputBridge.acceptResult(frame, (out) => send(ws, out))
                    }
                    return
                  }
                  case "suggested-action-respond": {
                    // Accept (auto-execute) or dismiss a suggested action. The
                    // resulting status/list update reaches the client over the
                    // chat subscribe stream (the service publishes onto the
                    // thread's pubsub), so we only route the decision here.
                    if (suggestedActions !== null) {
                      yield* suggestedActions
                        .respond({
                          threadId: frame.threadId,
                          actionId: frame.actionId,
                          decision: frame.decision,
                        })
                        .pipe(Effect.catchAllCause(() => Effect.void))
                    }
                    return
                  }
                  case "subscribe": {
                    if (chat === null) return
                    yield* subscribeChatThread(frame.threadId)
                    // Make this connection the secret-entry target for the
                    // thread, so the agent's `request_secret` tool can reach it.
                    registerSecretClient(frame.threadId)
                    // Smart bar: the snapshot frame (sent by the forwarder fiber
                    // after subscribe completes) triggers a push — no need to
                    // push here too, as it would add an extra frame before the
                    // snapshot and break tests that expect exact frame counts.
                    return
                  }
                  case "unsubscribe": {
                    if (chat === null) return
                    yield* unsubscribeChatThread(frame.threadId)
                    return
                  }
                  case "list-threads": {
                    if (chat === null) return
                    const threads = yield* chat.listThreads(frame.limit ?? 50, frame.status)
                    send(ws, { type: "thread-list", threads })
                    // Cache model for each thread so smart bar can show the model.
                    for (const t of threads) {
                      if (t.model) threadModelCache.set(t.id, t.model)
                    }
                    return
                  }
                  case "archive-thread": {
                    if (chat === null) return
                    const archiveOk = yield* chat.archiveThread(frame.threadId)
                    if (archiveOk) {
                      send(ws, { type: "thread-archived", threadId: frame.threadId })
                    } else {
                      send(ws, {
                        type: "thread-archive-error",
                        threadId: frame.threadId,
                        reason: "not-found",
                      })
                    }
                    return
                  }
                  case "unarchive-thread": {
                    if (chat === null) return
                    const unarchiveOk = yield* chat.unarchiveThread(frame.threadId)
                    if (unarchiveOk) {
                      send(ws, { type: "thread-unarchived", threadId: frame.threadId })
                    } else {
                      send(ws, {
                        type: "thread-archive-error",
                        threadId: frame.threadId,
                        reason: "not-found",
                      })
                    }
                    return
                  }
                  case "memory-search-request": {
                    if (chat === null) return
                    const result = yield* chat.searchMemory({
                      queryText: frame.queryText,
                      ...(frame.topK !== undefined ? { topK: frame.topK } : {}),
                    })
                    if ("error" in result) {
                      send(ws, {
                        type: "memory-search-error",
                        queryText: frame.queryText,
                        message: result.error.message,
                        kind: result.error.kind,
                      })
                    } else {
                      send(ws, {
                        type: "memory-search-result",
                        queryText: frame.queryText,
                        hits: result.hits,
                      })
                    }
                    return
                  }
                  case "new-thread": {
                    if (chat === null) return
                    // createThread is typed `never` in its error channel, but
                    // it can DIE (Effect.orDie on a session-store failure — e.g.
                    // a non-serializable options blob). A dying fiber here used
                    // to be swallowed by the handler's runFork, so the client
                    // hung forever waiting for `thread-created`. Catch the whole
                    // cause (defects included) and send a `thread-create-error`
                    // frame so the client can recover. The cause is also logged
                    // by the terminal defect logger at the runFork below.
                    yield* Effect.gen(function* () {
                      const summary = yield* chat.createThread({
                        model: frame.model,
                        // effort is forwarded verbatim — chat-service clamps it
                        // per-model inside createThread (buildSessionOptions),
                        // so an invalid combo never reaches the SDK options.
                        ...(frame.effort !== undefined ? { effort: frame.effort } : {}),
                        ...(frame.title !== undefined ? { title: frame.title } : {}),
                        ...(frame.tags !== undefined ? { tags: frame.tags } : {}),
                        ...(frame.systemPrompt !== undefined
                          ? { systemPrompt: frame.systemPrompt }
                          : {}),
                        ...(frame.accountId !== undefined
                          ? { boundAccountId: frame.accountId }
                          : {}),
                      })
                      send(ws, { type: "thread-created", thread: summary })
                      // Cache the model so the smart bar can show it.
                      if (summary.model) threadModelCache.set(summary.id, summary.model)
                      // Auto-subscribe so the client doesn't need a
                      // subscribe round-trip before sending the first
                      // user-message — a common ChatGPT-style pattern. Register
                      // the secret-entry client here too (not just on explicit
                      // `subscribe`), so a client that trusts auto-subscribe can
                      // still receive a `request_secret` prompt on this thread.
                      yield* subscribeChatThread(summary.id)
                      registerSecretClient(summary.id)
                      // Smart bar will be pushed when the snapshot frame arrives
                      // in the forwarder fiber — no extra push needed here.
                    }).pipe(
                      Effect.catchAllCause((cause) =>
                        Effect.sync(() => {
                          console.error(
                            "[ui-ws] new-thread failed:",
                            Cause.pretty(cause),
                          )
                          send(ws, {
                            type: "thread-create-error",
                            message:
                              "Could not create the thread. Please try again.",
                          })
                        }),
                      ),
                    )
                    return
                  }
                  case "user-message": {
                    if (chat === null) return
                    // Re-assert this connection as the secret-entry target for
                    // the thread on EVERY message — not just on `subscribe`/
                    // `new-thread`. A long-lived session whose WebSocket dropped
                    // and reconnected may keep chatting (user-messages route
                    // fine) WITHOUT re-subscribing; the old connection's teardown
                    // cleared the secret registration, so `request_secret` would
                    // report "no connected Moon client" even though chat works.
                    // Registering here makes any actively-chatting thread a valid
                    // secret target. Idempotent (last writer wins); cheap.
                    registerSecretClient(frame.threadId)
                    // TS types are erased at runtime — clients can send
                    // arbitrary mediaType strings or oversized data. Validate
                    // before forwarding to the SDK so a clean error surfaces
                    // instead of a generic Anthropic-API failure.
                    const attachErr = validateAttachments(frame.attachments)
                    if (attachErr !== null) {
                      send(ws, {
                        type: "assistant-error",
                        threadId: frame.threadId,
                        turnId: null,
                        error: { kind: "sdk", message: attachErr },
                      })
                      return
                    }
                    const result = yield* chat.send(
                      frame.threadId,
                      frame.text,
                      frame.attachments,
                      frame.client,
                    )
                    if (Option.isNone(result)) {
                      // Unknown thread — surface explicitly so the
                      // client doesn't sit waiting for a delta that
                      // will never come.
                      send(ws, {
                        type: "assistant-error",
                        threadId: frame.threadId,
                        turnId: null,
                        error: {
                          kind: "unknown-thread",
                          message: `unknown thread: ${frame.threadId}`,
                        },
                      })
                    }
                    return
                  }
                  case "interrupt": {
                    if (chat === null) return
                    yield* chat.interrupt(frame.threadId)
                    return
                  }
                  case "set-thread-config": {
                    // Model + effort switcher. Gated on chat being bound (which
                    // implies effortSelection: true in capabilities). The ack
                    // is sent only to the requesting connection — broadcast is
                    // optional per §1.D (comment left intentionally). Both
                    // fields are forwarded verbatim — chat-service clamps the
                    // effort against the thread's reference model and reports
                    // invalid combos in the ack's `rejected` list.
                    if (chat === null) return
                    const threadId = typeof frame.threadId === "string"
                      ? frame.threadId : ""
                    if (!threadId) return
                    const result = yield* chat.setThreadConfig({
                      threadId,
                      ...(frame.model !== undefined ? { model: frame.model } : {}),
                      ...(frame.effort !== undefined ? { effort: frame.effort } : {}),
                    })
                    send(ws, { type: "thread-config", ...result })
                    // An APPLIED model switch must reach the visible model
                    // indicator: refresh this connection's cache and re-push
                    // the smart bar. Without this the pill keeps showing the
                    // pre-switch model until the next list-threads — the
                    // "changing the model doesn't work" symptom.
                    if (
                      result.applied.includes("model") &&
                      typeof frame.model === "string" &&
                      frame.model.trim() !== ""
                    ) {
                      threadModelCache.set(threadId, frame.model)
                      sendSmartBarFor(threadId)
                    }
                    return
                  }
                  case "survey-response": {
                    if (survey === null) return
                    // Phase 3 D3 — D-LOCK-5 idempotency: pin EVERY verdict's `at`
                    // to the survey's `issuedAt` SERVER-SIDE. The client SHOULD
                    // already echo issuedAt, but the server overwrites it so a
                    // buggy or replaying client cannot double-move the EWMA.
                    // survey.ts keys idempotency on (ref, signalKind, at) —
                    // re-delivering the same frame with the same issuedAt is a no-op.
                    const pinnedVerdicts = frame.verdicts.map((v) => ({
                      ...v,
                      at: frame.issuedAt,
                    }))
                    yield* survey.submitVerdicts(frame.surveyId, frame.issuedAt, pinnedVerdicts).pipe(
                      Effect.catchAllCause(() => Effect.void),
                    )
                    return
                  }
                  case "skill-toggle": {
                    // PRD Part B §12. Persist + flip via the injected handle;
                    // ack the toggling client with skill-status, then
                    // BROADCAST the refreshed catalog to every connected
                    // client (review finding: unicast left a second open
                    // client — Moon + web is a normal setup — rendering
                    // stale enabled bits, and its stale-state toggle could
                    // re-flip the skill back). Failures (unknown id,
                    // registry defect) ack ok:false with a non-sensitive
                    // message and must never tear down the connection.
                    if (skillRegistry === null) return
                    // Malformed-frame guard: id/enabled types are attacker-
                    // controlled JSON — reject junk before touching state.
                    if (
                      typeof frame.id !== "string" ||
                      frame.id.length === 0 ||
                      typeof frame.enabled !== "boolean"
                    ) {
                      send(ws, {
                        type: "skill-status",
                        id: String((frame as { id?: unknown }).id ?? ""),
                        enabled: false,
                        ok: false,
                        message: "malformed skill-toggle frame",
                      })
                      return
                    }
                    const reg = skillRegistry
                    yield* reg.setEnabled(frame.id, frame.enabled).pipe(
                      Effect.flatMap(() => reg.catalog()),
                      Effect.flatMap((skills) =>
                        Effect.gen(function* () {
                          send(ws, {
                            type: "skill-status",
                            id: frame.id,
                            enabled: frame.enabled,
                            ok: true,
                          })
                          const wire = skills.map(toWireSkill)
                          const sockets = yield* Ref.get(activeSockets)
                          for (const sock of sockets) {
                            send(sock, { type: "skill-catalog", skills: wire })
                          }
                        }),
                      ),
                      Effect.catchAllCause((cause) =>
                        Effect.sync(() => {
                          send(ws, {
                            type: "skill-status",
                            id: frame.id,
                            enabled: frame.enabled,
                            ok: false,
                            message: failureMessage(cause),
                          })
                        }),
                      ),
                    )
                    return
                  }
                  case "feedback-submit": {
                    // Point-at-the-UI feedback. Persist via the injected sink,
                    // then UNICAST a feedback-ack echoing requestId (mirrors
                    // capability-execute-result). A sink defect acks ok:false
                    // and must never tear down the connection.
                    if (feedbackSink === null) return
                    // Malformed-frame guard: requestId/note/target are
                    // attacker-controlled JSON — reject junk before persisting.
                    // `note` is unbounded free text, and `target.context` can
                    // contain arbitrary client JSON, so cap both before the
                    // persistent sink sees them.
                    const NOTE_MAX = 8192
                    const TARGET_MAX = 16_384
                    const SELECTOR_MAX = 1024
                    const REQUEST_ID_MAX = 256
                    // ~512KB binary PNG ceiling × ~4/3 base64 expansion ≈
                    // 683KB, rounded up. Independent of the socket's 32MB
                    // maxPayload ceiling — this bounds disk usage per note.
                    const SCREENSHOT_MAX_BASE64_CHARS = 700_000
                    const rawReqId = (frame as { requestId?: unknown }).requestId
                    // A non-string requestId collapses to "" and is rejected by
                    // the length guard below (echoed back like skill-toggle).
                    const reqId = typeof rawReqId === "string" ? rawReqId : ""
                    const noteVal = (frame as { note?: unknown }).note
                    const targetVal = (frame as { target?: unknown }).target
                    let targetSize = Number.POSITIVE_INFINITY
                    try {
                      const encoded = JSON.stringify(targetVal)
                      if (typeof encoded === "string") targetSize = encoded.length
                    } catch {
                      // Keep Infinity: malformed/non-serializable targets fail closed.
                    }
                    const selectorVal =
                      typeof targetVal === "object" && targetVal !== null
                        ? (targetVal as { selector?: unknown }).selector
                        : undefined
                    if (
                      reqId.length === 0 ||
                      reqId.length > REQUEST_ID_MAX ||
                      typeof noteVal !== "string" ||
                      noteVal.trim().length === 0 ||
                      noteVal.length > NOTE_MAX ||
                      typeof targetVal !== "object" ||
                      targetVal === null ||
                      targetSize > TARGET_MAX ||
                      typeof selectorVal !== "string" ||
                      selectorVal.trim().length === 0 ||
                      selectorVal.length > SELECTOR_MAX
                    ) {
                      send(ws, {
                        type: "feedback-ack",
                        requestId: reqId,
                        ok: false,
                        message: "malformed feedback-submit frame",
                      })
                      return
                    }
                    const sink = feedbackSink
                    const f = frame as {
                      page?: string
                      threadId?: string
                      appVersion?: string
                      appearance?: string
                      clientTs?: number
                    }
                    // Screenshot is validated SEPARATELY from the malformed-
                    // frame guard above: a bad/oversized screenshot must
                    // never reject the whole note, it is silently dropped
                    // instead (best-effort, never-blocking capture).
                    const rawScreenshot = (frame as { screenshot?: unknown })
                      .screenshot
                    const screenshotVal =
                      typeof rawScreenshot === "string" &&
                      rawScreenshot.length > 0 &&
                      rawScreenshot.length <= SCREENSHOT_MAX_BASE64_CHARS
                        ? rawScreenshot
                        : undefined
                    yield* sink
                      .submit({
                        note: noteVal,
                        target: targetVal,
                        ...(typeof f.page === "string" ? { page: f.page } : {}),
                        ...(typeof f.threadId === "string"
                          ? { threadId: f.threadId }
                          : {}),
                        ...(typeof f.appVersion === "string"
                          ? { appVersion: f.appVersion }
                          : {}),
                        ...(typeof f.appearance === "string"
                          ? { appearance: f.appearance }
                          : {}),
                        ...(typeof f.clientTs === "number"
                          ? { clientTs: f.clientTs }
                          : {}),
                        ...(screenshotVal !== undefined
                          ? { screenshot: screenshotVal }
                          : {}),
                      })
                      .pipe(
                        Effect.flatMap((r) =>
                          Effect.sync(() =>
                            send(ws, {
                              type: "feedback-ack",
                              requestId: reqId,
                              ok: r.ok,
                              ...(r.message !== undefined
                                ? { message: r.message }
                                : {}),
                            }),
                          ),
                        ),
                        Effect.catchAllCause((cause) =>
                          Effect.sync(() =>
                            send(ws, {
                              type: "feedback-ack",
                              requestId: reqId,
                              ok: false,
                              message: failureMessage(cause),
                            }),
                          ),
                        ),
                      )
                    return
                  }
                  case "capability-execute": {
                    // Capability layer: invoke a backend-advertised capability
                    // and UNICAST the result to the requesting socket ONLY.
                    // This is a RESPONSE, not catalog state — unlike
                    // skill-toggle (which broadcasts the refreshed catalog), it
                    // must NEVER broadcast to activeSockets, or one client's
                    // execute result would leak to every other connection.
                    // Failures (unknown id, registry defect) ack ok:false with
                    // a non-sensitive message and must never tear down the
                    // connection.
                    if (capabilityRegistry === null) return
                    // Malformed-frame guard: requestId/kind/id are attacker-
                    // controlled JSON — reject junk before touching state.
                    if (
                      typeof frame.requestId !== "string" ||
                      frame.requestId.length === 0 ||
                      typeof frame.kind !== "string" ||
                      frame.kind.length === 0 ||
                      typeof frame.id !== "string" ||
                      frame.id.length === 0
                    ) {
                      send(ws, {
                        type: "capability-execute-result",
                        requestId: String(
                          (frame as { requestId?: unknown }).requestId ?? "",
                        ),
                        ok: false,
                        message: "malformed capability-execute frame",
                      })
                      return
                    }
                    const capReg = capabilityRegistry
                    const requestId = frame.requestId
                    yield* capReg
                      .execute({
                        kind: frame.kind,
                        id: frame.id,
                        ...(frame.args !== undefined ? { args: frame.args } : {}),
                      })
                      .pipe(
                        Effect.flatMap((result) =>
                          Effect.sync(() => {
                            send(ws, {
                              type: "capability-execute-result",
                              requestId,
                              ok: result.ok,
                              ...(result.message !== undefined
                                ? { message: result.message }
                                : {}),
                            })
                          }),
                        ),
                        Effect.catchAllCause((cause) =>
                          Effect.sync(() => {
                            send(ws, {
                              type: "capability-execute-result",
                              requestId,
                              ok: false,
                              message: failureMessage(cause),
                            })
                          }),
                        ),
                      )
                    return
                  }
                  case "connector-oauth-begin": {
                    // PRD A §09 step 3: the client bound its loopback and
                    // asks for a consent URL. Failures (missing per-operator
                    // client env var, already connected) ack ok:false with
                    // the operator-actionable message.
                    if (connectorService === null) return
                    const svc = connectorService
                    // Coerce requestId ONCE so success + failure echo the
                    // same value (review G2: the success path used to echo
                    // it un-coerced while the error path coerced it).
                    const beginReqId = String(
                      (frame as { requestId?: unknown }).requestId ?? "",
                    )
                    if (
                      typeof frame.definitionId !== "string" ||
                      typeof frame.loopbackPort !== "number" ||
                      typeof frame.label !== "string"
                    ) {
                      send(ws, {
                        type: "connector-status",
                        requestId: beginReqId,
                        ok: false,
                        message: "malformed connector-oauth-begin frame",
                      })
                      return
                    }
                    yield* svc
                      .beginAuth({
                        definitionId: frame.definitionId,
                        label: frame.label,
                        ...(frame.capabilityIds !== undefined
                          ? { capabilityIds: frame.capabilityIds }
                          : {}),
                        loopbackPort: frame.loopbackPort,
                      })
                      .pipe(
                        Effect.map((begun) => {
                          send(ws, {
                            type: "connector-oauth-redirect",
                            requestId: beginReqId,
                            pendingId: begun.pendingId,
                            authUrl: begun.authUrl,
                          })
                        }),
                        Effect.catchAllCause((cause) =>
                          Effect.sync(() => {
                            send(ws, {
                              type: "connector-status",
                              requestId: beginReqId,
                              ok: false,
                              message: failureMessage(cause),
                            })
                          }),
                        ),
                      )
                    return
                  }
                  case "connector-oauth-code": {
                    // PRD A §09 step 9: redeem the captured code. On success
                    // broadcast the refreshed instance list to ALL clients.
                    if (connectorService === null) return
                    const svc = connectorService
                    // Echo the client's requestId (when present) on BOTH the
                    // success and failure status so the panel can attribute the
                    // completion to the exact OAuth flow it started; a shared
                    // connector-status handler otherwise can't tell whose it is,
                    // and an unrelated ack could abort an in-flight consent.
                    // Runtime-validate: requestId is untrusted client input, so
                    // echo it back only when it is actually a string (a malformed
                    // non-string value is dropped, never serialized back).
                    const codeReqId =
                      typeof frame.requestId === "string" ? frame.requestId : undefined
                    yield* svc
                      .completeAuth({
                        pendingId: String(frame.pendingId),
                        code: String(frame.code),
                        state: String(frame.state),
                      })
                      .pipe(
                        Effect.flatMap((instance) =>
                          Effect.gen(function* () {
                            send(ws, {
                              type: "connector-status",
                              ...(codeReqId !== undefined ? { requestId: codeReqId } : {}),
                              ok: true,
                              instance,
                            })
                            const instances = yield* svc.list()
                            const sockets = yield* Ref.get(activeSockets)
                            for (const sock of sockets) {
                              send(sock, { type: "connector-list", instances })
                            }
                          }),
                        ),
                        Effect.catchAllCause((cause) =>
                          Effect.sync(() => {
                            send(ws, {
                              type: "connector-status",
                              ...(codeReqId !== undefined ? { requestId: codeReqId } : {}),
                              ok: false,
                              message: failureMessage(cause),
                            })
                          }),
                        ),
                      )
                    return
                  }
                  case "connector-connect": {
                    if (connectorService === null) return
                    const svc = connectorService
                    yield* svc
                      .connect({
                        definitionId: String(frame.definitionId),
                        label: String(frame.label ?? ""),
                        ...(frame.secretRef !== undefined
                          ? { secretRef: frame.secretRef }
                          : {}),
                        ...(frame.capabilityIds !== undefined
                          ? { capabilityIds: frame.capabilityIds }
                          : {}),
                      })
                      .pipe(
                        Effect.flatMap((instance) =>
                          Effect.gen(function* () {
                            send(ws, {
                              type: "connector-status",
                              requestId: frame.requestId,
                              ok: true,
                              instance,
                            })
                            const instances = yield* svc.list()
                            const sockets = yield* Ref.get(activeSockets)
                            for (const sock of sockets) {
                              send(sock, { type: "connector-list", instances })
                            }
                          }),
                        ),
                        Effect.catchAllCause((cause) =>
                          Effect.sync(() => {
                            send(ws, {
                              type: "connector-status",
                              requestId: frame.requestId,
                              ok: false,
                              message: failureMessage(cause),
                            })
                          }),
                        ),
                      )
                    return
                  }
                  case "connector-disconnect": {
                    if (connectorService === null) return
                    const svc = connectorService
                    yield* svc
                      .disconnect(String(frame.instanceId))
                      .pipe(
                        Effect.flatMap((removed) =>
                          Effect.gen(function* () {
                            send(ws, {
                              type: "connector-status",
                              ok: removed,
                              ...(removed ? {} : { message: "unknown instance" }),
                            })
                            const instances = yield* svc.list()
                            const sockets = yield* Ref.get(activeSockets)
                            for (const sock of sockets) {
                              send(sock, { type: "connector-list", instances })
                            }
                          }),
                        ),
                        Effect.catchAllCause((cause) =>
                          Effect.sync(() => {
                            send(ws, {
                              type: "connector-status",
                              ok: false,
                              message: failureMessage(cause),
                            })
                          }),
                        ),
                      )
                    return
                  }
                  case "connector-set-client": {
                    // PRD §23 (M2.6): store the operator's OAuth client creds,
                    // then re-broadcast the catalog so `clientSetup.configured`
                    // flips true in every connected client's UI. The values are
                    // never echoed back.
                    if (connectorService === null) return
                    const svc = connectorService
                    if (
                      typeof frame.definitionId !== "string" ||
                      typeof frame.clientId !== "string" ||
                      frame.clientId.trim().length === 0
                    ) {
                      send(ws, {
                        type: "connector-status",
                        requestId: frame.requestId,
                        ok: false,
                        message: "malformed connector-set-client frame",
                      })
                      return
                    }
                    yield* svc
                      .setClientCredentials({
                        definitionId: frame.definitionId,
                        clientId: frame.clientId,
                        ...(typeof frame.clientSecret === "string" &&
                        frame.clientSecret.length > 0
                          ? { clientSecret: frame.clientSecret }
                          : {}),
                      })
                      .pipe(
                        Effect.flatMap(() =>
                          Effect.gen(function* () {
                            send(ws, {
                              type: "connector-status",
                              requestId: frame.requestId,
                              ok: true,
                            })
                            const connectors = yield* svc.catalog()
                            const sockets = yield* Ref.get(activeSockets)
                            for (const sock of sockets) {
                              send(sock, { type: "connector-catalog", connectors })
                            }
                          }),
                        ),
                        Effect.catchAllCause((cause) =>
                          Effect.sync(() => {
                            send(ws, {
                              type: "connector-status",
                              requestId: frame.requestId,
                              ok: false,
                              message: failureMessage(cause),
                            })
                          }),
                        ),
                      )
                    return
                  }
                  case "artifact-pin": {
                    // PRD C/W1: persist an artifact by value. On success
                    // broadcast a fresh artifact-list to ALL clients (pins are
                    // global, like connector-list). Idempotent on id server-side.
                    if (artifactStore === null) return
                    const store = artifactStore
                    // Validate the inbound frame (review W1/uiws): reject
                    // malformed pins rather than coercing undefined → junk rows
                    // ("undefined" id, empty content). Same discipline as
                    // skill-toggle's id guard.
                    if (
                      typeof frame.id !== "string" ||
                      frame.id.trim().length === 0 ||
                      typeof frame.title !== "string" ||
                      typeof frame.content !== "string"
                    ) {
                      return
                    }
                    yield* store
                      .pin({
                        id: frame.id,
                        title: frame.title,
                        content: frame.content,
                        ...(frame.lang !== undefined ? { lang: frame.lang } : {}),
                        ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
                        ...(frame.origin !== undefined
                          ? { origin: frame.origin }
                          : {}),
                      })
                      .pipe(
                        Effect.flatMap(() =>
                          Effect.gen(function* () {
                            const artifacts = yield* store.list()
                            const sockets = yield* Ref.get(activeSockets)
                            for (const sock of sockets) {
                              send(sock, { type: "artifact-list", artifacts })
                            }
                          }),
                        ),
                        Effect.catchAllCause(() => Effect.void),
                      )
                    return
                  }
                  case "artifact-unpin": {
                    if (artifactStore === null) return
                    const store = artifactStore
                    if (
                      typeof frame.id !== "string" ||
                      frame.id.trim().length === 0
                    ) {
                      return
                    }
                    yield* store
                      .unpin(frame.id)
                      .pipe(
                        Effect.flatMap(() =>
                          Effect.gen(function* () {
                            const artifacts = yield* store.list()
                            const sockets = yield* Ref.get(activeSockets)
                            for (const sock of sockets) {
                              send(sock, { type: "artifact-list", artifacts })
                            }
                          }),
                        ),
                        Effect.catchAllCause(() => Effect.void),
                      )
                    return
                  }
                  case "artifact-edit": {
                    // PRD C/W1: edit an existing artifact's content. Routes
                    // through store.update (NOT unpin+re-pin) so the version
                    // ledger is preserved and bridgeCaps are left untouched —
                    // the same semantics widget_write/mcp_app_write rely on. On
                    // success broadcast a fresh artifact-list to ALL clients.
                    if (artifactStore === null || artifactStore.update === undefined) return
                    const store = artifactStore
                    const update = artifactStore.update
                    const ef = frame as import("./protocol.js").ArtifactEditFrame
                    if (
                      typeof ef.id !== "string" ||
                      ef.id.trim().length === 0 ||
                      typeof ef.content !== "string"
                    ) {
                      return
                    }
                    yield* update(ef.id, ef.content).pipe(
                      Effect.flatMap(() =>
                        Effect.gen(function* () {
                          const artifacts = yield* store.list()
                          const sockets = yield* Ref.get(activeSockets)
                          for (const sock of sockets) {
                            send(sock, { type: "artifact-list", artifacts })
                          }
                        }),
                      ),
                      Effect.catchAllCause(() => Effect.void),
                    )
                    return
                  }
                  case "workflow-refresh": {
                    // PRD C/W3: re-send the gallery to the requesting client.
                    if (workflowGallery === null) return
                    const gallery = workflowGallery
                    yield* gallery
                      .list()
                      .pipe(
                        Effect.flatMap((workflows) =>
                          Effect.sync(() => {
                            send(ws, { type: "workflow-list", workflows })
                          }),
                        ),
                        Effect.catchAllCause(() => Effect.void),
                      )
                    return
                  }
                  case "workflow-runs-request": {
                    // PRD C/W3: one job's run history (to the requester only).
                    if (workflowGallery === null) return
                    const gallery = workflowGallery
                    if (
                      typeof frame.jobId !== "string" ||
                      frame.jobId.trim().length === 0
                    ) {
                      return
                    }
                    const jobId = frame.jobId
                    // Clamp to a sane positive bound — a negative/huge/non-int
                    // limit from a malformed client must not bypass the default
                    // or hammer the DB (review G3).
                    const limit =
                      typeof frame.limit === "number" &&
                      Number.isInteger(frame.limit) &&
                      frame.limit > 0
                        ? Math.min(frame.limit, 200)
                        : undefined
                    yield* gallery
                      .runs(jobId, limit)
                      .pipe(
                        Effect.flatMap((runs) =>
                          Effect.sync(() => {
                            send(ws, { type: "workflow-runs", jobId, runs })
                          }),
                        ),
                        Effect.catchAllCause(() => Effect.void),
                      )
                    return
                  }
                  case "mcp-resource-read": {
                    // MCP Apps relay (Phase 7): resolve a ui:// app resource.
                    // The host NEVER rejects by contract; the catchAllCause is
                    // belt-and-suspenders so a defect can't kill the socket
                    // loop — it collapses to a generic ok:false reply.
                    if (mcpAppHost === null) return
                    const host = mcpAppHost
                    const out = yield* Effect.promise(() =>
                      host.handleResourceRead(frame),
                    ).pipe(
                      Effect.catchAllCause(() =>
                        Effect.succeed<ServerFrame>({
                          type: "mcp-resource-result",
                          requestId: String(
                            (frame as { requestId?: unknown }).requestId ?? "",
                          ),
                          ok: false,
                          message: "resource read failed",
                        }),
                      ),
                    )
                    send(ws, out)
                    return
                  }
                  case "mcp-tool-call": {
                    // MCP Apps relay (Phase 7): a rendered app called
                    // tools/call. Same-app enforcement lives in the provider;
                    // the result is app data and is never logged here.
                    if (mcpAppHost === null) return
                    const host = mcpAppHost
                    const out = yield* Effect.promise(() =>
                      host.handleToolCall(frame),
                    ).pipe(
                      Effect.catchAllCause(() =>
                        Effect.succeed<ServerFrame>({
                          type: "mcp-tool-result",
                          requestId: String(
                            (frame as { requestId?: unknown }).requestId ?? "",
                          ),
                          ok: false,
                          message: "tool call failed",
                        }),
                      ),
                    )
                    send(ws, out)
                    return
                  }
                  case "pty-input": {
                    setupHandle?.write(Buffer.from(frame.data, "base64").toString())
                    return
                  }
                  case "pty-resize": {
                    setupHandle?.resize(frame.cols, frame.rows)
                    return
                  }
                  case "register-op-token": {
                    // Moon secure-entry. Route to the injected handler; relay
                    // its status. The token is sensitive — never logged here,
                    // and the handler contract forbids echoing it in `message`.
                    if (registerOpToken === null) return
                    const result = yield* Effect.promise(() =>
                      registerOpToken({ label: frame.label, token: frame.token }),
                    )
                    send(ws, {
                      type: "register-op-token-status",
                      requestId: frame.requestId,
                      ok: result.ok,
                      message: result.message,
                    })
                    return
                  }
                  case "vault-put": {
                    // Luna Vault V1: register/update a credential. The frame
                    // carries a sensitive `value` — we log ONLY the type and
                    // requestId, never the payload. The handle receives the
                    // full frame but its returned `message` MUST NOT echo the
                    // value (enforced by handle contract, not this package).
                    if (vaultService === null) return
                    const vsvc = vaultService
                    const putReqId = String(
                      (frame as { requestId?: unknown }).requestId ?? "",
                    )
                    if (
                      typeof frame.name !== "string" ||
                      frame.name.trim().length === 0 ||
                      typeof frame.kind !== "string" ||
                      (frame.kind !== "env-secret" && frame.kind !== "op-token") ||
                      typeof frame.value !== "string" ||
                      frame.value.length === 0 ||
                      // B4: optional fields present-but-non-string → malformed
                      (frame.varName !== undefined && typeof frame.varName !== "string") ||
                      (frame.label !== undefined && typeof frame.label !== "string") ||
                      (frame.description !== undefined && typeof frame.description !== "string")
                    ) {
                      send(ws, {
                        type: "vault-status",
                        requestId: putReqId,
                        ok: false,
                        message: "malformed vault-put frame",
                      })
                      return
                    }
                    yield* Effect.promise(async () => {
                      const res = await vsvc.put(frame)
                      send(ws, {
                        type: "vault-status",
                        requestId: putReqId,
                        ok: res.ok,
                        message: res.message,
                      })
                      return res.ok
                    }).pipe(
                      Effect.catchAllCause((cause) =>
                        Effect.sync(() => {
                          send(ws, {
                            type: "vault-status",
                            requestId: putReqId,
                            ok: false,
                            message: failureMessage(cause),
                          })
                          return false
                        }),
                      ),
                      Effect.flatMap((ok) =>
                        ok
                          ? Effect.gen(function* () {
                              const sockets = yield* Ref.get(activeSockets)
                              yield* pushVaultList(vsvc, sockets)
                            })
                          : Effect.void,
                      ),
                    )
                    return
                  }
                  case "vault-delete": {
                    // Remove a registry row (and optionally the underlying
                    // credential). No sensitive values in this frame.
                    if (vaultService === null) return
                    const vsvc = vaultService
                    const delReqId = String(
                      (frame as { requestId?: unknown }).requestId ?? "",
                    )
                    if (
                      typeof frame.id !== "string" ||
                      frame.id.trim().length === 0
                    ) {
                      send(ws, {
                        type: "vault-status",
                        requestId: delReqId,
                        ok: false,
                        message: "malformed vault-delete frame",
                      })
                      return
                    }
                    yield* Effect.promise(async () => {
                      const res = await vsvc.remove(frame)
                      send(ws, {
                        type: "vault-status",
                        requestId: delReqId,
                        ok: res.ok,
                        message: res.message,
                      })
                      return res.ok
                    }).pipe(
                      Effect.catchAllCause((cause) =>
                        Effect.sync(() => {
                          send(ws, {
                            type: "vault-status",
                            requestId: delReqId,
                            ok: false,
                            message: failureMessage(cause),
                          })
                          return false
                        }),
                      ),
                      Effect.flatMap((ok) =>
                        ok
                          ? Effect.gen(function* () {
                              const sockets = yield* Ref.get(activeSockets)
                              yield* pushVaultList(vsvc, sockets)
                            })
                          : Effect.void,
                      ),
                    )
                    return
                  }
                  case "vault-sync-config": {
                    // Configure 1Password two-way sync (slice V3). No secret
                    // values in this frame (tokens live in their own storage).
                    if (vaultService === null) return
                    const vsvc = vaultService
                    const syncReqId = String(
                      (frame as { requestId?: unknown }).requestId ?? "",
                    )
                    if (
                      typeof frame.enabled !== "boolean" ||
                      (frame.opLabel !== undefined &&
                        typeof frame.opLabel !== "string") ||
                      (frame.opVault !== undefined &&
                        typeof frame.opVault !== "string") ||
                      (frame.pollSeconds !== undefined &&
                        (typeof frame.pollSeconds !== "number" ||
                          !Number.isFinite(frame.pollSeconds)))
                    ) {
                      send(ws, {
                        type: "vault-status",
                        requestId: syncReqId,
                        ok: false,
                        message: "malformed vault-sync-config frame",
                      })
                      return
                    }
                    yield* Effect.promise(async () => {
                      const res = await vsvc.setSyncConfig(frame)
                      send(ws, {
                        type: "vault-status",
                        requestId: syncReqId,
                        ok: res.ok,
                        message: res.message,
                      })
                      return res.ok
                    }).pipe(
                      Effect.catchAllCause((cause) =>
                        Effect.sync(() => {
                          send(ws, {
                            type: "vault-status",
                            requestId: syncReqId,
                            ok: false,
                            message: failureMessage(cause),
                          })
                          return false
                        }),
                      ),
                      Effect.flatMap((ok) =>
                        ok
                          ? Effect.gen(function* () {
                              const sockets = yield* Ref.get(activeSockets)
                              yield* pushVaultList(vsvc, sockets)
                            })
                          : Effect.void,
                      ),
                    )
                    return
                  }
                  case "vault-import": {
                    // Bulk Apple Passwords CSV import (slice V3). The frame
                    // carries sensitive `password` values in each item — log
                    // ONLY type + requestId. Server enforces ≤20 items/frame.
                    if (vaultService === null) return
                    const vsvc = vaultService
                    const importReqId = String(
                      (frame as { requestId?: unknown }).requestId ?? "",
                    )
                    // Read items ONCE via the unknown accessor; Array.isArray
                    // narrows without the ReadonlyArray→mutable cast (TS2352).
                    const importItems = (frame as { readonly items?: unknown }).items
                    if (!Array.isArray(importItems)) {
                      send(ws, {
                        type: "vault-status",
                        requestId: importReqId,
                        ok: false,
                        message: "malformed vault-import frame",
                      })
                      return
                    }
                    if (importItems.length > 20) {
                      send(ws, {
                        type: "vault-status",
                        requestId: importReqId,
                        ok: false,
                        message: "vault-import: too many items (max 20 per frame)",
                      })
                      return
                    }
                    yield* Effect.promise(async () => {
                      const res = await vsvc.importItems(frame)
                      send(ws, {
                        type: "vault-status",
                        requestId: importReqId,
                        ok: res.ok,
                        message: res.message,
                      })
                      return res.ok
                    }).pipe(
                      Effect.catchAllCause((cause) =>
                        Effect.sync(() => {
                          send(ws, {
                            type: "vault-status",
                            requestId: importReqId,
                            ok: false,
                            message: failureMessage(cause),
                          })
                          return false
                        }),
                      ),
                      Effect.flatMap((ok) =>
                        ok
                          ? Effect.gen(function* () {
                              const sockets = yield* Ref.get(activeSockets)
                              yield* pushVaultList(vsvc, sockets)
                            })
                          : Effect.void,
                      ),
                    )
                    return
                  }
                  case "model-routing-save": {
                    // Model-routing settings save (PR 1). No credential values
                    // in the frame — only opaque refs and metadata. Log type +
                    // requestId only; never log providers/roleBindings content.
                    if (modelRoutingService === null) return
                    const mrSvc = modelRoutingService
                    const mrFrame = frame as import("./protocol.js").ModelRoutingSaveFrame
                    const mrReqId = mrFrame.requestId ?? ""
                    const saveResult = mrSvc.save({
                      providers: mrFrame.providers ?? [],
                      roleBindings: mrFrame.roleBindings ?? [],
                    })
                    send(ws, {
                      type: "model-routing-status",
                      requestId: mrReqId,
                      ok: saveResult.ok,
                      message: saveResult.message,
                    })
                    if (saveResult.ok) {
                      // Re-broadcast fresh list to ALL clients. Crash-guarded: a list() failure
                      // after a successful save must not kill the connection fiber or leave other
                      // clients stale — the save already succeeded and was acked.
                      yield* Effect.gen(function* () {
                        const freshList = mrSvc.list()
                        const sockets = yield* Ref.get(activeSockets)
                        for (const sock of sockets) {
                          send(sock, freshList)
                        }
                      }).pipe(Effect.catchAllCause(() => Effect.void))
                      // Schedule restart so the resolver feeds the engine.
                      mrSvc.scheduleRestart?.()
                    }
                    return
                  }
                  default: {
                    // Unknown/unrecognized frame type. Surface it instead of
                    // dropping silently: a client sending a mistyped frame
                    // (e.g. "subscribe-thread" instead of "subscribe") would
                    // otherwise hang with no signal on either side. We log and
                    // ignore — no error frame is sent back (no generic
                    // malformed-frame reply type, and echoing could DoS-amplify
                    // a buggy client). `frame` is narrowed to `never` here by
                    // the exhaustive union, so read the type via a cast.
                    const unknownType = (frame as { readonly type?: unknown }).type
                    console.error(
                      `[ui-ws] ignoring unknown client frame type: ${String(unknownType)}`,
                    )
                    return
                  }
                }
              })

            // Terminal defect logger (permanent safety net). The message
            // handler is forked detached, so ANY failure or defect it
            // produces — e.g. an Effect.orDie in a service call — would
            // otherwise be dropped silently with no log and no client
            // signal (this is exactly what hid the new-thread hang). Logging
            // the full cause here guarantees every handler defect is visible
            // in the server logs. Individual cases (e.g. `new-thread`) are
            // additionally expected to catch their own failures and send the
            // client a typed error frame; this logger is the backstop for any
            // they miss.
            Runtime.runFork(runtime)(
              handle().pipe(
                Effect.tapErrorCause((c) =>
                  Effect.sync(() =>
                    console.error("[ui-ws] handler defect:", Cause.pretty(c)),
                  ),
                ),
              ),
            )
          })
        }

        // Wire ws close → resolve the close deferred. The setup pty is torn
        // down by the connection-scope finalizer above (covers all paths).
        ws.on("close", () => {
          Effect.runFork(Deferred.succeed(closed, void 0))
        })
        ws.on("error", () => {
          try {
            ws.close()
          } catch {
            // ignore
          }
        })

        // Run forwarder + pinger until the ws closes (or forwarder dies).
        yield* Effect.race(
          forwarder,
          Effect.race(pinger, Deferred.await(closed)),
        ).pipe(Effect.catchAllCause(() => Effect.void))
      })

    const runFork = Runtime.runFork(runtime)
    wss.on("connection", (ws) => {
      const fiber = runFork(Effect.scoped(handleConnection(ws)))
      const typed = fiber as Fiber.RuntimeFiber<unknown, unknown>
      runFork(Ref.update(activeFibers, (xs) => [...xs, typed]))
      // Remove from activeFibers when the fiber finishes (natural close,
      // forwarder error, etc.) — otherwise long-lived servers leak completed
      // fiber references in the Ref (auditor finding).
      fiber.addObserver(() => {
        runFork(Ref.update(activeFibers, (xs) => xs.filter((x) => x !== typed)))
      })
    })

    // Listen.
    yield* Effect.async<void, Error>((resume) => {
      const onError = (err: Error) => resume(Effect.fail(err))
      httpServer.once("error", onError)
      httpServer.listen(port, host, () => {
        httpServer.removeListener("error", onError)
        resume(Effect.void)
      })
    })

    const addr = httpServer.address()
    const resolvedPort =
      typeof addr === "object" && addr !== null ? addr.port : port

    // Finalizer: close all sockets, close ws server, close http server.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const sockets = yield* Ref.get(activeSockets)
        for (const s of sockets) {
          try {
            send(s, { type: "bye", reason: "server-shutdown" })
            s.close()
          } catch {
            // ignore
          }
        }
        const fibers = yield* Ref.get(activeFibers)
        yield* Fiber.interruptAll(fibers)
        yield* Effect.async<void>((resume) => {
          wss.close(() => resume(Effect.void))
        })
        // Force-close all tracked connections before calling httpServer.close().
        // Bun issue #14946: after WebSocket upgrades, httpServer.close(cb) may
        // never fire its callback if lingering TCP sockets remain tracked.
        // closeAllConnections() (Node 18.2+ / Bun compat) destroys them so the
        // callback fires promptly.
        try { (httpServer as { closeAllConnections?: () => void }).closeAllConnections?.() } catch { /* not critical */ }
        yield* Effect.async<void>((resume) => {
          // Safety-valve: resolve after 500ms even if the callback never fires
          // (Bun #14946 in environments that don't support closeAllConnections).
          const t = setTimeout(() => resume(Effect.void), 500)
          httpServer.close(() => {
            clearTimeout(t)
            resume(Effect.void)
          })
        })
      }),
    )

    return { port: resolvedPort, host } satisfies UIWebSocketServerHandle
  })

/**
 * Layer form: provides nothing (caller consumes the handle directly via
 * the Effect). Most users will call startUIWebSocketServer in a scoped
 * program; the Layer below is for cases where you want it as a managed
 * resource composed with other layers.
 */
export const UIWebSocketServerLayer = (
  config: UIWebSocketServerConfig,
): Layer.Layer<never, Error, UIService> =>
  Layer.scopedDiscard(startUIWebSocketServer(config).pipe(Effect.asVoid))
