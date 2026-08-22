/**
 * capability-execute.server.test.ts — LIVE capability-layer behavior against a
 * real startUIWebSocketServer. Mirrors skill-toggle.server.test.ts (the
 * protocol tests are type/serialization-only; the ROUTING needs runtime
 * coverage so a handler-gate omission can't ship silently).
 *
 * Pins:
 *   - hello advertises capabilities.commands:true when a capabilityRegistry is
 *     bound, and false when it is not
 *   - a capability-catalog is pushed to a freshly-connected socket, carrying
 *     the `interrupt` descriptor
 *   - a valid capability-execute returns capability-execute-result{ok:true}
 *     UNICAST to the sender — a SECOND connected socket receives NOTHING
 *     (the no-leak regression: this is a response, not catalog state)
 *   - malformed capability-execute (missing requestId/kind/id) acks ok:false
 *     and never throws / tears down the connection
 *   - OR-guard regression: the case fires on a capabilities-ONLY server (no
 *     chat) — proving it is not dead-registered
 *   - an execute DEFECT acks ok:false (catchCause) without killing the conn
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type { ServerFrame, WireCapabilityCatalog } from "../src/protocol.js"

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
>()("test/CapabilityServerHandle") {}

const makeCatalog = (): WireCapabilityCatalog => ({
  generation: 1,
  agreedSchema: 1,
  capabilities: [
    {
      kind: "command",
      id: "interrupt",
      title: "Stop",
      description: "Stop the current assistant turn",
      executor: "server",
      schemaVersion: 1,
    },
  ],
})

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
  readonly executeCalls: Array<{
    kind: string
    id: string
    args?: Record<string, unknown>
  }>
}

/**
 * Capabilities-ONLY server rig: a fake capabilityRegistry and NO chat service.
 * Running execute here proves the OR-guard fires (handler attached without a
 * chat). `executeCalls` records every forwarded request for args-passthrough
 * assertions. `id:"boom"` returns a DEFECT to exercise the catchCause path.
 */
const startCapabilitiesRig = async (): Promise<Rig> => {
  const executeCalls: Rig["executeCalls"] = []

  const serverLayer = Layer.effect(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        capabilityRegistry: {
          catalog: () => Effect.succeed(makeCatalog()),
          execute: (req) => {
            executeCalls.push(req)
            if (req.id === "interrupt") return Effect.succeed({ ok: true })
            if (req.id === "boom") return Effect.die(new Error("kaboom"))
            return Effect.succeed({
              ok: false,
              message: `unknown capability ${req.id}`,
            })
          },
        },
      })
      return { port: handle.port }
    }),
  ).pipe(Layer.provide(baseLayer()))

  const runtime = ManagedRuntime.make(serverLayer)
  const handle = await runtime.runPromise(ServerHandle)
  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    shutdown: () => runtime.dispose().then(() => {}),
    executeCalls,
  }
}

/** A server with NO capabilityRegistry — hello must report commands:false. */
const startBareRig = async (): Promise<Rig> => {
  const serverLayer = Layer.effect(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
      })
      return { port: handle.port }
    }),
  ).pipe(Layer.provide(baseLayer()))

  const runtime = ManagedRuntime.make(serverLayer)
  const handle = await runtime.runPromise(ServerHandle)
  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    shutdown: () => runtime.dispose().then(() => {}),
    executeCalls: [],
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
            const t = setTimeout(
              () => rej(new Error("waitFor timeout")),
              timeoutMs,
            )
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

const wait = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

let activeRig: Rig | null = null
afterEach(async () => {
  await activeRig?.shutdown()
  activeRig = null
})

