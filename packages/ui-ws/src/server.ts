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
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Runtime,
  Stream,
} from "effect"
import type * as Scope from "effect/Scope"
import * as http from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import { UIService } from "@luna/core"
import type { ObsEvent } from "@luna/core"
import type { ChatService, ChatFrame } from "@luna/chat-service"
import type { LocalShellBridge } from "./local-shell-bridge.js"
import {
  UI_WS_PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
  type PtyOutputFrame,
} from "./protocol.js"
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
   * or null if not due. Called once on connect (fire-and-forget).
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
}

export interface UIWebSocketServerHandle {
  /** Resolved listening port (useful when port: 0). */
  readonly port: number
  /** Bound host. */
  readonly host: string
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
 * Limits follow the Anthropic content-block limits:
 *   - mediaType ∈ { image/jpeg, image/png, image/gif, image/webp, application/pdf }
 *   - data: base64 string
 *   - decoded size ≤ 10 MB per image, ≤ 20 MB per PDF
 *   - turn total decoded ≤ 20 MB (base64 ≈ 27 MB, under the 32 MB API request ceiling)
 *   - ≤ 8 attachments per turn (defence-in-depth on top of maxPayload)
 */
const ALLOWED_ATTACH_MEDIA_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
])
const MAX_IMAGE_RAW_BYTES = 10 * 1024 * 1024 // Anthropic per-image base64 limit
const MAX_PDF_RAW_BYTES = 20 * 1024 * 1024   // PDFs are large and can't be downscaled
const MAX_TURN_RAW_BYTES = 20 * 1024 * 1024  // sum of decoded; base64 ≈ 27 MB < 32 MB request ceiling
const MAX_ATTACHMENTS_PER_TURN = 8

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
    const buildSha = config.buildSha

    const httpServer = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("ok")
        return
      }
      if (req.url === "/readyz") {
        // Deeper-than-liveness readiness (#28): distinguishes a NORMAL chat server
        // from a SETUP-mode server (which also answers /healthz 200). The mode is
        // derived from the boot config — chat-server starts setup-mode with
        // `setupPty` set + `chatService: null`, and normal-mode with `chatService`
        // set. credentialOk tracks normal mode (only reached past the boot-time
        // credential gate). Additive: /healthz keeps returning "ok" for liveness
        // consumers; this endpoint is what luna-update-server's gate inspects.
        const mode = setupPty != null ? "setup" : "normal"
        res.writeHead(200, { "content-type": "application/json" })
        // `buildSha` is additive: included only when the caller threaded it in
        // (production does; test rigs don't). Absent → field omitted, so older
        // /readyz consumers and the existing {status,mode,credentialOk} shape
        // are unaffected.
        res.end(
          JSON.stringify({
            status: "ok",
            mode,
            credentialOk: mode === "normal",
            ...(buildSha !== undefined ? { buildSha } : {}),
          }),
        )
        return
      }
      if (req.url === path) {
        // GET on the WS path without upgrade headers → 426.
        res.writeHead(426, { "content-type": "text/plain" })
        res.end("upgrade required")
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
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
        socket.destroy()
        return
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

        // Phase 3 D3 (D-LOCK-1): push a survey check-in if one is due.
        // Fire-and-forget — a survey failure must never take down the connection.
        // `now` is captured once and becomes `issuedAt` (D-LOCK-5 anchor).
        // surveyId is derived from issuedAt (unique per survey instance; T3
        // wiring can ignore it — issuedAt is the processVerdict idempotency key).
        if (survey !== null) {
          const s = survey
          const now = Date.now()
          Effect.runFork(
            Effect.flatMap(s.pendingSurvey(now), (pending) =>
              Effect.sync(() => {
                if (pending !== null) {
                  send(ws, {
                    type: "survey-request",
                    surveyId: `survey-${pending.issuedAt}`,
                    issuedAt: pending.issuedAt,
                    items: pending.items,
                  })
                }
              }),
            ).pipe(Effect.catchAllCause(() => Effect.void)),
          )
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
        if (chat !== null) {
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              const m = yield* Ref.get(chatFibers)
              yield* Fiber.interruptAll(Array.from(m.values()))
            }),
          )
        }

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

        const pinger =
          pingMs > 0
            ? Effect.forever(
                Effect.gen(function* () {
                  yield* Effect.sleep(`${pingMs} millis`)
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
          })

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
        if (chat !== null || localShellBridge !== null || survey !== null || setupPty != null) {
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

            const handle = (): Effect.Effect<void, never> =>
              Effect.gen(function* () {
                switch (frame.type) {
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
                    }
                    return
                  }
                  case "local-shell-result": {
                    if (localShellBridge !== null) {
                      localShellBridge.acceptResult(frame)
                    }
                    return
                  }
                  case "subscribe": {
                    if (chat === null) return
                    yield* subscribeChatThread(frame.threadId)
                    return
                  }
                  case "unsubscribe": {
                    if (chat === null) return
                    yield* unsubscribeChatThread(frame.threadId)
                    return
                  }
                  case "list-threads": {
                    if (chat === null) return
                    const threads = yield* chat.listThreads(frame.limit ?? 50)
                    send(ws, { type: "thread-list", threads })
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
                    const summary = yield* chat.createThread({
                      model: frame.model,
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
                    // Auto-subscribe so the client doesn't need a
                    // subscribe round-trip before sending the first
                    // user-message — a common ChatGPT-style pattern.
                    yield* subscribeChatThread(summary.id)
                    return
                  }
                  case "user-message": {
                    if (chat === null) return
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
                  case "pty-input": {
                    setupHandle?.write(Buffer.from(frame.data, "base64").toString())
                    return
                  }
                  case "pty-resize": {
                    setupHandle?.resize(frame.cols, frame.rows)
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

            Runtime.runFork(runtime)(handle())
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
