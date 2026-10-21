/**
 * Regression test: a WS client must never be able to claim `sandbox: true`.
 *
 * `LocalShellCapabilityFrame.sandbox` is documented (protocol.ts) as true
 * ONLY for the server's own in-process container sandbox — it is the gate
 * the bridge's `eligibleFor` uses to decide which clients an unattended
 * thread (forked-from-parent / channel / agent-created) may reach. Inbound
 * frames are JSON.parse'd with only `type` checked, so before the pin a
 * rogue WS client could send `sandbox: true` in its capability frame and
 * become reachable from unattended threads — an injection surface — and
 * could even squat the well-known `server_sandbox` clientId.
 *
 * These tests pin the trust boundary at the transport: the WS
 * `local-shell-capability` handler forces `sandbox: false`, so a client
 * asserting `sandbox: true` is registered (attended threads still see it)
 * but never passes the unattended gate.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { WebSocket } from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import { createLocalShellBridge } from "../src/local-shell-bridge.js"
import type { ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890" // >=16 chars

class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number; readonly host: string }
>()("test/ServerHandle") {}

interface Rig {
  url: string
  shutdown: () => Promise<void>
  bridge: ReturnType<typeof createLocalShellBridge>
}

const startRig = async (): Promise<Rig> => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const baseLayer = Layer.mergeAll(uiL, obsL, clockL)

  const bridge = createLocalShellBridge()

  const serverLayer = Layer.effect(
    ServerHandle,
    startUIWebSocketServer({
      port: 0,
      perConnectionCapacity: 256,
      pingIntervalMs: 0,
      surveyPollIntervalMs: 0,
      localShellBridge: bridge,
      token: TOKEN,
    }),
  ).pipe(Layer.provide(baseLayer))

  const fullLayer = Layer.mergeAll(serverLayer, baseLayer)
  const runtime = ManagedRuntime.make(fullLayer)
  const handle = await runtime.runPromise(ServerHandle)
  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    shutdown: () => runtime.dispose(),
    bridge,
  }
}

/** Connect, wait for hello, then send raw frames and wait a beat. */
const sendFrames = (url: string, frames: ReadonlyArray<unknown>): Promise<ServerFrame[]> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const out: ServerFrame[] = []
    const stop = setTimeout(() => {
      ws.close()
      resolve(out)
    }, 400)
    ws.on("error", (err) => {
      clearTimeout(stop)
      reject(err)
    })
    ws.on("message", (raw) => {
      try {
        out.push(JSON.parse(raw.toString()) as ServerFrame)
      } catch (e) {
        clearTimeout(stop)
        reject(e)
      }
    })
    ws.on("open", async () => {
      // Wait for the hello frame so the connection is fully established.
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && !out.some((f) => f.type === "hello")) {
        await new Promise((r) => setTimeout(r, 10))
      }
      for (const f of frames) ws.send(JSON.stringify(f))
    })
  })

describe("local-shell sandbox trust pin", () => {
  let shutdown: (() => Promise<void>) | undefined
  let bridge: ReturnType<typeof createLocalShellBridge> | undefined
  afterEach(async () => {
    await shutdown?.()
    shutdown = undefined
    bridge = undefined
  })

  const registerRogue = async (): Promise<void> => {
    const rig = await startRig()
    shutdown = rig.shutdown
    bridge = rig.bridge
    await sendFrames(rig.url, [
      {
        type: "local-shell-capability",
        enabled: true,
        approvalMode: "auto",
        clientId: "evil_client",
        label: "evil",
        // The lie: a WS client must never be able to claim this.
        sandbox: true,
        platform: "linux",
        cwd: "/tmp",
        roots: ["/tmp"],
        fullAccess: true,
      },
    ])
  }

  it("a WS client asserting sandbox:true is not eligible for unattended threads", async () => {
    await registerRogue()
    // Pre-pin, the rogue passed the unattended gate and appeared here.
    expect(
      bridge!.listTargets(["forked-from-parent"]).map((t) => t.clientId),
    ).toEqual([])
  })

  it("the same client is still usable from attended threads", async () => {
    await registerRogue()
    // The pin only strips the sandbox claim; legitimate WS registration
    // (attended threads) is unaffected.
    expect(bridge!.listTargets([]).map((t) => t.clientId)).toEqual([
      "evil_client",
    ])
  })
})
