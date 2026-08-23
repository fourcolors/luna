/**
 * ChatService Tier-2 simulation: prove the WS-layer-shaped contract holds
 * end-to-end through a fake SDK. Mirrors the architecture proof in
 * `packages/adapter-sdk/test/long-lived-query.sim.test.ts` one layer up.
 *
 * Scenarios:
 *   1. Two subscribers on the same thread receive the snapshot + every
 *      live frame; an unsubscribed subscriber on a DIFFERENT thread sees
 *      nothing for the first thread's traffic.
 *   2. Snapshot dedupe: subscribe AFTER 2 user turns are persisted —
 *      snapshot carries throughSeq covering them; subsequent live frames
 *      have seq > throughSeq.
 *   3. Interrupt: emits an `assistant-error` frame tagged "interrupted".
 *
 * The fake SDK loops over inbound user messages and yields one assistant
 * + one result per turn. No partial-stream deltas in this scenario; that
 * path needs a real-SDK smoke test, which we'll add separately.
 */
import { afterAll, describe, expect, it } from "vitest"
import {
  Effect,
  Fiber,
  Layer,
  Option,
  Scope,
  Stream,
} from "effect"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  TelemetryService,
  ThreadRegistryService,
  extractText,
  type ChatMessage,
  type SessionOptions,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

// Inline fake-sdk message builders — duplicated from
// `packages/adapter-sdk/test/fake-sdk.ts` because adapter-sdk's package.json
// `exports` map only exposes the `.` entry. Trivial enough that the
// duplication is cheaper than reshaping `exports`.
const makeAssistantMessage = (
  sessionId: string,
  text: string,
  uuid: string,
): SDKMessage =>
  ({
    type: "assistant",
    session_id: sessionId,
    uuid,
    parent_tool_use_id: null,
    message: {
      id: uuid,
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }) as unknown as SDKMessage

const makeResultMessage = (sessionId: string, uuid: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid,
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    result: "ok",
  }) as unknown as SDKMessage

const makeStreamEvent = (
  sessionId: string,
  uuid: string,
  text: string,
): SDKMessage =>
  ({
    type: "stream_event",
    session_id: sessionId,
    uuid,
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  }) as unknown as SDKMessage
import {
  ChatService,
  ThreadToolsProviderTag,
  type ChatFrame,
  type DeliveryNotification,
  type ThreadToolsProvider,
} from "../src/index.js"
import { applyClientMarker } from "../src/client-marker.js"

// No-op MemoryRouter: sim tests never call searchMemory; they just need
// the tag to be present in the layer graph after MemoryRouterTag was added
// to ChatService.Default's requirements.
const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("noopMemoryRouter.put"),
  get: () => Effect.die("noopMemoryRouter.get"),
  query: () => Stream.die("noopMemoryRouter.query"),
  delete: () => Effect.die("noopMemoryRouter.delete"),
  backendFor: () => { throw new Error("noopMemoryRouter.backendFor") },
  exportAll: () => Effect.die("noopMemoryRouter.exportAll"),
}

