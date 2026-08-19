/**
 * account-routing.server.test.ts — LIVE account-add / account-rm routing
 * against startUIWebSocketServer with a fake AccountBroker handle.
 *
 * Pins: hello → account-list; account-add → account-status + refreshed list;
 * account-rm → account-status + refreshed list; malformed → ok:false;
 * no broker → frames ignored.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type {
  AccountAddFrame,
  AccountListFrame,
  AccountRmFrame,
  AccountStatusFrame,
  ServerFrame,
} from "../src/protocol.js"

const TOKEN = "test-account-token-1234"

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
>()("test/AccountServerHandle") {}

type AccountRow = {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly health: string
}

const makeFakeBroker = (initial: AccountRow[] = []) => {
  let rows = [...initial]
  return {
    list: (_kindFilter?: string) => Effect.succeed(rows as ReadonlyArray<AccountRow>),
    add: (input: {
      readonly id: string
      readonly label: string
      readonly kind: string
      readonly secretRef: string
    }) =>
      Effect.gen(function* () {
        if (rows.some((r) => r.id === input.id)) {
          return yield* Effect.fail(new Error(`account id="${input.id}" already exists`))
        }
        if (input.secretRef.startsWith("file:")) {
          return yield* Effect.fail(new Error("file: refs are not resolvable"))
        }
        rows = [
          ...rows,
          {
            id: input.id,
            label: input.label,
            kind: input.kind,
            health: "healthy",
          },
        ]
      }),
    remove: (id: string) =>
      Effect.gen(function* () {
        const before = rows.length
        rows = rows.filter((r) => r.id !== id)
        if (rows.length === before) {
          return yield* Effect.fail(new Error(`no such account: ${id}`))
        }
      }),
  }
}

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
}

const startRig = async (
  accountBroker: ReturnType<typeof makeFakeBroker> | null,
): Promise<Rig> => {
  const serverLayer = Layer.effect(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        accountBroker,
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

const connect = (url: string): Promise<{
  ws: WebSocket
  frames: ServerFrame[]
  waitFor: <T extends ServerFrame>(
    pred: (f: ServerFrame) => f is T,
    timeoutMs?: number,
  ) => Promise<T>
  close: () => void
}> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const frames: ServerFrame[] = []
    const waiters: Array<{
      pred: (f: ServerFrame) => boolean
      resolve: (f: ServerFrame) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }> = []

    const waitFor = <T extends ServerFrame>(
      pred: (f: ServerFrame) => f is T,
      timeoutMs = 3000,
    ): Promise<T> =>
      new Promise((res, rej) => {
        for (const f of frames) {
          if (pred(f)) {
            res(f)
            return
          }
        }
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer)
          if (idx >= 0) waiters.splice(idx, 1)
          rej(new Error("timeout waiting for frame"))
        }, timeoutMs)
        waiters.push({
          pred,
          resolve: (f) => res(f as T),
          reject: rej,
          timer,
        })
      })

    ws.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame
      frames.push(frame)
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i]!
        if (w.pred(frame)) {
          clearTimeout(w.timer)
          waiters.splice(i, 1)
          w.resolve(frame)
        }
      }
    })
    ws.on("open", () => {
      resolve({
        ws,
        frames,
        waitFor,
        close: () => ws.close(),
      })
    })
    ws.on("error", reject)
  })

const isAccountList = (f: ServerFrame): f is AccountListFrame =>
  f.type === "account-list"
const isAccountStatus = (f: ServerFrame): f is AccountStatusFrame =>
  f.type === "account-status"

afterEach(async () => {
  // no shared state
})

describe("account-add / account-rm routing", () => {
  it("pushes account-list after hello with seeded rows", async () => {
    const broker = makeFakeBroker([
      { id: "default", label: "Claude.ai", kind: "anthropic", health: "healthy" },
      {
        id: "account-secondary-1",
        label: "secondary",
        kind: "anthropic",
        health: "healthy",
      },
    ])
    const rig = await startRig(broker)
    try {
      const client = await connect(rig.url)
      const list = await client.waitFor(isAccountList)
      expect(list.accounts).toHaveLength(2)
      expect(list.accounts.map((a) => a.id).sort()).toEqual([
        "account-secondary-1",
        "default",
      ])
      client.close()
    } finally {
      await rig.shutdown()
    }
  })

  it("account-add → account-status(ok) + refreshed account-list", async () => {
    const broker = makeFakeBroker([
      { id: "default", label: "Claude.ai", kind: "anthropic", health: "healthy" },
    ])
    const rig = await startRig(broker)
    try {
      const client = await connect(rig.url)
      await client.waitFor(isAccountList)

      const add: AccountAddFrame = {
        type: "account-add",
        requestId: "req-add-1",
        id: "account-secondary-1",
        label: "secondary",
        kind: "anthropic",
        secretRef: "claude-code:login",
      }
      client.ws.send(JSON.stringify(add))

      const status = await client.waitFor(
        (f): f is AccountStatusFrame =>
          isAccountStatus(f) && f.requestId === "req-add-1",
      )
      expect(status.ok).toBe(true)
      expect(JSON.stringify(status)).not.toContain("claude-code:login")

      const refreshed = await client.waitFor(
        (f): f is AccountListFrame =>
          isAccountList(f) && f.accounts.length === 2,
      )
      expect(refreshed.accounts.map((a) => a.id).sort()).toEqual([
        "account-secondary-1",
        "default",
      ])
      client.close()
    } finally {
      await rig.shutdown()
    }
  })

  it("account-rm → account-status(ok) + refreshed account-list", async () => {
    const broker = makeFakeBroker([
      { id: "default", label: "Claude.ai", kind: "anthropic", health: "healthy" },
      {
        id: "account-secondary-1",
        label: "secondary",
        kind: "anthropic",
        health: "healthy",
      },
    ])
    const rig = await startRig(broker)
    try {
      const client = await connect(rig.url)
      await client.waitFor(isAccountList)

      const rm: AccountRmFrame = {
        type: "account-rm",
        requestId: "req-rm-1",
        id: "account-secondary-1",
      }
      client.ws.send(JSON.stringify(rm))

      const status = await client.waitFor(
        (f): f is AccountStatusFrame =>
          isAccountStatus(f) && f.requestId === "req-rm-1",
      )
      expect(status.ok).toBe(true)

      const refreshed = await client.waitFor(
        (f): f is AccountListFrame =>
          isAccountList(f) && f.accounts.length === 1,
      )
      expect(refreshed.accounts[0]?.id).toBe("default")
      client.close()
    } finally {
      await rig.shutdown()
    }
  })

  it("malformed account-add → account-status(ok:false)", async () => {
    const broker = makeFakeBroker([])
    const rig = await startRig(broker)
    try {
      const client = await connect(rig.url)
      await client.waitFor(isAccountList)
      client.ws.send(
        JSON.stringify({
          type: "account-add",
          requestId: "bad",
          id: "",
          label: "x",
          kind: "anthropic",
          secretRef: "env:X",
        }),
      )
      const status = await client.waitFor(
        (f): f is AccountStatusFrame =>
          isAccountStatus(f) && f.requestId === "bad",
      )
      expect(status.ok).toBe(false)
      expect(status.message).toMatch(/malformed/)
      client.close()
    } finally {
      await rig.shutdown()
    }
  })

  it("without accountBroker, account-add is ignored", async () => {
    const rig = await startRig(null)
    try {
      const client = await connect(rig.url)
      // No account-list should arrive; give a short window then send add.
      await new Promise((r) => setTimeout(r, 80))
      expect(client.frames.some((f) => f.type === "account-list")).toBe(false)
      client.ws.send(
        JSON.stringify({
          type: "account-add",
          requestId: "ignored",
          id: "x",
          label: "x",
          kind: "anthropic",
          secretRef: "env:X",
        }),
      )
      await new Promise((r) => setTimeout(r, 80))
      expect(client.frames.some((f) => f.type === "account-status")).toBe(false)
      client.close()
    } finally {
      await rig.shutdown()
    }
  })
})
