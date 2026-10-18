/**
 * Regression tests: an unsubscribe that lands while a snapshot is in flight
 * must not let that snapshot reach the client.
 *
 * `subscribeChatThread` loads a snapshot across an async boundary while
 * holding `subscribeMutex`. Before #796, `unsubscribeChatThread` did not take
 * the mutex, so an unsubscribe could run mid-snapshot and the stale snapshot
 * still pushed `thread-snapshot` frames to a client that had left the thread.
 * `unsubscribeChatThread` now runs under the same mutex.
 *
 * Two races are covered:
 * - an unsubscribe that lands during the re-snapshot of the same thread;
 * - an unsubscribe for a thread whose subscribe is still queued behind
 *   another thread's re-snapshot. Before #796 the unsubscribe ran at once,
 *   found no forwarder, and did nothing; the queued subscribe then started a
 *   forwarder for a thread the client had already left.
 */
import { afterEach, describe, expect, it } from "vitest"
import { Context, Deferred, Effect, Layer, ManagedRuntime, Stream } from "effect"
import { WebSocket } from "ws"
import { Clock, ObservabilityService, UIService } from "@luna/core"
import { ChatService } from "@luna/chat-service"
import { startUIWebSocketServer } from "../src/server.js"
import type { ServerFrame } from "../src/protocol.js"

const TOKEN = "test-token-1234567890" // >=16 chars

class ServerHandle extends Context.Service<
  ServerHandle,
  { readonly port: number; readonly host: string }
>()("test/ServerHandle") {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Harness {
  readonly ws: WebSocket
  readonly frames: Array<{ at: number; frame: ServerFrame }>
  readonly entered: Deferred.Deferred<void>
  readonly release: Deferred.Deferred<void>
  readonly runtime: ManagedRuntime.ManagedRuntime<ServerHandle, never>
}

/**
 * Starts a server whose ChatService.snapshot() (called on a re-subscribe)
 * blocks for `gatedThread` until the test releases it. A first subscribe to
 * any thread in `emitOnSubscribe` delivers one snapshot frame at once through
 * ChatService.subscribe(), the way a real first subscribe does.
 */
const startHarness = async (
  gatedThread: string,
  emitOnSubscribe: ReadonlyArray<string>,
  onDispose: (fn: () => Promise<void>) => void,
): Promise<Harness> => {
  const entered = await Effect.runPromise(Deferred.make<void>())
  const release = await Effect.runPromise(Deferred.make<void>())
  const frameFor = (threadId: string) => ({
    type: "snapshot",
    threadId,
    throughSeq: 7,
    messages: [],
  })

  const gated = <A>(value: A) =>
    Effect.as(
      Effect.andThen(Deferred.succeed(entered, void 0), Deferred.await(release)),
      value,
    )

  const chatStub = {
    deliveries: Stream.empty,
    // Stream.never keeps the forwarder fiber registered in chatFibers.
    subscribe: (threadId: string) =>
      emitOnSubscribe.includes(threadId)
        ? Stream.concat(Stream.make(frameFor(threadId)), Stream.never)
        : Stream.never,
    snapshot: (threadId: string) =>
      threadId === gatedThread
        ? gated([frameFor(threadId)])
        : Effect.succeed([frameFor(threadId)]),
  } as unknown as Context.Service.Shape<typeof ChatService>

  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const uiL = UIService.makeLayer().pipe(Layer.provide(obsL), Layer.provide(clockL))
  const baseLayer = Layer.mergeAll(uiL, obsL, clockL)
  const serverLayer = Layer.effect(
    ServerHandle,
    startUIWebSocketServer({
      port: 0,
      perConnectionCapacity: 256,
      pingIntervalMs: 0,
      surveyPollIntervalMs: 0,
      chatService: chatStub,
      token: TOKEN,
    }),
  ).pipe(Layer.provide(baseLayer))
  const runtime = ManagedRuntime.make(Layer.mergeAll(serverLayer, baseLayer))
  onDispose(() => runtime.dispose())
  const handle = await runtime.runPromise(ServerHandle)

  const frames: Array<{ at: number; frame: ServerFrame }> = []
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ui`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  // Attach before open: the server sends `hello` during upgrade handling.
  ws.on("message", (raw) => {
    frames.push({ at: Date.now(), frame: JSON.parse(raw.toString()) as ServerFrame })
  })
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve())
    ws.on("error", reject)
  })
  await new Promise<void>((resolve) => {
    const check = () => {
      if (frames.some((f) => f.frame.type === "hello")) resolve()
      else setTimeout(check, 25)
    }
    check()
  })
  return { ws, frames, entered, release, runtime }
}

const waitEntered = (entered: Deferred.Deferred<void>) =>
  Effect.runPromise(
    Effect.race(
      Effect.as(Deferred.await(entered), "entered" as const),
      Effect.as(Effect.sleep("5 seconds"), "timeout" as const),
    ),
  )

/** Unsubscribes mid-snapshot, releases the snapshot, returns frames for `threadId` after the unsubscribe. */
const unsubscribeThenRelease = async (h: Harness, threadId: string) => {
  const unsubscribedAt = Date.now()
  h.ws.send(JSON.stringify({ type: "unsubscribe", threadId }))
  await sleep(500)
  await h.runtime.runPromise(Deferred.succeed(h.release, void 0))
  await sleep(500)
  h.ws.close()
  await sleep(200)
  return h.frames.filter(
    (f) =>
      f.at > unsubscribedAt &&
      f.frame.type === "thread-snapshot" &&
      (f.frame as { threadId?: string }).threadId === threadId,
  )
}

describe("unsubscribe vs in-flight snapshot", () => {
  let dispose: (() => Promise<void>) | undefined
  afterEach(async () => {
    await dispose?.()
    dispose = undefined
  })

  it("re-subscribe path: no thread-snapshot after unsubscribe", async () => {
    const h = await startHarness("t1", [], (fn) => (dispose = fn))
    h.ws.send(JSON.stringify({ type: "subscribe", threadId: "t1" }))
    await sleep(300)
    h.ws.send(JSON.stringify({ type: "subscribe", threadId: "t1" }))
    expect(await waitEntered(h.entered)).toBe("entered")

    expect(await unsubscribeThenRelease(h, "t1")).toHaveLength(0)
  }, 20000)

  it("queued subscribe: no frames for a thread unsubscribed before its subscribe ran", async () => {
    const h = await startHarness("t1", ["t2"], (fn) => (dispose = fn))
    h.ws.send(JSON.stringify({ type: "subscribe", threadId: "t1" }))
    await sleep(300)
    // Park t1's re-snapshot, then queue a first subscribe to t2 behind it.
    h.ws.send(JSON.stringify({ type: "subscribe", threadId: "t1" }))
    expect(await waitEntered(h.entered)).toBe("entered")
    h.ws.send(JSON.stringify({ type: "subscribe", threadId: "t2" }))
    await sleep(200)

    expect(await unsubscribeThenRelease(h, "t2")).toHaveLength(0)
  }, 20000)
})
