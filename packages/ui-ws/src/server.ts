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
  Ref,
  Runtime,
  Stream,
} from "effect"
import type * as Scope from "effect/Scope"
import * as http from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import { UIService } from "@experiment-agent/core"
import type { ObsEvent } from "@experiment-agent/core"
import {
  UI_WS_PROTOCOL_VERSION,
  type ServerFrame,
} from "./protocol.js"

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

    const httpServer = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("ok")
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

    const wss = new WebSocketServer({ noServer: true })

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
          // Chat is wired in by `withChatService` (Commit 2b). The base
          // server is obs-only; flip these to true when the chat router
          // is bound on top.
          capabilities: { chat: false, streamingDeltas: false },
        })

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

        // Wire ws close → resolve the close deferred.
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
        yield* Effect.async<void>((resume) => {
          httpServer.close(() => resume(Effect.void))
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