describe("capability layer ui-ws server (live)", () => {
  it("advertises commands:true and pushes a capability-catalog with the interrupt descriptor (OR-guard fires with no chat)", async () => {
    activeRig = await startCapabilitiesRig()
    const client = await openClient(activeRig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(hello.type === "hello" ? hello.capabilities.commands : false).toBe(
      true,
    )

    const catalog = await client.waitFor((f) => f.type === "capability-catalog")
    if (catalog.type === "capability-catalog") {
      expect(catalog.catalog.generation).toBe(1)
      expect(catalog.catalog.agreedSchema).toBe(1)
      expect(catalog.catalog.capabilities).toHaveLength(1)
      const d = catalog.catalog.capabilities[0]!
      expect(d).toMatchObject({
        kind: "command",
        id: "interrupt",
        title: "Stop",
        executor: "server",
        schemaVersion: 1,
      })
    }
    client.close()
  })

  it("reports commands:false when no capabilityRegistry is bound", async () => {
    activeRig = await startBareRig()
    const client = await openClient(activeRig.url)
    const hello = await client.waitFor((f) => f.type === "hello")
    expect(
      hello.type === "hello" ? (hello.capabilities.commands ?? false) : true,
    ).toBe(false)
    // A capabilities-free server never pushes a capability-catalog.
    await wait(100)
    expect(
      client.frames.filter((f) => f.type === "capability-catalog"),
    ).toHaveLength(0)
    client.close()
  })

  it("UNICASTs the execute result to the SENDER only — a second socket receives NOTHING (no-leak regression)", async () => {
    activeRig = await startCapabilitiesRig()
    const a = await openClient(activeRig.url)
    const b = await openClient(activeRig.url)
    await a.waitFor((f) => f.type === "capability-catalog")
    await b.waitFor((f) => f.type === "capability-catalog")

    a.send({
      type: "capability-execute",
      requestId: "r1",
      kind: "command",
      id: "interrupt",
      args: { threadId: "t1" },
    })
    const res = await a.waitFor((f) => f.type === "capability-execute-result")
    expect(res).toMatchObject({
      type: "capability-execute-result",
      requestId: "r1",
      ok: true,
    })

    // Let any erroneous broadcast arrive, then assert B saw NOTHING.
    await wait(150)
    expect(
      b.frames.filter((f) => f.type === "capability-execute-result"),
    ).toHaveLength(0)

    // The server forwarded args verbatim to the registry.
    expect(activeRig.executeCalls).toContainEqual({
      kind: "command",
      id: "interrupt",
      args: { threadId: "t1" },
    })
    a.close()
    b.close()
  })

  it("rejects malformed capability-execute (missing requestId/kind/id) with ok:false and never throws", async () => {
    activeRig = await startCapabilitiesRig()
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "capability-catalog")

    // Missing requestId.
    client.send({ type: "capability-execute", kind: "command", id: "interrupt" })
    const m1 = await client.waitFor(
      (f) => f.type === "capability-execute-result",
    )
    expect(m1).toMatchObject({
      ok: false,
      message: "malformed capability-execute frame",
    })

    // Missing kind.
    client.send({ type: "capability-execute", requestId: "r2", id: "interrupt" })
    const m2 = await client.waitFor(
      (f) => f.type === "capability-execute-result" && f.requestId === "r2",
    )
    expect(m2).toMatchObject({ requestId: "r2", ok: false })

    // Missing id.
    client.send({ type: "capability-execute", requestId: "r3", kind: "command" })
    const m3 = await client.waitFor(
      (f) => f.type === "capability-execute-result" && f.requestId === "r3",
    )
    expect(m3).toMatchObject({ requestId: "r3", ok: false })

    // The registry was never touched by any of the malformed frames.
    expect(activeRig.executeCalls).toHaveLength(0)

    // Connection still alive: a valid execute still works.
    client.send({
      type: "capability-execute",
      requestId: "r4",
      kind: "command",
      id: "interrupt",
    })
    const ok = await client.waitFor(
      (f) => f.type === "capability-execute-result" && f.requestId === "r4",
    )
    expect(ok).toMatchObject({ requestId: "r4", ok: true })
    client.close()
  })

  it("acks unknown ids ok:false and survives an execute DEFECT (catchCause)", async () => {
    activeRig = await startCapabilitiesRig()
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "capability-catalog")

    // Unknown id → registry returns ok:false with a message.
    client.send({
      type: "capability-execute",
      requestId: "u1",
      kind: "command",
      id: "ghost",
    })
    const unknown = await client.waitFor(
      (f) => f.type === "capability-execute-result" && f.requestId === "u1",
    )
    expect(unknown).toMatchObject({ requestId: "u1", ok: false })
    expect(
      unknown.type === "capability-execute-result" ? unknown.message : "",
    ).toContain("unknown capability ghost")

    // Defect → catchCause acks ok:false without tearing down the conn.
    client.send({
      type: "capability-execute",
      requestId: "boom1",
      kind: "command",
      id: "boom",
    })
    const boom = await client.waitFor(
      (f) => f.type === "capability-execute-result" && f.requestId === "boom1",
    )
    expect(boom).toMatchObject({ requestId: "boom1", ok: false })

    // Still usable afterwards.
    client.send({
      type: "capability-execute",
      requestId: "after",
      kind: "command",
      id: "interrupt",
    })
    const after = await client.waitFor(
      (f) => f.type === "capability-execute-result" && f.requestId === "after",
    )
    expect(after).toMatchObject({ requestId: "after", ok: true })
    client.close()
  })
})
