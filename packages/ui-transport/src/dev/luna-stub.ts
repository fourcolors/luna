/**
 * Minimal runnable Luna WebSocket stub server for tests and local development.
 *
 * Implements the Luna WS protocol surface that LunaWsAdapter uses:
 *   - HTTP upgrade with Bearer ?token= auth (rejects 401 on bad/missing token)
 *   - Sends a `hello` frame with a full ServerDescriptor (server-emitted origin)
 *     identity.kind="luna-chat-server", update.revertible=TRUE (THE key differentiator
 *     from Hermes where revertible=false)
 *   - Handles `new-thread` → responds with `thread-created`
 *   - Handles `subscribe` (no-op, thread already implicitly tracked)
 *   - Handles `user-message` → streams `assistant-delta` × N + `assistant-done`
 *   - Handles `interrupt` (no-op on stub, just ignores)
 *   - Handles `unsubscribe` (no-op)
 *
 * Uses Node.js http + ws package for portability (same as the test suite pattern).
 *
 * Usage in tests:
 *   const stub = await startLunaStub({ token: "test-luna-token" })
 *   // ... run tests against stub.url ...
 *   await stub.stop()
 *
 * Usage as a CLI (Bun or Node):
 *   bun run src/dev/luna-stub.ts
 */

import * as http from "node:http"
import { WebSocketServer } from "ws"
import type WebSocket from "ws"
import type { ServerDescriptor } from "../contract.js"

export interface LunaStubOptions {
  /** Bearer token (?token=...) callers must present. Default: "test-luna-token" */
  token?: string
  /** Port to listen on. Default: 0 (random OS-assigned port). */
  port?: number
  /** Server version reported in the descriptor. Default: "0.99.0-stub" */
  version?: string
  /** Number of assistant-delta chunks to emit per user-message. Default: 3 */
  deltaCount?: number
  /** The descriptor generation number. Default: 1 */
  generation?: number
}

export interface LunaStubHandle {
  /** Base WS URL, e.g. "ws://127.0.0.1:PORT" */
  readonly url: string
  readonly port: number
  stop(): Promise<void>
}

/**
 * Build the ServerDescriptor that the Luna stub sends in the `hello` frame.
 * Key differentiator: update.revertible = TRUE (Luna has rollback support).
 * The harness asserts this is TRUE for Luna and FALSE for Hermes.
 */
function buildLunaDescriptor(opts: {
  version: string
  generation: number
}): ServerDescriptor {
  return {
    descriptorSchema: 1,
    generation: opts.generation,
    issuedAt: new Date().toISOString(),
    negotiation: { agreed: 2 },
    identity: {
      name: "luna-stable",
      kind: "luna-chat-server",
      displayName: "Luna",
      version: opts.version,
    },
    runtimeSummary: {
      category: "host-process",
      live: true,
    },
    capabilities: [
      {
        operation: "interact",
        available: true,
        title: "Chat",
        authz: { allowed: true, scope: "write" },
        detail: { streaming: "ws-delta", protocol: "luna-v2" },
      },
      {
        operation: "inspect",
        available: true,
        title: "Status",
        authz: { allowed: true, scope: "read" },
        detail: { health: "/healthz", readiness: "/readyz" },
      },
      {
        operation: "administer",
        available: true,
        title: "Manage server",
        authz: { allowed: true, scope: "admin" },
      },
      {
        operation: "update",
        available: true,
        title: "Update & rollback",
        authz: { allowed: true, scope: "admin" },
        detail: {
          // Luna supports rollback (git reset --hard + systemd restart)
          revertible: true,
          mechanism: "luna-update-server",
        },
      },
    ],
    health: {
      status: "normal",
      credentialOk: true,
      port: 4753,
      checks: [
        { name: "/healthz", ok: true },
        { name: "/readyz", ok: true },
      ],
      checkedAt: new Date().toISOString(),
    },
    // THE differentiator: revertible=TRUE for Luna (rollback-capable)
    // Contrast with Hermes where revertible=false (conservative default, §7 note (a))
    update: {
      driverKind: "luna-chat-server",
      currentVersion: opts.version,
      revertible: true,       // ← ROLLBACK CAPABLE — renders the "Rollback" button
      forwardOnly: false,
      phase: "idle",
    },
  }
}

/**
 * Start a minimal Luna WS stub server.
 * Returns a handle with the base WS URL, port, and a stop() function.
 */
