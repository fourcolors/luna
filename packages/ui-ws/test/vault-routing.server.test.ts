/**
 * vault-routing.server.test.ts — LIVE vault-frame routing against a real
 * startUIWebSocketServer, using a fake vaultService handle. Mirrors
 * workflow-gallery.server.test.ts and artifact-frames.server.test.ts.
 *
 * Pins:
 *   - a VAULT-ONLY server (no chat) attaches the message handler and
 *     advertises capabilities.vault = true
 *   - vault-list arrives after hello with the seeded items
 *   - vault-put → vault-status(ok:true) + fresh vault-list sent to the
 *     requesting client
 *   - vault-put failure → vault-status(ok:false, message) — no vault-list
 *   - vault-delete → vault-status(ok:true) + fresh vault-list
 *   - vault-sync-config → vault-status + fresh vault-list
 *   - vault-import → vault-status + fresh vault-list
 *   - malformed vault-put (missing name) → vault-status(ok:false)
 *   - vault-import with >20 items → vault-status(ok:false)
 *   - a server WITHOUT a vaultService: capabilities.vault absent; no
 *     vault-list pushed; vault-put frames are silently ignored
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type {
  ServerFrame,
  VaultDeleteFrame,
  VaultImportFrame,
  VaultListFrame,
  VaultPutFrame,
  VaultStatusFrame,
  VaultSyncConfigFrame,
  VaultWireItem,
} from "../src/protocol.js"

const TOKEN = "test-vault-token-1234"

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
>()("test/VaultServerHandle") {}

/* -------------------------------------------------------------------------- */
/* Fake vaultService                                                           */
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

/**
 * A simple in-memory fake vaultService. Holds a mutable item list so round-
 * trip tests can verify the vault-list payload reflects mutations.
 *
 * @param opts.listRejectsAfterPut - when true, the first call to list() AFTER
 *   a successful put() rejects, simulating a refresh failure. Used for the
 *   finding-6 double-status test.
 */
const makeFakeVaultService = (
  initialItems: VaultWireItem[] = [],
  opts: { listRejectsAfterPut?: boolean } = {},
) => {
  let items = [...initialItems]
  let putSucceeded = false
  return {
    list: () => {
      if (opts.listRejectsAfterPut && putSucceeded) {
        putSucceeded = false // only reject once
        return Promise.reject(new Error("simulated list failure"))
      }
      return Promise.resolve(items as ReadonlyArray<VaultWireItem>)
    },
    syncState: () => Promise.resolve(null),
    put: async (f: VaultPutFrame) => {
      if (f.name === "FAIL_ME") {
        return { ok: false, message: "forced failure for test" }
      }
      items = [...items, makeItem(`new-${Date.now()}`, f.name)]
      putSucceeded = true
      return { ok: true, message: "stored" }
    },
    remove: async (f: VaultDeleteFrame) => {
      const before = items.length
      items = items.filter((i) => i.id !== f.id)
      return items.length < before
        ? { ok: true, message: "removed" }
        : { ok: false, message: "not found" }
    },
    setSyncConfig: async (_f: VaultSyncConfigFrame) => ({
      ok: true,
      message: "sync config updated",
    }),
    importItems: async (f: VaultImportFrame) => ({
      ok: true,
      message: `imported ${f.items.length} item(s)`,
    }),
  }
}

/* -------------------------------------------------------------------------- */
/* Test rig                                                                    */
/* -------------------------------------------------------------------------- */

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
}

