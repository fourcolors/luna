/**
 * Minimal runnable Hermes stub server for tests and local development.
 *
 * Implements the Hermes HTTP+SSE API surface that HermesHttpSseAdapter uses:
 *   GET  /health                → { status: "ok" }
 *   GET  /v1/capabilities       → capabilities doc including version
 *   GET  /v1/models             → model list
 *   POST /v1/chat/completions   → SSE stream (when Accept: text/event-stream)
 *   GET  /v1/runs               → empty run list
 *   POST /v1/runs               → create-run stub
 *
 * Bearer auth is enforced on all routes (401 without it).
 *
 * Uses Node.js http module for portability (works in vitest/Node AND Bun).
 *
 * Usage in tests:
 *   const stub = await startHermesStub({ token: "test-key" })
 *   // ... run tests against stub.url ...
 *   await stub.stop()
 *
 * Usage as a CLI (Bun or Node):
 *   bun run src/dev/hermes-stub.ts
 */

import * as http from "node:http"

export interface HermesStubOptions {
  /** Bearer token that callers must present. Default: "test-hermes-key" */
  token?: string
  /** Port to listen on. Default: 0 (random OS-assigned port). */
  port?: number
  /**
   * Hermes version reported in /v1/capabilities.
   * ⚠️ ASSUMPTION: field name "version" in capabilities unconfirmed vs live Hermes.
   */
  version?: string
  /** Number of SSE delta chunks to emit per completion. Default: 3. */
  deltaCount?: number
}

export interface HermesStubHandle {
  readonly url: string
  readonly port: number
  stop(): Promise<void>
}

/**
 * Start a minimal Hermes HTTP+SSE stub server.
 * Returns a handle with the base URL, port, and a stop() function.
 */
export function startHermesStub(opts?: HermesStubOptions): Promise<HermesStubHandle> {
  const TOKEN = opts?.token ?? "test-hermes-key"
  const VERSION = opts?.version ?? "0.17.0-stub"
  const DELTA_COUNT = opts?.deltaCount ?? 3

  function checkAuth(req: http.IncomingMessage): boolean {
    const auth = req.headers["authorization"] ?? ""
    if (!auth.startsWith("Bearer ")) return false
    return auth.slice("Bearer ".length).trim() === TOKEN
  }

  function sendJson(res: http.ServerResponse, body: unknown, status = 200): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(payload)
  }

  function sendUnauthorized(res: http.ServerResponse): void {
    sendJson(res, { error: "Unauthorized", code: 401 }, 401)
  }

  /**
   * Write an SSE stream for /v1/chat/completions.
   * Emits DELTA_COUNT delta chunks then a [DONE] sentinel.
   * Maps to OpenAI streaming format so HermesHttpSseAdapter can parse it.
   */
  function sendSseStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Read the request body to extract the user's message (for echo)
    let body = ""
    req.on("data", (chunk: Buffer) => { body += chunk.toString() })
    req.on("end", () => {
      let userText = "stub-response"
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> }
        const msgs = parsed.messages ?? []
        // findLast not available in all TS targets; use manual reverse scan
        let lastUser: { role: string; content: string } | undefined
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]?.role === "user") { lastUser = msgs[i]; break }
        }
        if (lastUser?.content) userText = lastUser.content
      } catch { /* use default */ }

      const messageId = `chatcmpl-stub-${Date.now()}`

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })

      // Emit delta chunks
      for (let i = 0; i < DELTA_COUNT; i++) {
        const isLast = i === DELTA_COUNT - 1
        const chunk = {
          id: messageId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "hermes-3",
          choices: [
            {
              index: 0,
              delta: { content: i === 0 ? `Echo: ${userText} ` : `[chunk-${i}] ` },
              finish_reason: isLast ? "stop" : null,
            },
          ],
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }

      // [DONE] sentinel — HermesHttpSseAdapter watches for this to close the stream
      res.write("data: [DONE]\n\n")
      res.end()
    })
  }

  return new Promise<HermesStubHandle>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const method = req.method ?? "GET"
      const url = new URL(req.url ?? "/", `http://127.0.0.1`)
      const path = url.pathname

      // ── Auth check ─────────────────────────────────────────────────────
      if (!checkAuth(req)) {
        sendUnauthorized(res)
        return
      }

      // ── GET /health ────────────────────────────────────────────────────
      if (method === "GET" && path === "/health") {
        sendJson(res, { status: "ok" })
        return
      }

      // ── GET /v1/capabilities ───────────────────────────────────────────
      if (method === "GET" && path === "/v1/capabilities") {
        sendJson(res, {
          // ⚠️ ASSUMPTION: "version" field name unconfirmed vs live Hermes /v1/capabilities
          version: VERSION,
          name: "Hermes Agent",
          description: "Nous Research Hermes Agent (stub)",
          features: ["chat", "runs", "streaming"],
          openai_compatible: true,
        })
        return
      }

      // ── GET /v1/models ─────────────────────────────────────────────────
      if (method === "GET" && path === "/v1/models") {
        sendJson(res, {
          object: "list",
          data: [
            {
              id: "hermes-3",
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: "nousresearch",
            },
          ],
        })
        return
      }

      // ── POST /v1/chat/completions ──────────────────────────────────────
      if (method === "POST" && path === "/v1/chat/completions") {
        sendSseStream(req, res)
        return
      }

      // ── GET /v1/runs ───────────────────────────────────────────────────
      if (method === "GET" && path === "/v1/runs") {
        sendJson(res, { object: "list", data: [] })
        return
      }

      // ── POST /v1/runs ──────────────────────────────────────────────────
      if (method === "POST" && path === "/v1/runs") {
        sendJson(
          res,
          {
            id: `run-stub-${Date.now()}`,
            object: "run",
            status: "queued",
            created_at: Math.floor(Date.now() / 1000),
          },
          201,
        )
        return
      }

      // ── 404 ────────────────────────────────────────────────────────────
      sendJson(res, { error: "Not found" }, 404)
    })

    server.on("error", reject)

    server.listen(opts?.port ?? 0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0

      const handle: HermesStubHandle = {
        url: `http://127.0.0.1:${port}`,
        port,
        stop(): Promise<void> {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()))
          })
        },
      }

      resolve(handle)
    })
  })
}

// ── CLI entry point ──────────────────────────────────────────────────────────

// Detect direct execution in Bun or Node (ESM import.meta.main)
// biome-ignore lint/suspicious/noExplicitAny: cross-runtime main detection
const isBunMain = typeof (globalThis as any).Bun !== "undefined" &&
  // biome-ignore lint/suspicious/noExplicitAny: Bun global
  (import.meta as any).main === true

// In Node ESM we check if this file is the entry point via argv
const isNodeMain = typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))

if (isBunMain || isNodeMain) {
  const TOKEN = process.env["HERMES_STUB_TOKEN"] ?? "test-hermes-key"
  const PORT = process.env["HERMES_STUB_PORT"] ? parseInt(process.env["HERMES_STUB_PORT"], 10) : 8642

  const stub = await startHermesStub({ token: TOKEN, port: PORT })
  console.log(`Hermes stub listening on ${stub.url}`)
  console.log(`Token: ${TOKEN}`)
  console.log("Endpoints: GET /health, GET /v1/capabilities, GET /v1/models,")
  console.log("           POST /v1/chat/completions (SSE), GET/POST /v1/runs")
  console.log("Press Ctrl+C to stop.")
}
