/**
 * TelegramAdapter unit tests.
 *
 * All tests use an injected fake HTTP transport — no network is required.
 * The fake transport records every call and returns scripted responses,
 * allowing assertions on:
 *   - Correct API method names and parameters.
 *   - Message construction from Telegram update objects.
 *   - stream-edit state machine (sendMessage → editMessageText).
 *   - Poll-loop resilience (transient errors are retried, not fatal).
 *   - Dedup key correctness (platformMessageId = update_id).
 */
import { describe, expect, it } from "vitest"
import {
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Redacted,
  Ref,
  Stream,
} from "effect"
import { Clock } from "@luna/core"
import { ChatService } from "@luna/chat-service"
import {
  makeTelegramAdapter,
  makeRealTransport,
  normalizeCommandMention,
  type TelegramHttpTransport,
  type TelegramAdapterConfig,
} from "../src/adapters/telegram.js"
import { channelCommands } from "../src/commands.js"
import {
  ChannelService,
  ChannelServiceLayer,
  ChannelSessionStore,
  InboundDedupStore,
} from "../src/index.js"
import type {
  ChannelMessage,
  DeliverOptions,
  DeliveryTarget,
} from "../src/types.js"
import type { ChatFrame, CreateThreadOptions } from "@luna/chat-service"
import type { ChatMessage, SessionSummary } from "@luna/core"

/* -------------------------------------------------------------------------- */
/* Fake HTTP transport helpers                                                 */
/* -------------------------------------------------------------------------- */

interface FakeCall {
  readonly method: string
  readonly params: Record<string, unknown>
}

/**
 * Make a fake TelegramHttpTransport.
 *
 * `responses` is a queue of scripted replies consumed in order WITHIN each
 * method's own queue. Provide `perMethod` to script per-method queues; those
 * responses are consumed before the fallback `responses` queue.
 *
 * Once all scripted responses for a method are exhausted:
 *   - getUpdates: returns `{ ok: true, result: [] }` (empty poll)
 *   - sendMessage / editMessageText: returns a generic success message
 *   - getMe: returns a stable bot identity (username "LunaTestBot")
 *   - anything else: returns `{ ok: true, result: null }`
 *
 * Startup lifecycle calls (getMe, setMyCommands) never consume the global
 * `responses` queue — they are incidental to every start(), and stealing
 * entries scripted for getUpdates would silently skew inbound tests. Script
 * them via `perMethod` when a test needs specific behavior.
 */
type FakeResponse = { ok: boolean; result?: unknown; description?: string; error_code?: number }

const makeFakeTransport = (
  responses: Array<FakeResponse> = [],
  perMethod: Partial<Record<string, Array<FakeResponse>>> = {},
) => {
  const calls: FakeCall[] = []
  const globalQueue = [...responses]
  const methodQueues: Map<string, Array<FakeResponse>> = new Map()
  for (const [method, queue] of Object.entries(perMethod)) {
    if (queue !== undefined) {
      methodQueues.set(method, [...queue])
    }
  }

  const defaultFor = (method: string): FakeResponse => {
    if (method === "getUpdates") return { ok: true, result: [] }
    if (method === "sendMessage" || method === "editMessageText") {
      return { ok: true, result: { message_id: 1, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } }
    }
    if (method === "getMe") {
      return { ok: true, result: { id: 424242, username: "LunaTestBot", first_name: "Luna" } }
    }
    return { ok: true, result: null }
  }

  /** Lifecycle calls that must not steal globally-scripted responses. */
  const lifecycleMethods = new Set(["getMe", "setMyCommands"])

  const transport: TelegramHttpTransport = (method, params) =>
    Effect.gen(function* () {
      if (method === "getUpdates") {
        yield* Effect.sleep("1 millis")
      }
      calls.push({ method, params })
      // Check per-method queue first
      const methodQueue = methodQueues.get(method)
      if (methodQueue !== undefined && methodQueue.length > 0) {
        const r = methodQueue.shift()
        if (r !== undefined) return r
      }
      // Then global queue (startup lifecycle calls skip it — see doc above)
      if (!lifecycleMethods.has(method)) {
        const scripted = globalQueue.shift()
        if (scripted !== undefined) return scripted
      }
      // Default fallback
      return defaultFor(method)
    })

  return { transport, calls }
}

/* -------------------------------------------------------------------------- */
/* Telegram update / message builders                                         */
/* -------------------------------------------------------------------------- */

let updateIdCounter = 1000

const makeTextUpdate = (overrides: {
  chatId?: number
  chatType?: "private" | "group" | "supergroup" | "channel"
  fromId?: number
  text?: string
  updateId?: number
  messageId?: number
  date?: number
}) => {
  const updateId = overrides.updateId ?? updateIdCounter++
  return {
    update_id: updateId,
    message: {
      message_id: overrides.messageId ?? 42,
      chat: {
        id: overrides.chatId ?? 111,
        type: overrides.chatType ?? "private",
      },
      from: {
        id: overrides.fromId ?? 999,
        first_name: "Test",
      },
      text: overrides.text ?? "hello luna",
      date: overrides.date ?? Math.floor(Date.now() / 1000),
    },
  }
}

/** A non-text update (photo). Should be ignored. */
const makePhotoUpdate = (chatId = 111, updateId = updateIdCounter++) => ({
  update_id: updateId,
  message: {
    message_id: 43,
    chat: { id: chatId, type: "private" as const },
    from: { id: 999, first_name: "Test" },
    photo: [{ file_id: "abc", width: 100, height: 100, file_size: 1234 }],
    date: Math.floor(Date.now() / 1000),
  },
})

/** A non-message update (e.g. callback_query). Should be ignored. */
const makeCallbackUpdate = (updateId = updateIdCounter++) => ({
  update_id: updateId,
  callback_query: { id: "cq-1", data: "some_data" },
})

