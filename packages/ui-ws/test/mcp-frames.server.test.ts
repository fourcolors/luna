/**
 * mcp-frames.server.test.ts — LIVE MCP-Apps relay behavior against a real
 * startUIWebSocketServer (widget-system.md Phase 7).
 *
 * Mirrors artifact-frames.server.test.ts: the host module is unit-tested in
 * mcp-app-host.test.ts; what needs RUNTIME coverage is the server WIRING —
 * the message-handler gate (an mcpApps-only server must still attach the
 * inbound handler), the hello `mcpApps` capability, and the reply landing on
 * the SAME connection with the requestId echoed.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import { createMcpAppHost } from "../src/mcp-app-host.js"
import type { ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890"
const APP_URI = "ui://luna/test-app"
const APP_HTML = "<h1>app</h1>"

const baseLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(Layer.provide(obsL), Layer.provide(clockL))
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Effect.Tag("test/McpServerHandle")<
  ServerHandle,
  { readonly port: number }
>() {}

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
}

/** MCP-apps-ONLY server rig: no chat, no artifacts — just the relay. */
const startMcpRig = async (): Promise<Rig> => {
  const host = createMcpAppHost({
    readResource: async (uri) =>
      uri === APP_URI
        ? { ok: true, mimeType: "text/html;profile=mcp-app", text: APP_HTML }
        : { ok: false, message: `unknown app resource: ${uri}` },
    callTool: async (appUri, tool, args) =>
      appUri === APP_URI && tool === "echo"
        ? { ok: true, result: { structuredContent: args } }
        : { ok: false, message: "tool not on this app" },
  })

  const serverLayer = Layer.scoped(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        mcpAppHost: host,
      })
      return { port: handle.port }
    }),
  ).pipe(Layer.provide(baseLayer()))

  const runtime = ManagedRuntime.make(serverLayer)
  const handle = await runtime.runPromise(ServerHandle)
  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    shutdown: () => runtime.dispose().then(() => {}),
  }
}

interface Client {
  readonly frames: ServerFrame[]
  readonly send: (f: unknown) => void
  readonly waitFor: (
    pred: (f: ServerFrame) => boolean,
    timeoutMs?: number,
  ) => Promise<ServerFrame>
  readonly close: () => void
}

const openClient = (url: string): Promise<Client> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const frames: ServerFrame[] = []
    const waiters: Array<{
      pred: (f: ServerFrame) => boolean
      resolve: (f: ServerFrame) => void
    }> = []
    ws.on("error", reject)
    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame
      frames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(frame)) {
          waiters[i]!.resolve(frame)
          waiters.splice(i, 1)
        }
      }
    })
    ws.on("open", () =>
      resolve({
        frames,
        send: (f) => ws.send(JSON.stringify(f)),
        waitFor: (pred, timeoutMs = 3000) => {
          const already = frames.find(pred)
          if (already) return Promise.resolve(already)
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("waitFor timeout")), timeoutMs)
            waiters.push({
              pred,
              resolve: (f) => {
                clearTimeout(t)
                res(f)
              },
            })
          })
        },
        close: () => ws.close(),
      }),
    )
  })

let activeRig: Rig | null = null
afterEach(async () => {
  await activeRig?.shutdown()
  activeRig = null
})

describe("mcp-apps-only ui-ws server (live)", () => {
  it("advertises mcpApps and ROUTES a resource read on a chat-less server (gate regression pin)", async () => {
    activeRig = await startMcpRig()
    const client = await openClient(activeRig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(hello.type === "hello" ? hello.capabilities.mcpApps : false).toBe(true)

    // A handler-gate omission (mcpAppHost missing from the ws.on("message")
    // condition) would make this time out — the exact silent-hang bug class.
    client.send({ type: "mcp-resource-read", requestId: "rr-1", uri: APP_URI })
    const out = await client.waitFor((f) => f.type === "mcp-resource-result")
    expect(out).toEqual({
      type: "mcp-resource-result",
      requestId: "rr-1",
      ok: true,
      mimeType: "text/html;profile=mcp-app",
      text: APP_HTML,
    })
    client.close()
  })

  it("tool-call round-trip replies on the SAME connection with the requestId echoed", async () => {
    activeRig = await startMcpRig()
    const a = await openClient(activeRig.url)
    const b = await openClient(activeRig.url)
    await a.waitFor((f) => f.type === "hello")
    await b.waitFor((f) => f.type === "hello")

    a.send({
      type: "mcp-tool-call",
      requestId: "tc-1",
      appUri: APP_URI,
      tool: "echo",
      args: { n: 42 },
    })
    const out = await a.waitFor((f) => f.type === "mcp-tool-result")
    expect(out).toEqual({
      type: "mcp-tool-result",
      requestId: "tc-1",
      ok: true,
      result: { structuredContent: { n: 42 } },
    })
    // Request/response is connection-scoped — the other client sees nothing.
    expect(b.frames.some((f) => f.type === "mcp-tool-result")).toBe(false)
    a.close()
    b.close()
  })

  it("unknown resource / wrong-app tool come back ok:false (and the socket survives)", async () => {
    activeRig = await startMcpRig()
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "hello")

    client.send({ type: "mcp-resource-read", requestId: "rr-2", uri: "ui://nope" })
    const readOut = await client.waitFor(
      (f) => f.type === "mcp-resource-result" && f.requestId === "rr-2",
    )
    expect(readOut.type === "mcp-resource-result" ? readOut.ok : true).toBe(false)

    client.send({
      type: "mcp-tool-call",
      requestId: "tc-2",
      appUri: "ui://nope",
      tool: "echo",
      args: {},
    })
    const callOut = await client.waitFor(
      (f) => f.type === "mcp-tool-result" && f.requestId === "tc-2",
    )
    expect(callOut.type === "mcp-tool-result" ? callOut.ok : true).toBe(false)

    // The connection is still healthy after both failures.
    client.send({ type: "mcp-resource-read", requestId: "rr-3", uri: APP_URI })
    const alive = await client.waitFor(
      (f) => f.type === "mcp-resource-result" && f.requestId === "rr-3",
    )
    expect(alive.type === "mcp-resource-result" ? alive.ok : false).toBe(true)
    client.close()
  })
})
