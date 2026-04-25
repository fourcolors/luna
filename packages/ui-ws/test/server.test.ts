/**
 * UIWebSocketServer — integration tests.
 *
 * Real http + real ws client; in-process. Coverage:
 *   - 401 on missing/wrong bearer
 *   - hello frame on connect (incl. advertisedKinds)
 *   - one whitelisted ObsEvent kind round-trips end-to-end
 *   - parametrized round-trip across every member of DEFAULT_UI_KINDS
 *     (locks the layer's kind-shape indifference)
 *   - fan-out: two clients each receive every event independently
 *   - path routing (404 on unknown, 200 on /healthz)
 *   - startup validation: refuses short token
 *
 * Slow-consumer drop and scope-leak shutdown are covered indirectly by
 * the bounded-buffer + Layer.scoped finalizer; an explicit drop test is
 * left as a follow-up because reliably stalling a localhost ws send
 * buffer in a unit test is flaky.
 */
import { afterEach, describe, expect, it } from "vitest"
import {
  Effect,
  Layer,
  ManagedRuntime,
} from "effect"
import { WebSocket } from "ws"
import { Clock } from "@experiment-agent/core"
import {
  DEFAULT_UI_KINDS,
  ObservabilityService,
  UIService,
} from "@experiment-agent/core"
import type { ObsEvent } from "@experiment-agent/core"
import { startUIWebSocketServer } from "../src/server.js"
import type { ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890" // ≥16 chars

const makeFullLayer = (config?: Parameters<typeof UIService.makeLayer>[0]) => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer(config).pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  return Layer.mergeAll(uiL, obsL, clockL)
}

const collectFrames = (
  url: string,
  headers: Record<string, string>,
  takeN: number,
  timeoutMs = 2000,
): Promise<ServerFrame[]> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    const out: ServerFrame[] = []
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`timeout: got ${out.length}/${takeN} frames`))
    }, timeoutMs)
    ws.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer)
      reject(new Error(`unexpected ${res.statusCode}`))
    })
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as ServerFrame
        out.push(frame)
        if (out.length >= takeN) {
          clearTimeout(timer)
          ws.close()
          resolve(out)
        }
      } catch (e) {
        clearTimeout(timer)
        reject(e)
      }
    })
  })

interface TestRig {
  url: string
  obsEmit: (ev: Parameters<UIService extends never ? never : ObservabilityService["emit"]>[0]) => Promise<void>
  shutdown: () => Promise<void>
}

// Service tag for the running server handle, so we can compose it as a
// Layer with the rest of the runtime — that way Layer scope owns the
// server's lifetime, and ManagedRuntime.dispose() shuts it down cleanly.
class ServerHandle extends Effect.Tag("test/ServerHandle")<
  ServerHandle,
  { readonly port: number; readonly host: string }
>() {}

const startRig = async (
  uiConfig?: Parameters<typeof UIService.makeLayer>[0],
  serverConfig?: Partial<Parameters<typeof startUIWebSocketServer>[0]>,
): Promise<TestRig> => {
  const baseLayer = makeFullLayer(uiConfig)
  const serverLayer = Layer.scoped(
    ServerHandle,
    startUIWebSocketServer({
      port: 0,
      perConnectionCapacity: serverConfig?.perConnectionCapacity ?? 256,
      pingIntervalMs: 0,
      ...serverConfig,
      token: TOKEN,
    }),
  ).pipe(Layer.provide(baseLayer))

  const fullLayer = Layer.mergeAll(serverLayer, baseLayer)
  const runtime = ManagedRuntime.make(fullLayer)

  const handle = await runtime.runPromise(ServerHandle)

  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    obsEmit: async (ev) => {
      await runtime.runPromise(
        Effect.flatMap(ObservabilityService, (obs) => obs.emit(ev)),
      )
    },
    shutdown: async () => {
      await runtime.dispose()
    },
  }
}