const testClock = CoreClock.Test(1_700_000_000_000)
const obsJsonlPath = join(
  tmpdir(),
  `luna-chat-service-sim-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
)

afterAll(() => {
  try { unlinkSync(obsJsonlPath) } catch { /* ignore */ }
})

const obsLayer = ObservabilityService.makeLayer({
  logToConsole: false,
  jsonlPath: obsJsonlPath,
}).pipe(
  Layer.provide(testClock),
)
const telemetryLayer = TelemetryService.makeLayer().pipe(
  Layer.provide(testClock),
)
const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  testClock,
  obsLayer,
  telemetryLayer,
  Layer.succeed(MemoryRouterTag, noopMemoryRouter),
)

/** Fake Query that loops over inbound user messages, yielding assistant +
 *  result per turn. Identical pattern to long-lived-query.sim.test.ts. */
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
          : "(structured)"
      yield makeAssistantMessage(
        params.sessionId,
        params.responseFor(userText),
        `assistant-${turnIdx}`,
      )
      yield makeResultMessage(params.sessionId, `result-${turnIdx}`)
    }
  }
  const it = gen()
  return Object.assign(it, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

// A query whose stream fails before emitting a `result`, modelling a fatal
// adapter failure (e.g. a stale executable) mid-turn.
const makeFailingQuery = (): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    throw new Error("adapter stream boom")
  }
  const it = gen()
  return Object.assign(it, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

const makeStreamingQuery = (params: {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly sessionId: string
}): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for await (const _u of params.prompt) {
      yield {
        type: "stream_event",
        session_id: params.sessionId,
        uuid: "delta-1",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "O" },
        },
      } as unknown as SDKMessage
      yield {
        type: "stream_event",
        session_id: params.sessionId,
        uuid: "delta-2",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "K" },
        },
      } as unknown as SDKMessage
      yield makeAssistantMessage(params.sessionId, "OK", "assistant-final")
      yield makeResultMessage(params.sessionId, "result-final")
    }
  }
  const it = gen()
  return Object.assign(it, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    applyFlagSettings: async () => {},
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

const fullLayer = (
  fakeLayer: Layer.Layer<SDKClient>,
): Layer.Layer<
  ChatService | SessionStore | CoreClock | ObservabilityService | TelemetryService
> =>
  Layer.provideMerge(
    ChatService.Default,
    Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
  )

const runScoped = <A, E>(
  eff: Effect.Effect<
    A,
    E,
    ChatService | SessionStore | CoreClock | ObservabilityService | Scope.Scope
    | TelemetryService
  >,
  fakeLayer: Layer.Layer<SDKClient>,
) =>
  Effect.runPromise(
    Effect.scoped(eff).pipe(Effect.provide(fullLayer(fakeLayer))),
  )

describe("ChatService (Tier-2 sim)", () => {
  it("replaces per-turn recall without storing or accumulating it", async () => {
    const sdkUserTexts: string[] = []
    const systemPrompts: string[] = []
    const resumes: Array<string | undefined> = []
    const observed: Array<{
      userText: string
      assistantText: string
      isError: boolean
    }> = []
    const fakeLayer = SDKClient.fake((p) => {
      systemPrompts.push(String(p.options?.systemPrompt ?? ""))
      resumes.push(p.options?.resume)
      return makeChatLoopQuery({
        prompt: p.prompt as AsyncIterable<SDKUserMessage>,
        sessionId: "thr-hooks",
        responseFor: (text) => {
          sdkUserTexts.push(text)
          return "assistant final"
        },
      })
    })
    const provider: ThreadToolsProvider = {
      decorate: () => ({
        mcpServers: {},
        systemPrompt: "base identity",
        onBound: () => {},
        recallMemory: ({ userText }) =>
          Effect.succeed(
            `<memory_context>${userText} memory</memory_context>`,
          ),
        observeTurn: ({ userText, assistantText, isError }) =>
          Effect.sync(() => observed.push({ userText, assistantText, isError })),
      }),
    }
    const layer = Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(
        SDKAdapter.Default,
        Layer.mergeAll(
          fakeLayer,
          baseLayer,
          Layer.succeed(ThreadToolsProviderTag, provider),
        ),
      ),
    )

    const storedText = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore
          const thread = yield* chat.createThread({ model: "claude-test" })
          yield* chat.send(thread.id, "first user text")
          yield* Effect.sleep("100 millis")
          yield* chat.send(thread.id, "second user text")
          yield* Effect.sleep("100 millis")
          const messages = yield* store
            .readMessages(thread.id)
            .pipe(Stream.runCollect)
          return Array.from(messages)
            .filter((m) => m.kind === "user")
            .map((m) => extractText(m.payload))
        }),
      ).pipe(Effect.provide(layer)),
    )

    expect(storedText).toEqual(["first user text", "second user text"])
    expect(sdkUserTexts).toEqual(["first user text", "second user text"])
    expect(systemPrompts).toHaveLength(2)
    expect(systemPrompts[0]).toContain("base identity")
    expect(systemPrompts[0]).toContain("first user text memory")
    expect(systemPrompts[0]).not.toContain("second user text memory")
    expect(systemPrompts[1]).toContain("base identity")
    expect(systemPrompts[1]).toContain("second user text memory")
    expect(systemPrompts[1]).not.toContain("first user text memory")
    expect(resumes).toEqual([undefined, "thr-hooks"])
    expect(observed).toEqual([
      {
        userText: "first user text",
        assistantText: "assistant final",
        isError: false,
      },
      {
        userText: "second user text",
        assistantText: "assistant final",
        isError: false,
      },
    ])
  })

  it("an adapter stream failure drains its observation seed so later turns stay paired", async () => {
    const observed: Array<{
      userText: string
      assistantText: string
      isError: boolean
    }> = []
    let turn = 0
    const fakeLayer = SDKClient.fake((p) => {
      turn += 1
      // The first turn's stream fails before any `result`; the second turn
      // succeeds. If the failure does not drain the pendingTurns seed, the
      // second turn's `result` pairs with the FIRST turn's user text.
      if (turn === 1) return makeFailingQuery()
      return makeChatLoopQuery({
        prompt: p.prompt as AsyncIterable<SDKUserMessage>,
        sessionId: "thr-fail",
        responseFor: () => "assistant final",
      })
    })
    const provider: ThreadToolsProvider = {
      decorate: () => ({
        mcpServers: {},
        systemPrompt: "base identity",
        onBound: () => {},
        // A bound recallMemory routes the thread through the per-turn finite
        // query path where handleAdapterFailure fires per turn.
        recallMemory: () => Effect.succeed(null),
        observeTurn: ({ userText, assistantText, isError }) =>
          Effect.sync(() => observed.push({ userText, assistantText, isError })),
      }),
    }
    const layer = Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(
        SDKAdapter.Default,
        Layer.mergeAll(
          fakeLayer,
          baseLayer,
          Layer.succeed(ThreadToolsProviderTag, provider),
        ),
      ),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const thread = yield* chat.createThread({ model: "claude-test" })
          yield* chat.send(thread.id, "first user text")
          yield* Effect.sleep("150 millis")
          yield* chat.send(thread.id, "second user text")
          yield* Effect.sleep("150 millis")
        }),
      ).pipe(Effect.provide(layer)),
    )

    expect(observed).toEqual([
      { userText: "first user text", assistantText: "", isError: true },
      {
        userText: "second user text",
        assistantText: "assistant final",
        isError: false,
      },
    ])
  })

  it("a hung recall hook is bounded by the timeout and degrades to the original payload", async () => {
    const prev = process.env["LUNA_CHAT_RECALL_TIMEOUT_MS"]
    process.env["LUNA_CHAT_RECALL_TIMEOUT_MS"] = "50"
    try {
      let sdkUserText = ""
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-hang",
          responseFor: (text) => {
            sdkUserText = text
            return "assistant final"
          },
        }),
      )
      // recallMemory never resolves - without the bound, the turn would hang
      // and the user's message would never reach the SDK.
      const provider: ThreadToolsProvider = {
        decorate: () => ({
          mcpServers: {},
          onBound: () => {},
          recallMemory: () => Effect.never,
        }),
      }
      const layer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.Default,
          Layer.mergeAll(
            fakeLayer,
            baseLayer,
            Layer.succeed(ThreadToolsProviderTag, provider),
          ),
        ),
      )

      const storedText = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const store = yield* SessionStore
            const thread = yield* chat.createThread({ model: "claude-test" })
            yield* chat.send(thread.id, "original user text")
            yield* Effect.sleep("300 millis")
            const messages = yield* store
              .readMessages(thread.id)
              .pipe(Stream.runCollect)
            const user = Array.from(messages).find((m) => m.kind === "user")
            return user === undefined ? null : extractText(user.payload)
          }),
        ).pipe(Effect.provide(layer)),
      )

      expect(storedText).toBe("original user text")
      // The turn still reached the SDK with the unmodified payload.
      expect(sdkUserText).toBe("original user text")
    } finally {
      if (prev === undefined) delete process.env["LUNA_CHAT_RECALL_TIMEOUT_MS"]
      else process.env["LUNA_CHAT_RECALL_TIMEOUT_MS"] = prev
    }
  })

  it(
    "fan-out: two subscribers on the same thread see every frame; another thread's subscriber stays untouched",
    async () => {
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        }),
      )

      const { aFrames, bFrames, cFrames } = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService

          const t1 = yield* chat.createThread({
            model: "claude-test",
            title: "T1",
          })
          const t2 = yield* chat.createThread({
            model: "claude-test",
            title: "T2",
          })

          // Subscribers attach BEFORE messages flow.
          const subA = chat.subscribe(t1.id)
          const subB = chat.subscribe(t1.id)
          const subC = chat.subscribe(t2.id)

          const TURNS = 3
          // Each subscriber should see, per turn: user-accepted + assistant-done
          // + turn-complete (the SDK `result`) = 3 frames. Plus 1 snapshot →
          // 1 + TURNS * 3 = 10 frames.
          // (No assistant-delta frames — fake doesn't emit stream_event.)
          const collectN = (s: Stream.Stream<ChatFrame, never>, n: number) =>
            s.pipe(Stream.take(n), Stream.runCollect)

          const aFiber = yield* Effect.forkChild(collectN(subA, 1 + TURNS * 3))
          const bFiber = yield* Effect.forkChild(collectN(subB, 1 + TURNS * 3))
          const cFiber = yield* Effect.forkChild(collectN(subC, 1)) // just snapshot

          // Let the forked subscribers attach to their PubSub before any
          // send fires — `Stream.unwrap` only opens the underlying
          // PubSub.subscribe lazily on first pull.
          yield* Effect.sleep("30 millis")

          // Drive the conversation.
          for (let i = 0; i < TURNS; i++) {
            yield* chat.send(t1.id, `q-${i}`)
            yield* Effect.sleep("10 millis")
          }

          const aChunk = yield* Fiber.join(aFiber)
          const bChunk = yield* Fiber.join(bFiber)
          const cChunk = yield* Fiber.join(cFiber)
          return {
            aFrames: Array.from(aChunk),
            bFrames: Array.from(bChunk),
            cFrames: Array.from(cChunk),
          }
        }),
        fakeLayer,
      )

      // Both A and B see the same sequence of types.
      const types = (frames: ReadonlyArray<ChatFrame>) =>
        frames.map((f) => f.type)
      expect(types(aFrames)).toEqual([
        "snapshot",
        "user-accepted",
        "assistant-done",
        "turn-complete",
        "user-accepted",
        "assistant-done",
        "turn-complete",
        "user-accepted",
        "assistant-done",
        "turn-complete",
      ])
      expect(types(bFrames)).toEqual(types(aFrames))

      // A's first frame is the snapshot; throughSeq is -1 (no messages yet
      // when subscribed).
      expect(aFrames[0]!.type).toBe("snapshot")
      if (aFrames[0]!.type === "snapshot") {
        expect(aFrames[0].throughSeq).toBe(-1)
        expect(aFrames[0].messages).toHaveLength(0)
      }

      // C only ever saw T2's snapshot (empty).
      expect(types(cFrames)).toEqual(["snapshot"])
      if (cFrames[0]!.type === "snapshot") {
        expect(cFrames[0].messages).toHaveLength(0)
      }

      // Live frames carry monotonic seq.
      const liveSeqs: number[] = []
      for (const f of aFrames.slice(1)) {
        if (f.type === "user-accepted" || f.type === "assistant-done") {
          liveSeqs.push(f.seq)
        }
      }
      const sorted = [...liveSeqs].sort((a, b) => a - b)
      expect(liveSeqs).toEqual(sorted)
    },
    { timeout: 10_000 },
  )

  it(
    "snapshot dedupe: subscribing after 2 turns yields throughSeq covering them; later live frames carry seq > throughSeq",
    async () => {
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: "thr-x",
          responseFor: (t) => `re:${t}`,
        }),
      )

      const result = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t = yield* chat.createThread({
            model: "claude-test",
            title: "snap",
          })

          // Drive 2 turns BEFORE any subscriber attaches.
          yield* chat.send(t.id, "first")
          yield* Effect.sleep("20 millis")
          yield* chat.send(t.id, "second")
          yield* Effect.sleep("20 millis")

          // Now subscribe. Snapshot should carry throughSeq covering all
          // 4 stored messages (2 user + 2 assistant + 2 result; result
          // doesn't project, so messages.length===4).
          const sub = chat.subscribe(t.id)

          // Push one more turn live.
          const fiber = yield* Effect.forkChild(
            sub.pipe(Stream.take(3), Stream.runCollect),
          )
          // Wait for the subscriber to attach to PubSub before sending.
          yield* Effect.sleep("30 millis")
          yield* chat.send(t.id, "third")
          const chunk = yield* Fiber.join(fiber)
          const frames = Array.from(chunk)
          return frames
        }),
        fakeLayer,
      )

      // Frame 0: snapshot with 4 projected ChatMessages, throughSeq covers
      // all stored msgs including the result rows.
      const snap = result[0]!
      expect(snap.type).toBe("snapshot")
      if (snap.type === "snapshot") {
        // 2 user + 2 assistant projected; results filtered by projection.
        expect(snap.messages.map((m: ChatMessage) => m.role)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ])
        expect(snap.throughSeq).toBeGreaterThanOrEqual(3) // 0..N for stored seqs
      }

      // Frames 1-2 are the live "third" turn — seq must EXCEED throughSeq.
      const live = result.slice(1)
      const through = snap.type === "snapshot" ? snap.throughSeq : -1
      for (const f of live) {
        if (f.type === "user-accepted" || f.type === "assistant-done") {
          expect(f.seq).toBeGreaterThan(through)
        }
      }
    },
    { timeout: 10_000 },
  )

  it(
    "interrupt emits an `assistant-error` frame tagged 'interrupted'",
    async () => {
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: "thr-i",
          responseFor: (t) => `r:${t}`,
        }),
      )

      const errorFrame = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t = yield* chat.createThread({
            model: "claude-test",
            title: "int",
          })
          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.forkChild(
            sub.pipe(
              Stream.filter((f) => f.type === "assistant-error"),
              Stream.take(1),
              Stream.runCollect,
            ),
          )
          yield* Effect.sleep("5 millis")
          yield* chat.interrupt(t.id)
          const chunk = yield* Fiber.join(fiber)
          return Array.from(chunk)[0]!
        }),
        fakeLayer,
      )

      expect(errorFrame.type).toBe("assistant-error")
      if (errorFrame.type === "assistant-error") {
        expect(errorFrame.error.kind).toBe("interrupted")
      }
    },
    { timeout: 10_000 },
  )

  it(
    "stream_event deltas with distinct SDK uuids keep one stable wire turn id",
    async () => {
      const fakeLayer = SDKClient.fake((p) =>
        makeStreamingQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
        }),
      )

      const frames = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t = yield* chat.createThread({
            model: "claude-test",
            title: "streaming",
          })
          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.forkChild(
            sub.pipe(Stream.take(5), Stream.runCollect),
          )
          yield* Effect.sleep("30 millis")
          yield* chat.send(t.id, "reply ok")
          const chunk = yield* Fiber.join(fiber)
          return Array.from(chunk)
        }),
        fakeLayer,
      )

      const deltas = frames.filter((f) => f.type === "assistant-delta")
      const done = frames.find((f) => f.type === "assistant-done")
      expect(deltas).toHaveLength(2)
      expect(deltas.map((f) => f.turnId)).toEqual(["delta-1", "delta-1"])
      expect(deltas.map((f) => f.text)).toEqual(["O", "OK"])
      expect(done?.type).toBe("assistant-done")
      if (done?.type !== "assistant-done") {
        throw new Error("expected assistant-done frame")
      }
      expect(done.turnId).toBe("delta-1")
      expect(done.message.text).toBe("OK")
    },
    { timeout: 10_000 },
  )

  it(
    "resets in-flight turn state when a turn ends without a final assistant message (no cross-turn delta bleed)",
    async () => {
      // Turn 1 streams deltas + result but NO final `assistant` message (an
      // aborted-style turn). The in-flight reset lives only in the assistant
      // branch, so without a result-branch reset, turn 2's deltas inherit
      // turn 1's stale turnId + accumulated text.
      const fakeLayer = SDKClient.fake((p) => {
        const sessionId = (p as { sessionId?: string }).sessionId ?? "thr-?"
        let turn = 0
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const _u of p.prompt as AsyncIterable<SDKUserMessage>) {
            turn += 1
            if (turn === 1) {
              yield makeStreamEvent(sessionId, "t1d1", "A")
              yield makeStreamEvent(sessionId, "t1d2", "B")
              yield makeResultMessage(sessionId, "t1-result")
            } else {
              yield makeStreamEvent(sessionId, "t2d1", "X")
              yield makeStreamEvent(sessionId, "t2d2", "Y")
              yield makeAssistantMessage(sessionId, "XY", "t2-assistant")
              yield makeResultMessage(sessionId, "t2-result")
            }
          }
        }
        const it = gen()
        return Object.assign(it, {
          interrupt: async () => {},
          setPermissionMode: async () => {},
          setModel: async () => {},
          applyFlagSettings: async () => {},
          setMaxThinkingTokens: async () => {},
          supplyToolPermissionResponse: async () => {},
          mcpServerStatus: async () => ({}),
        } as Partial<Query>) as Query
      })

      const deltas = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t = yield* chat.createThread({
            model: "claude-test",
            title: "reset",
          })
          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.forkChild(
            sub.pipe(
              Stream.filter((f) => f.type === "assistant-delta"),
              Stream.take(4),
              Stream.runCollect,
            ),
          )
          yield* Effect.sleep("30 millis")
          yield* chat.send(t.id, "turn one")
          yield* Effect.sleep("40 millis")
          yield* chat.send(t.id, "turn two")
          const chunk = yield* Fiber.join(fiber)
          return Array.from(chunk)
        }),
        fakeLayer,
      )

      // The last two deltas belong to turn 2 — they MUST carry turn 2's id and
      // fresh text, not turn 1's leftovers.
      const turn2 = deltas.slice(2)
      expect(
        turn2.map((f) => (f.type === "assistant-delta" ? f.turnId : "?")),
      ).toEqual(["t2d1", "t2d1"])
      expect(
        turn2.map((f) => (f.type === "assistant-delta" ? f.text : "?")),
      ).toEqual(["X", "XY"])
    },
    { timeout: 10_000 },
  )

  it(
    "interrupt() resets in-flight turn state so the next turn's deltas are not corrupted",
    async () => {
      // Turn 1 emits one delta then stalls (no result/assistant) — an in-flight
      // turn. The user hits Stop (interrupt), then sends a new turn. interrupt()
      // must clear the in-flight turn state, else turn 2's first delta inherits
      // turn 1's stale turnId + text. This path has NO result, so ONLY the
      // interrupt() reset (not the result-branch reset) can cover it.
      const fakeLayer = SDKClient.fake((p) => {
        const sessionId = (p as { sessionId?: string }).sessionId ?? "thr-?"
        let turn = 0
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const _u of p.prompt as AsyncIterable<SDKUserMessage>) {
            turn += 1
            if (turn === 1) {
              yield makeStreamEvent(sessionId, "i1d1", "A")
              // no result/assistant — the turn stays in-flight until interrupt
            } else {
              yield makeStreamEvent(sessionId, "i2d1", "X")
              yield makeStreamEvent(sessionId, "i2d2", "Y")
              yield makeAssistantMessage(sessionId, "XY", "i2-assistant")
              yield makeResultMessage(sessionId, "i2-result")
            }
          }
        }
        const it = gen()
        return Object.assign(it, {
          interrupt: async () => {},
          setPermissionMode: async () => {},
          setModel: async () => {},
          applyFlagSettings: async () => {},
          setMaxThinkingTokens: async () => {},
          supplyToolPermissionResponse: async () => {},
          mcpServerStatus: async () => ({}),
        } as Partial<Query>) as Query
      })

      const deltas = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t = yield* chat.createThread({
            model: "claude-test",
            title: "int-reset",
          })
          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.forkChild(
            sub.pipe(
              Stream.filter((f) => f.type === "assistant-delta"),
              Stream.take(3),
              Stream.runCollect,
            ),
          )
          yield* Effect.sleep("30 millis")
          yield* chat.send(t.id, "turn one")
          yield* Effect.sleep("30 millis")
          yield* chat.interrupt(t.id)
          yield* Effect.sleep("10 millis")
          yield* chat.send(t.id, "turn two")
          const chunk = yield* Fiber.join(fiber)
          return Array.from(chunk)
        }),
        fakeLayer,
      )

      // turn 1 produced exactly one delta; the rest belong to turn 2.
      const turn2 = deltas.slice(1)
      expect(
        turn2.map((f) => (f.type === "assistant-delta" ? f.turnId : "?")),
      ).toEqual(["i2d1", "i2d1"])
      expect(
        turn2.map((f) => (f.type === "assistant-delta" ? f.text : "?")),
      ).toEqual(["X", "XY"])
    },
    { timeout: 10_000 },
  )

  it(
    "send() to an unknown threadId returns Option.none and does not throw",
    async () => {
      const fakeLayer = SDKClient.fake(() => {
        throw new Error("should not be constructed for nonexistent thread")
      })
      const out = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          return yield* chat.send("thr-does-not-exist", "anything")
        }),
        fakeLayer,
      )
      expect(Option.isNone(out)).toBe(true)
    },
    { timeout: 10_000 },
  )

  it(
    "SDK defaults isolate settings, disable auto memory, and remove Claude Code built-ins except Task",
    async () => {
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        // Return a parked Query — we only care about the options capture.
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })
      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          // Default — no settingSources passed
          yield* chat.createThread({ model: "claude-test", title: "default" })
          yield* Effect.sleep("30 millis")
        }),
        fakeLayer,
      )
      expect(capturedOptions).toBeDefined()
      expect(capturedOptions!["settingSources"]).toEqual([])
      // Luna grants the research/fix built-ins (web, filesystem, shell) plus
      // "Task" (subagent spawn). These route through the canUseTool safety rail
      // installed in chat-server. TodoWrite et al. stay removed.
      expect(capturedOptions!["tools"]).toEqual([
        "Task",
        "WebFetch",
        "WebSearch",
        "Read",
        "Edit",
        "Write",
        "Grep",
        "Glob",
      ])
      expect(capturedOptions!["allowedTools"]).toEqual([
        "mcp__memory__*",
        "mcp__scheduler__*",
        "mcp__observability__*",
        "mcp__local_shell__*",
        "mcp__secret_tools__*",
        "mcp__skill_tools__*",
        "mcp__widget_tools__*",
        "mcp__suggested_actions__*",
        "Task",
      ])
      expect(capturedOptions!["strictMcpConfig"]).toBe(true)
      expect(capturedOptions!["env"]).toMatchObject({
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      })
    },
    { timeout: 10_000 },
  )

  it(
    "programmatic MCP servers stay available alongside the research/fix built-ins",
    async () => {
      const mcpServers = {
        memory: { type: "sdk", instance: {} },
        scheduler: { type: "sdk", instance: {} },
      }
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })
      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          yield* chat.createThread({
            model: "claude-test",
            title: "mcp-only-tools",
            mcpServers,
          })
          yield* Effect.sleep("30 millis")
        }),
        fakeLayer,
      )
      expect(capturedOptions).toBeDefined()
      // Built-ins are now granted (Task + research/fix tools), and the
      // caller-supplied MCP servers still pass through unchanged.
      expect(capturedOptions!["tools"]).toContain("Task")
      expect(capturedOptions!["tools"]).toContain("WebFetch")
      expect(capturedOptions!["allowedTools"]).toContain("mcp__memory__*")
      expect(capturedOptions!["allowedTools"]).toContain("mcp__scheduler__*")
      expect(capturedOptions!["mcpServers"]).toEqual(mcpServers)
    },
    { timeout: 10_000 },
  )

  it(
    "SDK env defaults preserve CLAUDE_CONFIG_DIR while disabling Claude Code auto memory",
    async () => {
      const prev = process.env["CLAUDE_CONFIG_DIR"]
      process.env["CLAUDE_CONFIG_DIR"] = "/tmp/luna-claude-config-test"
      try {
        let capturedOptions: Record<string, unknown> | undefined
        const fakeLayer = SDKClient.fake((p) => {
          capturedOptions = (p.options ?? {}) as Record<string, unknown>
          return makeChatLoopQuery({
            prompt: p.prompt as AsyncIterable<SDKUserMessage>,
            sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
            responseFor: (t) => `echo:${t}`,
          })
        })
        await runScoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            yield* chat.createThread({ model: "claude-test", title: "env" })
            yield* Effect.sleep("30 millis")
          }),
          fakeLayer,
        )
        expect(capturedOptions).toBeDefined()
        expect(capturedOptions!["env"]).toMatchObject({
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CONFIG_DIR: "/tmp/luna-claude-config-test",
        })
      } finally {
        if (prev === undefined) delete process.env["CLAUDE_CONFIG_DIR"]
        else process.env["CLAUDE_CONFIG_DIR"] = prev
      }
    },
    { timeout: 10_000 },
  )

  it(
    "settingSources can be explicitly opted into per-thread",
    async () => {
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })
      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          yield* chat.createThread({
            model: "claude-test",
            title: "project-settings",
            settingSources: ["project"],
          })
          yield* Effect.sleep("30 millis")
        }),
        fakeLayer,
      )
      expect(capturedOptions).toBeDefined()
      expect(capturedOptions!["settingSources"]).toEqual(["project"])
    },
    { timeout: 10_000 },
  )

  // Contract table: every field in CreateThreadOptions that must reach sdkOptions.
  // Regression anchor for systemPrompt (prior bug: silently dropped before SDK);
  // also pins cwd, settingSources, permissionMode, and mcpServers in one sweep.
  const CONTRACT_FIELDS = [
    {
      name: "systemPrompt" as const,
      value: "X-IDENTITY-X",
      sdkKey: "systemPrompt",
    },
    {
      // GAP#3: opts.model MUST reach sdkOptions.model — the SDK adapter routes
      // both the broker (provider selection, adapter.ts:263) and the SDK on
      // sdkOptions.model, NOT the top-level SessionOptions.model. Before the
      // fix this was dropped, so every chat thread routed to the default
      // (anthropic) provider regardless of the requested model.
      name: "model" as const,
      value: "gemini-2.5-flash",
      sdkKey: "model",
    },
    {
      name: "cwd" as const,
      value: "/tmp/luna-cwd-test",
      sdkKey: "cwd",
    },
    {
      name: "settingSources" as const,
      value: ["project"] as string[],
      sdkKey: "settingSources",
    },
    {
      name: "permissionMode" as const,
      value: "bypassPermissions" as const,
      sdkKey: "permissionMode",
    },
    {
      name: "mcpServers" as const,
      value: { foo: {} as never },
      sdkKey: "mcpServers",
    },
  ] as const

  it.each(CONTRACT_FIELDS)(
    "createThread forwards opts.$name into SDK options as $sdkKey",
    async ({ name, value, sdkKey }) => {
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })
      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          yield* chat.createThread({
            model: "claude-test",
            title: "contract",
            [name]: value,
          })
          yield* Effect.sleep("30 millis")
        }),
        fakeLayer,
      )
      expect(capturedOptions).toBeDefined()
      expect(capturedOptions![sdkKey]).toEqual(value)
    },
    { timeout: 10_000 },
  )

  // PING: stderr forward — surface SDK subprocess errors instead of swallowing
  // them to /dev/null. Without this, expired-OAuth retry-loops and similar
  // failure modes are invisible to operators (cost ~30 min today).
  it(
    "createThread wires a stderr forward into sdkOptions so SDK subprocess errors are observable",
    async () => {
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })
      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          yield* chat.createThread({ model: "claude-test", title: "stderr-wire" })
          yield* Effect.sleep("30 millis")
        }),
        fakeLayer,
      )
      expect(capturedOptions).toBeDefined()
      const stderr = capturedOptions!["stderr"]
      expect(typeof stderr).toBe("function")
      // Calling the captured callback should produce side effects on
      // process.stderr (we can't easily spy on it cross-process; the smoke
      // check that it's a function exercising chunk-string input is enough
      // to lock the contract).
      ;(stderr as (data: string) => void)("from-sdk: ETIMEOUT\n")
    },
  )

  // PING: when subscribing to a threadId the chat-service forgot (server
  // restart wiped in-memory state) BUT the persisted map remembers its
  // SDK session id, the subscribe call must transparently re-create the
  // thread with resumeFromSessionId so the model retains context.
  it(
    "subscribe re-creates a forgotten thread when the persisted map has its SDK session id",
    async () => {
      const fs = require("node:fs") as typeof import("node:fs")
      const path = require("node:path") as typeof import("node:path")
      const os = require("node:os") as typeof import("node:os")
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "luna-resume-"))
      const prevHome = process.env["LUNA_HOME"]
      process.env["LUNA_HOME"] = home
      try {
        // Pre-populate the persisted map as if a prior session had run.
        const RESUMED_ID = "thr_resumeme_abc123"
        const PERSISTED_SDK_ID = "sdk-prior-uuid-xyz"
        const mapDir = path.join(home, ".luna")
        fs.mkdirSync(mapDir, { recursive: true })
        fs.writeFileSync(
          path.join(mapDir, "thread-session-map.json"),
          JSON.stringify({ [RESUMED_ID]: PERSISTED_SDK_ID }),
          { mode: 0o600 },
        )

        let capturedResume: string | undefined
        const fakeLayer = SDKClient.fake((p) => {
          const opts = (p.options ?? {}) as Record<string, unknown>
          if (opts["resume"] !== undefined) {
            capturedResume = opts["resume"] as string
          }
          return makeChatLoopQuery({
            prompt: p.prompt as AsyncIterable<SDKUserMessage>,
            sessionId: PERSISTED_SDK_ID,
            responseFor: (t) => `echo:${t}`,
          })
        })

        await runScoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            // Subscribe to a thread we never created — should trigger
            // the auto-resume path.
            const sub = chat.subscribe(RESUMED_ID)
            const fiber = yield* Effect.forkChild(
              sub.pipe(
                Stream.take(1),
                Stream.runCollect,
              ),
            )
            yield* Effect.sleep("100 millis")
            yield* Fiber.interrupt(fiber)
          }),
          fakeLayer,
        )
        expect(capturedResume).toBe(PERSISTED_SDK_ID)
      } finally {
        if (prevHome !== undefined) {
          process.env["LUNA_HOME"] = prevHome
        } else {
          delete process.env["LUNA_HOME"]
        }
        fs.rmSync(home, { recursive: true, force: true })
      }
    },
  )

  // PING: the extended map shape — recovery must rebuild createThread with
  // the persisted {model, effort}, not just the sid, so a recovered thread
  // routes to the same provider lane and runs at the same effort level the
  // user selected before the restart (the D3 "survives restart" risk).
  it(
    "subscribe re-creates a forgotten thread with its persisted model and effort",
    async () => {
      const fs = require("node:fs") as typeof import("node:fs")
      const path = require("node:path") as typeof import("node:path")
      const os = require("node:os") as typeof import("node:os")
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "luna-resume-cfg-"))
      const prevHome = process.env["LUNA_HOME"]
      process.env["LUNA_HOME"] = home
      try {
        // Pre-populate the persisted map with the EXTENDED object shape, as
        // a prior session's createThread + setThreadConfig would have left it.
        const RESUMED_ID = "thr_resumecfg_def456"
        const PERSISTED_SDK_ID = "sdk-prior-uuid-cfg"
        const SAVED_MODEL = "claude-fable-5"
        const SAVED_EFFORT = "xhigh" // valid for fable — survives the clamp
        const mapDir = path.join(home, ".luna")
        fs.mkdirSync(mapDir, { recursive: true })
        fs.writeFileSync(
          path.join(mapDir, "thread-session-map.json"),
          JSON.stringify({
            [RESUMED_ID]: { sid: PERSISTED_SDK_ID, model: SAVED_MODEL, effort: SAVED_EFFORT },
          }),
          { mode: 0o600 },
        )

        let capturedOptions: Record<string, unknown> | undefined
        const fakeLayer = SDKClient.fake((p) => {
          capturedOptions = p.options as Record<string, unknown> | undefined
          return makeChatLoopQuery({
            prompt: p.prompt as AsyncIterable<SDKUserMessage>,
            sessionId: PERSISTED_SDK_ID,
            responseFor: (t) => `echo:${t}`,
          })
        })

        const storedOptions = await runScoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const store = yield* SessionStore
            // Subscribe to a thread the in-memory map forgot — recovery
            // must rebuild createThread from the persisted entry.
            const sub = chat.subscribe(RESUMED_ID)
            const fiber = yield* Effect.forkChild(
              sub.pipe(
                Stream.take(1),
                Stream.runCollect,
              ),
            )
            yield* Effect.sleep("100 millis")
            yield* Fiber.interrupt(fiber)
            return yield* store.getOptions(RESUMED_ID)
          }),
          fakeLayer,
        )

        // The rebuilt SDK query received resume + the saved model + effort.
        expect(capturedOptions?.["resume"]).toBe(PERSISTED_SDK_ID)
        expect(capturedOptions?.["model"]).toBe(SAVED_MODEL)
        expect(capturedOptions?.["effort"]).toBe(SAVED_EFFORT)
        // And the recovered session row reflects both in its sdkOptions.
        const sdkOpts = storedOptions?.sdkOptions as Record<string, unknown> | undefined
        expect(sdkOpts?.["model"]).toBe(SAVED_MODEL)
        expect(sdkOpts?.["effort"]).toBe(SAVED_EFFORT)
      } finally {
        if (prevHome !== undefined) {
          process.env["LUNA_HOME"] = prevHome
        } else {
          delete process.env["LUNA_HOME"]
        }
        fs.rmSync(home, { recursive: true, force: true })
      }
    },
  )

  // PING: when LUNA_HOME is set, ChatService must persist the
  // lunaThreadId → sdkSessionId mapping so threads can be resumed after
  // a chat-server restart.
  it(
    "createThread persists thread-session-map entry when LUNA_HOME is set",
    async () => {
      const fs = require("node:fs") as typeof import("node:fs")
      const path = require("node:path") as typeof import("node:path")
      const os = require("node:os") as typeof import("node:os")
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "luna-chat-tsmap-"))
      const prevHome = process.env["LUNA_HOME"]
      process.env["LUNA_HOME"] = home
      try {
        // The fake SDK assigns a known session_id that diverges from the
        // Luna threadId so we can prove the mapping captures the SDK's id
        // (not just an echo of what we passed in).
        const SDK_UUID = "sdk-uuid-from-fake-9f8e7d"
        const fakeLayer = SDKClient.fake((p) =>
          makeChatLoopQuery({
            prompt: p.prompt as AsyncIterable<SDKUserMessage>,
            sessionId: SDK_UUID,
            responseFor: (t) => `echo:${t}`,
          }),
        )
        let createdThreadId: string | undefined
        await runScoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const summary = yield* chat.createThread({
              model: "claude-test",
              title: "tsmap-test",
            })
            createdThreadId = summary.id
            // Trigger one user-message so the fake SDK actually yields.
            yield* chat.send(summary.id, "hello", undefined)
            yield* Effect.sleep("80 millis")
          }),
          fakeLayer,
        )
        expect(createdThreadId).toBeDefined()
        const mapPath = path.join(home, ".luna", "thread-session-map.json")
        expect(fs.existsSync(mapPath)).toBe(true)
        const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as Record<
          string,
          unknown
        >
        // New format: object with sid field (legacy bare strings also supported)
        const entry = map[createdThreadId!]
        const sid = typeof entry === "string" ? entry
          : (entry !== null && typeof entry === "object" && "sid" in (entry as Record<string, unknown>)
            ? (entry as Record<string, unknown>)["sid"]
            : undefined)
        expect(sid).toBe(SDK_UUID)
      } finally {
        if (prevHome !== undefined) {
          process.env["LUNA_HOME"] = prevHome
        } else {
          delete process.env["LUNA_HOME"]
        }
        fs.rmSync(home, { recursive: true, force: true })
      }
    },
  )

  it(
    "permissionMode defaults to 'default' when LUNA_TRUSTED_LOCAL is unset",
    async () => {
      const prev = process.env["LUNA_TRUSTED_LOCAL"]
      delete process.env["LUNA_TRUSTED_LOCAL"]
      try {
        let capturedOptions: Record<string, unknown> | undefined
        const fakeLayer = SDKClient.fake((p) => {
          capturedOptions = (p.options ?? {}) as Record<string, unknown>
          return makeChatLoopQuery({
            prompt: p.prompt as AsyncIterable<SDKUserMessage>,
            sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
            responseFor: (t) => `echo:${t}`,
          })
        })
        await runScoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            yield* chat.createThread({ model: "claude-test", title: "untrusted" })
            yield* Effect.sleep("30 millis")
          }),
          fakeLayer,
        )
        expect(capturedOptions).toBeDefined()
        expect(capturedOptions!["permissionMode"]).toBe("default")
      } finally {
        if (prev !== undefined) process.env["LUNA_TRUSTED_LOCAL"] = prev
      }
    },
    { timeout: 10_000 },
  )

  it(
    "permissionMode defaults to 'bypassPermissions' when LUNA_TRUSTED_LOCAL=1",
    async () => {
      const prev = process.env["LUNA_TRUSTED_LOCAL"]
      process.env["LUNA_TRUSTED_LOCAL"] = "1"
      try {
        let capturedOptions: Record<string, unknown> | undefined
        const fakeLayer = SDKClient.fake((p) => {
          capturedOptions = (p.options ?? {}) as Record<string, unknown>
          return makeChatLoopQuery({
            prompt: p.prompt as AsyncIterable<SDKUserMessage>,
            sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
            responseFor: (t) => `echo:${t}`,
          })
        })
        await runScoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            yield* chat.createThread({ model: "claude-test", title: "trusted" })
            yield* Effect.sleep("30 millis")
          }),
          fakeLayer,
        )
        expect(capturedOptions).toBeDefined()
        expect(capturedOptions!["permissionMode"]).toBe("bypassPermissions")
      } finally {
        if (prev === undefined) delete process.env["LUNA_TRUSTED_LOCAL"]
        else process.env["LUNA_TRUSTED_LOCAL"] = prev
      }
    },
    { timeout: 10_000 },
  )

  it(
    "forwards LUNA_CLAUDE_CODE_EXECUTABLE as pathToClaudeCodeExecutable",
    async () => {
      const prev = process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]
      process.env["LUNA_CLAUDE_CODE_EXECUTABLE"] = "/usr/local/bin/claude"
      try {
        let capturedOptions: Record<string, unknown> | undefined
        const fakeLayer = SDKClient.fake((p) => {
          capturedOptions = (p.options ?? {}) as Record<string, unknown>
          return makeChatLoopQuery({
            prompt: p.prompt as AsyncIterable<SDKUserMessage>,
            sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
            responseFor: (t) => `echo:${t}`,
          })
        })
        await runScoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            yield* chat.createThread({ model: "claude-test", title: "exec" })
            yield* Effect.sleep("30 millis")
          }),
          fakeLayer,
        )
        expect(capturedOptions).toBeDefined()
        expect(capturedOptions!["pathToClaudeCodeExecutable"]).toBe(
          "/usr/local/bin/claude",
        )
      } finally {
        if (prev === undefined) delete process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]
        else process.env["LUNA_CLAUDE_CODE_EXECUTABLE"] = prev
      }
    },
    { timeout: 10_000 },
  )

  it(
    "caller-supplied permissionMode wins over the env-derived default",
    async () => {
      const prev = process.env["LUNA_TRUSTED_LOCAL"]
      process.env["LUNA_TRUSTED_LOCAL"] = "1"
      try {
        let capturedOptions: Record<string, unknown> | undefined
        const fakeLayer = SDKClient.fake((p) => {
          capturedOptions = (p.options ?? {}) as Record<string, unknown>
          return makeChatLoopQuery({
            prompt: p.prompt as AsyncIterable<SDKUserMessage>,
            sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
            responseFor: (t) => `echo:${t}`,
          })
        })
        await runScoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            yield* chat.createThread({
              model: "claude-test",
              title: "plan-override",
              permissionMode: "plan",
            })
            yield* Effect.sleep("30 millis")
          }),
          fakeLayer,
        )
        expect(capturedOptions).toBeDefined()
        expect(capturedOptions!["permissionMode"]).toBe("plan")
      } finally {
        if (prev === undefined) delete process.env["LUNA_TRUSTED_LOCAL"]
        else process.env["LUNA_TRUSTED_LOCAL"] = prev
      }
    },
    { timeout: 10_000 },
  )

  it(
    "closeThread interrupts the per-thread Scope without dying on Exit",
    async () => {
      const fakeLayer = SDKClient.fake(async function* () {
        // Park; closing the scope should interrupt this generator.
        yield await new Promise<never>(() => {})
      })
      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t = yield* chat.createThread({
            model: "claude-test",
            title: "close-test",
          })
          // Should resolve without throwing — regression for the
          // `undefined as never` Exit bug.
          yield* chat.closeThread(t.id)
          // After close, send() to the same threadId returns Option.none
          // because the entry was removed from the map.
          const out = yield* chat.send(t.id, "ping")
          expect(Option.isNone(out)).toBe(true)
        }),
        fakeLayer,
      )
    },
    { timeout: 10_000 },
  )

  // ── Observability emission tests ────────────────────────────────────────

  it(
    "obs: createThread emits SessionStart with the thread id and model",
    async () => {
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        }),
      )

      const events = await runScoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          // Eagerly subscribe BEFORE creating the thread so we don't miss the event.
          const evStream = yield* obs.subscribeEvents
          const fiber = yield* Effect.forkChild(
            evStream.pipe(
              Stream.filter((e) => e.kind === "SessionStart"),
              Stream.take(1),
              Stream.runCollect,
            ),
          )

          const chat = yield* ChatService
          yield* chat.createThread({ model: "claude-sonnet-test", title: "obs-start" })

          const chunk = yield* Fiber.join(fiber)
          return Array.from(chunk)
        }),
        fakeLayer,
      )

      expect(events).toHaveLength(1)
      const ev = events[0]!
      expect(ev.kind).toBe("SessionStart")
      if (ev.kind === "SessionStart") {
        expect(ev.model).toBe("claude-sonnet-test")
        expect(ev.sessionId).toMatch(/^thr_/)
        expect(ev.level).toBe("info")
      }
    },
    { timeout: 10_000 },
  )

  it(
    "obs: assistant message with tool_use blocks emits ToolCall per block",
    async () => {
      // Build a fake SDK that returns an assistant message with two tool_use blocks.
      const makeAssistantWithTools = (sessionId: string): SDKMessage =>
        ({
          type: "assistant",
          session_id: sessionId,
          uuid: "turn-tools",
          parent_tool_use_id: null,
          message: {
            id: "turn-tools",
            role: "assistant",
            model: "claude-test",
            content: [
              { type: "tool_use", name: "Bash" },
              { type: "tool_use", name: "Read" },
              { type: "text", text: "done" },
            ],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }) as unknown as SDKMessage

      const fakeLayer = SDKClient.fake((p) => {
        const sessionId = (p as { sessionId?: string }).sessionId ?? "thr-?"
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const _u of p.prompt as AsyncIterable<SDKUserMessage>) {
            yield makeAssistantWithTools(sessionId)
            yield makeResultMessage(sessionId, "result-1")
          }
        }
        const it = gen()
        return Object.assign(it, {
          interrupt: async () => {},
          setPermissionMode: async () => {},
          setModel: async () => {},
          applyFlagSettings: async () => {},
          setMaxThinkingTokens: async () => {},
          supplyToolPermissionResponse: async () => {},
          mcpServerStatus: async () => ({}),
        } as Partial<Query>) as Query
      })

      const toolCallEvents = await runScoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const evStream = yield* obs.subscribeEvents
          const fiber = yield* Effect.forkChild(
            evStream.pipe(
              Stream.filter((e) => e.kind === "ToolCall"),
              Stream.take(2),
              Stream.runCollect,
            ),
          )

          const chat = yield* ChatService
          const t = yield* chat.createThread({ model: "claude-test", title: "tool-obs" })
          yield* Effect.sleep("5 millis")
          yield* chat.send(t.id, "go")

          const chunk = yield* Fiber.join(fiber)
          return Array.from(chunk)
        }),
        fakeLayer,
      )

      expect(toolCallEvents).toHaveLength(2)
      const names = toolCallEvents.map((e) => {
        if (e.kind === "ToolCall") return e.toolName
        return null
      })
      expect(names).toEqual(["Bash", "Read"])
      for (const e of toolCallEvents) {
        if (e.kind === "ToolCall") {
          expect(e.status).toBe("success")
          expect(e.durationMs).toBe(0)
          expect(e.sessionId).toMatch(/^thr_/)
        }
      }
    },
    { timeout: 10_000 },
  )

  it(
    "telemetry: records thread, user message, assistant message, and turn counters",
    async () => {
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: () => "done",
        }),
      )

      const snapshot = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const tel = yield* TelemetryService
          const t = yield* chat.createThread({ model: "claude-test", title: "tel" })
          yield* chat.send(t.id, "ping")
          yield* Effect.sleep("30 millis")
          return yield* tel.snapshot
        }),
        fakeLayer,
      )

      const valueFor = (
        name: string,
        tags: Readonly<Record<string, string>>,
      ): number =>
        snapshot.find((row) =>
          row.name === name &&
          JSON.stringify(row.tags) === JSON.stringify(tags),
        )?.value ?? 0

      expect(valueFor("luna.chat.threads.created", { model: "claude-test" })).toBe(1)
      expect(valueFor("luna.chat.user_messages.accepted", { attachments: "0" })).toBe(1)
      expect(valueFor("luna.chat.assistant_messages.completed", {})).toBe(1)
      expect(valueFor("luna.chat.turns.completed", { is_error: "false" })).toBe(1)
    },
    { timeout: 10_000 },
  )

  it(
    "§3.1 identity: systemPrompt containing Luna sentinel reaches SDK options",
    async () => {
      const LUNA_IDENTITY =
        "You are **Luna** — a modular, locally-hosted AI agent framework."
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })
      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          yield* chat.createThread({
            model: "claude-test",
            title: "luna-identity",
            systemPrompt: LUNA_IDENTITY,
          })
          yield* Effect.sleep("30 millis")
        }),
        fakeLayer,
      )
      expect(capturedOptions).toBeDefined()
      expect(typeof capturedOptions!["systemPrompt"]).toBe("string")
      expect(capturedOptions!["systemPrompt"] as string).toContain(
        "You are **Luna**",
      )
    },
    { timeout: 10_000 },
  )

  it(
    // Regression: session-service.fork() previously built childOpts with
    // systemPrompt at the TOP-LEVEL only, never slotting it into sdkOptions.
    // The SDKAdapter reads ONLY sessionOptions.sdkOptions so the override was
    // silently dropped before reaching Claude. Fixed in session-service.ts by
    // propagating overrides.systemPrompt into childOpts.sdkOptions.
    "fork: overrides.systemPrompt reaches SDK options (regression for dead-letter fix)",
    async () => {
      // Capture what the adapter actually sends to the SDK client.
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })

      // Drive the adapter directly with the fork()-shaped SessionOptions to
      // confirm systemPrompt now lands in sdkOptions after the fix. The fix
      // populates sdkOptions.systemPrompt in session-service.fork(), so even
      // callers who pass only top-level overrides get the correct SDK call.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* SDKAdapter
            const forkShapedOptions = {
              model: "claude-test",
              disableIdleTimeout: true,
              systemPrompt: "CHILD-IDENTITY",
              sdkOptions: { systemPrompt: "CHILD-IDENTITY" },
            }
            const replies = yield* adapter.query({
              sessionId: "thr-fork-test",
              prompt: Stream.empty as Stream.Stream<SDKUserMessage>,
              sessionOptions: forkShapedOptions as SessionOptions,
            })
            yield* Stream.runDrain(replies).pipe(Effect.catch(() => Effect.void))
          }),
        ).pipe(Effect.provide(fullLayer(fakeLayer))),
      )

      expect(capturedOptions).toBeDefined()
      expect(capturedOptions!["systemPrompt"]).toBe("CHILD-IDENTITY")
    },
    { timeout: 10_000 },
  )

  it(
    "obs: result message emits CostAccrued then SessionEnd",
    async () => {
      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: () => "done",
        }),
      )

      const obsEvents = await runScoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const evStream = yield* obs.subscribeEvents
          const fiber = yield* Effect.forkChild(
            evStream.pipe(
              Stream.filter(
                (e) => e.kind === "CostAccrued" || e.kind === "SessionEnd",
              ),
              Stream.take(2),
              Stream.runCollect,
            ),
          )

          const chat = yield* ChatService
          const t = yield* chat.createThread({ model: "claude-test", title: "cost-obs" })
          yield* Effect.sleep("5 millis")
          yield* chat.send(t.id, "ping")

          const chunk = yield* Fiber.join(fiber)
          return Array.from(chunk)
        }),
        fakeLayer,
      )

      // CostAccrued fires first, then SessionEnd.
      expect(obsEvents).toHaveLength(2)
      expect(obsEvents[0]!.kind).toBe("CostAccrued")
      expect(obsEvents[1]!.kind).toBe("SessionEnd")

      const cost = obsEvents[0]!
      const end = obsEvents[1]!
      if (cost.kind === "CostAccrued") {
        expect(cost.sessionId).toMatch(/^thr_/)
        // Fake result has no usage — fields default to 0.
        expect(cost.tokensIn).toBe(0)
        expect(cost.tokensOut).toBe(0)
      }
      if (end.kind === "SessionEnd") {
        expect(end.sessionId).toMatch(/^thr_/)
        expect(end.level).toBe("info") // is_error: false
      }
    },
    { timeout: 10_000 },
  )
})

// ── deliverResult: the chat_thread delivery sink (#124) ─────────────────────

describe("ChatService.deliverResult (#124)", () => {
  // A fake that never produces traffic on its own — deliverResult does not
  // drive the SDK, so the loop query is fine (no user turns are sent).
  const idleFake = SDKClient.fake((p) =>
    makeChatLoopQuery({
      prompt: p.prompt as AsyncIterable<SDKUserMessage>,
      sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
      responseFor: (t) => `echo:${t}`,
    }),
  )

  it(
    "posts assistant-done with the delivery marker into a LIVE thread + emits a DeliveryNotification",
    async () => {
      const { frames, notes } = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t1 = yield* chat.createThread({ model: "claude-test", title: "T1" })

          const sub = chat.subscribe(t1.id)
          // Collect: snapshot + assistant-done = 2 frames. (A delivery does NOT
          // emit turn-complete — it must not settle a concurrent live run.)
          const framesFiber = yield* Effect.forkChild(
            sub.pipe(Stream.take(2), Stream.runCollect),
          )
          // Capture the cross-thread notification stream too.
          const notesFiber = yield* Effect.forkChild(
            chat.deliveries.pipe(Stream.take(1), Stream.runCollect),
          )
          yield* Effect.sleep("30 millis")

          const posted = yield* chat.deliverResult({
            threadId: t1.id,
            text: "Found 3 flights under $400.",
            source: "suggested-action",
            label: "Research flights",
          })
          expect(Option.isSome(posted)).toBe(true)

          const framesChunk = yield* Fiber.join(framesFiber)
          const notesChunk = yield* Fiber.join(notesFiber)
          return {
            frames: Array.from(framesChunk),
            notes: Array.from(notesChunk),
          }
        }),
        idleFake,
      )

      expect(frames.map((f) => f.type)).toEqual([
        "snapshot",
        "assistant-done",
      ])
      const done = frames[1]!
      expect(done.type).toBe("assistant-done")
      if (done.type === "assistant-done") {
        expect(done.message.role).toBe("assistant")
        expect(done.message.text).toBe("Found 3 flights under $400.")
        // The persisted provenance marker rides the projected ChatMessage.
        expect(done.message.delivery).toEqual({
          source: "suggested-action",
          label: "Research flights",
        })
      }

      // The global toast notification carries thread + label + preview.
      expect(notes).toHaveLength(1)
      const n: DeliveryNotification = notes[0]!
      expect(n.source).toBe("suggested-action")
      expect(n.label).toBe("Research flights")
      expect(n.preview).toBe("Found 3 flights under $400.")
    },
    { timeout: 10_000 },
  )

  it(
    "persists the delivered message: a NEW subscriber replays it (with marker) from the snapshot",
    async () => {
      const snapshot = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t1 = yield* chat.createThread({ model: "claude-test", title: "T1" })

          yield* chat.deliverResult({
            threadId: t1.id,
            text: "Background brief ready.",
            source: "background-job",
            label: "Daily brief",
          })

          // A subscriber that attaches AFTER delivery must still see it — this
          // is the not-live / replay-on-subscribe path the issue requires.
          const sub = chat.subscribe(t1.id)
          const chunk = yield* sub.pipe(Stream.take(1), Stream.runCollect)
          return Array.from(chunk)[0]!
        }),
        idleFake,
      )

      expect(snapshot.type).toBe("snapshot")
      if (snapshot.type === "snapshot") {
        expect(snapshot.messages).toHaveLength(1)
        const msg = snapshot.messages[0]!
        expect(msg.role).toBe("assistant")
        expect(msg.text).toBe("Background brief ready.")
        expect(msg.delivery).toEqual({
          source: "background-job",
          label: "Daily brief",
        })
      }
    },
    { timeout: 10_000 },
  )

  it(
    "drops (returns none) an empty/whitespace result — no bubble, no toast",
    async () => {
      const out = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t1 = yield* chat.createThread({ model: "claude-test", title: "T1" })
          // Watch the toast stream — it must NOT fire for an empty result.
          const notesFiber = yield* Effect.forkChild(
            chat.deliveries.pipe(Stream.take(1), Stream.runCollect),
          )
          yield* Effect.sleep("20 millis")
          const posted = yield* chat.deliverResult({
            threadId: t1.id,
            text: "   \n  ",
            source: "background-job",
          })
          // Then deliver a REAL result so the take(1) fiber resolves on it
          // (proving the empty one produced no notification before it).
          yield* chat.deliverResult({
            threadId: t1.id,
            text: "real one",
            source: "background-job",
            label: "Real",
          })
          const notesChunk = yield* Fiber.join(notesFiber)
          // The new subscriber's snapshot should contain ONLY the real message.
          const snap = yield* chat
            .subscribe(t1.id)
            .pipe(Stream.take(1), Stream.runCollect)
          return {
            emptyPosted: posted,
            notes: Array.from(notesChunk),
            snapshot: Array.from(snap)[0]!,
          }
        }),
        idleFake,
      )
      expect(Option.isNone(out.emptyPosted)).toBe(true)
      // Exactly one notification — the real one (the empty one fired none).
      expect(out.notes).toHaveLength(1)
      expect(out.notes[0]!.label).toBe("Real")
      // Exactly one persisted message — the real one.
      if (out.snapshot.type === "snapshot") {
        expect(out.snapshot.messages).toHaveLength(1)
        expect(out.snapshot.messages[0]!.text).toBe("real one")
      }
    },
    { timeout: 10_000 },
  )

  it(
    "drops (returns none) when the target thread has no session row",
    async () => {
      const result = await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          return yield* chat.deliverResult({
            threadId: "thr_never_created",
            text: "nowhere to land",
            source: "background-job",
          })
        }),
        idleFake,
      )
      expect(Option.isNone(result)).toBe(true)
    },
    { timeout: 10_000 },
  )
})

// ── ThreadRegistry-backed recovery tests ─────────────────────────────────────
// These tests wire the ThreadRegistry Memory layer into ChatService and verify
// the subscribe() recovery paths that go through the registry (not the legacy
// JSON map fallback).

describe("ChatService — ThreadRegistry-backed recovery", () => {
  // Build a layer that includes ThreadRegistry.Memory so the chat-service
  // uses the registry path (not the JSON-map fallback).
  const baseLayerWithRegistry = Layer.mergeAll(
    SessionStore.Default,
    testClock,
    obsLayer,
    telemetryLayer,
    Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    ThreadRegistryService.Memory.pipe(Layer.provide(testClock)),
  )

  const fullLayerWithRegistry = (
    fakeLayer: Layer.Layer<SDKClient>,
  ) =>
    Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(
        SDKAdapter.Default,
        Layer.mergeAll(fakeLayer, baseLayerWithRegistry),
      ),
    )

  const runScopedWithRegistry = <A, E>(
    eff: Effect.Effect<
      A,
      E,
      ChatService | SessionStore | CoreClock | ObservabilityService | Scope.Scope
      | TelemetryService | ThreadRegistryService
    >,
    fakeLayer: Layer.Layer<SDKClient>,
  ) =>
    Effect.runPromise(
      Effect.scoped(eff).pipe(Effect.provide(fullLayerWithRegistry(fakeLayer))),
    )

  // #253 routing hazard: an omitted model must STAY omitted at this layer —
  // "omitted model = broker default lane". ChatService must never pre-stamp a
  // concrete model, or the SDK adapter would acquire that model's lane instead
  // of the broker's "default" lane, bypassing any configured default overflow
  // chain and breaking deployments with no Anthropic account. The Sonnet 5
  // preference lives in the adapter's default-lane resolution (see
  // adapter-sdk provider-routing.sim.test.ts), gated on Anthropic actually
  // being available.
  it(
    "createThread leaves an omitted model on the broker default lane (no pre-stamp)",
    async () => {
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })

      const { row, storedOptions } = await runScopedWithRegistry(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore
          const reg = yield* ThreadRegistryService
          const summary = yield* chat.createThread({ title: "default-model" })
          return {
            row: yield* reg.get(summary.id),
            storedOptions: yield* store.getOptions(summary.id),
          }
        }),
        fakeLayer,
      )

      // No model reaches the SDK options — the adapter resolves the default
      // lane per session build (chain > Sonnet-5-on-Anthropic > provider).
      expect(capturedOptions?.["model"]).toBeUndefined()
      expect(capturedOptions?.["effort"]).toBeUndefined()
      // Nothing persisted either: the thread keeps resolving through the
      // default lane on every recovery instead of being pinned.
      expect(row?.model ?? null).toBeNull()
      expect(row?.effort ?? null).toBeNull()
      const sdkOpts = storedOptions?.sdkOptions as Record<string, unknown> | undefined
      expect(sdkOpts?.["model"]).toBeUndefined()
      expect(sdkOpts?.["effort"]).toBeUndefined()
    },
    { timeout: 10_000 },
  )

  it(
    "createThread injects the per-model default effort for an explicit Sonnet 5",
    async () => {
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })

      const row = await runScopedWithRegistry(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const summary = yield* chat.createThread({
            model: "claude-sonnet-5",
            title: "explicit-sonnet5",
          })
          return yield* reg.get(summary.id)
        }),
        fakeLayer,
      )

      expect(capturedOptions?.["model"]).toBe("claude-sonnet-5")
      expect(capturedOptions?.["effort"]).toBe("high")
      expect(row?.model).toBe("claude-sonnet-5")
      expect(row?.effort).toBe("high")
    },
    { timeout: 10_000 },
  )

  it(
    "createThread keeps an explicit model instead of applying the chat default",
    async () => {
      let capturedOptions: Record<string, unknown> | undefined
      const fakeLayer = SDKClient.fake((p) => {
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "thr-?",
          responseFor: (t) => `echo:${t}`,
        })
      })

      const row = await runScopedWithRegistry(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const summary = yield* chat.createThread({
            model: "claude-haiku-4-5",
            title: "explicit-model",
          })
          return yield* reg.get(summary.id)
        }),
        fakeLayer,
      )

      expect(capturedOptions?.["model"]).toBe("claude-haiku-4-5")
      expect(capturedOptions?.["effort"]).toBeUndefined()
      expect(row?.model).toBe("claude-haiku-4-5")
      expect(row?.effort).toBeNull()
    },
    { timeout: 10_000 },
  )

  // #253 invariant, recovery side: a legacy thread persisted WITHOUT a model
  // (created before model persistence, or on the default lane) must recover
  // through the broker default lane — recovery must not hard-stamp today's
  // preferred default onto a conversation whose lane the operator may have
  // rerouted (overflow chain / non-Anthropic deployment).
  it(
    "recovery of a legacy thread with no persisted model stays on the default lane",
    async () => {
      const THREAD_ID = "thr_test_legacy_nomodel"
      let capturedOptions: Record<string, unknown> | undefined
      let queryCallCount = 0

      const fakeLayer = SDKClient.fake((p) => {
        queryCallCount++
        capturedOptions = (p.options ?? {}) as Record<string, unknown>
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: `sdk-legacy-${queryCallCount}`,
          responseFor: (t) => `echo:${t}`,
        })
      })

      const rowAfter = await runScopedWithRegistry(
        Effect.gen(function* () {
          const reg = yield* ThreadRegistryService
          // A pre-#253 row: known thread, no sid (Case B re-create), and — the
          // point of this test — no persisted model.
          // sdkSessionId omitted → inserts with the column NULL (Case B).
          yield* reg.upsert({
            id: THREAD_ID,
            cwd: "/test/cwd",
            model: null,
          })

          const chat = yield* ChatService
          const fiber = yield* Effect.forkChild(
            chat.subscribe(THREAD_ID).pipe(Stream.take(1), Stream.runCollect),
          )
          yield* Effect.sleep("100 millis")
          yield* Fiber.join(fiber)
          return yield* reg.get(THREAD_ID)
        }),
        fakeLayer,
      )

      // Recovery re-created the thread live…
      expect(queryCallCount).toBeGreaterThan(0)
      // …without stamping a model: the SDK options carry none, so the adapter
      // acquires the broker's "default" lane (which prefers Sonnet 5 only when
      // Anthropic is actually available), and the row stays model-less.
      expect(capturedOptions?.["model"]).toBeUndefined()
      expect(rowAfter?.model ?? null).toBeNull()
    },
    { timeout: 15_000 },
  )

  // PING (fix #3): subscribe() on a sid-less KNOWN thread must take the Case-B
  // (re-create live) path when ThreadRegistry is wired — NOT fall through to the
  // empty/unknown stream. Verifies chat-service.ts:1789-1804 is exercised.
  it(
    "subscribe() on a sid-less known thread (Case B) re-creates live and yields a non-empty stream with a warning",
    async () => {
      const THREAD_ID = "thr_test_sidless01"
      const SAVED_MODEL = "claude-test"

      let capturedWarning = false
      let queryCallCount = 0

      const fakeLayer = SDKClient.fake((p) => {
        queryCallCount++
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: `sdk-new-${queryCallCount}`,
          responseFor: (t) => `echo:${t}`,
        })
      })

      await runScopedWithRegistry(
        Effect.gen(function* () {
          const reg = yield* ThreadRegistryService
          // Pre-populate registry with a sid-less entry — simulates a thread
          // that was created but onSdkSessionId never fired (e.g., the server
          // restarted before the first turn completed).
          yield* reg.upsert({
            id: THREAD_ID,
            // sdkSessionId omitted → no sid, Case B
            cwd: "/test/cwd",
            model: SAVED_MODEL,
          })

          const chat = yield* ChatService

          // Capture Effect.logWarning output by subscribing to obs events.
          const obs = yield* ObservabilityService
          const evStream = yield* obs.subscribeEvents
          const warnFiber = yield* Effect.forkChild(
            evStream.pipe(
              Stream.filter((e) =>
                e.kind === "ToolCall" ||
                // Warning events come through as Log kind or similar
                (typeof (e as Record<string, unknown>)["message"] === "string" &&
                  ((e as Record<string, unknown>)["message"] as string).includes("no sdk_session_id")),
              ),
              Stream.take(1),
              Stream.runCollect,
            ),
          )

          // subscribe() on the sid-less known thread — should NOT return empty stream
          const sub = chat.subscribe(THREAD_ID)
          const fiber = yield* Effect.forkChild(
            sub.pipe(
              // Take the snapshot frame — Case B re-creates live so the stream
              // is non-empty (snapshot arrives immediately).
              Stream.take(1),
              Stream.runCollect,
            ),
          )

          yield* Effect.sleep("100 millis")

          // Send a message to trigger a turn and confirm the thread is live.
          yield* chat.send(THREAD_ID, "hello from recovery")
          yield* Effect.sleep("80 millis")

          const frames = yield* Fiber.join(fiber)
          yield* Fiber.interrupt(warnFiber)

          // The subscribe must have yielded at least a snapshot frame (not empty).
          expect((frames).length).toBeGreaterThan(0)
          const first = (frames)[0]!
          expect(first.type).toBe("snapshot")

          // The re-creation path must have called the SDK (queryCallCount > 0).
          expect(queryCallCount).toBeGreaterThan(0)
        }),
        fakeLayer,
      )
    },
    { timeout: 15_000 },
  )

  // PING (fix #4 + cwd pass-through): Case A (sid present) must pass the
  // persisted cwd through to createThread so the SDK resume uses the right
  // encoded project dir.
  it(
    "subscribe() Case A (known + sid) passes persisted cwd to createThread",
    async () => {
      const THREAD_ID = "thr_test_cwdresume01"
      const PERSISTED_SID = "sdk-prior-session-abc123"
      const PERSISTED_CWD = "/home/user/my-project"
      let capturedCwd: string | undefined

      const fakeLayer = SDKClient.fake((p) => {
        const opts = (p.options ?? {}) as Record<string, unknown>
        capturedCwd = opts["cwd"] as string | undefined
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: PERSISTED_SID,
          responseFor: (t) => `echo:${t}`,
        })
      })

      await runScopedWithRegistry(
        Effect.gen(function* () {
          const reg = yield* ThreadRegistryService
          // Simulate a thread with persisted sid + cwd (post-first-turn state).
          yield* reg.upsert({
            id: THREAD_ID,
            sdkSessionId: PERSISTED_SID,
            cwd: PERSISTED_CWD,
            model: "claude-test",
          })

          const chat = yield* ChatService
          const sub = chat.subscribe(THREAD_ID)
          const fiber = yield* Effect.forkChild(
            sub.pipe(Stream.take(1), Stream.runCollect),
          )
          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(fiber)
        }),
        fakeLayer,
      )

      // The createThread call inside subscribe's Case A must have forwarded the
      // persisted cwd so the SDK receives it.
      expect(capturedCwd).toBe(PERSISTED_CWD)
    },
    { timeout: 15_000 },
  )

  // REGRESSION (silent context loss): Case A resume routes through
  // createThread(), which used to pass `sdkSessionId: null` into reg.upsert().
  // Since `null !== undefined`, the registry cleared the column — so the act of
  // RESUMING a healthy thread destroyed the pointer it had just resumed from.
  // The next open then fell through to Case B and re-created the thread with
  // EMPTY history, leaving the user with a full on-screen transcript in front
  // of an amnesiac model. 45 of 94 real threads on the live server were
  // damaged this way before the fix.
  it(
    "subscribe() Case A resume must NOT clear the persisted sdk session id",
    async () => {
      const THREAD_ID = "thr_test_sidkeep01"
      const PERSISTED_SID = "sdk-must-survive-resume"
      let sidAfterResume: string | null | undefined

      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: PERSISTED_SID,
          responseFor: (t) => `echo:${t}`,
        }),
      )

      await runScopedWithRegistry(
        Effect.gen(function* () {
          const reg = yield* ThreadRegistryService
          yield* reg.upsert({
            id: THREAD_ID,
            sdkSessionId: PERSISTED_SID,
            cwd: "/test/cwd",
            model: "claude-test",
          })

          const chat = yield* ChatService
          const fiber = yield* Effect.forkChild(
            chat.subscribe(THREAD_ID).pipe(Stream.take(1), Stream.runCollect),
          )
          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(fiber)

          const row = yield* reg.get(THREAD_ID)
          sidAfterResume = row?.sdkSessionId
        }),
        fakeLayer,
      )

      expect(sidAfterResume).toBe(PERSISTED_SID)
    },
    { timeout: 15_000 },
  )

  // PING (fix #4 — degradation): when cwd is NULL in the registry, subscribe()
  // must still re-create the thread live (not 404) using a fallback cwd.
  it(
    "subscribe() Case A with NULL cwd degrades to live re-creation with fallback cwd (no error)",
    async () => {
      const THREAD_ID = "thr_test_nullcwd01"
      const PERSISTED_SID = "sdk-null-cwd-session"
      let capturedCwd: string | undefined
      let queryCallCount = 0

      const fakeLayer = SDKClient.fake((p) => {
        queryCallCount++
        const opts = (p.options ?? {}) as Record<string, unknown>
        capturedCwd = opts["cwd"] as string | undefined
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: PERSISTED_SID,
          responseFor: (t) => `echo:${t}`,
        })
      })

      await runScopedWithRegistry(
        Effect.gen(function* () {
          const reg = yield* ThreadRegistryService
          // Store a row with NULL cwd — the degradation case.
          yield* reg.upsert({
            id: THREAD_ID,
            sdkSessionId: PERSISTED_SID,
            cwd: null, // degradation trigger
            model: "claude-test",
          })

          const chat = yield* ChatService
          const sub = chat.subscribe(THREAD_ID)
          // Collect exactly one frame; the stream completes on its own after
          // take(1) so we join directly. No interrupt needed — take(1) is
          // self-terminating. This avoids the race where interrupt fires before
          // the first frame arrives and Fiber.join then throws.
          const frames = yield* sub.pipe(Stream.take(1), Stream.runCollect)
          // Must still produce a snapshot (not empty/error).
          expect((frames).length).toBeGreaterThan(0)
          expect((frames)[0]!.type).toBe("snapshot")
        }),
        fakeLayer,
      )

      // SDK was called (thread was re-created, not errored).
      expect(queryCallCount).toBeGreaterThan(0)
      // cwd fell back to a non-null value (LUNA_REPO_ROOT or process.cwd()).
      expect(capturedCwd).toBeDefined()
    },
    { timeout: 15_000 },
  )

  // REGRESSION: subscribe() Case B — thread in registry with sdkSessionId=null
  // BUT session-store ALREADY has a row for the id (inconsistent state that
  // occurs when the server restarts mid-first-turn before onSdkSessionId fires).
  //
  // Without the fix, createThread() calls store.create() which returns an
  // IntegrityError; Effect.orDie kills the fiber; no snapshot is emitted;
  // the client's watchdog times out with "Reattach stalled" forever.
  //
  // With the fix, createThread() detects the existing row via store.get() and
  // reuses it — the subscribe() path emits a thread-snapshot and does NOT throw.
  it(
    "subscribe_resumes_thread_with_existing_session_row_no_sid: Case B with pre-existing store row emits snapshot, no IntegrityError",
    async () => {
      const THREAD_ID = "thr_test_caseb_collision01"
      const SAVED_MODEL = "claude-test"
      let queryCallCount = 0
      let threwError = false

      const fakeLayer = SDKClient.fake((p) => {
        queryCallCount++
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: `sdk-new-caseb-${queryCallCount}`,
          responseFor: (t) => `echo:${t}`,
        })
      })

      let frames: ReadonlyArray<import("../src/types.js").ChatFrame> | undefined

      try {
        await runScopedWithRegistry(
          Effect.gen(function* () {
            const reg = yield* ThreadRegistryService
            const store = yield* SessionStore

            // Step 1: seed ThreadRegistry with sdkSessionId=null (Case B).
            yield* reg.upsert({
              id: THREAD_ID,
              // sdkSessionId omitted → seeds Case B (no sid).
              cwd: "/test/cwd",
              model: SAVED_MODEL,
            })

            // Step 2: seed SessionStore with a row for the SAME id — this is
            // the inconsistent state that causes the collision. The row would
            // have been created by the original createThread() call before the
            // server restarted, but onSdkSessionId never captured the sid.
            yield* store.create({
              id: THREAD_ID,
              options: {
                model: SAVED_MODEL,
                disableIdleTimeout: true,
                sdkOptions: { model: SAVED_MODEL },
              },
              createdAt: Date.now(),
            }).pipe(Effect.orDie)

            const chat = yield* ChatService

            // Step 3: subscribe() — without the fix this dies on IntegrityError;
            // with the fix it should yield a snapshot immediately.
            const sub = chat.subscribe(THREAD_ID)
            frames = yield* sub.pipe(Stream.take(1), Stream.runCollect)
          }),
          fakeLayer,
        )
      } catch (e) {
        threwError = true
        console.error("subscribe_resumes_thread_with_existing_session_row_no_sid threw:", e)
      }

      // Must NOT have thrown — the IntegrityError must be swallowed by reuse.
      expect(threwError).toBe(false)
      // Must have emitted at least one frame (the snapshot).
      expect(frames).toBeDefined()
      expect((frames!).length).toBeGreaterThan(0)
      const first = (frames!)[0]!
      expect(first.type).toBe("snapshot")
      // SDK must have been called — the thread was re-created live.
      expect(queryCallCount).toBeGreaterThan(0)
    },
    { timeout: 15_000 },
  )
})

// ── listThreads archival-filter tests ─────────────────────────────────────────
// Copilot comment #2: the default (active) listThreads path MUST exclude threads
// that are archived in ThreadRegistry. These tests confirm:
//   a) an archived thread does NOT appear in the default listThreads result.
//   b) a non-archived thread DOES appear.
//   c) the archived thread still appears when status='archived' is passed.
describe("ChatService — listThreads excludes archived threads", () => {
  // Minimal fake SDK that immediately provides a snapshot (createThread succeeds).
  const noopFakeLayer = SDKClient.fake((p) => {
    let done = false
    return {
      [Symbol.asyncIterator]: async function* () {
        if (!done) {
          done = true
          yield {
            type: "result",
            session_id: `sdk-list-test-${Math.random().toString(36).slice(2)}`,
            content: [],
            stop_reason: "end_turn",
          }
        }
      },
    } as unknown as import("@anthropic-ai/claude-agent-sdk").Query
  })

  const baseLayerWithRegistry = Layer.mergeAll(
    SessionStore.Default,
    testClock,
    obsLayer,
    telemetryLayer,
    Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    ThreadRegistryService.Memory.pipe(Layer.provide(testClock)),
  )

  const fullLayerWithRegistry = () =>
    Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(
        SDKAdapter.Default,
        Layer.mergeAll(noopFakeLayer, baseLayerWithRegistry),
      ),
    )

  const run = <A, E>(
    eff: Effect.Effect<
      A,
      E,
      | ChatService
      | SessionStore
      | CoreClock
      | ObservabilityService
      | Scope.Scope
      | TelemetryService
      | ThreadRegistryService
    >,
  ) =>
    Effect.runPromise(
      Effect.scoped(eff).pipe(Effect.provide(fullLayerWithRegistry())),
    )

  it(
    "archived thread does NOT appear in default listThreads; non-archived thread DOES",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const store = yield* SessionStore

          // Create two threads. createThread upserts both into ThreadRegistry.
          const t1 = yield* chat.createThread({ model: "claude-test", title: "active-thread" })
          const t2 = yield* chat.createThread({ model: "claude-test", title: "archived-thread" })
          // t1 must be a real conversation to survive the active-list filter
          // (titled-but-empty threads are hidden); give it a first user message.
          yield* store.appendMessage({
            sessionId: t1.id,
            messageId: "m-active-1",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: { message: { content: "keep me active" } },
          })

          // Archive t2 in the registry.
          const archiveOk = yield* reg.archive(t2.id)
          expect(archiveOk).toBe(true)

          // Default (active) list must include t1 but NOT t2.
          const activeList = yield* chat.listThreads(50)
          const activeIds = activeList.map((s) => s.id)
          expect(activeIds).toContain(t1.id)
          expect(activeIds).not.toContain(t2.id)
        }),
      )
    },
    { timeout: 15_000 },
  )

  it(
    "archived thread appears in listThreads(status='archived') but not in default list",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService

          const t1 = yield* chat.createThread({ model: "claude-test", title: "stay-active" })
          const t2 = yield* chat.createThread({ model: "claude-test", title: "to-archive" })

          yield* reg.archive(t2.id)

          // Active list: only t1.
          const activeList = yield* chat.listThreads(50)
          expect(activeList.map((s) => s.id)).not.toContain(t2.id)

          // Archived list: only t2 (via ThreadRegistry).
          const archivedList = yield* chat.listThreads(50, "archived")
          const archivedIds = archivedList.map((s) => s.id)
          expect(archivedIds).toContain(t2.id)
          expect(archivedIds).not.toContain(t1.id)
        }),
      )
    },
    { timeout: 15_000 },
  )

  // ── Agent sidebar S2: filing at creation, projection on both branches ──────
  it(
    "createThread(agentName) files the thread: thread-created summary + active list + archived list all carry it",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const store = yield* SessionStore

          const filed = yield* chat.createThread({
            model: "claude-test",
            title: "advisor-thread",
            agentName: "advisor",
          })
          // The creating client files the row from the returned summary
          // (no list-threads round-trip).
          expect(filed.agentName).toBe("advisor")

          const general = yield* chat.createThread({
            model: "claude-test",
            title: "general-thread",
          })
          expect(general.agentName).toBeUndefined()

          // Both need a first user message to survive the active filter.
          for (const [t, msg] of [
            [filed, "m-ag-1"],
            [general, "m-ag-2"],
          ] as const) {
            yield* store.appendMessage({
              sessionId: t.id,
              messageId: msg,
              ts: 1,
              parentId: null,
              kind: "user",
              payload: { message: { content: "hello" } },
            })
          }

          // Active projection: agentName layered from the registry.
          const active = yield* chat.listThreads(50)
          expect(active.find((s) => s.id === filed.id)?.agentName).toBe("advisor")
          expect(active.find((s) => s.id === general.id)?.agentName).toBeUndefined()

          // Archived projection (registry-only branch) keeps the section.
          yield* reg.archive(filed.id)
          const archived = yield* chat.listThreads(50, "archived")
          expect(archived.find((s) => s.id === filed.id)?.agentName).toBe("advisor")
        }),
      )
    },
    { timeout: 15_000 },
  )

  // ── Agent participation (PR2): recording from the SDK consumer ─────────────
  // Codex review finding 1: recording must live in the path that runs for
  // every turn REGARDLESS of connected clients. This drives a real turn
  // through ChatService with a fake SDK whose assistant message spawns
  // subagents, with NO subscriber attached — and the involvement must land.
  it(
    "a NAMED Agent spawn in a turn records involvement with no client subscribed; untyped spawns never do",
    async () => {
      const makeSpawningAssistant = (sessionId: string): SDKMessage =>
        ({
          type: "assistant",
          session_id: sessionId,
          uuid: "turn-spawn",
          parent_tool_use_id: null,
          message: {
            id: "turn-spawn",
            role: "assistant",
            model: "claude-test",
            content: [
              { type: "tool_use", id: "sp1", name: "Agent", input: { subagent_type: "advisor", prompt: "review" } },
              // Untyped general-purpose spawn — a tree node, NOT a lookup target.
              { type: "tool_use", id: "sp2", name: "Task", input: { description: "generic" } },
              // Non-spawn tool — never involvement.
              { type: "tool_use", id: "sp3", name: "Bash", input: { command: "ls" } },
              { type: "text", text: "delegated" },
            ],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }) as unknown as SDKMessage

      const fakeLayer = SDKClient.fake((p) => {
        const sessionId = (p as { sessionId?: string }).sessionId ?? "thr-?"
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const _u of p.prompt as AsyncIterable<SDKUserMessage>) {
            yield makeSpawningAssistant(sessionId)
            yield makeResultMessage(sessionId, "result-spawn")
          }
        }
        const it = gen()
        return Object.assign(it, {
          interrupt: async () => {},
          setPermissionMode: async () => {},
          setModel: async () => {},
          applyFlagSettings: async () => {},
          setMaxThinkingTokens: async () => {},
          supplyToolPermissionResponse: async () => {},
          mcpServerStatus: async () => ({}),
        } as Partial<Query>) as Query
      })

      const spawningLayer = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.Default,
          Layer.mergeAll(fakeLayer, baseLayerWithRegistry),
        ),
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const reg = yield* ThreadRegistryService
            const t = yield* chat.createThread({ model: "claude-test", title: "spawner" })
            yield* Effect.sleep("5 millis")
            // send() with NO subscribe — the exact case the bridge-based
            // recorder lost.
            yield* chat.send(t.id, "delegate please")
            yield* Effect.sleep("50 millis")
            const rows = yield* reg.listInvolvement()
            const mine = rows.filter((r) => r.threadId === t.id)
            expect(mine.map((r) => r.agentName)).toEqual(["advisor"])
            // Scoped read matches too; an unrelated id scopes to empty.
            expect(yield* reg.listInvolvement([t.id])).toHaveLength(1)
            expect(yield* reg.listInvolvement(["thr_nope"])).toHaveLength(0)
          }),
        ).pipe(Effect.provide(spawningLayer)),
      )
    },
    { timeout: 15_000 },
  )

  // ── Agent participation (PR2): involvement projection ──────────────────────
  it(
    "involvement reaches listThreads: created-under records it, delegations add to it, archived branch carries it",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const store = yield* SessionStore

          // Created under advisor → involvement recorded at create.
          const filed = yield* chat.createThread({
            model: "claude-test",
            title: "advisor-born",
            agentName: "advisor",
          })
          // A later delegation observed in the same thread (what the
          // subagent-tree bridge's onDelegation tap records).
          yield* reg.recordInvolvement(filed.id, "auditor")

          yield* store.appendMessage({
            sessionId: filed.id,
            messageId: "m-inv-1",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: { message: { content: "hello" } },
          })

          const active = yield* chat.listThreads(50)
          const row = active.find((s) => s.id === filed.id)
          expect(row?.involvedAgents).toEqual(
            expect.arrayContaining(["advisor", "auditor"]),
          )

          // Archived branch (registry-only) keeps the lookup working.
          yield* reg.archive(filed.id)
          const archived = yield* chat.listThreads(50, "archived")
          expect(
            archived.find((s) => s.id === filed.id)?.involvedAgents,
          ).toEqual(expect.arrayContaining(["advisor", "auditor"]))
        }),
      )
    },
    { timeout: 15_000 },
  )

  it(
    "an explicit creation title is seeded into the registry so the archived list shows it",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const store = yield* SessionStore

          const t = yield* chat.createThread({ model: "claude-test", title: "Incident review" })
          // A first user message that would derive a DIFFERENT title if it won.
          yield* store.appendMessage({
            sessionId: t.id,
            messageId: "m-arch-1",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: { message: { content: "Summarize the logs" } },
          })
          yield* reg.archive(t.id)

          // Archived list is registry-only — it must show the explicit title,
          // not the derived "Summarize the logs".
          const archived = yield* chat.listThreads(50, "archived")
          expect(archived.find((s) => s.id === t.id)?.title).toBe("Incident review")
        }),
      )
    },
    { timeout: 15_000 },
  )

  it(
    "archived (user-messaged) threads do NOT consume limit slots and evict active ones",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const store = yield* SessionStore

          // Give every thread a first user message so `hasUserMessage` keeps
          // it — the ONLY reason a real thread should drop out here is the
          // archived filter, which must run BEFORE the limit.
          const seedUser = (id: string, ts: number) =>
            store.appendMessage({
              sessionId: id,
              messageId: `m-${id}`,
              ts,
              parentId: null,
              kind: "user",
              payload: { message: { content: `msg ${id}` } },
            })

          // Archived threads first so they sort NEWEST (highest lastMessageAt)
          // and would occupy the top `limit` slots if filtered after the limit.
          const archivedThreads = []
          for (let i = 0; i < 3; i++) {
            const th = yield* chat.createThread({ model: "claude-test", title: `arch-${i}` })
            yield* seedUser(th.id, 100 + i)
            yield* reg.archive(th.id)
            archivedThreads.push(th)
          }
          // Two real active threads created after, still real conversations.
          const a1 = yield* chat.createThread({ model: "claude-test", title: "active-1" })
          yield* seedUser(a1.id, 200)
          const a2 = yield* chat.createThread({ model: "claude-test", title: "active-2" })
          yield* seedUser(a2.id, 201)

          // limit=2: if archived threads consumed slots BEFORE being filtered,
          // the page would under-fill and drop a1/a2. Both must survive.
          const list = yield* chat.listThreads(2)
          const ids = list.map((s) => s.id)
          expect(ids).toContain(a1.id)
          expect(ids).toContain(a2.id)
          for (const th of archivedThreads) expect(ids).not.toContain(th.id)
        }),
      )
    },
    { timeout: 15_000 },
  )
})

// ── listThreads auto-title tests ──────────────────────────────────────────────
// The SessionStore `title` column is write-once at INSERT and Moon never sends
// one, while the first-turn heuristic writes derived titles to ThreadRegistry.
// listThreads must overlay those (and derive-on-read for threads predating the
// heuristic) or every sidebar row renders "untitled".
describe("ChatService — listThreads auto-titles untitled threads", () => {
  const noopFakeLayer = SDKClient.fake((p) => {
    let done = false
    return {
      [Symbol.asyncIterator]: async function* () {
        if (!done) {
          done = true
          yield {
            type: "result",
            session_id: `sdk-title-test-${Math.random().toString(36).slice(2)}`,
            content: [],
            stop_reason: "end_turn",
          }
        }
      },
    } as unknown as import("@anthropic-ai/claude-agent-sdk").Query
  })

  const baseLayerWithRegistry = Layer.mergeAll(
    SessionStore.Default,
    testClock,
    obsLayer,
    telemetryLayer,
    Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    ThreadRegistryService.Memory.pipe(Layer.provide(testClock)),
  )

  const fullLayerWithRegistry = () =>
    Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(
        SDKAdapter.Default,
        Layer.mergeAll(noopFakeLayer, baseLayerWithRegistry),
      ),
    )

  const run = <A, E>(
    eff: Effect.Effect<
      A,
      E,
      | ChatService
      | SessionStore
      | CoreClock
      | ObservabilityService
      | Scope.Scope
      | TelemetryService
      | ThreadRegistryService
    >,
  ) =>
    Effect.runPromise(
      Effect.scoped(eff).pipe(Effect.provide(fullLayerWithRegistry())),
    )

  it(
    "a ThreadRegistry title (first-turn heuristic) surfaces on an untitled session row",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const store = yield* SessionStore

          const t = yield* chat.createThread({ model: "claude-test" }) // no title
          // In production the first-turn heuristic writes the registry title
          // from the user's first message, so a real thread always has one.
          // Seed a first user message whose derived title DIFFERS from the
          // registry title to prove the registry title wins over derive-on-read.
          yield* store.appendMessage({
            sessionId: t.id,
            messageId: "m-reg-1",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: { message: { content: "raw first message text" } },
          })
          yield* reg.upsert({ id: t.id, title: "Deploy plan for the router" })

          const list = yield* chat.listThreads(50)
          const row = list.find((s) => s.id === t.id)
          expect(row?.title).toBe("Deploy plan for the router")
        }),
      )
    },
    { timeout: 15_000 },
  )

  it(
    "an untitled thread derives its title from the first user message and persists it to the registry",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const store = yield* SessionStore

          // A legacy thread predating the first-turn heuristic: session and
          // registry rows exist, neither has a title. Seed the registry row at
          // an OLD timestamp (the test clock is frozen at 1_700_000_000_000)
          // so any last_active_at bump by the persist would be detectable.
          const legacyId = "thr_legacy_title"
          const legacyTs = 1_600_000_000_000
          yield* store.create({
            id: legacyId,
            options: { model: "claude-test" }, // no title anywhere
            createdAt: legacyTs,
          })
          yield* reg.upsert({ id: legacyId, nowMs: legacyTs })
          yield* store.appendMessage({
            sessionId: legacyId,
            messageId: "m-title-1",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: { message: { content: "Fix the Ollama boot probe\nand more detail" } },
          })

          const list = yield* chat.listThreads(50)
          const row = list.find((s) => s.id === legacyId)
          // First line of the first user message, per deriveTitleFromMessage.
          expect(row?.title).toBe("Fix the Ollama boot probe")

          // Derivation is one-shot: the title is persisted to the registry.
          const regRow = yield* reg.get(legacyId)
          expect(regRow?.title).toBe("Fix the Ollama boot probe")
          // The persist is clock-neutral: listing the sidebar is a read and
          // must not reset the 14-day auto-archive idle clock.
          expect(regRow?.lastActiveAt).toBe(legacyTs)
        }),
      )
    },
    { timeout: 15_000 },
  )

  it(
    "derive-on-read strips the client-identity marker: the title comes from the user's first line, never the marker",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const store = yield* SessionStore

          // A marker-era legacy thread: the stored payload is what send()
          // persisted — applyClientMarker(text, client) — so its first line
          // is the '[client: ...]' hint, not the user's message.
          const markerId = "thr_marker_title"
          yield* store.create({
            id: markerId,
            options: { model: "claude-test" }, // no title anywhere
            createdAt: 1,
          })
          yield* reg.upsert({ id: markerId, nowMs: 1 })
          const storedText = applyClientMarker(
            "Tune the retry backoff\nsecond line detail",
            { name: "luna-moon", version: "0.0.55", platform: "darwin" },
          )
          yield* store.appendMessage({
            sessionId: markerId,
            messageId: "m-title-marker",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: { message: { content: storedText } },
          })

          const list = yield* chat.listThreads(50)
          const row = list.find((s) => s.id === markerId)
          expect(row?.title).toBe("Tune the retry backoff")

          // The persisted one-shot title must also be the user's line — a
          // wrong persist here would freeze the marker as the title forever.
          const regRow = yield* reg.get(markerId)
          expect(regRow?.title).toBe("Tune the retry backoff")
        }),
      )
    },
    { timeout: 15_000 },
  )

  it(
    "an explicit creation title is never overridden by registry or derivation",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const reg = yield* ThreadRegistryService
          const store = yield* SessionStore

          const t = yield* chat.createThread({ model: "claude-test", title: "Explicit title" })
          yield* reg.upsert({ id: t.id, title: "registry noise" })
          yield* store.appendMessage({
            sessionId: t.id,
            messageId: "m-title-2",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: { message: { content: "derived noise" } },
          })

          const list = yield* chat.listThreads(50)
          const row = list.find((s) => s.id === t.id)
          expect(row?.title).toBe("Explicit title")
        }),
      )
    },
    { timeout: 15_000 },
  )

  it(
    "an empty thread (no title, no user message) is hidden from the sidebar list",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore
          // Empty probe thread: created, never used.
          const empty = yield* chat.createThread({ model: "claude-test" })
          // Real thread: has a first user message.
          const real = yield* chat.createThread({ model: "claude-test" })
          yield* store.appendMessage({
            sessionId: real.id,
            messageId: "m-real-1",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: { message: { content: "Ship the release" } },
          })

          const list = yield* chat.listThreads(50)
          const ids = list.map((s) => s.id)
          expect(ids).not.toContain(empty.id) // empty probe hidden
          expect(ids).toContain(real.id)
          expect(list.find((s) => s.id === real.id)?.title).toBe("Ship the release")
        }),
      )
    },
    { timeout: 15_000 },
  )

  it(
    "an explicitly-titled thread with no user message is hidden from the sidebar list",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          // Titled at creation but never typed in - not a conversation yet.
          const t = yield* chat.createThread({ model: "claude-test", title: "Named but empty" })
          const list = yield* chat.listThreads(50)
          expect(list.map((s) => s.id)).not.toContain(t.id)
        }),
      )
    },
    { timeout: 15_000 },
  )

  it(
    "empty threads never evict a real thread past the limit",
    async () => {
      await run(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore
          // A real thread created FIRST (oldest createdAt).
          const real = yield* chat.createThread({ model: "claude-test" })
          yield* store.appendMessage({
            sessionId: real.id,
            messageId: "m-real-limit",
            ts: 1,
            parentId: null,
            kind: "user",
            payload: { message: { content: "The one real conversation" } },
          })
          // Many empty probe threads created AFTER - they sort by createdAt and
          // would crowd the top of an unfiltered page.
          for (let i = 0; i < 10; i++) {
            yield* chat.createThread({ model: "claude-test" })
          }
          // Small limit: if empties counted toward the limit, `real` would be
          // sliced off the page. It must still be returned.
          const list = yield* chat.listThreads(3)
          const ids = list.map((s) => s.id)
          expect(ids).toContain(real.id)
          // Every empty probe was filtered out, so only the real thread remains.
          expect(ids).toEqual([real.id])
        }),
      )
    },
    { timeout: 15_000 },
  )
})

// ── send-after-reap recovery tests ───────────────────────────────────────────
// These tests exercise ensureThreadLive via send(), wired through ThreadRegistry.
// They drive reapIdleThreadsOnce() manually to control when the eviction fires.
// LUNA_CHAT_THREAD_IDLE_MS=1 makes threads reapable after 1ms so we don't need
// to advance the clock (the test clock is fixed; we use real elapsed time).

describe("ChatService — send() resumes evicted threads (ensureThreadLive)", () => {
  // Use a 1ms idle threshold so any real elapsed time qualifies for reaping.
  // The real (wall-clock) Clock is used so that elapsed time > 1ms is guaranteed.
  const reapClock = CoreClock.Default

  const baseLayerWithRegistry = Layer.mergeAll(
    SessionStore.Default,
    reapClock,
    obsLayer,
    telemetryLayer,
    Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    ThreadRegistryService.Memory.pipe(Layer.provide(testClock)),
  )

  const fullLayerWithRegistry = (fakeLayer: Layer.Layer<SDKClient>) =>
    Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(
        SDKAdapter.Default,
        Layer.mergeAll(fakeLayer, baseLayerWithRegistry),
      ),
    )

  const runScopedReg = <A, E>(
    eff: Effect.Effect<
      A, E,
      ChatService | SessionStore | CoreClock | ObservabilityService | Scope.Scope
      | TelemetryService | ThreadRegistryService
    >,
    fakeLayer: Layer.Layer<SDKClient>,
  ) =>
    Effect.runPromise(
      Effect.scoped(eff).pipe(Effect.provide(fullLayerWithRegistry(fakeLayer))),
    )

  // Helper: advance real time enough that any thread's lastActivity is stale
  // relative to LUNA_CHAT_THREAD_IDLE_MS=1.
  const waitForIdleEligibility = () => Effect.sleep("5 millis")

  it(
    "send-after-reap Case A: resumes with resumeFromSessionId after idle reap evicts the thread",
    async () => {
      const SDK_SID = "sdk-case-a-resume-sid"
      let createCallCount = 0
      let capturedResume: string | undefined
      const prevIdleMs = process.env["LUNA_CHAT_THREAD_IDLE_MS"]
      process.env["LUNA_CHAT_THREAD_IDLE_MS"] = "1"

      const fakeLayer = SDKClient.fake((p) => {
        createCallCount++
        const opts = (p.options ?? {}) as Record<string, unknown>
        if (opts["resume"] !== undefined) capturedResume = opts["resume"] as string
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: SDK_SID,
          responseFor: (t) => `echo:${t}`,
        })
      })

      try {
        const result = await runScopedReg(
          Effect.gen(function* () {
            const chat = yield* ChatService

            // 1. Create thread normally.
            const t = yield* chat.createThread({ model: "claude-test", title: "reap-case-a" })

            // 2. Seed ThreadRegistry with the persisted sdk session id (simulates
            //    onSdkSessionId having fired in the real path).
            const reg = yield* ThreadRegistryService
            yield* reg.upsert({ id: t.id, sdkSessionId: SDK_SID, cwd: "/test", model: "claude-test" })

            // 3. Wait for thread to be idle-eligible (idleReapMs=1ms), then reap.
            yield* waitForIdleEligibility()
            yield* chat.reapIdleThreadsOnce()
            // After reap the in-memory entry is gone but registry still has it.

            // 4. send() must recover via ensureThreadLive → Case A (has sid).
            const sendResult = yield* chat.send(t.id, "hello after reap")

            // 5. Read persisted messages to confirm message was stored.
            const store = yield* SessionStore
            const msgs = yield* store.readMessages(t.id).pipe(
              Stream.runCollect,
              Effect.map((c) => Array.from(c)),
            )

            return { sendResult, msgs, createCallCount, capturedResume }
          }),
          fakeLayer,
        )

        expect(Option.isSome(result.sendResult)).toBe(true)
        // message was persisted
        expect(result.msgs.some((m) => m.kind === "user")).toBe(true)
        // createThread was called TWICE: once for initial create, once for resume
        expect(result.createCallCount).toBeGreaterThanOrEqual(2)
        // The resume call used the persisted SDK session id
        expect(result.capturedResume).toBe(SDK_SID)
      } finally {
        if (prevIdleMs === undefined) delete process.env["LUNA_CHAT_THREAD_IDLE_MS"]
        else process.env["LUNA_CHAT_THREAD_IDLE_MS"] = prevIdleMs
      }
    },
    { timeout: 15_000 },
  )

  it(
    "send-after-reap Case B: resumes with empty history when no sdk_session_id is stored",
    async () => {
      let createCallCount = 0
      let capturedResume: string | undefined
      // Track ChatUnknownThread events
      const unknownThreadEvents: string[] = []
      const prevIdleMs = process.env["LUNA_CHAT_THREAD_IDLE_MS"]
      process.env["LUNA_CHAT_THREAD_IDLE_MS"] = "1"

      const fakeLayer = SDKClient.fake((p) => {
        createCallCount++
        const opts = (p.options ?? {}) as Record<string, unknown>
        if (opts["resume"] !== undefined) capturedResume = opts["resume"] as string
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: `sdk-case-b-${createCallCount}`,
          responseFor: (t) => `echo:${t}`,
        })
      })

      try {
        const result = await runScopedReg(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const obs = yield* ObservabilityService

            // Subscribe to obs events to check ChatUnknownThread is NOT emitted.
            const evStream = yield* obs.subscribeEvents
            yield* Effect.forkChild(
              evStream.pipe(
                Stream.runForEach((e) =>
                  Effect.sync(() => {
                    if (
                      e.kind === "Error" &&
                      (e as Record<string, unknown>)["errorTag"] === "ChatUnknownThread"
                    ) {
                      unknownThreadEvents.push((e as Record<string, unknown>)["message"] as string)
                    }
                  }),
                ),
              ),
            )

            const t = yield* chat.createThread({ model: "claude-test", title: "reap-case-b" })

            // Seed registry WITHOUT a sid (Case B — server restarted before first turn).
            const reg = yield* ThreadRegistryService
            yield* reg.upsert({ id: t.id, cwd: "/test", model: "claude-test" })

            // Wait for idle-eligibility, then reap.
            yield* waitForIdleEligibility()
            yield* chat.reapIdleThreadsOnce()

            // send() must recover via Case B (no sid → re-create live, empty history).
            const sendResult = yield* chat.send(t.id, "hello case b")

            yield* Effect.sleep("30 millis")

            return { sendResult, createCallCount, capturedResume: capturedResume as string | undefined }
          }),
          fakeLayer,
        )

        // send() succeeded
        expect(Option.isSome(result.sendResult)).toBe(true)
        // No resume option — empty-history re-create
        expect(result.capturedResume).toBeUndefined()
        // No ChatUnknownThread event (Case B is "known but no sid", not unknown)
        expect(unknownThreadEvents).toHaveLength(0)
        // At least 2 SDK queries: initial create + Case B re-create
        expect(result.createCallCount).toBeGreaterThanOrEqual(2)
      } finally {
        if (prevIdleMs === undefined) delete process.env["LUNA_CHAT_THREAD_IDLE_MS"]
        else process.env["LUNA_CHAT_THREAD_IDLE_MS"] = prevIdleMs
      }
    },
    { timeout: 15_000 },
  )

  it(
    "send to genuinely-unknown thread (Case C): returns Option.none and emits ChatUnknownThread",
    async () => {
      const unknownThreadEvents: string[] = []

      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: "sdk-case-c",
          responseFor: (t) => `echo:${t}`,
        }),
      )

      const result = await runScopedReg(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const obs = yield* ObservabilityService

          const evStream = yield* obs.subscribeEvents
          yield* Effect.forkChild(
            evStream.pipe(
              Stream.runForEach((e) =>
                Effect.sync(() => {
                  if (
                    e.kind === "Error" &&
                    (e as Record<string, unknown>)["errorTag"] === "ChatUnknownThread"
                  ) {
                    unknownThreadEvents.push((e as Record<string, unknown>)["message"] as string)
                  }
                }),
              ),
            ),
          )

          // No thread created, not in registry → genuinely unknown.
          const sendResult = yield* chat.send("thr_truly_unknown_99", "hello")
          yield* Effect.sleep("20 millis")
          return { sendResult }
        }),
        fakeLayer,
      )

      expect(Option.isNone(result.sendResult)).toBe(true)
      expect(unknownThreadEvents.length).toBeGreaterThan(0)
    },
    { timeout: 15_000 },
  )

  it(
    "concurrent double-send after reap: exactly ONE SDK query spawned, BOTH messages persisted",
    async () => {
      const SDK_SID = "sdk-concurrent-resume"
      let createCallCount = 0
      const prevIdleMs = process.env["LUNA_CHAT_THREAD_IDLE_MS"]
      process.env["LUNA_CHAT_THREAD_IDLE_MS"] = "1"

      const fakeLayer = SDKClient.fake((p) => {
        createCallCount++
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: SDK_SID,
          responseFor: (t) => `echo:${t}`,
        })
      })

      // A ThreadRegistry wrapper whose `get` suspends for 5 ms before
      // delegating to the Memory impl. This suspension is the key to making
      // the double-create race observable: with the real withPermits(1) guard
      // fiber-2 blocks on the semaphore until fiber-1 has finished createThread
      // and written the thread into the in-memory map. When fiber-2 eventually
      // runs its post-acquire re-check its delayed `get` sees the winner and
      // skips createThread (total SDK calls = 2). Without the guard (mutation:
      // withPermits(0)) both fibers enter simultaneously, both suspend in their
      // delayed `get`, both wake with a miss, both call createThread (total = 3)
      // and the assertion fails — proving the guard was load-bearing.
      const slowGetRegistryLayer: Layer.Layer<ThreadRegistryService> = Layer.effect(
        ThreadRegistryService,
        Effect.gen(function* () {
          const inner = yield* ThreadRegistryService
          const api: typeof inner = {
            ...inner,
            get: (id: string) =>
              Effect.sleep("5 millis").pipe(Effect.andThen(inner.get(id))),
          }
          return api
        }),
      ).pipe(Layer.provide(ThreadRegistryService.Memory.pipe(Layer.provide(testClock))))

      const baseLayerWithSlowRegistry = Layer.mergeAll(
        SessionStore.Default,
        reapClock,
        obsLayer,
        telemetryLayer,
        Layer.succeed(MemoryRouterTag, noopMemoryRouter),
        slowGetRegistryLayer,
      )

      const fullLayerWithSlowRegistry = (sdkLayer: Layer.Layer<SDKClient>) =>
        Layer.provideMerge(
          ChatService.Default,
          Layer.provideMerge(
            SDKAdapter.Default,
            Layer.mergeAll(sdkLayer, baseLayerWithSlowRegistry),
          ),
        )

      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const chat = yield* ChatService

              const t = yield* chat.createThread({ model: "claude-test", title: "concurrent-reap" })
              const reg = yield* ThreadRegistryService
              yield* reg.upsert({ id: t.id, sdkSessionId: SDK_SID, cwd: "/test", model: "claude-test" })

              // Wait for idle-eligibility, then reap.
              yield* waitForIdleEligibility()
              yield* chat.reapIdleThreadsOnce()

              // Fire two sends concurrently — only one should spawn a new SDK query.
              const [r1, r2] = yield* Effect.all(
                [chat.send(t.id, "msg-a"), chat.send(t.id, "msg-b")],
                { concurrency: "unbounded" },
              )

              yield* Effect.sleep("30 millis")

              const store = yield* SessionStore
              const msgs = yield* store.readMessages(t.id).pipe(
                Stream.runCollect,
                Effect.map((c) => Array.from(c).filter((m) => m.kind === "user")),
              )

              return { r1, r2, msgs, createCallCount }
            }),
          ).pipe(Effect.provide(fullLayerWithSlowRegistry(fakeLayer))),
        )

        // Both sends succeeded
        expect(Option.isSome(result.r1)).toBe(true)
        expect(Option.isSome(result.r2)).toBe(true)
        // Both messages were persisted
        expect(result.msgs.length).toBeGreaterThanOrEqual(2)
        // The semaphore ensures only ONE extra createThread call for the resume
        // (initial create + exactly 1 resume = 2 total; never 3).
        // Without the semaphore guard both fibers would race through the delayed
        // registry.get simultaneously and both call createThread => count = 3.
        expect(result.createCallCount).toBeLessThanOrEqual(2)
      } finally {
        if (prevIdleMs === undefined) delete process.env["LUNA_CHAT_THREAD_IDLE_MS"]
        else process.env["LUNA_CHAT_THREAD_IDLE_MS"] = prevIdleMs
      }
    },
    { timeout: 15_000 },
  )

  it(
    "reap-then-resume-then-immediate-reap: resumed thread is NOT re-reaped in the same sweep",
    async () => {
      const SDK_SID = "sdk-reap-resume-noreap"
      let createCallCount = 0
      const prevIdleMs = process.env["LUNA_CHAT_THREAD_IDLE_MS"]
      process.env["LUNA_CHAT_THREAD_IDLE_MS"] = "1"

      const fakeLayer = SDKClient.fake((p) => {
        createCallCount++
        return makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: SDK_SID,
          responseFor: (t) => `echo:${t}`,
        })
      })

      // Mutable test clock, advanced explicitly. The wall clock made this
      // test flaky: with the 1ms idle window, any ≥1ms scheduling hiccup
      // between send()'s lastActivity write and the second sweep's now-read
      // re-reaped the thread and failed the assertion. Driving time by hand
      // makes "immediately reap again" mean EXACTLY zero elapsed ms.
      let nowMs = 1_700_000_000_000
      const mutableClockLayer: Layer.Layer<CoreClock> = Layer.succeed(
        CoreClock,
        CoreClock.of({
          _tag: "luna/Clock",
          nowMs: () => Effect.sync(() => nowMs),
          nowIso: () => Effect.sync(() => new Date(nowMs).toISOString()),
        }),
      )
      const baseLayerMutableClock = Layer.mergeAll(
        SessionStore.Default,
        mutableClockLayer,
        obsLayer,
        telemetryLayer,
        Layer.succeed(MemoryRouterTag, noopMemoryRouter),
        ThreadRegistryService.Memory.pipe(Layer.provide(mutableClockLayer)),
      )
      const fullLayerMutableClock = Layer.provideMerge(
        ChatService.Default,
        Layer.provideMerge(
          SDKAdapter.Default,
          Layer.mergeAll(fakeLayer, baseLayerMutableClock),
        ),
      )

      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const chat = yield* ChatService

              const t = yield* chat.createThread({ model: "claude-test", title: "reap-resume-noreap" })
              const reg = yield* ThreadRegistryService
              yield* reg.upsert({ id: t.id, sdkSessionId: SDK_SID, cwd: "/test", model: "claude-test" })

              // Advance past the 1ms idle window, then reap.
              nowMs += 10
              yield* chat.reapIdleThreadsOnce()

              // Resume via send() — this updates lastActivity to `nowMs`.
              const sendResult = yield* chat.send(t.id, "resuming now")

              // Immediately reap again WITHOUT advancing the clock — the
              // just-resumed thread must NOT be reaped (0ms elapsed < 1ms window).
              const reapedCount = yield* chat.reapIdleThreadsOnce()

              return { sendResult, reapedCount, createCallCount }
            }),
          ).pipe(Effect.provide(fullLayerMutableClock)),
        )

        expect(Option.isSome(result.sendResult)).toBe(true)
        // The second reap sweep should not touch the resumed thread.
        expect(result.reapedCount).toBe(0)
      } finally {
        if (prevIdleMs === undefined) delete process.env["LUNA_CHAT_THREAD_IDLE_MS"]
        else process.env["LUNA_CHAT_THREAD_IDLE_MS"] = prevIdleMs
      }
    },
    { timeout: 15_000 },
  )

  it(
    "subscriber attached BEFORE the reap keeps receiving frames after resume (persistent per-thread PubSub)",
    async () => {
      // The Moon regression: a client subscribes, the idle reaper evicts the
      // thread, send() resumes it — the pre-reap subscription must still see
      // the recovered turn's frames. Before the persistent-PubSub fix the
      // resume minted a fresh hub, so this subscriber received nothing (no
      // frames, no error) and the UI hung. server.chat.reap.test.ts pins the
      // same contract over the real ws wire; this pins it at the service seam.
      const SDK_SID = "sdk-pubsub-survives-reap"
      const prevIdleMs = process.env["LUNA_CHAT_THREAD_IDLE_MS"]
      process.env["LUNA_CHAT_THREAD_IDLE_MS"] = "1"

      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: SDK_SID,
          responseFor: (t) => `echo:${t}`,
        }),
      )

      try {
        const result = await runScopedReg(
          Effect.gen(function* () {
            const chat = yield* ChatService

            const t = yield* chat.createThread({ model: "claude-test", title: "pubsub-survives" })
            const reg = yield* ThreadRegistryService
            yield* reg.upsert({ id: t.id, sdkSessionId: SDK_SID, cwd: "/test", model: "claude-test" })

            // Subscribe BEFORE the reap and hold the stream open across it,
            // collecting every frame that arrives (like a connected client).
            const seen: string[] = []
            yield* Effect.forkScoped(
              chat.subscribe(t.id).pipe(
                Stream.runForEach((f) =>
                  Effect.sync(() => {
                    seen.push(f.type)
                  }),
                ),
              ),
            )
            // Let the snapshot land so the subscription is fully attached.
            yield* Effect.sleep("20 millis")

            yield* waitForIdleEligibility()
            const reaped = yield* chat.reapIdleThreadsOnce()

            // Recovered turn: these frames MUST reach the pre-reap subscriber.
            const sendResult = yield* chat.send(t.id, "after reap")
            yield* Effect.sleep("50 millis")

            return { reaped, sendResult, seen: [...seen] }
          }),
          fakeLayer,
        )

        expect(result.reaped).toBeGreaterThanOrEqual(1)
        expect(Option.isSome(result.sendResult)).toBe(true)
        expect(result.seen).toContain("user-accepted")
        expect(result.seen).toContain("assistant-done")
      } finally {
        if (prevIdleMs === undefined) delete process.env["LUNA_CHAT_THREAD_IDLE_MS"]
        else process.env["LUNA_CHAT_THREAD_IDLE_MS"] = prevIdleMs
      }
    },
    { timeout: 15_000 },
  )

  it(
    "setThreadConfig after reap: recovers the thread instead of rejecting with 'unknown thread'",
    async () => {
      // Same recovery contract as send()/subscribe(): the user parking a
      // thread past the idle window and then flipping the model/effort
      // dropdown must not be told the thread is unknown.
      const SDK_SID = "sdk-config-after-reap"
      const prevIdleMs = process.env["LUNA_CHAT_THREAD_IDLE_MS"]
      process.env["LUNA_CHAT_THREAD_IDLE_MS"] = "1"

      const fakeLayer = SDKClient.fake((p) =>
        makeChatLoopQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: SDK_SID,
          responseFor: (t) => `echo:${t}`,
        }),
      )

      try {
        const result = await runScopedReg(
          Effect.gen(function* () {
            const chat = yield* ChatService

            const t = yield* chat.createThread({
              model: "claude-sonnet-4-6",
              title: "config-after-reap",
            })
            const reg = yield* ThreadRegistryService
            yield* reg.upsert({
              id: t.id,
              sdkSessionId: SDK_SID,
              cwd: "/test",
              model: "claude-sonnet-4-6",
            })

            yield* waitForIdleEligibility()
            const reaped = yield* chat.reapIdleThreadsOnce()

            const config = yield* chat.setThreadConfig({ threadId: t.id, effort: "high" })

            return { reaped, config }
          }),
          fakeLayer,
        )

        expect(result.reaped).toBeGreaterThanOrEqual(1)
        const reasons = (result.config.rejected ?? []).map((r) => r.reason)
        expect(reasons).not.toContain("unknown thread")
        expect(result.config.applied).toContain("effort")
      } finally {
        if (prevIdleMs === undefined) delete process.env["LUNA_CHAT_THREAD_IDLE_MS"]
        else process.env["LUNA_CHAT_THREAD_IDLE_MS"] = prevIdleMs
      }
    },
    { timeout: 15_000 },
  )
})