/* -------------------------------------------------------------------------- */
/* Delivery target builder                                                    */
/* -------------------------------------------------------------------------- */

const makeDeliveryTarget = (
  chatId: string,
  platformMessageId: string,
): DeliveryTarget => ({
  inReplyTo: {
    transport: "telegram",
    channelId: chatId,
    senderId: "999",
    threadingKey: chatId,
    text: "hello",
    platformMessageId,
    ts: new Date().toISOString(),
  },
  address: {
    transport: "telegram",
    channelId: chatId,
    senderId: "999",
    threadingKey: chatId,
  },
})

const makeDeliverOpts = (overrides: Partial<DeliverOptions> = {}): DeliverOptions => ({
  isPartial: false,
  isFinal: true,
  chunkIndex: 0,
  totalChunks: 1,
  ...overrides,
})

/* -------------------------------------------------------------------------- */
/* 1. getUpdates → correct ChannelMessage + offset advances                   */
/* -------------------------------------------------------------------------- */

describe("inbound: getUpdates → ChannelMessage", () => {
  it("builds a correct ChannelMessage from a text update", async () => {
    const receivedMessages: ChannelMessage[] = []

    const update = makeTextUpdate({ chatId: 12345, fromId: 67890, text: "hello luna", updateId: 5001 })
    const { transport } = makeFakeTransport([
      { ok: true, result: [update] },
      // Subsequent polls return empty so the loop suspends
    ])

    const adapter = makeTelegramAdapter({ id: "tg-test", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => {
        receivedMessages.push(msg)
      }),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Run start() with a scope; let it spin briefly then interrupt.
          const fiber = yield* Effect.fork(
            Effect.scoped(adapter.start()),
          )
          // Give the poll loop time to run one iteration
          yield* Effect.sleep("50 millis")
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )

    expect(receivedMessages).toHaveLength(1)
    const msg = receivedMessages[0]
    expect(msg).toBeDefined()
    expect(msg!.transport).toBe("telegram")
    expect(msg!.channelId).toBe("12345")
    expect(msg!.senderId).toBe("67890")
    expect(msg!.threadingKey).toBe("12345")  // chat.id
    expect(msg!.text).toBe("hello luna")
    expect(msg!.platformMessageId).toBe("5001")  // update_id
    expect(msg!.metadata).toMatchObject({ chatType: "private", messageId: 42, userId: 67890, username: undefined, firstName: "Test" })
  })

  it("advances the offset past consumed updates", async () => {
    const update1 = makeTextUpdate({ updateId: 200, chatId: 1 })
    const update2 = makeTextUpdate({ updateId: 201, chatId: 1 })
    const { transport, calls } = makeFakeTransport([
      { ok: true, result: [update1, update2] },
      // Second poll: empty
      { ok: true, result: [] },
      // Third poll: empty
    ])

    const adapter = makeTelegramAdapter({ id: "tg-offset", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          Effect.scoped(adapter.start()),
        )
        yield* Effect.sleep("80 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // start() issues lifecycle calls (getMe, setMyCommands) before polling;
    // assert on the getUpdates sequence only.
    const polls = calls.filter((c) => c.method === "getUpdates")

    // First poll: offset 0 (no prior updates)
    expect(polls[0]?.params["offset"]).toBe(0)

    // Second poll: offset should be 202 (last update_id + 1)
    expect(polls[1]?.params["offset"]).toBe(202)
  })
})

/* -------------------------------------------------------------------------- */
/* 2. Non-text / non-message updates are ignored                              */
/* -------------------------------------------------------------------------- */

describe("inbound: non-text / non-message updates ignored", () => {
  it("ignores a photo update (no text field)", async () => {
    const receivedMessages: ChannelMessage[] = []
    const photoUpdate = makePhotoUpdate(111, 300)
    const textUpdate = makeTextUpdate({ updateId: 301, text: "actual text" })

    const { transport } = makeFakeTransport([
      { ok: true, result: [photoUpdate, textUpdate] },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-photo", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // Only the text update should produce a ChannelMessage
    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]?.text).toBe("actual text")
    expect(receivedMessages[0]?.platformMessageId).toBe("301")
  })

  it("ignores a callback_query update (no message field)", async () => {
    const receivedMessages: ChannelMessage[] = []
    const cbUpdate = makeCallbackUpdate(400)
    const textUpdate = makeTextUpdate({ updateId: 401 })

    const { transport } = makeFakeTransport([
      { ok: true, result: [cbUpdate, textUpdate] },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-cb", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]?.platformMessageId).toBe("401")
  })
})

/* -------------------------------------------------------------------------- */
/* 3. deliver: stream-edit state machine                                      */
/* -------------------------------------------------------------------------- */

describe("deliver: stream-edit (sendMessage → editMessageText)", () => {
  it("first partial calls sendMessage; subsequent partials call editMessageText", async () => {
    const { transport, calls } = makeFakeTransport([
      // sendMessage response
      { ok: true, result: { message_id: 999, chat: { id: 111, type: "private" }, date: 0, from: { id: 1 } } },
      // editMessageText responses
      { ok: true, result: { message_id: 999, chat: { id: 111, type: "private" }, date: 0, from: { id: 1 } } },
      { ok: true, result: { message_id: 999, chat: { id: 111, type: "private" }, date: 0, from: { id: 1 } } },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-se", httpTransport: transport })

    const target = makeDeliveryTarget("111", "update-1")

    // First partial (placeholder — chunkIndex 0, isPartial, not isFinal)
    await Effect.runPromise(
      adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })),
    )

    // Second partial
    await Effect.runPromise(
      adapter.deliver(target, "Hello", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })),
    )

    // Final
    await Effect.runPromise(
      adapter.deliver(target, "Hello world", makeDeliverOpts({ isPartial: false, isFinal: true, chunkIndex: 0, totalChunks: 1 })),
    )

    // First call must be sendMessage
    expect(calls[0]?.method).toBe("sendMessage")
    expect(calls[0]?.params["chat_id"]).toBe("111")
    expect(calls[0]?.params["text"]).toBe("…")

    // Subsequent calls must be editMessageText with the captured message_id
    expect(calls[1]?.method).toBe("editMessageText")
    expect(calls[1]?.params["chat_id"]).toBe("111")
    expect(calls[1]?.params["message_id"]).toBe(999)
    expect(calls[1]?.params["text"]).toBe("Hello")

    expect(calls[2]?.method).toBe("editMessageText")
    expect(calls[2]?.params["text"]).toBe("Hello world")
  })

  it("cleans up the turn-key after isFinal so a new turn starts fresh", async () => {
    const { transport, calls } = makeFakeTransport([
      // First turn: sendMessage
      { ok: true, result: { message_id: 100, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } },
      // Second turn: sendMessage (should be new, not editMessageText)
      { ok: true, result: { message_id: 200, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-cleanup", httpTransport: transport })

    const target1 = makeDeliveryTarget("1", "turn-A")
    const target2 = makeDeliveryTarget("1", "turn-B")

    // Complete the first turn
    await Effect.runPromise(adapter.deliver(target1, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })))
    await Effect.runPromise(adapter.deliver(target1, "Done", makeDeliverOpts({ isPartial: false, isFinal: true, chunkIndex: 0, totalChunks: 1 })))

    // Start a new turn (different platformMessageId)
    await Effect.runPromise(adapter.deliver(target2, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })))

    // First call: sendMessage for turn-A
    expect(calls[0]?.method).toBe("sendMessage")
    // Second call: editMessageText for turn-A final
    expect(calls[1]?.method).toBe("editMessageText")
    expect(calls[1]?.params["message_id"]).toBe(100)
    // Third call: sendMessage for turn-B (fresh turn — NOT editMessageText)
    expect(calls[2]?.method).toBe("sendMessage")
  })

  it("recovery send on isFinal does NOT leave a residual turn-key entry (no map leak)", async () => {
    // Scenario: the first-partial sendMessage succeeded (so sentMessageIds has
    // the turnKey), but then we simulate the case where existingMsgId is absent
    // (recovery path) on the isFinal call. After isFinal, the turn-key must be
    // gone so that a subsequent fresh turn starts with sendMessage, not editMessageText.
    //
    // We force the recovery path by: (1) NOT calling the first partial (so
    // sentMessageIds has no entry) and (2) calling deliver with isFinal=true.
    // After that call, a new first-partial for the same turnKey must again call
    // sendMessage (not editMessageText), proving the map is clean.

    // Script: recovery sendMessage, then a fresh sendMessage for the new turn.
    const { transport, calls } = makeFakeTransport([
      // Recovery sendMessage (isFinal call with no prior entry)
      { ok: true, result: { message_id: 300, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } },
      // Fresh sendMessage for the next turn's first partial
      { ok: true, result: { message_id: 301, chat: { id: 1, type: "private" }, date: 0, from: { id: 1 } } },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-leak", httpTransport: transport })
    const target = makeDeliveryTarget("1", "turn-leak")

    // Directly call with isFinal=true, no prior setup → recovery branch.
    await Effect.runPromise(
      adapter.deliver(target, "final content", makeDeliverOpts({ isPartial: false, isFinal: true, chunkIndex: 0, totalChunks: 1 })),
    )

    // Recovery branch should call sendMessage.
    expect(calls[0]?.method).toBe("sendMessage")

    // Now start a fresh turn with the SAME turnKey.
    // If the map were leaked, this would try editMessageText (wrong).
    // If the map is clean, this is treated as a first partial → sendMessage.
    await Effect.runPromise(
      adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })),
    )

    // The second call must also be sendMessage (fresh turn, clean map).
    expect(calls[1]?.method).toBe("sendMessage")
    // No editMessageText calls at all — the map was not leaked.
    expect(calls.every((c) => c.method !== "editMessageText")).toBe(true)
  })

  it("ignores 'message is not modified' errors (400) silently", async () => {
    const { transport, calls } = makeFakeTransport([
      // sendMessage
      { ok: true, result: { message_id: 77, chat: { id: 5, type: "private" }, date: 0, from: { id: 1 } } },
      // editMessageText returns a "not modified" error — adapter should not throw
      { ok: false, error_code: 400, description: "Bad Request: message is not modified" },
    ])

    const adapter = makeTelegramAdapter({ id: "tg-notmod", httpTransport: transport })
    const target = makeDeliveryTarget("5", "turn-notmod")

    await Effect.runPromise(adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false, chunkIndex: 0, totalChunks: 1 })))

    // This should NOT throw even though the response is ok: false
    await expect(
      Effect.runPromise(adapter.deliver(target, "same content", makeDeliverOpts({ isPartial: false, isFinal: true, chunkIndex: 0, totalChunks: 1 }))),
    ).resolves.toBeUndefined()

    expect(calls).toHaveLength(2)
    expect(calls[1]?.method).toBe("editMessageText")
  })
})

