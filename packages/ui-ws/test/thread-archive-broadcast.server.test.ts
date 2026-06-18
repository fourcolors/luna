/**
 * thread-archive-broadcast.server.test.ts — LIVE coverage for the 14-day
 * auto-archive broadcast bridge (PR #171 follow-up).
 *
 * The server-side auto-archive policy (chat-server's runAutoArchive loop)
 * flips threads to `archived` with NO client request. Without a broadcast,
 * a client actively viewing such a thread goes silently stale. This pins:
 *   - the `threadArchiveNotifier.changes` hook is registered, and
 *   - invoking it broadcasts a `thread-archived` frame for EACH id to EVERY
 *     connected client (so each client's handler can recover its own view).
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Ref } from "effect"
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
  const uiL = UIService.makeLayer().pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Effect.Tag("test/ArchiveServerHandle")<
  ServerHandle,
  { readonly port: number }
>() {}

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
  readonly fireAutoArchive: (ids: ReadonlyArray<string>) => void
}

const startRig = async (): Promise<Rig> => {
  let notify: ((ids: ReadonlyArray<string>) => void) | null = null

  const serverLayer = Layer.scoped(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        threadArchiveNotifier: {
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
    fireAutoArchive: (ids) => notify?.(ids),
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

describe("thread-archive auto-archive broadcast (live)", () => {
  it("broadcasts a thread-archived frame for each auto-archived id to every client", async () => {
    activeRig = await startRig()
    const a = await openClient(activeRig.url)
    const b = await openClient(activeRig.url)
    await a.waitFor((f) => f.type === "hello")
    await b.waitFor((f) => f.type === "hello")

    // The 24h auto-archive loop fires with two stale ids — no client asked.
    activeRig.fireAutoArchive(["thread-1", "thread-2"])

    for (const client of [a, b]) {
      const f1 = await client.waitFor(
        (f) => f.type === "thread-archived" && f.threadId === "thread-1",
      )
      const f2 = await client.waitFor(
        (f) => f.type === "thread-archived" && f.threadId === "thread-2",
      )
      expect(f1).toMatchObject({ type: "thread-archived", threadId: "thread-1" })
      expect(f2).toMatchObject({ type: "thread-archived", threadId: "thread-2" })
    }

    a.close()
    b.close()
  })
})
