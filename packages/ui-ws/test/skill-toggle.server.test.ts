/**
 * skill-toggle.server.test.ts — LIVE skill-frame behavior against a real
 * startUIWebSocketServer (review finding: the protocol tests were
 * type/serialization-only; the toggle ROUTING had zero runtime coverage,
 * which let the handler-gate omission ship).
 *
 * Pins:
 *   - a SKILLS-ONLY server (no chat) attaches the message handler — the
 *     gate regression made toggles vanish silently
 *   - toggle round-trip: skill-status ok + refreshed catalog
 *   - the refreshed catalog BROADCASTS to other connected clients
 *   - the `changes` hook broadcasts hot-load deltas to every client
 *   - malformed skill-toggle frames are rejected with ok:false
 *   - the wire-projection strips smuggled body fields (defence-in-depth)
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Ref } from "effect"
import WebSocket from "ws"
import {
  Clock,
  ObservabilityService,
  UIService,
} from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type {
  ServerFrame,
  SkillCatalogItem,
} from "../src/protocol.js"

const TOKEN = "test-token-1234567890"

const baseLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(Layer.provide(obsL), Layer.provide(clockL))
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Effect.Tag("test/SkillServerHandle")<
  ServerHandle,
  { readonly port: number }
>() {}

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
  readonly notifyChange: () => void
}

/**
 * Skills-ONLY server rig: an in-memory registry handle (with a deliberate
 * body-smuggling entry to exercise the wire projection) and NO chat
 * service. `changes` captures the broadcast hook like chat-server does.
 */
const startSkillsRig = async (): Promise<Rig> => {
  type Entry = SkillCatalogItem & { body?: string }
  const makeEntries = (enabledA: boolean): Entry[] => [
    {
      id: "alpha",
      name: "Alpha",
      description: "First.",
      whenToUse: "When alpha.",
      category: "other",
      tags: ["a"],
      source: "builtin",
      enabled: enabledA,
      body: "SMUGGLED-BODY-ALPHA", // must NEVER survive to the wire
    },
    {
      id: "beta",
      name: "Beta",
      description: "Second.",
      whenToUse: "When beta.",
      category: "other",
      tags: ["b"],
      source: "builtin",
      enabled: true,
    },
  ]
  let notify: (() => void) | null = null

  const serverLayer = Layer.scoped(
    ServerHandle,
    Effect.gen(function* () {
      const enabledA = yield* Ref.make(true)
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        skillRegistry: {
          catalog: () => Ref.get(enabledA).pipe(Effect.map(makeEntries)),
          setEnabled: (id, enabled) =>
            id === "alpha"
              ? Ref.set(enabledA, enabled)
              : Effect.fail(new Error(`unknown skill "${id}"`)),
          changes: (n) => {
            notify = n
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
    notifyChange: () => notify?.(),
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

let activeRig: Rig | null = null
afterEach(async () => {
  await activeRig?.shutdown()
  activeRig = null
})

describe("skills-only ui-ws server (live)", () => {
  it("advertises skills, sends a body-stripped catalog, and ROUTES toggles (gate regression pin)", async () => {
    activeRig = await startSkillsRig()
    const client = await openClient(activeRig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(
      hello.type === "hello" ? hello.capabilities.skills : false,
    ).toBe(true)

    const catalog = await client.waitFor((f) => f.type === "skill-catalog")
    expect(JSON.stringify(catalog)).not.toContain("SMUGGLED-BODY")
    if (catalog.type === "skill-catalog") {
      expect(catalog.skills.map((s) => s.id)).toEqual(["alpha", "beta"])
      expect(Object.keys(catalog.skills[0]!).sort()).toEqual([
        "category", "description", "enabled", "id", "name", "source", "tags", "whenToUse",
      ])
    }

    // Toggle round-trip — on a server with NO chat service. Before the
    // gate fix this timed out: the message handler was never attached.
    client.send({ type: "skill-toggle", id: "alpha", enabled: false })
    const status = await client.waitFor((f) => f.type === "skill-status")
    expect(status).toMatchObject({ id: "alpha", enabled: false, ok: true })
    const refreshed = await client.waitFor(
      (f) =>
        f.type === "skill-catalog" &&
        f.skills.some((s) => s.id === "alpha" && !s.enabled),
    )
    expect(JSON.stringify(refreshed)).not.toContain("SMUGGLED-BODY")
    client.close()
  })

  it("broadcasts the refreshed catalog to OTHER clients on toggle, and on changes-notify", async () => {
    activeRig = await startSkillsRig()
    const a = await openClient(activeRig.url)
    const b = await openClient(activeRig.url)
    await a.waitFor((f) => f.type === "skill-catalog")
    await b.waitFor((f) => f.type === "skill-catalog")

    // Client A toggles; client B must receive the refreshed catalog.
    a.send({ type: "skill-toggle", id: "alpha", enabled: false })
    const bSaw = await b.waitFor(
      (f) =>
        f.type === "skill-catalog" &&
        f.skills.some((s) => s.id === "alpha" && !s.enabled),
    )
    expect(JSON.stringify(bSaw)).not.toContain("SMUGGLED-BODY")

    // Hot-load delta: the changes hook broadcasts to everyone.
    const beforeA = a.frames.filter((f) => f.type === "skill-catalog").length
    const beforeB = b.frames.filter((f) => f.type === "skill-catalog").length
    activeRig.notifyChange()
    await a.waitFor(
      (f) =>
        f.type === "skill-catalog" &&
        a.frames.filter((x) => x.type === "skill-catalog").length > beforeA,
    )
    await b.waitFor(
      (f) =>
        f.type === "skill-catalog" &&
        b.frames.filter((x) => x.type === "skill-catalog").length > beforeB,
    )
    a.close()
    b.close()
  })

  it("rejects malformed toggles (non-string id / non-bool enabled) and acks unknown ids ok:false", async () => {
    activeRig = await startSkillsRig()
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "skill-catalog")

    client.send({ type: "skill-toggle", id: 42, enabled: false })
    const malformed = await client.waitFor((f) => f.type === "skill-status")
    expect(malformed).toMatchObject({ ok: false, message: "malformed skill-toggle frame" })

    client.send({ type: "skill-toggle", id: "ghost", enabled: true })
    const unknown = await client.waitFor(
      (f) => f.type === "skill-status" && f.id === "ghost",
    )
    expect(unknown).toMatchObject({ id: "ghost", ok: false })
    expect(
      unknown.type === "skill-status" ? unknown.message : "",
    ).toContain("unknown skill")
    client.close()
  })
})