/* -------------------------------------------------------------------------- */
/* 4. Reconnection: transient errors are retried, not fatal                   */
/* -------------------------------------------------------------------------- */

describe("reconnection: transient poll errors are retried", () => {
  it("a transport error on getUpdates is retried with the SAME offset, and at least 2 polls occur before success", async () => {
    const receivedMessages: ChannelMessage[] = []
    const textUpdate = makeTextUpdate({ updateId: 500, text: "after error" })

    // Record the offset parameter from every getUpdates call so we can assert
    // that the retry re-ran pollOnce with the SAME offset (not advanced).
    const getUpdatesOffsets: number[] = []

    // Script: first getUpdates fails, second succeeds with the update.
    // All other methods (sendMessage etc.) use the default fallback.
    const perMethodQueues: Partial<Record<string, Array<{ ok: boolean; result?: unknown; description?: string }>>> = {
      getUpdates: [
        { ok: false, description: "503: Service Unavailable" },
        { ok: true, result: [textUpdate] },
      ],
    }

    // Wrap the fake transport so we can intercept getUpdates offset values.
    const { transport: baseTransport } = makeFakeTransport([], perMethodQueues)
    const recordingTransport: TelegramHttpTransport = (method, params) =>
      Effect.sync(() => {
        if (method === "getUpdates") {
          getUpdatesOffsets.push(params["offset"] as number)
        }
      }).pipe(
        Effect.flatMap(() => baseTransport(method, params)),
      )

    const adapter = makeTelegramAdapter({ id: "tg-retry", httpTransport: recordingTransport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        // Need enough time for: first poll failure + 1 second backoff + second poll success
        yield* Effect.sleep("2500 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // (a) The loop survived the error and delivered the message after retry.
    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]?.text).toBe("after error")

    // (b) At least 2 getUpdates calls occurred (failing poll + at least one retry).
    // A single lucky poll cannot satisfy this.
    expect(getUpdatesOffsets.length).toBeGreaterThanOrEqual(2)

    // (c) The RETRY call used the SAME offset as the failing call (offset was NOT
    // advanced after the error — the adapter correctly preserves the offset via
    // the catchAllCause fallback in the loop).
    // First call: offset 0 (no prior successful polls).
    expect(getUpdatesOffsets[0]).toBe(0)
    // Second call (the retry): same offset 0 — not advanced past the failed poll.
    expect(getUpdatesOffsets[1]).toBe(0)
  }, 10_000)
})

/* -------------------------------------------------------------------------- */
/* 5. Dedup key correctness                                                   */
/* -------------------------------------------------------------------------- */

describe("dedup key: platformMessageId === update_id", () => {
  it("sets platformMessageId to update_id (string)", async () => {
    const receivedMessages: ChannelMessage[] = []
    const update = makeTextUpdate({ updateId: 9999 })

    const { transport } = makeFakeTransport([{ ok: true, result: [update] }])

    const adapter = makeTelegramAdapter({ id: "tg-dedup", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(receivedMessages[0]?.platformMessageId).toBe("9999")
  })

  it("same update_id produces same platformMessageId (dedup identity)", async () => {
    // Two updates with the same update_id (simulates a retry scenario).
    // Our adapter will emit two ChannelMessages with the same platformMessageId —
    // it is the ChannelService's InboundDedupStore that suppresses the second.
    // This test verifies the mapping is correct so dedup CAN work.
    const update = makeTextUpdate({ updateId: 8888, text: "test" })
    const { transport } = makeFakeTransport([
      { ok: true, result: [update] },        // first poll: delivers update 8888
      { ok: true, result: [update] },        // second poll: same update re-delivered
    ])

    const receivedMessages: ChannelMessage[] = []
    const adapter = makeTelegramAdapter({ id: "tg-dedup2", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("80 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // Both messages have the same platformMessageId — dedup would catch the second
    const ids = receivedMessages.map((m) => m.platformMessageId)
    expect(ids.every((id) => id === "8888")).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* 6. End-to-end: TelegramAdapter wired into ChannelService                  */
/* -------------------------------------------------------------------------- */

/**
 * Stub ChatService for e2e test: thin clone of the one in channels.test.ts.
 */
const makeStubChatService = () => {
  const threads = new Map<string, PubSub.PubSub<ChatFrame>>()
  let createCount = 0
  let sendCount = 0

  const makeId = () => `thr_tg_${(++createCount).toString(16)}`

  const makeSummary = (id: string): SessionSummary => ({
    id,
    parentId: null,
    title: `tg-thread-${id}`,
    tags: [],
    createdAt: Date.now(),
    endedAt: null,
    model: "test",
    status: "active" as const,
    lastMessageAt: null,
    lastMessagePreview: null,
  })

  const service = {
    createThread: (opts: CreateThreadOptions) =>
      Effect.gen(function* () {
        const id = opts.threadIdOverride ?? makeId()
        const pub = yield* PubSub.unbounded<ChatFrame>()
        threads.set(id, pub)
        return makeSummary(id)
      }),
    send: (_threadId: string, _text: string) => {
      sendCount++
      return Effect.succeed(Option.none<ChatMessage>())
    },
    interrupt: () => Effect.void,
    subscribe: (threadId: string): Stream.Stream<ChatFrame, never> => {
      const pub = threads.get(threadId)
      if (pub === undefined) return Stream.empty
      return Stream.unwrapScoped(
        Effect.gen(function* () {
          const q = yield* PubSub.subscribe(pub)
          return Stream.fromQueue(q)
        }),
      )
    },
    listThreads: () => Effect.succeed([] as ReadonlyArray<SessionSummary>),
    searchMemory: () => Effect.succeed({ hits: [] as ReadonlyArray<{ id: string; kind: string; content: string; score: number }> }),
    closeThread: () => Effect.void,
    setThreadConfig: (opts: { threadId: string; model?: string }) =>
      Effect.succeed({
        threadId: opts.threadId,
        applied: [] as ReadonlyArray<"model" | "effort">,
        deferred: [] as ReadonlyArray<"model" | "effort">,
      }),
  }

  return { service, threads, getCreateCount: () => createCount, getSendCount: () => sendCount }
}

describe("end-to-end: TelegramAdapter + ChannelService", () => {
  it("inbound update → sendMessage + editMessageText delivery via stream-edit", async () => {
    const { service: chatService, threads } = makeStubChatService()

    const textUpdate = makeTextUpdate({ updateId: 7001, chatId: 2000, fromId: 3000, text: "e2e test" })

    // Use method-aware transport so the getUpdates queue and the
    // sendMessage/editMessageText queues don't cross-pollinate.
    const { transport, calls } = makeFakeTransport(
      [],
      {
        // getUpdates: one real update, then forever empty
        getUpdates: [
          { ok: true, result: [textUpdate] },
        ],
        // sendMessage: returns message_id 55 (the placeholder "…")
        sendMessage: [
          { ok: true, result: { message_id: 55, chat: { id: 2000, type: "private" }, date: 0, from: { id: 1 } } },
        ],
        // editMessageText: success for all subsequent edits
        editMessageText: [
          { ok: true, result: { message_id: 55, chat: { id: 2000, type: "private" }, date: 0, from: { id: 1 } } },
          { ok: true, result: { message_id: 55, chat: { id: 2000, type: "private" }, date: 0, from: { id: 1 } } },
          { ok: true, result: { message_id: 55, chat: { id: 2000, type: "private" }, date: 0, from: { id: 1 } } },
        ],
      },
    )

    const adapter = makeTelegramAdapter({ id: "tg-e2e", httpTransport: transport })

    const serviceLayer = ChannelServiceLayer.pipe(
      Layer.provide(ChannelSessionStore.Memory),
      Layer.provide(InboundDedupStore.Memory),
      Layer.provide(Layer.succeed(ChatService, chatService as unknown as InstanceType<typeof ChatService>)),
      Layer.provide(Clock.Default),
    )

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(adapter)
          yield* svc.startAdapters()

          // Give the poll loop time to run and fire the inbound update
          yield* Effect.sleep("80 millis")

          // Find the created thread and emit assistant frames
          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread created after poll")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          // Emit a streaming response:
          //   delta("…")                 → placeholder sendMessage
          //   delta("Hello from Telegram!") → sets currentDeltaText
          //   assistant-done             → no-op in stream-edit mode
          //   turn-complete              → final editMessageText with currentDeltaText
          yield* PubSub.publish(pub, {
            type: "assistant-delta",
            threadId,
            turnId: "t1",
            text: "…",  // first delta: triggers placeholder sendMessage
          } satisfies ChatFrame)

          // Allow the placeholder send to complete
          yield* Effect.sleep("30 millis")

          // Second delta: update currentDeltaText to the final content
          yield* PubSub.publish(pub, {
            type: "assistant-delta",
            threadId,
            turnId: "t1",
            text: "Hello from Telegram!",  // cumulative delta text
          } satisfies ChatFrame)

          yield* Effect.sleep("10 millis")

          yield* PubSub.publish(pub, {
            type: "assistant-done",
            threadId,
            turnId: "t1",
            seq: 1,
            message: {
              id: "m1", seq: 1, ts: Date.now(), role: "assistant",
              text: "Hello from Telegram!", toolUses: [], attachments: [],
            },
          } satisfies ChatFrame)

          yield* PubSub.publish(pub, {
            type: "turn-complete",
            threadId,
          } satisfies ChatFrame)

          // Wait long enough for the final edit (turn-complete is synchronous,
          // but the fiber needs to process frames and make the API call)
          yield* Effect.sleep("300 millis")
        }),
        serviceLayer,
      ) as Effect.Effect<void, never>,
    )

    // Verify the Telegram API calls
    const sendCalls = calls.filter((c) => c.method === "sendMessage")
    const editCalls = calls.filter((c) => c.method === "editMessageText")

    // At least one sendMessage (placeholder or final)
    expect(sendCalls.length).toBeGreaterThanOrEqual(1)
    expect(sendCalls[0]?.params["chat_id"]).toBe("2000")

    // At least one editMessageText on the captured message_id
    expect(editCalls.length).toBeGreaterThanOrEqual(1)
    expect(editCalls[editCalls.length - 1]?.params["message_id"]).toBe(55)
    // Final edit carries the complete turn text
    expect(editCalls[editCalls.length - 1]?.params["text"]).toBe("Hello from Telegram!")
  }, 15_000)
})

/* -------------------------------------------------------------------------- */
/* 7. Adapter identity and static properties                                  */
/* -------------------------------------------------------------------------- */

describe("adapter identity", () => {
  it("has correct transport, capability, and maxMessageLength", () => {
    const { transport } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-id-test", httpTransport: transport })

    expect(adapter.transport).toBe("telegram")
    expect(adapter.capability).toBe("stream-edit")
    expect(adapter.maxMessageLength).toBe(4096)
    expect(adapter.id).toBe("tg-id-test")
  })

  it("stop() resolves cleanly without error", async () => {
    const adapter = makeTelegramAdapter({ id: "tg-stop", httpTransport: makeFakeTransport().transport })
    await expect(Effect.runPromise(adapter.stop())).resolves.toBeUndefined()
  })

  it("setMessageHandler installs the handler before start()", () => {
    const adapter = makeTelegramAdapter({ id: "tg-handler", httpTransport: makeFakeTransport().transport })
    let handlerInstalled = false
    adapter.setMessageHandler(() => {
      handlerInstalled = true
      return Effect.void
    })
    // Calling the handler should set the flag
    expect(handlerInstalled).toBe(false) // not called yet, just installed
  })
})

/* -------------------------------------------------------------------------- */
/* 8. makeRealTransport export (smoke test — no network)                      */
/* -------------------------------------------------------------------------- */

describe("makeRealTransport", () => {
  it("is exported and returns a function (accepts Redacted token)", () => {
    // makeRealTransport now requires a Redacted<string> so the plain-text token
    // is never stored as a bare string. The transport itself is still a function.
    const transport = makeRealTransport(Redacted.make("fake_token_12345"))
    expect(typeof transport).toBe("function")
  })
})


/* -------------------------------------------------------------------------- */
/* 9. buildChannelMessage: userId / username / firstName in metadata          */
/* -------------------------------------------------------------------------- */

describe("buildChannelMessage: extended metadata", () => {
  it("includes userId, username, firstName from msg.from in metadata", async () => {
    const receivedMessages: ChannelMessage[] = []

    const update = {
      update_id: 6001,
      message: {
        message_id: 99,
        chat: { id: 55555, type: "private" as const },
        from: {
          id: 12345,
          first_name: "Alice",
          username: "alice_tg",
        },
        text: "metadata test",
        date: Math.floor(Date.now() / 1000),
      },
    }

    const { transport } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-meta", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(receivedMessages).toHaveLength(1)
    const msg = receivedMessages[0]
    expect(msg!.metadata).toMatchObject({
      chatType: "private",
      messageId: 99,
      userId: 12345,
      username: "alice_tg",
      firstName: "Alice",
    })
  })

  it("handles missing username gracefully (username is undefined)", async () => {
    const receivedMessages: ChannelMessage[] = []

    const update = {
      update_id: 6002,
      message: {
        message_id: 100,
        chat: { id: 55556, type: "private" as const },
        from: {
          id: 99999,
          first_name: "Bob",
          // no username field
        },
        text: "no username",
        date: Math.floor(Date.now() / 1000),
      },
    }

    const { transport } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-meta-nousername", httpTransport: transport })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => { receivedMessages.push(msg) }),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(receivedMessages).toHaveLength(1)
    expect(receivedMessages[0]!.metadata?.username).toBeUndefined()
    expect(receivedMessages[0]!.metadata?.userId).toBe(99999)
    expect(receivedMessages[0]!.metadata?.firstName).toBe("Bob")
  })
})

/* -------------------------------------------------------------------------- */
/* HTML formatting on deliver                                                  */
/* -------------------------------------------------------------------------- */

describe("deliver: markdown → Telegram HTML", () => {
  it("sends converted HTML with parse_mode and link previews disabled", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-html", httpTransport: transport })
    const target = makeDeliveryTarget("101", "u-html-1")

    await Effect.runPromise(adapter.deliver(target, "**bold** and `code`", makeDeliverOpts()))

    const send = calls.find((c) => c.method === "sendMessage")
    expect(send?.params["text"]).toBe("<b>bold</b> and <code>code</code>")
    expect(send?.params["parse_mode"]).toBe("HTML")
    expect(send?.params["link_preview_options"]).toEqual({ is_disabled: true })
  })

  it("falls back to plain text when Telegram rejects the HTML", async () => {
    const { transport, calls } = makeFakeTransport([], {
      sendMessage: [
        {
          ok: false,
          error_code: 400,
          description:
            "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 5",
        },
        { ok: true, result: { message_id: 7, chat: { id: 101, type: "private" }, date: 0 } },
      ],
    })
    const adapter = makeTelegramAdapter({ id: "tg-fallback", httpTransport: transport })
    const target = makeDeliveryTarget("101", "u-fallback-1")

    await Effect.runPromise(adapter.deliver(target, ">! step\n**bold**", makeDeliverOpts()))

    const sends = calls.filter((c) => c.method === "sendMessage")
    expect(sends).toHaveLength(2)
    // First attempt: HTML. Second: plain text with the internal marker downgraded.
    expect(sends[0]?.params["parse_mode"]).toBe("HTML")
    expect(sends[1]?.params["parse_mode"]).toBeUndefined()
    expect(sends[1]?.params["text"]).toBe("> step\n**bold**")
    // Preview suppression survives the fallback — only parse_mode is dropped.
    expect(sends[1]?.params["link_preview_options"]).toEqual({ is_disabled: true })
  })

  it("edits with HTML formatting too", async () => {
    const { transport, calls } = makeFakeTransport([], {
      sendMessage: [
        { ok: true, result: { message_id: 55, chat: { id: 101, type: "private" }, date: 0 } },
      ],
    })
    const adapter = makeTelegramAdapter({ id: "tg-html-edit", httpTransport: transport })
    const target = makeDeliveryTarget("101", "u-html-edit")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false }))
        yield* adapter.deliver(target, "# Done", makeDeliverOpts())
      }),
    )

    const edit = calls.find((c) => c.method === "editMessageText")
    expect(edit?.params["text"]).toBe("<b>Done</b>")
    expect(edit?.params["parse_mode"]).toBe("HTML")
  })
})

