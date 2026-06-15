/**
 * model-routing.server.test.ts — LIVE model-routing-frame routing against a
 * real startUIWebSocketServer, using a fake modelRoutingService handle.
 * Mirrors vault-routing.server.test.ts.
 *
 * Pins:
 *   - a MODEL-ROUTING-ONLY server (no chat) advertises capabilities.modelRouting = true
 *   - model-routing-list arrives after hello with the seeded config
 *   - model-routing-save → validate → persist → model-routing-status(ok:true)
 *     + fresh model-routing-list sent to requesting client
 *   - model-routing-save failure → model-routing-status(ok:false, message)
 *   - scheduleRestart is called after a successful save
 *   - re-broadcast: a second connected client receives model-routing-list
 *     after a successful save from the first client
 *   - no-secret-on-wire: credentialRef is an opaque pointer; no raw value in any frame
 *   - a server WITHOUT modelRoutingService: capabilities.modelRouting absent;
 *     no model-routing-list pushed; model-routing-save frames are silently ignored
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type {
  ServerFrame,
  ModelRoutingListFrame,
  ModelRoutingStatusFrame,
  ProviderSettingsItem,
  RoleBindingItem,
} from "../src/protocol.js"

const TOKEN = "test-model-routing-token-5678"

const baseLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(Layer.provide(obsL), Layer.provide(clockL))
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Effect.Tag("test/ModelRoutingServerHandle")<
  ServerHandle,
  { readonly port: number }
>() {}

/* -------------------------------------------------------------------------- */
/* Fake modelRoutingService                                                    */
/* -------------------------------------------------------------------------- */

const SEED_PROVIDERS: ProviderSettingsItem[] = [
  { kind: "anthropic", enabled: true, credentialRef: "env:ANTHROPIC_API_KEY" },
]
const SEED_ROLE_BINDINGS: RoleBindingItem[] = [
  {
    role: "daily-driver",
    preferenceList: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
  },
]

const makeFakeModelRoutingService = (
  opts: { failOnSave?: boolean } = {},
) => {
  let providers: ProviderSettingsItem[] = [...SEED_PROVIDERS]
  let roleBindings: RoleBindingItem[] = [...SEED_ROLE_BINDINGS]
  const scheduleRestart = vi.fn()

  const svc = {
    list: (): ModelRoutingListFrame => ({
      type: "model-routing-list" as const,
      providers,
      roleBindings,
    }),
    save: (input: {
      readonly providers: ReadonlyArray<ProviderSettingsItem>
      readonly roleBindings: ReadonlyArray<RoleBindingItem>
    }): { readonly ok: boolean; readonly message: string } => {
      if (opts.failOnSave) {
        return { ok: false, message: "validation failure for test" }
      }
      providers = [...input.providers]
      roleBindings = [...input.roleBindings]
      return { ok: true, message: "Model routing settings saved. Restart to apply." }
    },
    scheduleRestart,
  }
  return { svc, scheduleRestart }
}

/* -------------------------------------------------------------------------- */
/* Test rig                                                                    */
/* -------------------------------------------------------------------------- */

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
}