describe("UIWebSocketServer", () => {
  let rig: TestRig

  afterEach(async () => {
    if (rig) await rig.shutdown()
  })

  it("rejects upgrade without bearer (401)", async () => {
    rig = await startRig()
    await expect(
      collectFrames(rig.url, {}, 1, 1000),
    ).rejects.toThrow(/401|unexpected|unexpected-response/i)
  })

  it("rejects upgrade with wrong bearer (401)", async () => {
    rig = await startRig()
    await expect(
      collectFrames(rig.url, { authorization: "Bearer wrongtoken1234567" }, 1, 1000),
    ).rejects.toThrow(/401|unexpected/i)
  })

  it("sends hello frame on connect with correct bearer", async () => {
    rig = await startRig()
    const frames = await collectFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      1,
    )
    expect(frames[0]?.type).toBe("hello")
    if (frames[0]?.type === "hello") {
      expect(frames[0].protocolVersion).toBe(1)
    }
  })

  it("hello frame advertises configured kinds", async () => {
    rig = await startRig(undefined, {
      advertisedKinds: ["SessionStart", "Error"],
    })
    const frames = await collectFrames(
      rig.url,
      { authorization: `Bearer ${TOKEN}` },
      1,
    )
    if (frames[0]?.type === "hello") {
      expect([...frames[0].kinds]).toEqual(["SessionStart", "Error"])
    } else {
      throw new Error("expected hello frame")
    }
  })

  it("forwards a whitelisted event after subscribe", async () => {
    rig = await startRig()
    const url = rig.url
    // Subscribe first; emit after a short delay.
    const collectorP = collectFrames(
      url,
      { authorization: `Bearer ${TOKEN}` },
      2,
      3000,
    )
    await new Promise((r) => setTimeout(r, 100))
    await rig.obsEmit({
      kind: "SessionStart",
      ts: new Date().toISOString(),
      level: "info",
      sessionId: "s1",
      model: "x",
      optionsDigest: "y",
    })
    const frames = await collectorP
    expect(frames.map((f) => f.type)).toEqual(["hello", "event"])
    if (frames[1]?.type === "event") {
      expect(frames[1].event.kind).toBe("SessionStart")
    }
  })

  // Locks the WS layer's indifference to event shape: every kind in
  // DEFAULT_UI_KINDS round-trips end-to-end. Auditor follow-up.
  const minimalEventFor = (kind: (typeof DEFAULT_UI_KINDS)[number]): ObsEvent => {
    const ts = new Date().toISOString()
    switch (kind) {
      case "SessionStart":
        return { ts, kind, level: "info", sessionId: "s", model: "m" }
      case "SessionEnd":
        return { ts, kind, level: "info", sessionId: "s", durationMs: 1 }
      case "ToolCall":
        return {
          ts, kind, level: "info", sessionId: "s",
          toolName: "bash", durationMs: 1, status: "success",
        }
      case "TeammateStart":
        return { ts, kind, level: "info", team: "t", teammate: "tm" }
      case "TeammateIdle":
        return { ts, kind, level: "info", team: "t", teammate: "tm", idleMs: 100 }
      case "TeammateStop":
        return { ts, kind, level: "info", team: "t", teammate: "tm", reason: "done" }
      case "WorkflowTransition":
        return { ts, kind, level: "info", workflowId: "w", from: "a", to: "b" }
      case "CostAccrued":
        return {
          ts, kind, level: "info",
          tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, estimatedUsd: 0.001,
        }
      case "Error":
        return { ts, kind, level: "error", errorTag: "X", message: "y" }
      default: {
        const _exhaust: never = kind
        throw new Error(`unhandled kind: ${String(_exhaust)}`)
      }
    }
  }

  for (const kind of DEFAULT_UI_KINDS) {
    it(`round-trips ${kind} events`, async () => {
      rig = await startRig()
      const collectorP = collectFrames(
        rig.url,
        { authorization: `Bearer ${TOKEN}` },
        2,
        3000,
      )
      await new Promise((r) => setTimeout(r, 100))
      await rig.obsEmit(minimalEventFor(kind))
      const frames = await collectorP
      expect(frames[1]?.type).toBe("event")
      if (frames[1]?.type === "event") {
        expect(frames[1].event.kind).toBe(kind)
      }
    })
  }

  it("fan-out: two clients each receive the same event", async () => {
    rig = await startRig()
    const headers = { authorization: `Bearer ${TOKEN}` }
    const aP = collectFrames(rig.url, headers, 2, 3000)
    const bP = collectFrames(rig.url, headers, 2, 3000)
    await new Promise((r) => setTimeout(r, 150))
    await rig.obsEmit({
      kind: "SessionStart",
      ts: new Date().toISOString(),
      level: "info",
      sessionId: "s2",
      model: "m",
    })
    const [a, b] = await Promise.all([aP, bP])
    expect(a[1]?.type).toBe("event")
    expect(b[1]?.type).toBe("event")
  })

  it("rejects /unknown path with 404", async () => {
    rig = await startRig()
    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/unknown"))
    expect(res.status).toBe(404)
  })

  it("/healthz returns 200", async () => {
    rig = await startRig()
    const res = await fetch(rig.url.replace("ws://", "http://").replace("/ui", "/healthz"))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  it("refuses to start with token shorter than 16 chars", async () => {
    const baseLayer = makeFullLayer()
    const badLayer = Layer.scoped(
      ServerHandle,
      startUIWebSocketServer({ port: 0, token: "short" }),
    ).pipe(Layer.provide(baseLayer))
    const runtime = ManagedRuntime.make(Layer.mergeAll(badLayer, baseLayer))
    await expect(runtime.runPromise(ServerHandle)).rejects.toThrow(
      /token must be set/,
    )
    await runtime.dispose()
  })
})