/* -------------------------------------------------------------------------- */
/* Continuation chunks (long final answers)                                    */
/* -------------------------------------------------------------------------- */

describe("deliver: continuation chunks", () => {
  it("chunk 0 edits the placeholder; later chunks are fresh messages", async () => {
    const { transport, calls } = makeFakeTransport([], {
      sendMessage: [
        { ok: true, result: { message_id: 91, chat: { id: 202, type: "private" }, date: 0 } },
        { ok: true, result: { message_id: 92, chat: { id: 202, type: "private" }, date: 0 } },
      ],
    })
    const adapter = makeTelegramAdapter({ id: "tg-chunks", httpTransport: transport })
    const target = makeDeliveryTarget("202", "u-chunks-1")

    await Effect.runPromise(
      Effect.gen(function* () {
        // Placeholder (stream-edit turn in flight)
        yield* adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false }))
        // Finalization split across two chunks
        yield* adapter.deliver(
          target,
          "part one",
          makeDeliverOpts({ isFinal: false, chunkIndex: 0, totalChunks: 2 }),
        )
        yield* adapter.deliver(
          target,
          "part two",
          makeDeliverOpts({ isFinal: true, chunkIndex: 1, totalChunks: 2 }),
        )
      }),
    )

    const edits = calls.filter((c) => c.method === "editMessageText")
    const sends = calls.filter((c) => c.method === "sendMessage")
    expect(edits).toHaveLength(1)
    expect(edits[0]?.params["text"]).toBe("part one")
    expect(sends).toHaveLength(2) // placeholder + continuation
    expect(sends[1]?.params["text"]).toBe("part two")

    // Turn state is cleaned up: a new turn starts fresh with sendMessage.
    await Effect.runPromise(
      adapter.deliver(makeDeliveryTarget("202", "u-chunks-2"), "next", makeDeliverOpts()),
    )
    const sendsAfter = calls.filter((c) => c.method === "sendMessage")
    expect(sendsAfter).toHaveLength(3)
  })
})

