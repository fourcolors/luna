/**
 * agent-list.server.test.ts — LIVE agent-roster behavior against a real
 * startUIWebSocketServer (agent sidebar S1).
 *
 * Pins:
 *   - a server with an agentRoster handle advertises capabilities.agents
 *     and sends an `agent-list` frame after `hello`, metadata only
 *   - the frame's rows carry EXACTLY {name, description} keys
 *   - a server WITHOUT the handle omits the capability and never sends
 *     the frame (additive gating — the old-server story)
 *
 * Rig mirrors skill-toggle.server.test.ts exactly (no chat service, port 0,
 * ManagedRuntime dispose in afterEach).
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
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

class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number }
>()("test/AgentListServerHandle") {}

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
}

const startRig = async (withRoster: boolean): Promise<Rig> => {
  const serverLayer = Layer.effect(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        ...(withRoster
          ? {
              agentRoster: {
                list: () =>
                  Effect.succeed([
                    { name: "advisor", description: "Critiques plans." },
                    { name: "dev-agent", description: "Ships PRs." },
                  ]),
              },
            }
          : {}),
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

describe("agent-list over a live ui-ws server", () => {
  it("advertises capabilities.agents and sends agent-list after hello", async () => {
    activeRig = await startRig(true)
    const client = await openClient(activeRig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(hello.type === "hello" ? hello.capabilities.agents : false).toBe(true)

    const list = await client.waitFor((f) => f.type === "agent-list")
    if (list.type === "agent-list") {
      expect(list.agents.map((a) => a.name)).toEqual(["advisor", "dev-agent"])
      // Wire-safety pin: exact key set on every row.
      for (const row of list.agents) {
        expect(Object.keys(row).sort()).toEqual(["description", "name"])
      }
    }
    client.close()
  })

  it("omits the capability and the frame when no roster is bound (old-server story)", async () => {
    activeRig = await startRig(false)
    const client = await openClient(activeRig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(
      hello.type === "hello" ? hello.capabilities.agents ?? false : true,
    ).toBe(false)

    // Give a would-be agent-list a moment to arrive, then assert it never did.
    await new Promise((r) => setTimeout(r, 150))
    expect(client.frames.some((f) => f.type === "agent-list")).toBe(false)
    client.close()
  })
})