export function startLunaStub(opts?: LunaStubOptions): Promise<LunaStubHandle> {
  const TOKEN = opts?.token ?? "test-luna-token"
  const VERSION = opts?.version ?? "0.99.0-stub"
  const DELTA_COUNT = opts?.deltaCount ?? 3
  const GENERATION = opts?.generation ?? 1

  return new Promise<LunaStubHandle>((resolve, reject) => {
    const httpServer = http.createServer((_req, res) => {
      // Non-WS requests just get a 200 (health-check friendly)
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ status: "ok", service: "luna-stub" }))
    })

    const wss = new WebSocketServer({
      server: httpServer,
      // Validate the token before the WS upgrade completes.
      // The adapter sends: ?token=<tokenRef>
      verifyClient: (info: { req: http.IncomingMessage }) => {
        const url = new URL(info.req.url ?? "/", "http://127.0.0.1")
        const token = url.searchParams.get("token") ?? ""
        return token === TOKEN
      },
    })

    wss.on("connection", (ws: WebSocket) => {
      // Send hello with descriptor immediately after connection is established.
      const descriptor = buildLunaDescriptor({ version: VERSION, generation: GENERATION })
      const helloFrame = {
        type: "hello",
        protocolVersion: 2,
        kinds: ["luna-chat-server"],
        serverVersion: VERSION,
        // Carry descriptor under the additive field (per design doc §5.2 wire-shape note)
        descriptor,
        capabilities: {
          chat: true,
          streamingDeltas: true,
          setup: false,
        },
      }
      ws.send(JSON.stringify(helloFrame))

      // Track threads per connection
      const threads = new Set<string>()
      let threadCounter = 0
      // Incrementing sequence counter for ChatMessage.seq (FIX 1)
      let msgSeq = 0

      ws.on("message", (raw) => {
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(String(raw)) as Record<string, unknown>
        } catch {
          return
        }

        const type = frame["type"] as string | undefined

        if (type === "new-thread") {
          // Respond with thread-created
          threadCounter++
          const threadId = `thread-stub-${Date.now()}-${threadCounter}`
          threads.add(threadId)
          // FIX 2: faithful ThreadCreatedFrame.thread — complete SessionSummary
          // shape: {id,parentId,title,tags,createdAt(number),endedAt,model,
          //         status,lastMessageAt,lastMessagePreview}
          ws.send(
            JSON.stringify({
              type: "thread-created",
              thread: {
                id: threadId,
                parentId: null,
                title: null,
                tags: [],
                createdAt: Date.now(),
                endedAt: null,
                model: (frame["model"] as string | undefined) ?? "claude-opus-4-5",
                status: "active",
                lastMessageAt: null,
                lastMessagePreview: null,
              },
            }),
          )
          return
        }

        if (type === "subscribe") {
          const threadId = frame["threadId"] as string | undefined
          if (threadId) threads.add(threadId)
          // No response needed for subscribe — adapter already tracks locally
          return
        }

        if (type === "user-message") {
          const threadId = (frame["threadId"] as string | undefined) ?? "unknown"
          const userText = (frame["text"] as string | undefined) ?? ""
          const turnId = `turn-stub-${Date.now()}`

          // Accumulate the full text across all delta chunks so we can embed
          // it faithfully in the assistant-done ChatMessage.
          const chunks: string[] = []

          // Emit DELTA_COUNT assistant-delta frames then assistant-done
          for (let i = 0; i < DELTA_COUNT; i++) {
            const isFirst = i === 0
            const chunk = isFirst ? `Echo from Luna stub: "${userText}" ` : `[delta-${i}] `
            chunks.push(chunk)
            ws.send(
              JSON.stringify({
                type: "assistant-delta",
                threadId,
                turnId,
                text: chunk,
              }),
            )
          }

          // FIX 1: faithful AssistantDoneFrame — seq (incrementing) + ChatMessage,
          // no stopReason.  ChatMessage shape: {id,seq,ts,role,text,toolUses,attachments}
          msgSeq++
          const fullText = chunks.join("")
          ws.send(
            JSON.stringify({
              type: "assistant-done",
              threadId,
              turnId,
              seq: msgSeq,
              message: {
                id: `msg-stub-${Date.now()}`,
                seq: msgSeq,
                ts: Date.now(),
                role: "assistant",
                text: fullText,
                toolUses: [],
                attachments: [],
              },
            }),
          )
          return
        }

        if (type === "interrupt" || type === "unsubscribe") {
          // No-op on stub
          return
        }

        // Unknown frame — silently ignore (robust to future protocol additions)
      })

      ws.on("error", () => {
        // Ignore per-connection errors in the stub
      })
    })

    wss.on("error", reject)

    httpServer.on("error", reject)

    httpServer.listen(opts?.port ?? 0, "127.0.0.1", () => {
      const addr = httpServer.address()
      const port = typeof addr === "object" && addr ? addr.port : 0

      const handle: LunaStubHandle = {
        url: `ws://127.0.0.1:${port}`,
        port,
        stop(): Promise<void> {
          return new Promise<void>((res, rej) => {
            wss.close((wsErr) => {
              if (wsErr) { rej(wsErr); return }
              httpServer.close((httpErr) => (httpErr ? rej(httpErr) : res()))
            })
          })
        },
      }

      resolve(handle)
    })
  })
}

// ── CLI entry point ──────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: cross-runtime main detection
const isBunMain =
  typeof (globalThis as any).Bun !== "undefined" &&
  // biome-ignore lint/suspicious/noExplicitAny: Bun global
  (import.meta as any).main === true

const isNodeMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))

if (isBunMain || isNodeMain) {
  const TOKEN = process.env["LUNA_STUB_TOKEN"] ?? "test-luna-token"
  const PORT = process.env["LUNA_STUB_PORT"] ? parseInt(process.env["LUNA_STUB_PORT"], 10) : 4753

  const stub = await startLunaStub({ token: TOKEN, port: PORT })
  console.log(`Luna stub listening on ${stub.url}`)
  console.log(`Token: ${TOKEN}`)
  console.log(
    "Connect: ws://127.0.0.1:" + stub.port + "?token=" + TOKEN,
  )
  console.log(
    "Handles: new-thread, subscribe, user-message → assistant-delta×3 + assistant-done",
  )
  console.log("Descriptor: identity.kind=luna-chat-server, update.revertible=true")
  console.log("Press Ctrl+C to stop.")
}