/* -------------------------------------------------------------------------- */
/* Group reply threading                                                       */
/* -------------------------------------------------------------------------- */

describe("deliver: group reply threading", () => {
  const makeGroupTarget = (platformMessageId: string): DeliveryTarget => ({
    inReplyTo: {
      transport: "telegram",
      channelId: "-500",
      senderId: "999",
      threadingKey: "-500",
      text: "hello",
      platformMessageId,
      ts: new Date().toISOString(),
    },
    address: {
      transport: "telegram",
      channelId: "-500",
      senderId: "999",
      threadingKey: "-500",
      chatType: "group",
      messageId: 42,
    },
  })

  it("threads the first group reply onto the triggering message", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-reply", httpTransport: transport })

    await Effect.runPromise(adapter.deliver(makeGroupTarget("u-grp-1"), "hi", makeDeliverOpts()))

    const send = calls.find((c) => c.method === "sendMessage")
    expect(send?.params["reply_parameters"]).toEqual({ message_id: 42 })
  })

  it("does not add reply parameters in private chats", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-noreply", httpTransport: transport })
    // makeDeliveryTarget carries no chatType → treated as private/unknown
    await Effect.runPromise(
      adapter.deliver(makeDeliveryTarget("101", "u-dm-1"), "hi", makeDeliverOpts()),
    )

    const send = calls.find((c) => c.method === "sendMessage")
    expect(send?.params["reply_parameters"]).toBeUndefined()
  })

  it("does not add reply parameters on continuation chunks", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-reply-chunks", httpTransport: transport })
    const target = makeGroupTarget("u-grp-2")

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* adapter.deliver(target, "a", makeDeliverOpts({ isFinal: false, totalChunks: 2 }))
        yield* adapter.deliver(
          target,
          "b",
          makeDeliverOpts({ isFinal: true, chunkIndex: 1, totalChunks: 2 }),
        )
      }),
    )

    const sends = calls.filter((c) => c.method === "sendMessage")
    expect(sends[0]?.params["reply_parameters"]).toEqual({ message_id: 42 })
    expect(sends[1]?.params["reply_parameters"]).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* Loading indication: typing chat action                                      */
