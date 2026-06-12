/**
 * Tier-2 architecture simulation: prove that a SINGLE long-lived
 * `query()` call can drain N user turns from a Queue-backed prompt
 * Stream and yield matching assistant turns, without spawning new
 * Queries.
 *
 * Why this exists: the chat UI architecture (one SDK session per thread)
 * rests entirely on this assumption. The SDK type defs say it works
 * (`prompt: string | AsyncIterable<SDKUserMessage>`, `streamInput()`
 * exists on Query). But before we build 2K lines of UI on top, we
 * de-risk it with a fake SDK that consumes user turns and emits
 * responses on the same loop.
 *
 * The test does NOT touch the network. The fake's generator reads
 * from the AsyncIterable the adapter feeds it, and yields one
 * assistant + result message per inbound user message — exactly the
 * pattern the real SDK uses for streaming-input mode.
 */
import { describe, expect, it } from "vitest"
import { Chunk, Effect, Layer, Queue, Scope, Stream } from "effect"
import { SessionStore } from "@luna/core"
import { Clock as CoreClock } from "@luna/core"
import { SDKAdapter, SDKClient } from "../src/index.js"
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { makeAssistantMessage, makeResultMessage } from "./fake-sdk.js"

const sid = "s-chat"

const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  CoreClock.Test(1_700_000_000_000),
)

/**
 * Build a fake `Query` that LOOPS over the inbound user messages,
 * emitting one assistant + result per user turn. Closes when the
 * inbound iterable closes.
 */
