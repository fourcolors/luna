/**
 * feedback.server.test.ts — LIVE point-at-the-UI feedback behavior against a
 * real startUIWebSocketServer (same rig shape as skill-toggle.server.test.ts /
 * capability-execute.server.test.ts).
 *
 * Pins:
 *   - a FEEDBACK-ONLY server (no chat) advertises capabilities.feedback and
 *     ATTACHES the message handler — the OR-gate omission would silently drop
 *     every frame (this is the sole test catching that regression)
 *   - feedback-submit round-trip: the sink is invoked with the mapped note +
 *     target and the client receives feedback-ack { ok:true } echoing requestId
 *   - malformed frames (blank requestId / non-string note / missing
 *     target.selector) are rejected with ok:false and the sink is NEVER called
 *   - a sink defect acks ok:false via catchAllCause and does NOT tear the
 *     connection down
 */
import { afterEach, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
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
  const uiL = UIService.makeLayer().pipe(Layer.provide(obsL), Layer.provide(clockL))
  return Layer.mergeAll(uiL, obsL, clockL)
}

class ServerHandle extends Effect.Tag("test/FeedbackServerHandle")<
  ServerHandle,
  { readonly port: number }
>() {}

type SinkInput = {
  readonly note: string
  readonly target?: unknown
  readonly page?: string
  readonly threadId?: string
  readonly appVersion?: string
  readonly appearance?: string
  readonly clientTs?: number
}

interface Rig {
  readonly url: string
  readonly shutdown: () => Promise<void>
  readonly recorded: SinkInput[]
}

/**
 * Feedback-ONLY server rig: a feedbackSink recording into `recorded` and NO
 * chat service, to prove the handler gate. `mode` toggles the sink outcome:
 * ok (default) → {ok:true}; sinkErr → {ok:false, message}; defect → dies.
 */
const startFeedbackRig = async (
  mode: "ok" | "sinkErr" | "defect" = "ok",
): Promise<Rig> => {
  const recorded: SinkInput[] = []
  const serverLayer = Layer.scoped(
    ServerHandle,
    Effect.gen(function* () {
      const handle = yield* startUIWebSocketServer({
        port: 0,
        token: TOKEN,
        pingIntervalMs: 0,
        feedbackSink: {
          submit: (input) => {
            recorded.push(input)
            if (mode === "defect") return Effect.die(new Error("boom"))
            if (mode === "sinkErr") {
              return Effect.succeed({ ok: false as const, message: "sink said no" })
            }
            return Effect.succeed({ ok: true as const })
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
    recorded,
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
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } })
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

const validSubmit = (over: Record<string, unknown> = {}) => ({
  type: "feedback-submit",
  requestId: "fb-req-1",
  threadId: "thr-7",
  note: "the send button is too small",
  target: { selector: "#send-btn", tag: "button", id: "send-btn" },
  page: "chat.html",
  clientTs: 1783918800000,
  ...over,
})

let activeRig: Rig | null = null
afterEach(async () => {
  await activeRig?.shutdown()
  activeRig = null
})

describe("feedback-only ui-ws server (live)", () => {
  it("advertises feedback and ROUTES feedback-submit → sink + ack (gate regression pin)", async () => {
    activeRig = await startFeedbackRig()
    const client = await openClient(activeRig.url)

    const hello = await client.waitFor((f) => f.type === "hello")
    expect(hello.type === "hello" ? hello.capabilities.feedback : false).toBe(true)

    // Round-trip on a server with NO chat service. The OR-gate omission made
    // this time out: the message handler was never attached.
    client.send(validSubmit())
    const ack = await client.waitFor((f) => f.type === "feedback-ack")
    expect(ack).toMatchObject({ type: "feedback-ack", requestId: "fb-req-1", ok: true })

    expect(activeRig.recorded).toHaveLength(1)
    expect(activeRig.recorded[0]!.note).toBe("the send button is too small")
    expect(activeRig.recorded[0]!.threadId).toBe("thr-7")
    expect((activeRig.recorded[0]!.target as { selector: string }).selector).toBe("#send-btn")
    client.close()
  })

  it("rejects malformed frames (blank requestId / non-string note / missing target.selector) without calling the sink", async () => {
    activeRig = await startFeedbackRig()
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "hello")

    // blank requestId
    client.send(validSubmit({ requestId: "" }))
    const a = await client.waitFor((f) => f.type === "feedback-ack")
    expect(a).toMatchObject({ ok: false, message: "malformed feedback-submit frame" })

    // non-string note
    client.send(validSubmit({ requestId: "fb-2", note: 42 }))
    const b = await client.waitFor(
      (f) => f.type === "feedback-ack" && f.requestId === "fb-2",
    )
    expect(b).toMatchObject({ ok: false, message: "malformed feedback-submit frame" })

    // missing target.selector
    client.send(validSubmit({ requestId: "fb-3", target: { tag: "button" } }))
    const c = await client.waitFor(
      (f) => f.type === "feedback-ack" && f.requestId === "fb-3",
    )
    expect(c).toMatchObject({ ok: false, message: "malformed feedback-submit frame" })

    // empty/whitespace note
    client.send(validSubmit({ requestId: "fb-4", note: "   " }))
    const d = await client.waitFor(
      (f) => f.type === "feedback-ack" && f.requestId === "fb-4",
    )
    expect(d).toMatchObject({ ok: false })

    expect(activeRig.recorded).toHaveLength(0) // sink never touched
    client.close()
  })

  it("a sink defect acks ok:false (catchAllCause) and keeps the connection alive", async () => {
    activeRig = await startFeedbackRig("defect")
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "hello")

    client.send(validSubmit({ requestId: "fb-boom-1" }))
    const ack = await client.waitFor(
      (f) => f.type === "feedback-ack" && f.requestId === "fb-boom-1",
    )
    expect(ack).toMatchObject({ ok: false })

    // Connection still alive: a second frame still gets acked.
    client.send(validSubmit({ requestId: "fb-boom-2" }))
    const ack2 = await client.waitFor(
      (f) => f.type === "feedback-ack" && f.requestId === "fb-boom-2",
    )
    expect(ack2).toMatchObject({ ok: false })
    expect(activeRig.recorded.length).toBeGreaterThanOrEqual(2)
    client.close()
  })

  it("a sink-reported failure ({ok:false}) is forwarded to the client verbatim", async () => {
    activeRig = await startFeedbackRig("sinkErr")
    const client = await openClient(activeRig.url)
    await client.waitFor((f) => f.type === "hello")

    client.send(validSubmit({ requestId: "fb-x" }))
    const ack = await client.waitFor(
      (f) => f.type === "feedback-ack" && f.requestId === "fb-x",
    )
    expect(ack).toMatchObject({ ok: false, message: "sink said no" })
    client.close()
  })
})