/* -------------------------------------------------------------------------- */

describe("typing indicator", () => {
  it("sends a typing action when a message arrives and stops after the first deliver", async () => {
    const update = makeTextUpdate({ chatId: 777, updateId: 9100, text: "work on this" })
    const { transport, calls } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-typing", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("80 millis")

        const typingCalls = calls.filter((c) => c.method === "sendChatAction")
        expect(typingCalls.length).toBeGreaterThanOrEqual(1)
        expect(typingCalls[0]?.params).toMatchObject({ chat_id: "777", action: "typing" })

        // First deliver stops the loop; no typing call should follow it.
        yield* adapter.deliver(
          makeDeliveryTarget("777", "9100"),
          "…",
          makeDeliverOpts({ isPartial: true, isFinal: false }),
        )
        const countAtDeliver = calls.filter((c) => c.method === "sendChatAction").length
        yield* Effect.sleep("100 millis")
        const countAfter = calls.filter((c) => c.method === "sendChatAction").length
        expect(countAfter).toBe(countAtDeliver)

        yield* Fiber.interrupt(fiber)
      }),
    )
  })

  it("stop() sweeps any live typing fibers", async () => {
    const update = makeTextUpdate({ chatId: 778, updateId: 9200 })
    const { transport, calls } = makeFakeTransport([{ ok: true, result: [update] }])
    const adapter = makeTelegramAdapter({ id: "tg-typing-stop", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
        yield* adapter.stop()
        const countAtStop = calls.filter((c) => c.method === "sendChatAction").length
        yield* Effect.sleep("80 millis")
        const countAfter = calls.filter((c) => c.method === "sendChatAction").length
        expect(countAfter).toBe(countAtStop)
      }),
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Command registration + mention normalization                                */
/* -------------------------------------------------------------------------- */

describe("start(): command registration", () => {
  it("registers the built-in commands via setMyCommands", async () => {
    const { transport, calls } = makeFakeTransport()
    const adapter = makeTelegramAdapter({ id: "tg-cmds", httpTransport: transport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("30 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    const reg = calls.find((c) => c.method === "setMyCommands")
    expect(reg).toBeDefined()
    expect(reg?.params["commands"]).toEqual(
      channelCommands.map((c) => ({ command: c.id, description: c.description })),
    )
    // Telegram constraints: 1-32 chars, lowercase letters/digits/underscores.
    for (const c of channelCommands) {
      expect(c.id).toMatch(/^[a-z0-9_]{1,32}$/)
      expect(c.description.length).toBeGreaterThanOrEqual(1)
      expect(c.description.length).toBeLessThanOrEqual(256)
    }
  })

  it("drops group commands addressed to another bot and strips our own mention", async () => {
    const received: ChannelMessage[] = []
    const forOther = makeTextUpdate({
      chatId: -600,
      chatType: "group",
      updateId: 9300,
      text: "/new@OtherBot",
    })
    const forUs = makeTextUpdate({
      chatId: -600,
      chatType: "group",
      updateId: 9301,
      text: "/new@LunaTestBot with args",
    })
    // getMe default resolves username LunaTestBot (see makeFakeTransport).
    const { transport } = makeFakeTransport([{ ok: true, result: [forOther, forUs] }])
    const adapter = makeTelegramAdapter({ id: "tg-mentions", httpTransport: transport })
    adapter.setMessageHandler((msg) => Effect.sync(() => { received.push(msg) }))

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("60 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    expect(received).toHaveLength(1)
    expect(received[0]?.text).toBe("/new with args")
  })
})

describe("normalizeCommandMention", () => {
  it("passes non-command text through unchanged", () => {
    expect(normalizeCommandMention("hello @LunaTestBot", "LunaTestBot")).toBe(
      "hello @LunaTestBot",
    )
  })

  it("strips our mention case-insensitively", () => {
    expect(normalizeCommandMention("/stop@lunatestbot", "LunaTestBot")).toBe("/stop")
  })

  it("drops commands for other bots", () => {
    expect(normalizeCommandMention("/stop@OtherBot", "LunaTestBot")).toBeNull()
  })

  it("leaves bare commands and unknown-username cases unchanged", () => {
    expect(normalizeCommandMention("/stop now", "LunaTestBot")).toBe("/stop now")
    expect(normalizeCommandMention("/stop@AnyBot", null)).toBe("/stop@AnyBot")
  })
})

/* -------------------------------------------------------------------------- */
/* Lifecycle-call resilience + final-send cleanup                              */
/* -------------------------------------------------------------------------- */

describe("start(): lifecycle-call resilience", () => {
  it("polling starts even when getMe and setMyCommands die", async () => {
    const { transport: base, calls } = makeFakeTransport()
    const dyingTransport: TelegramHttpTransport = (method, params) =>
      method === "getMe" || method === "setMyCommands"
        ? Effect.die(new Error(`${method} exploded`))
        : base(method, params)

    const adapter = makeTelegramAdapter({ id: "tg-lifecycle-die", httpTransport: dyingTransport })
    adapter.setMessageHandler(() => Effect.void)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    // The poll loop reached getUpdates despite both lifecycle calls dying.
    expect(calls.some((c) => c.method === "getUpdates")).toBe(true)
  })
})

describe("deliver: final cleanup is failure-proof", () => {
  it("drops the turn key even when the final send dies", async () => {
    const { transport: base, calls } = makeFakeTransport()
    let dieOnSend = false
    const flakyTransport: TelegramHttpTransport = (method, params) =>
      method === "editMessageText" && dieOnSend
        ? Effect.die(new Error("network exploded"))
        : base(method, params)

    const adapter = makeTelegramAdapter({ id: "tg-final-die", httpTransport: flakyTransport })
    const target = makeDeliveryTarget("303", "u-die-1")

    // Placeholder creates the edit-routing entry.
    await Effect.runPromise(
      adapter.deliver(target, "…", makeDeliverOpts({ isPartial: true, isFinal: false })),
    )
    // Final edit dies mid-flight (delivery.ts would swallow this).
    dieOnSend = true
    await Effect.runPromise(Effect.exit(adapter.deliver(target, "final", makeDeliverOpts())))
    dieOnSend = false

    // The entry must be gone: a retry on the SAME turn key sends a fresh
    // message instead of editing a stale one. (The dying edit bypasses the
    // recording fake entirely, so no editMessageText call is visible.)
    await Effect.runPromise(adapter.deliver(target, "retry", makeDeliverOpts()))
    const methods = calls.map((c) => c.method)
    expect(methods.filter((m) => m === "sendMessage")).toHaveLength(2) // placeholder + retry
    expect(methods.filter((m) => m === "editMessageText")).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Inbound allowlist (union gate: sender id OR chat id)                        */
/* -------------------------------------------------------------------------- */

describe("inbound allowlist", () => {
  /** Drive one poll of `updates` through an adapter with the given allowlist. */
  const runInbound = async (
    updates: ReturnType<typeof makeTextUpdate>[],
    allowedIds: TelegramAdapterConfig["allowedIds"],
  ): Promise<ChannelMessage[]> => {
    const received: ChannelMessage[] = []
    const { transport } = makeFakeTransport([{ ok: true, result: updates }])
    const adapter = makeTelegramAdapter({
      id: "tg-allow",
      httpTransport: transport,
      ...(allowedIds !== undefined ? { allowedIds } : {}),
    })
    adapter.setMessageHandler((msg) =>
      Effect.sync(() => {
        received.push(msg)
      }),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.scoped(adapter.start()))
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )
    return received
  }

  it("accepts a DM whose sender id is allowlisted, drops other senders in the same batch", async () => {
    const allowed = makeTextUpdate({ fromId: 111, chatId: 111, updateId: 7001, text: "hi" })
    const blocked = makeTextUpdate({ fromId: 222, chatId: 222, updateId: 7002, text: "nope" })
    const received = await runInbound([allowed, blocked], ["111"])
    expect(received.map((m) => m.senderId)).toEqual(["111"])
  })

  it("serves EVERY sender in an allowlisted group (chat id), even senders not in the list", async () => {
    // Group chat -100500 is allowlisted; neither member's user id is listed.
    const memberA = makeTextUpdate({ fromId: 333, chatId: -100500, chatType: "supergroup", updateId: 7101, text: "a" })
    const memberB = makeTextUpdate({ fromId: 444, chatId: -100500, chatType: "supergroup", updateId: 7102, text: "b" })
    const outsider = makeTextUpdate({ fromId: 555, chatId: 555, updateId: 7103, text: "dm" })
    const received = await runInbound([memberA, memberB, outsider], ["-100500"])
    // Both group members served (chat-id match); the unrelated DM is dropped.
    expect(received.map((m) => m.senderId).sort()).toEqual(["333", "444"])
    expect(received.every((m) => m.channelId === "-100500")).toBe(true)
  })

  it("is open (accepts any sender) when allowedIds is omitted", async () => {
    const a = makeTextUpdate({ fromId: 1, chatId: 1, updateId: 7201 })
    const b = makeTextUpdate({ fromId: 2, chatId: 2, updateId: 7202 })
    const received = await runInbound([a, b], undefined)
    expect(received).toHaveLength(2)
  })

  it("is open when allowedIds is empty (fail-open, not fail-closed)", async () => {
    const a = makeTextUpdate({ fromId: 1, chatId: 1, updateId: 7301 })
    const received = await runInbound([a], [])
    expect(received).toHaveLength(1)
  })
})