const startModelRoutingRig = async (
  modelRoutingService: ReturnType<typeof makeFakeModelRoutingService>["svc"] | null,
): Promise<Rig> => {
  const serverLayer = Layer.scoped(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        modelRoutingService,
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
  readonly waitFor: (pred: (f: ServerFrame) => boolean, timeoutMs?: number) => Promise<ServerFrame>
  readonly close: () => void
}

const openClient = (url: string): Promise<Client> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } })
    const frames: ServerFrame[] = []
    const waiters: Array<{
      pred: (f: ServerFrame) => boolean
      resolve: (f: ServerFrame) => void
      reject: (e: Error) => void
    }> = []
    ws.on("error", reject)
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerFrame
      frames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!
        if (w.pred(frame)) {
          waiters.splice(i, 1)
          w.resolve(frame)
        }
      }
    })
    ws.on("open", () =>
      resolve({
        frames,
        send: (f) => ws.send(JSON.stringify(f)),
        waitFor: (pred, timeoutMs = 2000) =>
          new Promise((res, rej) => {
            const existing = frames.find(pred)
            if (existing) { res(existing); return }
            const tid = setTimeout(() => rej(new Error("waitFor timeout")), timeoutMs)
            waiters.push({
              pred,
              resolve: (f) => { clearTimeout(tid); res(f) },
              reject: rej,
            })
          }),
        close: () => ws.close(),
      }),
    )
  })

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("model-routing server routing", () => {
  let rig: Rig | null = null

  afterEach(async () => {
    await rig?.shutdown()
    rig = null
    vi.restoreAllMocks()
  })

  it("hello advertises capabilities.modelRouting=true when modelRoutingService is present", async () => {
    const { svc } = makeFakeModelRoutingService()
    rig = await startModelRoutingRig(svc)
    const client = await openClient(rig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(
      (hello as { capabilities: { modelRouting?: boolean } }).capabilities.modelRouting,
    ).toBe(true)

    client.close()
  })

  it("model-routing-list is pushed after hello with seeded config (no secret values on wire)", async () => {
    const { svc } = makeFakeModelRoutingService()
    rig = await startModelRoutingRig(svc)
    const client = await openClient(rig.url)

    const list = await client.waitFor(
      (f) => f.type === "model-routing-list",
    ) as ModelRoutingListFrame
    expect(list.providers).toHaveLength(1)
    expect(list.providers[0]?.kind).toBe("anthropic")
    expect(list.providers[0]?.enabled).toBe(true)
    // credentialRef is an opaque pointer — present but NEVER a raw secret value.
    expect(list.providers[0]?.credentialRef).toBe("env:ANTHROPIC_API_KEY")
    // No raw API key or secret value anywhere in any frame.
    const json = JSON.stringify(client.frames)
    expect(json).not.toMatch(/sk-ant|Bearer|secret|password/i)

    expect(list.roleBindings).toHaveLength(1)
    expect(list.roleBindings[0]?.role).toBe("daily-driver")
    expect(list.roleBindings[0]?.preferenceList[0]?.model).toBe("claude-sonnet-4-6")

    client.close()
  })

  it("model-routing-save success: save → validate → persist → status(ok:true) + fresh list + scheduleRestart called", async () => {
    const { svc, scheduleRestart } = makeFakeModelRoutingService()
    rig = await startModelRoutingRig(svc)
    const client = await openClient(rig.url)
    // Wait for post-hello list before mutating.
    await client.waitFor((f) => f.type === "model-routing-list")

    const newProviders: ProviderSettingsItem[] = [
      { kind: "anthropic", enabled: true, credentialRef: "env:ANTHROPIC_API_KEY" },
      { kind: "openai", enabled: false },
    ]
    const newBindings: RoleBindingItem[] = [
      {
        role: "advisor",
        preferenceList: [{ provider: "anthropic", model: "claude-opus-4-8" }],
      },
    ]

    client.send({
      type: "model-routing-save",
      requestId: "req-save-001",
      providers: newProviders,
      roleBindings: newBindings,
    })

    const status = await client.waitFor(
      (f) =>
        f.type === "model-routing-status" &&
        (f as ModelRoutingStatusFrame).requestId === "req-save-001",
    ) as ModelRoutingStatusFrame
    expect(status.ok).toBe(true)
    expect(status.requestId).toBe("req-save-001")
    // Message must not echo any raw credential value.
    expect(status.message).not.toMatch(/sk-ant|Bearer|secret/i)

    // A fresh model-routing-list arrives after the status.
    const updatedList = await client.waitFor(
      (f) =>
        f.type === "model-routing-list" &&
        (f as ModelRoutingListFrame).providers.length === 2,
    ) as ModelRoutingListFrame
    expect(updatedList.providers.some((p) => p.kind === "openai")).toBe(true)
    // credentialRef stays opaque in the updated list too.
    const json = JSON.stringify(updatedList)
    expect(json).not.toMatch(/sk-ant|Bearer|secret|password/i)

    // scheduleRestart must be called after a successful save.
    expect(scheduleRestart).toHaveBeenCalledTimes(1)

    client.close()
  })

  it("model-routing-save failure: status(ok:false, message); scheduleRestart NOT called", async () => {
    const { svc, scheduleRestart } = makeFakeModelRoutingService({ failOnSave: true })
    rig = await startModelRoutingRig(svc)
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "model-routing-list")

    client.send({
      type: "model-routing-save",
      requestId: "req-save-fail",
      providers: [],
      roleBindings: [],
    })

    const status = await client.waitFor(
      (f) =>
        f.type === "model-routing-status" &&
        (f as ModelRoutingStatusFrame).requestId === "req-save-fail",
    ) as ModelRoutingStatusFrame
    expect(status.ok).toBe(false)
    expect(status.message).toBe("validation failure for test")

    // scheduleRestart must NOT be called on failure.
    expect(scheduleRestart).not.toHaveBeenCalled()

    client.close()
  })

  it("re-broadcast: second client receives model-routing-list after save from first client", async () => {
    const { svc } = makeFakeModelRoutingService()
    rig = await startModelRoutingRig(svc)
    const client1 = await openClient(rig.url)
    const client2 = await openClient(rig.url)

    // Wait for both to receive the initial post-hello list.
    await client1.waitFor((f) => f.type === "model-routing-list")
    await client2.waitFor((f) => f.type === "model-routing-list")

    // Snapshot client2's list count AFTER the initial list is in.
    const listsBefore = client2.frames.filter((f) => f.type === "model-routing-list").length

    // Save a config that produces a list with empty roleBindings
    // (distinct from the seeded list with one binding — so we can tell the
    // fresh broadcast apart from the boot list).
    client1.send({
      type: "model-routing-save",
      requestId: "req-broadcast-001",
      providers: [{ kind: "anthropic", enabled: true }],
      roleBindings: [],
    })

    // Client1 gets status.
    await client1.waitFor(
      (f) =>
        f.type === "model-routing-status" &&
        (f as ModelRoutingStatusFrame).requestId === "req-broadcast-001",
    )

    // Client2 MUST also receive a fresh model-routing-list (the broadcast).
    // The broadcast list has empty roleBindings (the saved state) — wait for it.
    await client2.waitFor(
      (f) =>
        f.type === "model-routing-list" &&
        (f as ModelRoutingListFrame).roleBindings.length === 0,
    )
    const listsAfter = client2.frames.filter((f) => f.type === "model-routing-list").length
    expect(listsAfter).toBeGreaterThan(listsBefore)

    client1.close()
    client2.close()
  })

  it("no-secret-on-wire: credentialRef is opaque — no raw secret value in any frame", async () => {
    const { svc } = makeFakeModelRoutingService()
    rig = await startModelRoutingRig(svc)
    const client = await openClient(rig.url)

    await client.waitFor((f) => f.type === "model-routing-list")

    // Send a save with an opaque ref (NOT a raw secret).
    client.send({
      type: "model-routing-save",
      requestId: "req-wire-safety",
      providers: [
        {
          kind: "anthropic",
          enabled: true,
          credentialRef: "env:ANTHROPIC_API_KEY", // opaque pointer only
        },
      ],
      roleBindings: [],
    })

    await client.waitFor(
      (f) =>
        f.type === "model-routing-status" &&
        (f as ModelRoutingStatusFrame).requestId === "req-wire-safety",
    )

    // Inspect ALL frames: no raw secret, no literal API key pattern.
    const allJson = JSON.stringify(client.frames)
    // These are the patterns a raw key would contain — ensure none leaked.
    expect(allJson).not.toMatch(/sk-ant-api|sk-[A-Za-z0-9]{20,}/)
    // The opaque ref IS present (that's its purpose) — it's the pointer, not the value.
    expect(allJson).toContain("env:ANTHROPIC_API_KEY")

    client.close()
  })

  it("server WITHOUT modelRoutingService: capabilities.modelRouting absent; no model-routing-list; save ignored", async () => {
    rig = await startModelRoutingRig(null)
    const client = await openClient(rig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(
      (hello as { capabilities: Record<string, unknown> }).capabilities.modelRouting,
    ).toBeFalsy()

    // No model-routing-list after hello.
    await new Promise((r) => setTimeout(r, 80))
    const listFrames = client.frames.filter((f) => f.type === "model-routing-list")
    expect(listFrames).toHaveLength(0)

    // model-routing-save should be silently ignored (no model-routing-status reply).
    const frameCountBefore = client.frames.length
    client.send({
      type: "model-routing-save",
      requestId: "req-ignored",
      providers: [],
      roleBindings: [],
    })
    await new Promise((r) => setTimeout(r, 80))
    const statusFrames = client.frames.filter((f) => f.type === "model-routing-status")
    expect(statusFrames).toHaveLength(0)
    expect(client.frames.length).toBe(frameCountBefore)

    client.close()
  })
})
