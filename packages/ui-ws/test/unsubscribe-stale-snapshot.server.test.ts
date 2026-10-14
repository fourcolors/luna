/**
 * Regression test: unsubscribe during an in-flight re-snapshot must not
 * deliver a stale thread-snapshot.
 *
 * `subscribeChatThread` serializes re-subscribes through `subscribeMutex`,
 * but the re-snapshot path (`m.has(threadId)` -> `chat.snapshot(...)`)
 * awaits across an async boundary while holding the mutex, and
 * `unsubscribeChatThread` does not take the mutex. An unsubscribe landing
 * mid-snapshot used to delete + interrupt the forwarder fiber, yet the
 * stale snapshot still pushed `thread-snapshot` frames to a client that
 * had already left the thread.
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

describe("unsubscribe vs in-flight re-snapshot", () => {
  let dispose: (() => Promise<void>) | undefined
  afterEach(async () => {
    await dispose?.()
    dispose = undefined
  })

  it("does not deliver thread-snapshot after unsubscribe", async () => {
    // Gate the mock snapshot so the test can park the re-snapshot path
    // mid-flight and interleave an unsubscribe deterministically.
    const entered = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const snapshotFrame = {
      type: "snapshot",
      threadId: "t1",
      throughSeq: 7,
      messages: [],
    }

    const chatStub = {
      deliveries: Stream.empty,
      // Hang: the forwarder fiber stays registered in chatFibers.
      subscribe: (_threadId: string) => Stream.never,
      // Block until the test releases; signal entry for interleaving.
      snapshot: (_threadId: string) =>
        Effect.as(
          Effect.andThen(
            Deferred.succeed(entered, void 0),
            Deferred.await(release),
          ),
          [snapshotFrame],
        ),
    } as unknown as Context.Service.Shape<typeof ChatService>

    const clockL = Clock.Default
    const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
      Layer.provide(clockL),
    )
    const uiL = UIService.makeLayer().pipe(
      Layer.provide(obsL),
      Layer.provide(clockL),
    )
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
    dispose = () => runtime.dispose()
    const handle = await runtime.runPromise(ServerHandle)
    const url = `ws://127.0.0.1:${handle.port}/ui`

    const frames: Array<{ at: number; frame: ServerFrame }> = []
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    // Attach before open: the server sends `hello` during upgrade handling.
    ws.on("message", (raw) => {
      frames.push({
        at: Date.now(),
        frame: JSON.parse(raw.toString()) as ServerFrame,
      })
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

    // 1. First subscribe: registers the forwarder fiber.
    ws.send(JSON.stringify({ type: "subscribe", threadId: "t1" }))
    await sleep(300)

    // 2. Subscribe again: takes the re-snapshot path, parks in snapshot().
    ws.send(JSON.stringify({ type: "subscribe", threadId: "t1" }))
    await Effect.runPromise(
      Effect.race(
        Effect.as(Deferred.await(entered), "entered" as const),
        Effect.as(Effect.sleep("5 seconds"), "timeout" as const),
      ),
    )

    // 3. Unsubscribe while the snapshot is in flight.
    const unsubscribedAt = Date.now()
    ws.send(JSON.stringify({ type: "unsubscribe", threadId: "t1" }))
    await sleep(500)

    // 4. Let the stale snapshot resolve.
    await runtime.runPromise(Deferred.succeed(release, void 0))
    await sleep(500)
    ws.close()
    await sleep(200)

    const staleSnapshots = frames.filter(
      (f) => f.frame.type === "thread-snapshot" && f.at > unsubscribedAt,
    )
    expect(staleSnapshots.length).toBe(0)
  }, 20000)
})
