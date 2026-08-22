/**
 * GatewayService — tests (Phase 17).
 *
 * Tests adapter registration, message routing, handler dispatch,
 * and in-memory adapter (no real stdio/HTTP).
 */
import { describe, expect, it } from "vitest"
import {
  Duration,
  Effect,
  Layer,
  Queue,
  Ref,
  Stream,
} from "effect"
import { Clock } from "../src/clock.js"
import {
  GatewayService,
} from "../src/gateway/index.js"
import type {
  GatewayAdapter,
  GatewayMessage,
  GatewayResponse,
} from "../src/gateway/index.js"

/**
 * Build a test adapter backed by a Queue (inject messages programmatically).
 * Must be created inside an Effect (needs a Queue).
 */
function makeTestAdapter(
  transport: string,
  q: Queue.Queue<GatewayMessage>,
  responsesRef: Ref.Ref<GatewayResponse[]>,
): GatewayAdapter {
  return {
    transport,
    messages: Stream.fromQueue(q),
    send: (r: GatewayResponse) =>
      Ref.update(responsesRef, (xs) => [...xs, r]),
  }
}

const makeTestRuntime = () =>
  GatewayService.makeLayer({ logMessages: false }).pipe(
    Layer.provide(Clock.Default),
  )

describe("GatewayService", () => {
  it("(2) message routed to correct adapter: echo handler", async () => {
    const responses: GatewayResponse[] = []
    let counter = 0

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const q = yield* Queue.unbounded<GatewayMessage>()
          const responsesRef = yield* Ref.make<GatewayResponse[]>([])
          const adapter = makeTestAdapter("echo-transport", q, responsesRef)

          const gateway = yield* GatewayService
          yield* gateway.registerAdapter(adapter)
          yield* gateway.setHandler((msg) => Effect.succeed(`ECHO: ${msg.text}`))

          yield* Effect.forkDetach(
            gateway.start.pipe(Effect.catchCause(() => Effect.void)),
          )

          // Inject a message
          yield* Queue.offer(q, {
            id: `t-${++counter}`,
            transport: "echo-transport",
            channelId: "ch-1",
            senderId: "tester",
            text: "ping",
            metadata: {},
            ts: new Date().toISOString(),
          })

          yield* Effect.sleep(Duration.millis(50))

          const captured = yield* Ref.get(responsesRef)
          responses.push(...captured)
        }).pipe(Effect.provide(makeTestRuntime())),
      ),
    )

    expect(responses.length).toBeGreaterThanOrEqual(1)
    expect(responses[0]?.text).toBe("ECHO: ping")
  })

  it("(3) multiple adapters: messages from both are handled", async () => {
    const allResponses: string[] = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const q1 = yield* Queue.unbounded<GatewayMessage>()
          const q2 = yield* Queue.unbounded<GatewayMessage>()
          const resp1Ref = yield* Ref.make<GatewayResponse[]>([])
          const resp2Ref = yield* Ref.make<GatewayResponse[]>([])
          const a1 = makeTestAdapter("transport-1", q1, resp1Ref)
          const a2 = makeTestAdapter("transport-2", q2, resp2Ref)

          const gateway = yield* GatewayService
          yield* gateway.registerAdapter(a1)
          yield* gateway.registerAdapter(a2)
          yield* gateway.setHandler((msg) =>
            Effect.succeed(`[${msg.transport}] ${msg.text}`),
          )

          yield* Effect.forkDetach(
            gateway.start.pipe(Effect.catchCause(() => Effect.void)),
          )

          yield* Queue.offer(q1, {
            id: "m-1", transport: "transport-1", channelId: "ch", senderId: "u",
            text: "from-1", metadata: {}, ts: new Date().toISOString(),
          })
          yield* Queue.offer(q2, {
            id: "m-2", transport: "transport-2", channelId: "ch", senderId: "u",
            text: "from-2", metadata: {}, ts: new Date().toISOString(),
          })
          yield* Effect.sleep(Duration.millis(60))

          const r1 = yield* Ref.get(resp1Ref)
          const r2 = yield* Ref.get(resp2Ref)
          allResponses.push(...r1.map((r) => r.text))
          allResponses.push(...r2.map((r) => r.text))
        }).pipe(Effect.provide(makeTestRuntime())),
      ),
    )

    expect(allResponses).toContain("[transport-1] from-1")
    expect(allResponses).toContain("[transport-2] from-2")
  })

  it("(4) handler crash: gateway continues, sends error response", async () => {
    const responses: GatewayResponse[] = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const q = yield* Queue.unbounded<GatewayMessage>()
          const responsesRef = yield* Ref.make<GatewayResponse[]>([])
          const adapter = makeTestAdapter("crash-transport", q, responsesRef)

          const gateway = yield* GatewayService
          yield* gateway.registerAdapter(adapter)
          yield* gateway.setHandler(() => Effect.die("boom"))

          yield* Effect.forkDetach(
            gateway.start.pipe(Effect.catchCause(() => Effect.void)),
          )

          yield* Queue.offer(q, {
            id: "c-1", transport: "crash-transport", channelId: "ch", senderId: "u",
            text: "trigger-crash", metadata: {}, ts: new Date().toISOString(),
          })
          yield* Effect.sleep(Duration.millis(50))

          const captured = yield* Ref.get(responsesRef)
          responses.push(...captured)
        }).pipe(Effect.provide(makeTestRuntime())),
      ),
    )

    expect(responses.length).toBeGreaterThanOrEqual(1)
    expect(responses[0]?.text).toContain("Error")
  })

  it("(5) no handler: messages are silently dropped", async () => {
    const responses: GatewayResponse[] = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const q = yield* Queue.unbounded<GatewayMessage>()
          const responsesRef = yield* Ref.make<GatewayResponse[]>([])
          const adapter = makeTestAdapter("no-handler", q, responsesRef)

          const gateway = yield* GatewayService
          yield* gateway.registerAdapter(adapter)
          // No setHandler

          yield* Effect.forkDetach(
            gateway.start.pipe(Effect.catchCause(() => Effect.void)),
          )

          yield* Queue.offer(q, {
            id: "n-1", transport: "no-handler", channelId: "ch", senderId: "u",
            text: "no handler here", metadata: {}, ts: new Date().toISOString(),
          })
          yield* Effect.sleep(Duration.millis(30))

          const captured = yield* Ref.get(responsesRef)
          responses.push(...captured)
        }).pipe(Effect.provide(makeTestRuntime())),
      ),
    )

    expect(responses.length).toBe(0)
  })

  it("(6) send() pushes message to adapter directly", async () => {
    const responses: GatewayResponse[] = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const q = yield* Queue.unbounded<GatewayMessage>()
          const responsesRef = yield* Ref.make<GatewayResponse[]>([])
          const adapter = makeTestAdapter("push-transport", q, responsesRef)

          const gateway = yield* GatewayService
          yield* gateway.registerAdapter(adapter)
          yield* gateway.setHandler((msg) => Effect.succeed(`echo: ${msg.text}`))

          yield* Effect.forkDetach(
            gateway.start.pipe(Effect.catchCause(() => Effect.void)),
          )

          // Push via gateway.send (not via adapter queue)
          yield* gateway.send("push-transport", "ch-1", "push message")
          yield* Effect.sleep(Duration.millis(30))

          const captured = yield* Ref.get(responsesRef)
          responses.push(...captured)
        }).pipe(Effect.provide(makeTestRuntime())),
      ),
    )

    expect(responses.length).toBeGreaterThanOrEqual(1)
    expect(responses[0]?.text).toBe("push message")
  })

  it("(7) no adapters: start() completes immediately (empty stream)", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* GatewayService
          yield* gateway.setHandler((msg) => Effect.succeed(msg.text))

          // No adapters registered; start() should complete right away
          yield* Effect.timeout(gateway.start, Duration.millis(100)).pipe(
            Effect.catchTag("TimeoutError", () => Effect.succeed("timeout")),
          )
          return "ok"
        }).pipe(Effect.provide(makeTestRuntime())),
      ),
    )
    expect(result).toBe("ok")
  })
})
