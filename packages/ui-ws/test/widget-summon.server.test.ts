/**
 * widget-summon.server.test.ts — LIVE replay behavior of the WidgetSummonBridge
 * through a real startUIWebSocketServer.
 *
 * The bridge unit tests (widget-summon-bridge.test.ts) prove the buffer/flush
 * logic in isolation; this pins the SERVER WIRING that makes it real: an
 * artifact opened while no host is connected (a Moon mid-turn reconnect) must
 * be replayed to the next connection that announces a `widget-directory`. A
 * regression in how the server hands its per-connection `send` closure to
 * `registerClient` would surface here, not in the unit tests.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import { createWidgetSummonBridge } from "../src/widget-summon-bridge.js"
import type { WidgetSummonBridge } from "../src/widget-summon-bridge.js"
import type { ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890"

const baseLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(Layer.provide(obsL), Layer.provide(clockL))
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Effect.Tag("test/WidgetSummonServerHandle")<
  ServerHandle,
  { readonly port: number }
>() {}

interface Rig {
  readonly url: string
  readonly bridge: WidgetSummonBridge
  readonly shutdown: () => Promise<void>
}

const startRig = async (): Promise<Rig> => {
  // The SAME bridge the agent tools would call — the test drives it directly
  // (openArtifact is normally invoked by widget_write/open_artifact).
  const bridge = createWidgetSummonBridge()
  const serverLayer = Layer.scoped(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        widgetSummoner: bridge,
      })
      return { port: handle.port }
    }),
  ).pipe(Layer.provide(baseLayer()))

  const runtime = ManagedRuntime.make(serverLayer)
  const handle = await runtime.runPromise(ServerHandle)
  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    bridge,
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

/** Poll until `pred` holds — used to await the server processing an inbound
 *  frame that has no client-visible ack (e.g. widget-directory registration). */
const waitUntil = (pred: () => boolean, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (pred()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil timeout"))
      setTimeout(tick, 10)
    }
    tick()
  })

let activeRig: Rig | null = null
afterEach(async () => {
  await activeRig?.shutdown()
  activeRig = null
})

describe("widget-summon bridge (live server)", () => {
  it("replays an open issued while disconnected to the next host that announces", async () => {
    activeRig = await startRig()

    // Artifact opened while NO host is connected (Moon mid-reconnect). The
    // bridge buffers it rather than dropping it.
    const queued = activeRig.bridge.openArtifact("widget:pr-99", "PR #99", "widget")
    expect(queued.ok).toBe(false)
    expect(queued.message).toContain("queued")

    // A host connects and announces its directory → the server registers it,
    // and the buffered open is flushed to this connection.
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "hello")
    client.send({ type: "widget-directory", widgets: [] })

    const opened = await client.waitFor((f) => f.type === "open-artifact-widget")
    expect(opened).toMatchObject({
      type: "open-artifact-widget",
      artifactId: "widget:pr-99",
      title: "PR #99",
      kind: "widget",
    })
    client.close()
  })

  it("delivers an open immediately to an already-announced host (no replay needed)", async () => {
    activeRig = await startRig()
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "hello")
    // Announce a NON-empty directory so the test can detect (race-free) when the
    // server has finished registering this connection as the host.
    client.send({
      type: "widget-directory",
      widgets: [{ kind: "settings.voice", title: "Voice", description: "Voice settings" }],
    })
    await waitUntil(() => activeRig!.bridge.directory().length > 0)

    const r = activeRig.bridge.openArtifact("mcp-app:dash", "Dashboard", "mcp-app")
    expect(r.ok).toBe(true)

    const opened = await client.waitFor((f) => f.type === "open-artifact-widget")
    expect(opened).toMatchObject({ artifactId: "mcp-app:dash", kind: "mcp-app" })
    client.close()
  })
})