const makeChatLoopQuery = (params: {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly sessionId: string
  readonly responseFor: (userText: string) => string
}): Query => {
  let turnIdx = 0

  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for await (const u of params.prompt) {
      turnIdx += 1
      const userText =
        typeof u.message.content === "string"
          ? u.message.content
          : "(structured user content)"
      yield makeAssistantMessage(
        params.sessionId,
        params.responseFor(userText),
        `assistant-${turnIdx}`,
      )
      yield makeResultMessage(params.sessionId, `result-${turnIdx}`)
    }
  }

  const iterator = gen()
  return Object.assign(iterator, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

const userMsg = (text: string): SDKUserMessage =>
  ({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  }) as SDKUserMessage

const runScoped = <A, E>(
  eff: Effect.Effect<A, E, SDKAdapter | SessionStore | Scope.Scope>,
  fakeLayer: Layer.Layer<SDKClient>,
) =>
  Effect.runPromise(
    Effect.scoped(eff).pipe(
      Effect.provide(
        Layer.provideMerge(
          SDKAdapter.Default,
          Layer.mergeAll(fakeLayer, baseLayer),
        ),
      ),
    ),
  )

describe("SDKAdapter long-lived Query simulation (Tier-2 architecture proof)", () => {
  it(
    "drains 5 user turns through a single query() call",
    async () => {
      let constructedQueries = 0
      const fakeLayer = SDKClient.fake((p) => {
        constructedQueries += 1
        const it = p.prompt as AsyncIterable<SDKUserMessage>
        return makeChatLoopQuery({
          prompt: it,
          sessionId: sid,
          responseFor: (t) => `echo: ${t}`,
        })
      })

      const result = await runScoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: sid,
            options: { model: "claude-test" },
            createdAt: 0,
          })

          // Queue is the production pattern: ChatService will push
          // user messages into a Queue and feed Stream.fromQueue to
          // the adapter as `prompt`.
          const inbox = yield* Queue.unbounded<SDKUserMessage>()
          const promptStream: Stream.Stream<SDKUserMessage> =
            Stream.fromQueue(inbox)

          const adapter = yield* SDKAdapter
          const out = yield* adapter.query({
            sessionId: sid,
            prompt: promptStream,
            sessionOptions: {
              model: "claude-test",
              idleTimeoutMs: 30_000,
            },
          })

          const TURNS = 5
          const consumed: Array<SDKMessage> = []

          const consumer = Effect.gen(function* () {
            const collected = yield* out.pipe(
              Stream.take(TURNS * 2),
              Stream.runCollect,
            )
            for (const m of collected) consumed.push(m)
          })

          const producer = Effect.gen(function* () {
            for (let i = 0; i < TURNS; i++) {
              yield* Queue.offer(inbox, userMsg(`turn-${i}`))
              yield* Effect.sleep("10 millis")
            }
            yield* Queue.shutdown(inbox)
          })

          yield* Effect.all([consumer, producer], { concurrency: 2 })

          const stored = yield* Stream.runCollect(store.readMessages(sid))
          return {
            consumedCount: consumed.length,
            consumedKinds: consumed.map((m) => (m as { type: string }).type),
            persistedCount: Chunk.size(stored),
          }
        }),
        fakeLayer,
      )

      // Load-bearing assertions:
      // 1. EXACTLY ONE query() call serviced all 5 turns.
      expect(constructedQueries).toBe(1)
      // 2. Every user turn produced an assistant + result.
      expect(result.consumedCount).toBe(10)
      expect(
        result.consumedKinds.filter((k) => k === "assistant"),
      ).toHaveLength(5)
      expect(result.consumedKinds.filter((k) => k === "result")).toHaveLength(5)
      // 3. SessionStore mirrored every SDK message.
      expect(result.persistedCount).toBe(10)
    },
    { timeout: 10_000 },
  )

  it(
    "with disableIdleTimeout: true, survives a starve-then-resume gap longer than DEFAULT_IDLE_TIMEOUT_MS would allow",
    async () => {
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: sid,
          responseFor: (t) => `re: ${t}`,
        }),
      )

      const total = await runScoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: sid,
            options: { model: "claude-test" },
            createdAt: 0,
          })
          const inbox = yield* Queue.unbounded<SDKUserMessage>()
          const promptStream = Stream.fromQueue(inbox)

          const adapter = yield* SDKAdapter
          const out = yield* adapter.query({
            sessionId: sid,
            prompt: promptStream,
            sessionOptions: {
              model: "claude-test",
              // 100ms timeout would normally trip in the 300ms gap below.
              idleTimeoutMs: 100,
              // …but disabled, so the Queue is allowed to starve.
              disableIdleTimeout: true,
            },
          })

          const consumer = out.pipe(Stream.take(4), Stream.runCollect)

          const producer = Effect.gen(function* () {
            yield* Queue.offer(inbox, userMsg("first"))
            // Long pause — far exceeds idleTimeoutMs:100. With opt-out
            // engaged, no SDKError fires.
            yield* Effect.sleep("300 millis")
            yield* Queue.offer(inbox, userMsg("second"))
            yield* Effect.sleep("50 millis")
            yield* Queue.shutdown(inbox)
          })

          const [collected] = yield* Effect.all([consumer, producer], {
            concurrency: 2,
          })
          return Array.from(collected).length
        }),
        fakeLayer,
      )

      expect(total).toBe(4)
    },
    { timeout: 10_000 },
  )

  it(
    "remains responsive when user turns arrive with idle gaps shorter than the timeout",
    async () => {
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: sid,
          responseFor: (t) => `re: ${t}`,
        }),
      )

      const total = await runScoped(
        Effect.gen(function* () {
          const store = yield* SessionStore
          yield* store.create({
            id: sid,
            options: { model: "claude-test" },
            createdAt: 0,
          })
          const inbox = yield* Queue.unbounded<SDKUserMessage>()
          const promptStream = Stream.fromQueue(inbox)

          const adapter = yield* SDKAdapter
          const out = yield* adapter.query({
            sessionId: sid,
            prompt: promptStream,
            sessionOptions: {
              model: "claude-test",
              idleTimeoutMs: 2_000, // 2s — gap below is 200ms
            },
          })

          const consumer = out.pipe(Stream.take(4), Stream.runCollect)

          const producer = Effect.gen(function* () {
            yield* Queue.offer(inbox, userMsg("first"))
            yield* Effect.sleep("200 millis")
            yield* Queue.offer(inbox, userMsg("second"))
            yield* Effect.sleep("200 millis")
            yield* Queue.shutdown(inbox)
          })

          const [collected] = yield* Effect.all([consumer, producer], {
            concurrency: 2,
          })
          return Array.from(collected).length
        }),
        fakeLayer,
      )

      expect(total).toBe(4) // 2 turns × (assistant + result)
    },
    { timeout: 10_000 },
  )
})
