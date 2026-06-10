/**
 * artifact-frames.server.test.ts — LIVE artifact-frame behavior against a
 * real startUIWebSocketServer, backed by the real ArtifactStore.Memory.
 *
 * Mirrors skill-toggle.server.test.ts (the protocol tests are
 * type/serialization-only; the pin/unpin ROUTING needs runtime coverage so a
 * handler-gate omission can't ship silently — the exact class of bug the
 * skills track hit).
 *
 * Pins:
 *   - an ARTIFACTS-ONLY server (no chat) attaches the message handler and
 *     advertises capabilities.artifacts
 *   - artifact-list arrives after hello with the seeded pin
 *   - pin round-trip: artifact-pin → store → broadcast artifact-list with it
 *   - unpin round-trip: artifact-unpin → broadcast artifact-list without it
 *   - the broadcast reaches OTHER connected clients
 *   - the `changes` hook broadcasts to every client
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { ArtifactStore, Clock, ObservabilityService, UIService } from "@luna/core"
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

class ServerHandle extends Effect.Tag("test/ArtifactServerHandle")<
  ServerHandle,
  { readonly port: number }
>() {}

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
  readonly notifyChange: () => void
  readonly editSeed: () => Promise<void>
}

/**
 * Artifacts-ONLY server rig: a real ArtifactStore.Memory seeded with one pin,
 * NO chat service. `changes` captures the broadcast hook like chat-server does;
 * `editSeed` mutates the store out-of-band to exercise that hook.
 */
const startArtifactsRig = async (): Promise<Rig> => {
  let notify: (() => void) | null = null
  // Captured inside the scoped layer so the changes-hook test can mutate the
  // SAME store the server reads (an agent edit, out of band from any client).
  let editSeed: () => Promise<void> = async () => {}

  const serverLayer = Layer.scoped(
    ServerHandle,
    Effect.gen(function* () {
      const store = yield* ArtifactStore
      // Seed one pin so the post-hello artifact-list is non-empty.
      yield* store.pin({ id: "seed:0", title: "Seed", lang: "ts", content: "x" })
      editSeed = () =>
        Effect.runPromise(
          store
            .update("seed:0", "edited", "agent")
            .pipe(Effect.provide(Clock.Default)) as Effect.Effect<unknown>,
        ).then(() => notify?.())

      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        artifactStore: {
          list: () => store.list(),
          pin: (input) => store.pin(input),
          unpin: (id) => store.unpin(id),
          changes: (n) => {
            notify = n
          },
        },
      })
      return { port: handle.port }
    }),
  ).pipe(Layer.provide(ArtifactStore.Memory), Layer.provide(baseLayer()))

  const runtime = ManagedRuntime.make(serverLayer)
  const handle = await runtime.runPromise(ServerHandle)
  return {
    url: `ws://127.0.0.1:${handle.port}/ui`,
    shutdown: () => runtime.dispose().then(() => {}),
    notifyChange: () => notify?.(),
    editSeed: () => editSeed(),
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

const pinned = (f: ServerFrame): ReadonlyArray<{ id: string }> =>
  f.type === "artifact-list" ? f.artifacts : []

describe("artifacts-only ui-ws server (live)", () => {
  it("advertises artifacts, sends the seeded list, and ROUTES pins (gate regression pin)", async () => {
    activeRig = await startArtifactsRig()
    const client = await openClient(activeRig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(hello.type === "hello" ? hello.capabilities.artifacts : false).toBe(true)

    const list = await client.waitFor((f) => f.type === "artifact-list")
    expect(pinned(list).map((a) => a.id)).toEqual(["seed:0"])

    // Pin round-trip — on a server with NO chat service. A handler-gate
    // omission would make this time out.
    client.send({
      type: "artifact-pin",
      id: "msg-9:1",
      title: "New",
      lang: "md",
      content: "# hi",
    })
    const afterPin = await client.waitFor(
      (f) => f.type === "artifact-list" && pinned(f).some((a) => a.id === "msg-9:1"),
    )
    // Most-recently-updated first: the new pin leads.
    expect(pinned(afterPin)[0]!.id).toBe("msg-9:1")
    expect(pinned(afterPin).map((a) => a.id).sort()).toEqual(["msg-9:1", "seed:0"])
    client.close()
  })

  it("unpin round-trip removes the artifact from the broadcast list", async () => {
    activeRig = await startArtifactsRig()
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "artifact-list")

    client.send({ type: "artifact-unpin", id: "seed:0" })
    const afterUnpin = await client.waitFor(
      (f) => f.type === "artifact-list" && pinned(f).every((a) => a.id !== "seed:0"),
    )
    expect(pinned(afterUnpin)).toEqual([])
    client.close()
  })

  it("broadcasts to OTHER clients on pin, and on changes-notify (agent edit)", async () => {
    activeRig = await startArtifactsRig()
    const a = await openClient(activeRig.url)
    const b = await openClient(activeRig.url)
    await a.waitFor((f) => f.type === "artifact-list")
    await b.waitFor((f) => f.type === "artifact-list")

    // Client A pins; client B must receive the refreshed list.
    a.send({ type: "artifact-pin", id: "shared:0", title: "S", content: "y" })
    const bSaw = await b.waitFor(
      (f) => f.type === "artifact-list" && pinned(f).some((x) => x.id === "shared:0"),
    )
    expect(pinned(bSaw).some((x) => x.id === "shared:0")).toBe(true)

    // Out-of-band agent edit → the changes hook broadcasts an updated head to all.
    const beforeA = a.frames.filter((f) => f.type === "artifact-list").length
    await activeRig.editSeed()
    await a.waitFor(
      (f) =>
        f.type === "artifact-list" &&
        a.frames.filter((x) => x.type === "artifact-list").length > beforeA,
    )
    const latest = [...a.frames].reverse().find((f) => f.type === "artifact-list")!
    const seed = pinned(latest).find((x) => x.id === "seed:0") as
      | { content: string; version: number }
      | undefined
    expect(seed?.content).toBe("edited")
    expect(seed?.version).toBe(2)
    a.close()
    b.close()
  })
})
