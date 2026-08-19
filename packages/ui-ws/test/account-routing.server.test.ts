/**
 * account-routing.server.test.ts — account-add / account-rm via
 * accountManageService (SQL write + scheduleRestart), not AccountBroker hot-reload.
 */
import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import WebSocket from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { startUIWebSocketServer } from "../src/server.js"
import type {
  AccountAddFrame,
  AccountListFrame,
  AccountRmFrame,
  AccountStatusFrame,
  HelloFrame,
  ServerFrame,
} from "../src/protocol.js"

const TOKEN = "test-account-manage-token"

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
>()("test/AccountManageServerHandle") {}

type AccountRow = {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly health: string
}

const makeFakeAccountManage = (initial: AccountRow[] = []) => {
  let rows = [...initial]
  let restartCalls = 0
  return {
    restartCalls: () => restartCalls,
    svc: {
      list: () => rows as ReadonlyArray<AccountRow>,
      add: (input: {
        readonly id: string
        readonly label: string
        readonly kind: string
        readonly secretRef: string
      }) => {
        if (input.secretRef.startsWith("file:")) {
          return { ok: false, message: "file: refs are not resolvable" }
        }
        if (rows.some((r) => r.id === input.id)) {
          return { ok: false, message: `account id="${input.id}" already exists` }
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
        return { ok: true, message: "Account added. Restarting to apply." }
      },
      remove: (input: { readonly id: string }) => {
        const target = rows.find((r) => r.id === input.id)
        if (!target) return { ok: false, message: `no such account: ${input.id}` }
        if (target.kind === "anthropic") {
          const n = rows.filter((r) => r.kind === "anthropic").length
          if (n <= 1) {
            return {
              ok: false,
              message: "refusing to delete the last Anthropic account",
            }
          }
        }
        rows = rows.filter((r) => r.id !== input.id)
        return { ok: true, message: "Account removed. Restarting to apply." }
      },
      scheduleRestart: () => {
        restartCalls += 1
      },
    },
  }
}

const makeFakeBroker = (initial: AccountRow[]) => ({
  list: (kindFilter?: string) =>
    Effect.succeed(
      (kindFilter
        ? initial.filter((r) => r.kind === kindFilter)
        : initial) as ReadonlyArray<AccountRow>,
    ),
})

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
}

const startRig = async (opts: {
  accountBroker?: ReturnType<typeof makeFakeBroker> | null
  accountManageService?: ReturnType<typeof makeFakeAccountManage>["svc"] | null
}): Promise<Rig> => {
  const serverLayer = Layer.effect(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        accountBroker: opts.accountBroker ?? null,
        accountManageService: opts.accountManageService ?? null,
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
      resolve({ ws, frames, waitFor, close: () => ws.close() })
    })
    ws.on("error", reject)
  })

const isHello = (f: ServerFrame): f is HelloFrame => f.type === "hello"
const isAccountList = (f: ServerFrame): f is AccountListFrame =>
  f.type === "account-list"
const isAccountStatus = (f: ServerFrame): f is AccountStatusFrame =>
  f.type === "account-status"

describe("account-manage routing (SQL + scheduleRestart)", () => {
  it("hello advertises accountManage when service is bound", async () => {
    const fake = makeFakeAccountManage()
    const rig = await startRig({ accountManageService: fake.svc })
    try {
      const client = await connect(rig.url)
      const hello = await client.waitFor(isHello)
      expect(hello.capabilities.accountManage).toBe(true)
      client.close()
    } finally {
      await rig.shutdown()
    }
  })

  it("account-add → status + list + scheduleRestart; never echoes secretRef", async () => {
    const seeded = [
      { id: "default", label: "Claude.ai", kind: "anthropic", health: "healthy" },
    ]
    const fake = makeFakeAccountManage(seeded)
    const broker = makeFakeBroker(seeded)
    const rig = await startRig({
      accountBroker: broker,
      accountManageService: fake.svc,
    })
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
      expect(fake.restartCalls()).toBe(1)

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

  it("account-rm refuses last Anthropic; succeeds with two", async () => {
    const seeded = [
      { id: "default", label: "Claude.ai", kind: "anthropic", health: "healthy" },
      {
        id: "account-secondary-1",
        label: "secondary",
        kind: "anthropic",
        health: "healthy",
      },
    ]
    const fake = makeFakeAccountManage(seeded)
    const rig = await startRig({ accountManageService: fake.svc })
    try {
      const client = await connect(rig.url)
      await client.waitFor(isHello)

      client.ws.send(
        JSON.stringify({
          type: "account-rm",
          requestId: "rm-1",
          id: "account-secondary-1",
        } satisfies AccountRmFrame),
      )
      const ok = await client.waitFor(
        (f): f is AccountStatusFrame =>
          isAccountStatus(f) && f.requestId === "rm-1",
      )
      expect(ok.ok).toBe(true)
      expect(fake.restartCalls()).toBe(1)

      client.ws.send(
        JSON.stringify({
          type: "account-rm",
          requestId: "rm-2",
          id: "default",
        } satisfies AccountRmFrame),
      )
      const refused = await client.waitFor(
        (f): f is AccountStatusFrame =>
          isAccountStatus(f) && f.requestId === "rm-2",
      )
      expect(refused.ok).toBe(false)
      expect(refused.message).toMatch(/last Anthropic/i)
      expect(fake.restartCalls()).toBe(1)
      client.close()
    } finally {
      await rig.shutdown()
    }
  })

  it("without accountManageService: capability absent; frames ignored", async () => {
    const rig = await startRig({ accountManageService: null })
    try {
      const client = await connect(rig.url)
      const hello = await client.waitFor(isHello)
      expect(hello.capabilities.accountManage).toBeFalsy()
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