const startVaultRig = async (
  vaultService: ReturnType<typeof makeFakeVaultService> | null,
): Promise<Rig> => {
  const serverLayer = Layer.effect(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        vaultService,
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
    const waiters: Array<{ pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void; reject: (e: Error) => void }> = []
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
            const tid = setTimeout(
              () => rej(new Error("waitFor timeout")),
              timeoutMs,
            )
            waiters.push({ pred, resolve: (f) => { clearTimeout(tid); res(f) }, reject: rej })
          }),
        close: () => ws.close(),
      }),
    )
  })

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("vault server routing", () => {
  let rig: Rig | null = null

  afterEach(async () => {
    await rig?.shutdown()
    rig = null
  })

  it("hello advertises capabilities.vault=true when vaultService is present", async () => {
    rig = await startVaultRig(makeFakeVaultService([makeItem("seed-1", "Seed Key")]))
    const client = await openClient(rig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect((hello as { capabilities: { vault?: boolean } }).capabilities.vault).toBe(true)

    client.close()
  })

  it("vault-list is pushed after hello with seeded items (no secret values)", async () => {
    const seed = [makeItem("seed-1", "Seed Key"), makeItem("seed-2", "Another Key")]
    rig = await startVaultRig(makeFakeVaultService(seed))
    const client = await openClient(rig.url)

    const vaultList = await client.waitFor((f) => f.type === "vault-list") as VaultListFrame
    expect(vaultList.items).toHaveLength(2)
    expect(vaultList.items[0]?.id).toBe("seed-1")
    expect(vaultList.items[1]?.id).toBe("seed-2")
    // Wire-safety: no item has a 'value' field.
    for (const item of vaultList.items) {
      expect("value" in item).toBe(false)
      expect("password" in item).toBe(false)
    }

    client.close()
  })

  it("vault-put success: sends vault-status(ok:true) then fresh vault-list", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    // Wait for the post-hello vault-list before sending mutations.
    await client.waitFor((f) => f.type === "vault-list")

    const putFrame: VaultPutFrame = {
      type: "vault-put",
      requestId: "req-put-001",
      name: "New Key",
      kind: "env-secret",
      varName: "NEW_KEY",
      value: "ops_test_token_fake",
    }
    client.send(putFrame)

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-put-001",
    ) as VaultStatusFrame
    expect(status.ok).toBe(true)
    expect(status.requestId).toBe("req-put-001")
    // Status message must not echo the value.
    expect(status.message).not.toContain("ops_test_token_fake")

    // A fresh vault-list arrives after the status.
    const updatedList = await client.waitFor(
      (f) => f.type === "vault-list" && (f as VaultListFrame).items.length > 0,
    ) as VaultListFrame
    expect(updatedList.items.some((i) => i.name === "New Key")).toBe(true)
    // Still no value fields in items.
    for (const item of updatedList.items) {
      expect("value" in item).toBe(false)
    }

    client.close()
  })

  it("vault-put failure: sends vault-status(ok:false); no vault-list follows", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    client.send({
      type: "vault-put",
      requestId: "req-fail-001",
      name: "FAIL_ME",
      kind: "env-secret",
      varName: "FAIL_ME",
      value: "ops_test_token_fake",
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-fail-001",
    ) as VaultStatusFrame
    expect(status.ok).toBe(false)
    expect(status.message).toBe("forced failure for test")

    // Verify no extra vault-list arrives within a short window (failure path).
    const listFramesBefore = client.frames.filter((f) => f.type === "vault-list").length
    await new Promise((r) => setTimeout(r, 80))
    const listFramesAfter = client.frames.filter((f) => f.type === "vault-list").length
    expect(listFramesAfter).toBe(listFramesBefore)

    client.close()
  })

  it("malformed vault-put (missing name) → vault-status(ok:false)", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    client.send({
      type: "vault-put",
      requestId: "req-malformed",
      // name intentionally omitted
      kind: "env-secret",
      value: "ops_test_token_fake",
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-malformed",
    ) as VaultStatusFrame
    expect(status.ok).toBe(false)
    expect(status.message).toMatch(/malformed/i)

    client.close()
  })

  it("vault-delete → vault-status(ok:true) + updated vault-list", async () => {
    const seed = [makeItem("del-target", "To Be Deleted")]
    rig = await startVaultRig(makeFakeVaultService(seed))
    const client = await openClient(rig.url)
    // Wait for initial vault-list so we know the server is ready.
    await client.waitFor((f) => f.type === "vault-list")

    client.send({
      type: "vault-delete",
      requestId: "req-del-001",
      id: "del-target",
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-del-001",
    ) as VaultStatusFrame
    expect(status.ok).toBe(true)

    // Wait for a vault-list where the deleted item is absent (the post-mutation refresh).
    const updatedList = await client.waitFor(
      (f) => f.type === "vault-list" && (f as VaultListFrame).items.every((i) => i.id !== "del-target"),
    ) as VaultListFrame
    expect(updatedList.items.every((i) => i.id !== "del-target")).toBe(true)

    client.close()
  })

  it("vault-sync-config → vault-status + fresh vault-list", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    client.send({
      type: "vault-sync-config",
      requestId: "req-sync-001",
      enabled: true,
      opLabel: "my-label",
      opVault: "Personal",
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-sync-001",
    ) as VaultStatusFrame
    expect(status.ok).toBe(true)

    // A fresh vault-list follows.
    await client.waitFor((f) => f.type === "vault-list")

    client.close()
  })

  it("vault-import → vault-status + fresh vault-list", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    client.send({
      type: "vault-import",
      requestId: "req-import-001",
      items: [
        { title: "Example Login", password: "hunter2_fake" },
        { title: "Another Login", password: "pw2_fake" },
      ],
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-import-001",
    ) as VaultStatusFrame
    expect(status.ok).toBe(true)
    // Message must not echo passwords.
    expect(status.message).not.toContain("hunter2_fake")
    expect(status.message).not.toContain("pw2_fake")

    await client.waitFor((f) => f.type === "vault-list")

    client.close()
  })

  it("vault-import with >20 items → vault-status(ok:false, max 20)", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    const items = Array.from({ length: 21 }, (_, i) => ({
      title: `Login ${i}`,
      password: `pw_fake_${i}`,
    }))
    client.send({
      type: "vault-import",
      requestId: "req-oversize",
      items,
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-oversize",
    ) as VaultStatusFrame
    expect(status.ok).toBe(false)
    expect(status.message).toMatch(/20/i)

    client.close()
  })

  it("server WITHOUT vaultService: capabilities.vault absent; no vault-list pushed; vault-put ignored", async () => {
    // Start with NO vaultService.
    rig = await startVaultRig(null)
    const client = await openClient(rig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect((hello as { capabilities: Record<string, unknown> }).capabilities.vault).toBeFalsy()

    // No vault-list should arrive after hello.
    await new Promise((r) => setTimeout(r, 80))
    const vaultListFrames = client.frames.filter((f) => f.type === "vault-list")
    expect(vaultListFrames).toHaveLength(0)

    // vault-put should be silently ignored (no vault-status reply).
    const frameCountBefore = client.frames.length
    client.send({
      type: "vault-put",
      requestId: "req-ignored",
      name: "Test",
      kind: "env-secret",
      varName: "TEST",
      value: "ops_test_token_fake",
    })
    await new Promise((r) => setTimeout(r, 80))
    const vaultStatusFrames = client.frames.filter((f) => f.type === "vault-status")
    expect(vaultStatusFrames).toHaveLength(0)
    // Total frame count should not have grown by more than 0 (no new frames).
    expect(client.frames.length).toBe(frameCountBefore)

    client.close()
  })

  // ── Finding 2: vault-import with items:"not-an-array" → malformed ──────────

  it("vault-import items:not-an-array → vault-status(ok:false, malformed)", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    // Send items as a non-array value (finding 2: precedence bug + type check).
    client.send({
      type: "vault-import",
      requestId: "req-bad-items",
      items: "not-an-array",
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-bad-items",
    ) as VaultStatusFrame
    expect(status.ok).toBe(false)
    expect(status.message).toMatch(/malformed/i)
    // Must NOT say "too many items" — wrong path.
    expect(status.message).not.toMatch(/too many/i)

    client.close()
  })

  // ── Finding 3: second connected client receives vault-list after put ────────

  it("second connected client receives vault-list broadcast after vault-put", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    // Open TWO clients to the same server.
    const client1 = await openClient(rig.url)
    const client2 = await openClient(rig.url)

    // Both clients receive the post-hello vault-list.
    await client1.waitFor((f) => f.type === "vault-list")
    await client2.waitFor((f) => f.type === "vault-list")

    // Snapshot client2's frame count before the mutation.
    const listsBefore = client2.frames.filter((f) => f.type === "vault-list").length

    // Client1 sends vault-put.
    client1.send({
      type: "vault-put",
      requestId: "req-broadcast-001",
      name: "Broadcast Key",
      kind: "env-secret",
      varName: "BROADCAST_KEY",
      value: "ops_test_broadcast_fake",
    })

    // Client1 receives the vault-status ack.
    const status = await client1.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-broadcast-001",
    ) as VaultStatusFrame
    expect(status.ok).toBe(true)

    // Client2 MUST also receive a fresh vault-list (the broadcast, finding 3).
    const updatedListOnClient2 = await client2.waitFor(
      (f) =>
        f.type === "vault-list" &&
        (f as VaultListFrame).items.some((i) => i.name === "Broadcast Key"),
    ) as VaultListFrame
    expect(updatedListOnClient2.items.some((i) => i.name === "Broadcast Key")).toBe(true)
    // Confirm client2 received MORE vault-list frames than before the put.
    const listsAfter = client2.frames.filter((f) => f.type === "vault-list").length
    expect(listsAfter).toBeGreaterThan(listsBefore)

    client1.close()
    client2.close()
  })

  // ── Finding 5: vault-put missing/empty value → malformed ───────────────────

  it("vault-put with empty value → vault-status(ok:false, malformed)", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    client.send({
      type: "vault-put",
      requestId: "req-empty-value",
      name: "Some Key",
      kind: "env-secret",
      varName: "SOME_KEY",
      value: "", // empty value
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-empty-value",
    ) as VaultStatusFrame
    expect(status.ok).toBe(false)
    expect(status.message).toMatch(/malformed/i)

    client.close()
  })

  it("vault-put with missing value field → vault-status(ok:false, malformed)", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    // Omit value entirely.
    client.send({
      type: "vault-put",
      requestId: "req-no-value",
      name: "Some Key",
      kind: "env-secret",
      varName: "SOME_KEY",
      // value intentionally absent
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-no-value",
    ) as VaultStatusFrame
    expect(status.ok).toBe(false)
    expect(status.message).toMatch(/malformed/i)

    client.close()
  })

  // ── B4: vault-put with present-but-non-string optional field → malformed ──

  it("vault-put with varName: 123 (non-string) → vault-status(ok:false, malformed), no handle call", async () => {
    // Seed one item so we can verify the item list didn't grow after the
    // malformed put (a successful handle call would append an item and push
    // a fresh vault-list).
    const seedItem = makeItem("seed-b4", "EXISTING_KEY")
    rig = await startVaultRig(makeFakeVaultService([seedItem]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")
    const vaultListFramesBefore = client.frames.filter((f) => f.type === "vault-list").length

    client.send({
      type: "vault-put",
      requestId: "req-bad-varname",
      name: "Some Key",
      kind: "env-secret",
      varName: 123 as unknown as string, // present but not a string → malformed
      value: "fake-value-for-b4-test",
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-bad-varname",
    ) as VaultStatusFrame
    expect(status.ok).toBe(false)
    expect(status.message).toMatch(/malformed/i)

    // A successful put triggers a vault-list push; a rejected put must not.
    // Give a short window then assert no extra vault-list arrived.
    await new Promise((r) => setTimeout(r, 80))
    const vaultListFramesAfter = client.frames.filter((f) => f.type === "vault-list").length
    expect(vaultListFramesAfter).toBe(vaultListFramesBefore)

    client.close()
  })

  it("vault-sync-config with non-boolean enabled → vault-status(ok:false, malformed)", async () => {
    rig = await startVaultRig(makeFakeVaultService([]))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    client.send({
      type: "vault-sync-config",
      requestId: "req-bad-enabled",
      enabled: "yes", // not a boolean
      opLabel: "my-label",
    })

    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-bad-enabled",
    ) as VaultStatusFrame
    expect(status.ok).toBe(false)
    expect(status.message).toMatch(/malformed/i)

    client.close()
  })

  it.each([
    ["opLabel", 123],
    ["opVault", { name: "Personal" }],
    ["pollSeconds", "300"],
  ])(
    "vault-sync-config with non-%s field → vault-status(ok:false, malformed)",
    async (field, value) => {
      rig = await startVaultRig(makeFakeVaultService([]))
      const client = await openClient(rig.url)
      await client.waitFor((f) => f.type === "vault-list")

      client.send({
        type: "vault-sync-config",
        requestId: `req-bad-${field}`,
        enabled: false,
        [field]: value,
      })

      const status = await client.waitFor(
        (f) =>
          f.type === "vault-status" &&
          (f as VaultStatusFrame).requestId === `req-bad-${field}`,
      ) as VaultStatusFrame
      expect(status.ok).toBe(false)
      expect(status.message).toMatch(/malformed/i)

      client.close()
    },
  )

  // ── Finding 6: list() rejects after successful put → exactly ONE vault-status ──

  it("list() failing after successful put emits exactly one vault-status(ok:true), no second status", async () => {
    // Use the variant that rejects list() after the first successful put.
    rig = await startVaultRig(makeFakeVaultService([], { listRejectsAfterPut: true }))
    const client = await openClient(rig.url)
    await client.waitFor((f) => f.type === "vault-list")

    client.send({
      type: "vault-put",
      requestId: "req-list-fail",
      name: "Key That Triggers List Failure",
      kind: "env-secret",
      varName: "KEY_LIST_FAIL",
      value: "ops_test_token_fake",
    })

    // The first (and ONLY) vault-status must be ok:true.
    const status = await client.waitFor(
      (f) => f.type === "vault-status" && (f as VaultStatusFrame).requestId === "req-list-fail",
    ) as VaultStatusFrame
    expect(status.ok).toBe(true)

    // Wait a moment and assert no second vault-status arrives.
    await new Promise((r) => setTimeout(r, 120))
    const allStatuses = client.frames.filter(
      (f) =>
        f.type === "vault-status" &&
        (f as VaultStatusFrame).requestId === "req-list-fail",
    )
    expect(allStatuses).toHaveLength(1)
    // The single status must be ok:true (refresh failure never produces ok:false).
    expect((allStatuses[0] as VaultStatusFrame).ok).toBe(true)

    client.close()
  })
})
