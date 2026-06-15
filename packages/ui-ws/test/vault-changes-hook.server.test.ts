/**
 * vault-changes-hook.server.test.ts — live test for the vaultService.changes
 * hook in startUIWebSocketServer. Mirrors skill-toggle.server.test.ts §
 * "broadcasts the refreshed catalog to OTHER clients on toggle, and on
 * changes-notify".
 *
 * Pins:
 *   - register a vaultService with a changes(notify) slot
 *   - connect TWO clients; fire notify → BOTH receive a fresh vault-list
 *   - the vault-list includes a `.sync` key when syncState returns a non-null
 *   - firing notify with zero connected clients does NOT throw
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type { ServerFrame, VaultListFrame, VaultSyncWire, VaultWireItem } from "../src/protocol.js"

const TOKEN = "test-vault-changes-token-9999"

const baseLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(Layer.provide(clockL))
  const uiL = UIService.makeLayer().pipe(Layer.provide(obsL), Layer.provide(clockL))
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Effect.Tag("test/VaultChangesServerHandle")<
  ServerHandle,
  { readonly port: number }
>() {}

/* -------------------------------------------------------------------------- */
/* Shared item factory                                                         */
/* -------------------------------------------------------------------------- */

const makeItem = (id: string, name: string): VaultWireItem => ({
  id,
  name,
  kind: "env-secret",
  ref: `env:${name.toUpperCase().replace(/ /g, "_")}`,
  source: "manual",
  description: null,
  createdAt: 1000,
  updatedAt: 1001,
  synced: false,
  shadowed: false,
})

/* -------------------------------------------------------------------------- */
/* Rig                                                                         */
/* -------------------------------------------------------------------------- */

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
  /** Fire the notify callback registered by the server via changes(). */
  readonly notifyChange: () => void
}

/**
 * Vault-ONLY server rig. The vaultService has a `changes` slot that the
 * server uses to register its broadcast callback. `syncState` returns a
 * non-null value so the test can verify the `.sync` key is propagated.
 */
const startVaultChangesRig = async (
  items: VaultWireItem[] = [],
  opts: { withSync?: boolean } = {},
): Promise<Rig> => {
  let notify: (() => void) | null = null

  const syncWire: VaultSyncWire = {
    enabled: true,
    opLabel: "testacct",
    opVault: "TestVault",
    lastSyncedAt: 1_750_000_000_000,
    lastError: null,
    pollSeconds: 300,
  }

  const serverLayer = Layer.scoped(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        vaultService: {
          list: () => Promise.resolve(items as ReadonlyArray<VaultWireItem>),
          syncState: () =>
            Promise.resolve(opts.withSync === true ? syncWire : null),
          put: async () => ({ ok: true, message: "stored" }),
          remove: async () => ({ ok: true, message: "removed" }),
          setSyncConfig: async () => ({ ok: true, message: "ok" }),
          importItems: async () => ({ ok: true, message: "ok" }),
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

/* -------------------------------------------------------------------------- */
/* Client helper (identical to vault-routing.server.test.ts)                  */
/* -------------------------------------------------------------------------- */

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
            if (existing) {
              res(existing)
              return
            }
            const tid = setTimeout(() => rej(new Error("waitFor timeout")), timeoutMs)
            waiters.push({
              pred,
              resolve: (f) => {
                clearTimeout(tid)
                res(f)
              },
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

let activeRig: Rig | null = null
afterEach(async () => {
  await activeRig?.shutdown()
  activeRig = null
})

describe("vault changes hook (live ui-ws server)", () => {
  it("notifying the changes hook broadcasts a fresh vault-list to BOTH connected clients", async () => {
    const seed = [makeItem("item-1", "API Key"), makeItem("item-2", "DB Pass")]
    activeRig = await startVaultChangesRig(seed)

    const a = await openClient(activeRig.url)
    const b = await openClient(activeRig.url)

    // Wait for the post-hello vault-list on both clients before firing notify.
    await a.waitFor((f) => f.type === "vault-list")
    await b.waitFor((f) => f.type === "vault-list")

    const beforeA = a.frames.filter((f) => f.type === "vault-list").length
    const beforeB = b.frames.filter((f) => f.type === "vault-list").length

    // Fire the out-of-band notify (simulates the 1Password sync poll loop
    // adopting new rows).
    activeRig.notifyChange()

    // Both clients must receive a new vault-list.
    await a.waitFor(
      (f) =>
        f.type === "vault-list" &&
        a.frames.filter((x) => x.type === "vault-list").length > beforeA,
    )
    await b.waitFor(
      (f) =>
        f.type === "vault-list" &&
        b.frames.filter((x) => x.type === "vault-list").length > beforeB,
    )

    // Both should contain the seeded items.
    const aLists = a.frames.filter((f) => f.type === "vault-list") as VaultListFrame[]
    const bLists = b.frames.filter((f) => f.type === "vault-list") as VaultListFrame[]
    const lastA = aLists[aLists.length - 1]!
    const lastB = bLists[bLists.length - 1]!
    expect(lastA.items).toHaveLength(2)
    expect(lastB.items).toHaveLength(2)

    a.close()
    b.close()
  })

  it("vault-list includes .sync when syncState returns a non-null wire", async () => {
    const seed = [makeItem("item-sync", "Synced Key")]
    activeRig = await startVaultChangesRig(seed, { withSync: true })

    const client = await openClient(activeRig.url)
    // The post-hello vault-list should already carry .sync; the notify path does too.
    const postHello = (await client.waitFor(
      (f) => f.type === "vault-list",
    )) as VaultListFrame
    expect(postHello.sync).toBeDefined()
    expect(postHello.sync?.enabled).toBe(true)
    expect(postHello.sync?.opLabel).toBe("testacct")
    expect(typeof postHello.sync?.pollSeconds).toBe("number")

    const before = client.frames.filter((f) => f.type === "vault-list").length
    activeRig.notifyChange()
    const notified = (await client.waitFor(
      (f) =>
        f.type === "vault-list" &&
        client.frames.filter((x) => x.type === "vault-list").length > before,
    )) as VaultListFrame
    expect(notified.sync).toBeDefined()
    expect(notified.sync?.lastSyncedAt).toBe(1_750_000_000_000)

    client.close()
  })

  it("firing notify with zero connected clients does not throw", async () => {
    // Start the rig but do not connect any client; fire notify immediately.
    activeRig = await startVaultChangesRig([makeItem("z", "Lone Item")])
    // Give the server a tick to register the changes callback.
    await new Promise((r) => setTimeout(r, 20))
    // Must not throw — the broadcast loop over an empty socket set is a no-op.
    expect(() => activeRig!.notifyChange()).not.toThrow()
    // Wait a tick to let any async Effect.promise settle (catches deferred throws).
    await new Promise((r) => setTimeout(r, 50))
  })
})
