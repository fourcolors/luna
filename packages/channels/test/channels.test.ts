/**
 * packages/channels — P1.1 end-to-end proof.
 *
 * Uses a FakeAdapter (in-memory, captures delivered output) and a stub
 * ChatService that emits a scripted ChatFrame stream. Exercises the full
 * path through ChannelService without a real SDK subprocess.
 *
 * Test cases:
 *   1. Session map: inbound message creates a thread; second message from the
 *      same (transport, channelId, threadingKey) reuses it.
 *   2. Dedup: a redelivered platformMessageId is dropped (no second turn).
 *   3. final-only delivery: reply is buffered then delivered (chunked when
 *      reply exceeds maxMessageLength).
 *   4. discrete-chunks delivery: each assistant-done is delivered immediately.
 *   5. Adapter lifecycle: start/stop are called; setMessageHandler is wired.
 *   6. splitToChunks utility: paragraph > sentence > word > hard-cut priority.
 */
import { describe, expect, it } from "vitest"
import {
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
} from "effect"
import { Clock } from "@luna/core"
import { ChatService } from "@luna/chat-service"
import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelMessage,
  DeliveryCapability,
  DeliverOptions,
  DeliveryTarget,
} from "../src/types.js"
import type { ToolStep } from "../src/index.js"
import {
  ChannelSessionStore,
  InboundDedupStore,
  ChannelService,
  ChannelServiceLayer,
  splitToChunks,
  buildStatusLine,
  buildTurnSummary,
  repairSplitFences,
  streamEditThrottleMs,
} from "../src/index.js"
import type { ChatFrame, CreateThreadOptions } from "@luna/chat-service"
import type { ChatMessage, SessionSummary } from "@luna/core"

/* -------------------------------------------------------------------------- */
/* FakeAdapter                                                                 */
/* -------------------------------------------------------------------------- */

interface DeliveredItem {
  readonly target: DeliveryTarget
  readonly content: string
  readonly opts: DeliverOptions
}

/**
 * FakeAdapter: in-memory ChannelAdapter for tests.
 * Captures all `deliver` calls in `deliveries` for assertion.
 */
const makeFakeAdapterClean = (
  id: string,
  capability: DeliveryCapability,
  maxMessageLength = 4096,
) => {
  const deliveries: DeliveredItem[] = []
  let started = false
  let stopped = false
  let handler: ((msg: ChannelMessage) => Effect.Effect<void>) | null = null

  const adapter: ChannelAdapter = {
    id,
    transport: "fake",
    capability,
    maxMessageLength,

    setMessageHandler(cb) {
      handler = cb
    },

    start() {
      return Effect.gen(function* () {
        started = true
        yield* Effect.addFinalizer(() => Effect.sync(() => { stopped = true }))
      }) as Effect.Effect<void, never, import("effect").Scope.Scope>
    },

    stop() {
      stopped = true
      return Effect.void
    },

    deliver(target, content, opts) {
      deliveries.push({ target, content, opts })
      return Effect.void
    },
  }

  return {
    adapter,
    deliveries,
    get started() { return started },
    get stopped() { return stopped },
    fireMessage: (msg: ChannelMessage) => {
      if (handler === null) throw new Error("handler not installed")
      return handler(msg)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Stub ChatService                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A scripted ChatService stub.
 * - createThread: returns a predictable thread id.
 * - send: no-op (returns none).
 * - subscribe: emits the scripted frames from `framesByThread`.
 */
const makeStubChatService = (
  framesByThread: Map<string, ChatFrame[]>,
  threadIdCounter = { n: 0 },
) => {
  const threads = new Map<string, PubSub.PubSub<ChatFrame>>()

  const makeThreadId = () => {
    const id = `thr_test_${(++threadIdCounter.n).toString(16)}`
    return id
  }

  const makeSummary = (id: string, opts?: CreateThreadOptions): SessionSummary => ({
    id,
    parentId: null,
    title: opts?.title ?? null,
    tags: opts?.tags ? [...opts.tags] : [],
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
        const id = opts.threadIdOverride ?? makeThreadId()
        const pub = yield* PubSub.unbounded<ChatFrame>()
        threads.set(id, pub)
        return makeSummary(id, opts)
      }),

    send: (_threadId: string, _text: string) =>
      Effect.succeed(Option.some<ChatMessage>({
        id: `stub-msg-${Math.random().toString(36).slice(2)}`,
        seq: 1,
        ts: Date.now(),
        role: "user",
        text: _text,
        toolUses: [],
        attachments: [],
      })),

    interrupt: (_threadId: string) => Effect.void,

    subscribe: (threadId: string): Stream.Stream<ChatFrame, never> => {
      const scripted = framesByThread.get(threadId) ?? []
      const pub = threads.get(threadId)

      // Emit scripted frames after a brief delay so the subscription is
      // established before frames arrive.
      if (pub !== undefined && scripted.length > 0) {
        // Publish frames asynchronously after subscribe is called
        Effect.runFork(
          Effect.gen(function* () {
            yield* Effect.sleep("10 millis")
            for (const frame of scripted) {
              yield* PubSub.publish(pub, frame)
              yield* Effect.sleep("1 millis")
            }
          }),
        )
      }

      if (pub === undefined) return Stream.empty

      return Stream.unwrap(
        Effect.gen(function* () {
          const sub = yield* PubSub.subscribe(pub)
          return Stream.fromSubscription(sub)
        }),
      )
    },

    listThreads: (_limit?: number) => Effect.succeed([] as ReadonlyArray<SessionSummary>),

    searchMemory: (_args: { queryText: string; topK?: number }) =>
      Effect.succeed({ hits: [] as ReadonlyArray<{ id: string; kind: string; content: string; score: number }> }),

    closeThread: (_threadId: string) => Effect.void,

    setThreadConfig: (_opts: { threadId: string; model?: string }) =>
      Effect.succeed({
        threadId: _opts.threadId,
        applied: [] as ReadonlyArray<"model" | "effort">,
        deferred: [] as ReadonlyArray<"model" | "effort">,
      }),
  }

  return {
    service,
    threads,
  }
}

/* -------------------------------------------------------------------------- */
/* Test helpers                                                                */
/* -------------------------------------------------------------------------- */

const makeTurnCompleteFrame = (threadId: string): ChatFrame => ({
  type: "turn-complete",
  threadId,
})

const makeAssistantDoneFrame = (
  threadId: string,
  text: string,
  seq = 1,
  delivery?: { readonly source: string; readonly label?: string },
): ChatFrame => ({
  type: "assistant-done",
  threadId,
  turnId: "turn-1",
  seq,
  message: {
    id: `msg-${seq}`,
    seq,
    ts: Date.now(),
    role: "assistant",
    text,
    toolUses: [],
    attachments: [],
    ...(delivery !== undefined ? { delivery } : {}),
  },
})

const makeAssistantDeltaFrame = (threadId: string, text: string): ChatFrame => ({
  type: "assistant-delta",
  threadId,
  turnId: "turn-1",
  text,
})

const makeMessage = (
  overrides: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  transport: "fake",
  channelId: "chan-1",
  senderId: "user-1",
  platformMessageId: `pmid-${Math.random().toString(36).slice(2)}`,
  text: "hello luna",
  ts: new Date().toISOString(),
  ...overrides,
})

/* -------------------------------------------------------------------------- */
/* Layer builders                                                              */
/* -------------------------------------------------------------------------- */

const baseLayer = (chatService: ReturnType<typeof makeStubChatService>["service"]) =>
  ChannelServiceLayer.pipe(
    Layer.provide(ChannelSessionStore.Memory),
    Layer.provide(InboundDedupStore.Memory),
    Layer.provide(Layer.succeed(ChatService, chatService as unknown as InstanceType<typeof ChatService>)),
    Layer.provide(Clock.Default),
  )

const run = <A>(
  chatService: ReturnType<typeof makeStubChatService>["service"],
  eff: Effect.Effect<A, unknown, ChannelService>,
) =>
  Effect.runPromise(
    eff.pipe(
      Effect.provide(baseLayer(chatService)),
    ) as Effect.Effect<A, never>,
  )

/* -------------------------------------------------------------------------- */
/* splitToChunks utility                                                       */
/* -------------------------------------------------------------------------- */

describe("splitToChunks", () => {
  it("returns the text as-is when it fits in one chunk", () => {
    expect(splitToChunks("hello", 10)).toEqual(["hello"])
  })

  it("returns [''] for empty input", () => {
    expect(splitToChunks("", 100)).toEqual([""])
  })

  it("splits on paragraph breaks preferentially", () => {
    const text = "first paragraph\n\nsecond paragraph\n\nthird paragraph"
    const chunks = splitToChunks(text, 20)
    // Should split at paragraph boundaries
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join("").replace(/\n\n/g, "\n\n")).toContain("first paragraph")
    expect(chunks.join("")).toContain("second paragraph")
  })

  it("splits on word boundary when no paragraph/sentence boundary fits", () => {
    const text = "one two three four five six seven eight nine ten"
    const chunks = splitToChunks(text, 15)
    // Each chunk must fit in 15 chars
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15)
    }
    // Reassembling should give all words back
    const rejoined = chunks.join(" ").replace(/\s+/g, " ").trim()
    expect(rejoined).toContain("one")
    expect(rejoined).toContain("ten")
  })

  it("hard-cuts very long tokens that have no break points", () => {
    const longToken = "a".repeat(200)
    const chunks = splitToChunks(longToken, 50)
    expect(chunks).toHaveLength(4)
    expect(chunks.every((c) => c.length <= 50)).toBe(true)
    expect(chunks.join("")).toBe(longToken)
  })
})

/* -------------------------------------------------------------------------- */
/* Session map                                                                 */
/* -------------------------------------------------------------------------- */

describe("session map", () => {
  it("creates a thread for a new (transport, channelId, threadingKey) and reuses it", async () => {
    const framesByThread = new Map<string, ChatFrame[]>()
    const { service: chatService } = makeStubChatService(framesByThread)
    let createCount = 0
    const trackedService = {
      ...chatService,
      createThread: (opts: CreateThreadOptions) => {
        createCount++
        return chatService.createThread(opts)
      },
    }

    const { fake } = await run(trackedService, Effect.gen(function* () {
      const svc = yield* ChannelService
      const fake = makeFakeAdapterClean("a1", "final-only")
      yield* svc.registerAdapter(fake.adapter)

      const msg1 = makeMessage({ channelId: "dm-1", threadingKey: "user-42", platformMessageId: "pm-1" })
      const msg2 = makeMessage({ channelId: "dm-1", threadingKey: "user-42", platformMessageId: "pm-2" })

      yield* svc.handleMessage(msg1)
      yield* svc.handleMessage(msg2)

      return { fake, createCount }
    }))

    // createThread should have been called exactly once — same key reuses
    expect(createCount).toBe(1)
    void fake // suppress unused
  })

  it("creates separate threads for different threadingKeys on the same channelId", async () => {
    const framesByThread = new Map<string, ChatFrame[]>()
    const { service: chatService } = makeStubChatService(framesByThread)
    let createCount = 0
    const trackedService = {
      ...chatService,
      createThread: (opts: CreateThreadOptions) => {
        createCount++
        return chatService.createThread(opts)
      },
    }

    await run(trackedService, Effect.gen(function* () {
      const svc = yield* ChannelService
      const fake = makeFakeAdapterClean("a2", "final-only")
      yield* svc.registerAdapter(fake.adapter)

      const msg1 = makeMessage({ channelId: "group-1", threadingKey: "topic-A", platformMessageId: "pm-a1" })
      const msg2 = makeMessage({ channelId: "group-1", threadingKey: "topic-B", platformMessageId: "pm-b1" })

      yield* svc.handleMessage(msg1)
      yield* svc.handleMessage(msg2)
    }))

    expect(createCount).toBe(2)
  })

  it("does not freeze a Telegram group thread to the first sender in thread-level channel metadata", async () => {
    const framesByThread = new Map<string, ChatFrame[]>()
    const { service: chatService } = makeStubChatService(framesByThread)
    const createCalls: CreateThreadOptions[] = []
    const trackedService = {
      ...chatService,
      createThread: (opts: CreateThreadOptions) => {
        createCalls.push(opts)
        return chatService.createThread(opts)
      },
    }

    await run(trackedService, Effect.gen(function* () {
      const svc = yield* ChannelService
      const fake = makeFakeAdapterClean("group-meta", "final-only")
      yield* svc.registerAdapter(fake.adapter)

      yield* svc.handleMessage(makeMessage({
        transport: "telegram",
        channelId: "-100123",
        threadingKey: "-100123",
        senderId: "42",
        platformMessageId: "group-meta-pm-1",
        metadata: {
          chatType: "supergroup",
          userId: 42,
          username: "alice",
          firstName: "Alice",
        },
      }))
    }))

    const createdWith = createCalls[0]
    expect(createdWith).toBeDefined()
    expect(createdWith?.channelMeta).toMatchObject({
      interface: "Telegram",
      chatId: "-100123",
    })
    expect(createdWith?.channelMeta?.userId).toBeUndefined()
    expect(createdWith?.channelMeta?.username).toBeUndefined()
    expect(createdWith?.channelMeta?.firstName).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* Dedup                                                                       */
/* -------------------------------------------------------------------------- */

describe("dedup", () => {
  it("drops a redelivered platformMessageId (no second turn)", async () => {
    const framesByThread = new Map<string, ChatFrame[]>()
    const { service: chatService } = makeStubChatService(framesByThread)
    let sendCount = 0
    const trackedService = {
      ...chatService,
      send: (threadId: string, text: string) => {
        sendCount++
        return chatService.send(threadId, text)
      },
    }

    await run(trackedService, Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(makeFakeAdapterClean("a3", "final-only").adapter)

      const msg = makeMessage({ platformMessageId: "dup-1" })
      const r1 = yield* svc.handleMessage(msg)
      const r2 = yield* svc.handleMessage(msg) // same platformMessageId

      expect(r1).toBe(true)
      expect(r2).toBe(false)
    }))

    // Only one turn should have been offered
    expect(sendCount).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Channel user text                                                           */
/* -------------------------------------------------------------------------- */

describe("channel user text", () => {
  it("prefixes Telegram group messages with the current sender identity", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    let sentText: string | null = null
    const trackedService = {
      ...chatService,
      send: (threadId: string, text: string) => {
        sentText = text
        return chatService.send(threadId, text)
      },
    }

    await run(trackedService, Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(makeFakeAdapterClean("group-text", "final-only").adapter)
      yield* svc.handleMessage(makeMessage({
        transport: "telegram",
        channelId: "-100123",
        threadingKey: "-100123",
        senderId: "42",
        platformMessageId: "group-text-pm-1",
        text: "can you summarize this?",
        metadata: {
          chatType: "group",
          userId: 42,
          username: "alice",
          firstName: "Alice",
        },
      }))
    }))

    expect(sentText).toBe("[telegram user: @alice (id: 42)]\ncan you summarize this?")
  })

  it("leaves Telegram private messages unchanged because the thread metadata identifies the user", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    let sentText: string | null = null
    const trackedService = {
      ...chatService,
      send: (threadId: string, text: string) => {
        sentText = text
        return chatService.send(threadId, text)
      },
    }

    await run(trackedService, Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(makeFakeAdapterClean("private-text", "final-only").adapter)
      yield* svc.handleMessage(makeMessage({
        transport: "telegram",
        channelId: "42",
        threadingKey: "42",
        senderId: "42",
        platformMessageId: "private-text-pm-1",
        text: "hello",
        metadata: {
          chatType: "private",
          userId: 42,
          username: "alice",
          firstName: "Alice",
        },
      }))
    }))

    expect(sentText).toBe("hello")
  })

  it("passes inbound attachments straight through to chat.send", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    let sentAttachments: ReadonlyArray<ChannelAttachment> | undefined
    const trackedService = {
      ...chatService,
      send: (
        threadId: string,
        text: string,
        attachments?: ReadonlyArray<ChannelAttachment>,
      ) => {
        sentAttachments = attachments
        return chatService.send(threadId, text)
      },
    }

    await run(trackedService, Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(makeFakeAdapterClean("attach-passthrough", "final-only").adapter)
      yield* svc.handleMessage(makeMessage({
        transport: "telegram",
        channelId: "42",
        threadingKey: "42",
        senderId: "42",
        platformMessageId: "attach-pm-1",
        text: "please summarize",
        attachments: [{ mediaType: "application/pdf", data: "JVBERi0=" }],
        metadata: { chatType: "private" },
      }))
    }))

    expect(sentAttachments).toEqual([{ mediaType: "application/pdf", data: "JVBERi0=" }])
  })

  it("a command-shaped CAPTION on an attachment goes to the LLM, not the command handler", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    let sentText: string | null = null
    let sentAttachments: ReadonlyArray<ChannelAttachment> | undefined
    const trackedService = {
      ...chatService,
      send: (
        threadId: string,
        text: string,
        attachments?: ReadonlyArray<ChannelAttachment>,
      ) => {
        sentText = text
        sentAttachments = attachments
        return chatService.send(threadId, text)
      },
    }

    await run(trackedService, Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(makeFakeAdapterClean("attach-cmd", "final-only").adapter)
      // A photo captioned "/new": without the attachment guard the built-in
      // command short-circuit would answer "/new" and silently DISCARD the
      // downloaded file — the gaslighting failure this feature exists to kill.
      const result = yield* svc.handleMessage(makeMessage({
        transport: "telegram",
        channelId: "42",
        threadingKey: "42",
        senderId: "42",
        platformMessageId: "attach-cmd-pm-1",
        text: "/new",
        attachments: [{ mediaType: "image/jpeg", data: "AQIDBA==" }],
        metadata: { chatType: "private" },
      }))
      expect(result).toBe(true)
    }))

    // The message reached chat.send WITH its attachment; the caption text
    // rode along as plain user text.
    expect(sentText).toBe("/new")
    expect(sentAttachments).toEqual([{ mediaType: "image/jpeg", data: "AQIDBA==" }])
  })
})

/* -------------------------------------------------------------------------- */
/* Delivery — final-only                                                       */
/* -------------------------------------------------------------------------- */

describe("delivery — final-only", () => {
  it("buffers the full turn and delivers once after turn-complete", async () => {
    // Set up a scripted stream: we need to know the threadId BEFORE scripting,
    // so we use a deferred approach: the stub's createThread records the id,
    // then we inject frames into the pubsub after subscribe.
    const framesByThread = new Map<string, ChatFrame[]>()
    const { service: chatService, threads } = makeStubChatService(framesByThread)

    const fakeCtx = makeFakeAdapterClean("final-1", "final-only", 100)

    // IMPORTANT: use Effect.provide(wholeEffect, layer) so the service scope
    // (captured by Layer.effect via yield* Effect.scope) stays alive for the
    // entire test. yield* Effect.provide(ChannelService, layer) would close the
    // layer scope immediately after tag resolution, interrupting delivery fibers
    // that were forked into serviceScope.
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService

          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "fo-pm-1" })
          yield* svc.handleMessage(msg)

          // Give the service time to create the thread and subscribe the delivery fiber
          yield* Effect.sleep("50 millis")

          // Find the thread that was created and emit frames into its pubsub
          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread created")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub for thread")

          yield* PubSub.publish(pub, makeAssistantDoneFrame(threadId, "Hello from Luna!"))
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))

          // Wait for delivery to process
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // final-only: one delivery with the complete text
    expect(fakeCtx.deliveries.length).toBe(1)
    expect(fakeCtx.deliveries[0]?.content).toBe("Hello from Luna!")
    expect(fakeCtx.deliveries[0]?.opts.isFinal).toBe(true)
  })

  it("splits a long reply across multiple chunks", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("final-chunk", "final-only", 20) // very short limit

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "fo-long-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          // Long text that must split across chunks (limit = 20)
          const longText = "one two three four five six seven eight nine ten eleven twelve"
          yield* PubSub.publish(pub, makeAssistantDoneFrame(threadId, longText))
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // Should have been split into multiple deliveries
    expect(fakeCtx.deliveries.length).toBeGreaterThan(1)
    // Each delivery must fit within maxMessageLength
    for (const d of fakeCtx.deliveries) {
      expect(d.content.length).toBeLessThanOrEqual(20)
    }
    // Last delivery should be final
    expect(fakeCtx.deliveries[fakeCtx.deliveries.length - 1]?.opts.isFinal).toBe(true)
    // Reassembling gives the original text (with possible space differences from chunk splits)
    const reassembled = fakeCtx.deliveries.map((d) => d.content).join(" ").trim()
    expect(reassembled).toContain("one")
    expect(reassembled).toContain("twelve")
  })
})

/* -------------------------------------------------------------------------- */
/* Delivery — discrete-chunks                                                  */
/* -------------------------------------------------------------------------- */

describe("delivery — discrete-chunks", () => {
  it("delivers each assistant-done immediately", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("dc-1", "discrete-chunks", 200)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "dc-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          // Emit two assistant-done frames (multi-step agentic turn)
          yield* PubSub.publish(pub, makeAssistantDoneFrame(threadId, "Step one.", 1))
          yield* Effect.sleep("10 millis")
          yield* PubSub.publish(pub, makeAssistantDoneFrame(threadId, "Step two.", 2))
          yield* Effect.sleep("10 millis")
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // Should have 2 deliveries — one per assistant-done
    expect(fakeCtx.deliveries.length).toBe(2)
    expect(fakeCtx.deliveries[0]?.content).toBe("Step one.")
    expect(fakeCtx.deliveries[1]?.content).toBe("Step two.")
    // Both are final (discrete-chunks marks each delivery as final)
    expect(fakeCtx.deliveries[0]?.opts.isFinal).toBe(true)
    expect(fakeCtx.deliveries[1]?.opts.isFinal).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Adapter lifecycle                                                           */
/* -------------------------------------------------------------------------- */

describe("adapter lifecycle", () => {
  it("setMessageHandler is called during registerAdapter", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    let handlerInstalled = false

    await run(chatService as unknown as ReturnType<typeof makeStubChatService>["service"], Effect.gen(function* () {
      const svc = yield* ChannelService
      const fakeCtx = makeFakeAdapterClean("life-1", "final-only")
      const originalSetHandler = fakeCtx.adapter.setMessageHandler.bind(fakeCtx.adapter)
      let installCalled = false
      // Wrap setMessageHandler to detect installation
      const wrappedAdapter: ChannelAdapter = {
        ...fakeCtx.adapter,
        setMessageHandler: (cb) => {
          installCalled = true
          originalSetHandler(cb)
        },
      }
      yield* svc.registerAdapter(wrappedAdapter)
      handlerInstalled = installCalled
    }))

    expect(handlerInstalled).toBe(true)
  })

  it("adapter finalizer fires when service scope closes (not via stopAdapters)", async () => {
    // This test closes the scope WITHOUT calling stopAdapters() explicitly.
    // The scope-finalizer wired in ChannelServiceLayer (Effect.addFinalizer)
    // must trigger adapter.stop() and the adapter's own start() finalizer.
    //
    // Pattern: Effect.provide(wholeEffect, layer) — the layer scope stays open
    // for the entire inner effect and only closes when the inner effect returns.
    const { service: chatService } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("life-2", "final-only")

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)
          yield* svc.startAdapters()
          // Effect ends here → layer scope closes → finalizer runs stop()
          // WITHOUT any explicit stopAdapters() call from the test.
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // The adapter's stop() flag is set by both the service finalizer (stopAdapters)
    // AND the adapter's own start() finalizer (Effect.addFinalizer in start()).
    expect(fakeCtx.stopped).toBe(true)
  })

  it("start() requires Scope: Effect.scoped satisfies the constraint at runtime", async () => {
    // The ChannelAdapter contract requires start() to accept a Scope.
    // This test verifies the FakeAdapter's start() finalizer actually fires
    // (sets stopped=true) when the scope closes — proving the Scope discipline
    // is not just a type annotation but has real runtime effect.
    const fakeCtx = makeFakeAdapterClean("scope-test", "final-only")

    await Effect.runPromise(
      Effect.scoped(fakeCtx.adapter.start()) as Effect.Effect<void, never>,
    )

    // The finalizer in FakeAdapter.start() sets stopped=true on scope close.
    expect(fakeCtx.stopped).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Stream-edit delivery (smoke test)                                           */
/* -------------------------------------------------------------------------- */

describe("delivery — stream-edit", () => {
  it("sends a placeholder on first delta and finalizes on turn-complete", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    // Small throttle for tests: override via a direct delivery path
    const fakeCtx = makeFakeAdapterClean("se-1", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "se-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          // Emit deltas and a turn-complete
          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, "Hello"))
          yield* Effect.sleep("10 millis")
          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, "Hello world"))
          // assistant-done (stream-edit waits for turn-complete)
          yield* PubSub.publish(pub, makeAssistantDoneFrame(threadId, "Hello world"))
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))

          // Wait long enough for the final edit (turn-complete triggers immediate delivery)
          yield* Effect.sleep("200 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // At minimum: placeholder "…" was delivered on first delta
    // and final content "Hello world" was delivered on turn-complete
    expect(fakeCtx.deliveries.length).toBeGreaterThanOrEqual(1)
    // The first delivery is the placeholder
    expect(fakeCtx.deliveries[0]?.content).toBe("…")
    // The last delivery should contain the final text and be marked final
    const lastDelivery = fakeCtx.deliveries[fakeCtx.deliveries.length - 1]
    expect(lastDelivery?.opts.isFinal).toBe(true)
    expect(lastDelivery?.content).toBe("Hello world")
  })

  // issue #375: deliverResult only emits assistant-done with message.delivery
  it("delivers a background job assistant-done as a standalone final without turn-complete (#375)", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("se-bg-1", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "se-bg-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          // No deltas, no turn-complete - only a deliverResult-shaped frame.
          yield* PubSub.publish(
            pub,
            makeAssistantDoneFrame(threadId, "Job finished: 3 items.", 9, {
              source: "background-job",
              label: "Nightly research",
            }),
          )
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    expect(fakeCtx.deliveries).toHaveLength(1)
    expect(fakeCtx.deliveries[0]?.content).toBe("Job finished: 3 items.")
    expect(fakeCtx.deliveries[0]?.opts.isFinal).toBe(true)
    expect(fakeCtx.deliveries[0]?.opts.standalone).toBe(true)
  })

  it("background delivery does not collapse a concurrent live stream-edit turn (#375)", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("se-bg-live", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "se-bg-live-pm" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          // Live turn starts streaming.
          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, "Live…"))
          yield* Effect.sleep("20 millis")
          // Background job result lands mid-turn.
          yield* PubSub.publish(
            pub,
            makeAssistantDoneFrame(threadId, "Background result.", 2, {
              source: "background-job",
            }),
          )
          yield* Effect.sleep("20 millis")
          // Live turn completes.
          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, "Live reply done."))
          yield* PubSub.publish(pub, makeAssistantDoneFrame(threadId, "Live reply done.", 3))
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("200 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    const contents = fakeCtx.deliveries.map((d) => d.content)
    expect(contents).toContain("Background result.")
    expect(contents.some((c) => c.includes("Live reply done."))).toBe(true)
    const bg = fakeCtx.deliveries.find((d) => d.content === "Background result.")
    expect(bg?.opts.standalone).toBe(true)
    // Live finalization is NOT marked standalone.
    const liveFinal = fakeCtx.deliveries.find(
      (d) => d.content.includes("Live reply done.") && d.opts.isFinal && !d.opts.standalone,
    )
    expect(liveFinal).toBeDefined()
  })
})

describe("delivery — final-only background (#375)", () => {
  it("delivers a background job assistant-done immediately without turn-complete", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("final-bg-1", "final-only", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "final-bg-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(
            pub,
            makeAssistantDoneFrame(threadId, "Final-only job result.", 1, {
              source: "suggested-action",
              label: "Accept research",
            }),
          )
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    expect(fakeCtx.deliveries).toHaveLength(1)
    expect(fakeCtx.deliveries[0]?.content).toBe("Final-only job result.")
    expect(fakeCtx.deliveries[0]?.opts.isFinal).toBe(true)
    expect(fakeCtx.deliveries[0]?.opts.standalone).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Fiber management smoke test                                                 */
/* -------------------------------------------------------------------------- */

describe("delivery fiber management", () => {
  it("a single delivery fiber is spawned per (threadId, adapterId)", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    let createCount = 0
    const trackedService = {
      ...chatService,
      createThread: (opts: CreateThreadOptions) => {
        createCount++
        return chatService.createThread(opts)
      },
    }

    await run(trackedService as unknown as ReturnType<typeof makeStubChatService>["service"], Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(makeFakeAdapterClean("fiber-1", "final-only").adapter)

      // Three messages from same (transport, channelId, threadingKey)
      const base = { channelId: "ch-1", threadingKey: "tk-1" }
      yield* svc.handleMessage(makeMessage({ ...base, platformMessageId: "f-1" }))
      yield* svc.handleMessage(makeMessage({ ...base, platformMessageId: "f-2" }))
      yield* svc.handleMessage(makeMessage({ ...base, platformMessageId: "f-3" }))
    }))

    // One thread was created (session map reuse)
    expect(createCount).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Production path: handler called via Effect.runFork (fire-and-forget)       */
/* -------------------------------------------------------------------------- */

describe("delivery via Effect.runFork (production adapter path)", () => {
  it("reply is delivered even when the inbound handler is fired via Effect.runFork", async () => {
    // This test proves MUST-FIX 1 (forkIn serviceScope).
    //
    // Real adapters call the installed handler fire-and-forget:
    //   adapter.setMessageHandler((msg) => handleMessage(msg).pipe(Effect.asVoid))
    //   ...later inside the polling loop...
    //   Effect.runFork(installedHandler(msg))
    //
    // handleMessage is a closure over the service's captured values (chat,
    // sessionStore, dedupStore, clock, serviceScope). When runFork fires it,
    // the effect runs in a fresh root fiber. That root fiber completes as soon
    // as handleMessage returns — BEFORE the delivery fiber finishes consuming
    // frames from the PubSub.
    //
    // Without forkIn(serviceScope): the delivery fiber is a child of the
    // runFork root, which auto-interrupts it on completion → no reply delivered.
    //
    // With forkIn(serviceScope): the delivery fiber is attached to the long-lived
    // service scope and survives the transient root fiber.
    //
    // Test structure: the service is kept alive via Effect.provide(wholeEffect, layer).
    // We capture the installed handler callback (exactly as a real adapter would),
    // then fire it via Effect.runFork from OUTSIDE the main fiber, wait for the
    // root to finish, then assert the delivery fiber is still alive and processes
    // frames published after the root is done.
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("runfork-1", "final-only", 4096)

    // Capture the installed handler so we can fire it like a real adapter does.
    let installedHandler: ((msg: ChannelMessage) => Effect.Effect<void>) | null = null
    const capturingAdapter: ChannelAdapter = {
      ...fakeCtx.adapter,
      setMessageHandler(cb) {
        installedHandler = cb
        fakeCtx.adapter.setMessageHandler(cb)
      },
    }

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(capturingAdapter)

          // Give the service a moment to be ready.
          yield* Effect.sleep("5 millis")

          if (installedHandler === null) throw new Error("handler not installed")

          // Simulate the production adapter path: fire-and-forget via runFork.
          // The installed handler is a pure Effect<void> closure that captures
          // all service dependencies. It needs no layer — just runFork.
          const msg = makeMessage({ platformMessageId: "runfork-pm-1" })
          const rootFiber = Effect.runFork(installedHandler(msg))

          // Wait for the root fiber to complete. handleMessage returns as soon
          // as the delivery fiber is forked (it does NOT await delivery). So the
          // root fiber finishes almost immediately.
          yield* Fiber.await(rootFiber)

          // At this point the transient runFork root fiber is DONE. If the fix
          // is not applied (Effect.forkChild instead of forkIn(serviceScope)), the
          // delivery fiber was auto-interrupted when the root completed.
          // Give the system a moment to reflect that interruption if it happened.
          yield* Effect.sleep("50 millis")

          // Now emit frames. A non-fixed delivery fiber is already gone; a fixed
          // one is still alive in serviceScope and will consume these frames.
          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread created")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub for thread")

          yield* PubSub.publish(pub, makeAssistantDoneFrame(threadId, "Reply via runFork!"))
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))

          // Wait for the delivery fiber to consume and forward the frames.
          yield* Effect.sleep("150 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // If MUST-FIX 1 is NOT applied, fakeCtx.deliveries is empty because the
    // delivery fiber was interrupted before frames arrived.
    // With the fix, the fiber survived and delivered the reply.
    expect(fakeCtx.deliveries.length).toBeGreaterThanOrEqual(1)
    expect(fakeCtx.deliveries[0]?.content).toBe("Reply via runFork!")
    expect(fakeCtx.deliveries[0]?.opts.isFinal).toBe(true)
  })
})


/* -------------------------------------------------------------------------- */
/* buildStatusLine                                                             */
/* -------------------------------------------------------------------------- */

describe("buildStatusLine", () => {
  const step = (over: Partial<ToolStep> & { toolCallId: string; name: string }): ToolStep => ({
    nested: false,
    status: "active",
    ...over,
  })

  it("returns empty string when there are no steps", () => {
    expect(buildStatusLine([])).toBe("")
  })

  it("shows active tools as spinning indicator", () => {
    const result = buildStatusLine([
      step({ toolCallId: "id1", name: "Read" }),
      step({ toolCallId: "id2", name: "Grep" }),
    ])
    expect(result).toContain("⚙ Read…")
    expect(result).toContain("⚙ Grep…")
  })

  it("shows settled tools with check/cross marks", () => {
    const result = buildStatusLine([
      step({ toolCallId: "id1", name: "Read", status: "ok" }),
      step({ toolCallId: "id2", name: "Write", status: "error" }),
    ])
    expect(result).toContain("✓ Read")
    expect(result).toContain("✗ Write")
  })

  it("keeps steps in invocation order (settled and active interleave)", () => {
    const result = buildStatusLine([
      step({ toolCallId: "id1", name: "Read", status: "ok" }),
      step({ toolCallId: "id2", name: "Grep" }),
      step({ toolCallId: "id3", name: "Write", status: "ok" }),
    ])
    const readIdx = result.indexOf("✓ Read")
    const grepIdx = result.indexOf("⚙ Grep…")
    const writeIdx = result.indexOf("✓ Write")
    expect(readIdx).toBeLessThan(grepIdx)
    expect(grepIdx).toBeLessThan(writeIdx)
  })

  it("labels Agent steps with their description and nests subagent calls", () => {
    const result = buildStatusLine([
      step({ toolCallId: "id1", name: "Agent", detail: "Research lunar cycles" }),
      step({ toolCallId: "id2", name: "Read", nested: true, status: "ok" }),
    ])
    expect(result).toContain("⚙ Agent - Research lunar cycles…")
    expect(result).toContain("✓ ↳ Read")
  })

  it("collapses older steps beyond the visible cap", () => {
    const steps = Array.from({ length: 11 }, (_, i) =>
      step({ toolCallId: `id${i}`, name: `Tool${i}`, status: "ok" }),
    )
    const result = buildStatusLine(steps)
    expect(result).toContain("… +3 earlier steps")
    expect(result).not.toContain("Tool0")
    expect(result).toContain("Tool10")
  })
})

/* -------------------------------------------------------------------------- */
/* buildTurnSummary                                                            */
/* -------------------------------------------------------------------------- */

describe("buildTurnSummary", () => {
  const okStep = (name: string, i: number): ToolStep => ({
    toolCallId: `id${i}`,
    name,
    nested: false,
    status: "ok",
  })

  it("returns empty string for a turn with no tool steps", () => {
    expect(buildTurnSummary([])).toBe("")
  })

  it("renders the Worked-for pill plus each step as expandable-quote lines", () => {
    const result = buildTurnSummary([okStep("Read", 1), okStep("Bash", 2)])
    const lines = result.split("\n")
    expect(lines[0]).toBe(">! ⚙ Worked for 2 steps")
    expect(lines[1]).toBe(">! ✓ Read")
    expect(lines[2]).toBe(">! ✓ Bash")
  })

  it("uses singular wording for a single step", () => {
    expect(buildTurnSummary([okStep("Read", 1)])).toContain("Worked for 1 step\n")
  })
})

/* -------------------------------------------------------------------------- */
/* repairSplitFences                                                           */
/* -------------------------------------------------------------------------- */

describe("repairSplitFences", () => {
  it("leaves chunks without fences untouched", () => {
    expect(repairSplitFences(["hello", "world"])).toEqual(["hello", "world"])
  })

  it("closes an open fence at a chunk boundary and reopens it in the next", () => {
    const chunks = ["intro\n```ts\nconst a = 1", "const b = 2\n```\ndone"]
    const repaired = repairSplitFences(chunks)
    expect(repaired[0]).toBe("intro\n```ts\nconst a = 1\n```")
    expect(repaired[1]).toBe("```\nconst b = 2\n```\ndone")
  })

  it("keeps balanced chunks balanced", () => {
    const chunks = ["```\ncode\n```", "plain"]
    expect(repairSplitFences(chunks)).toEqual(["```\ncode\n```", "plain"])
  })

  it("repairs tilde fences with tilde markers", () => {
    const chunks = ["intro\n~~~\ncode start", "code end\n~~~\ndone"]
    const repaired = repairSplitFences(chunks)
    expect(repaired[0]).toBe("intro\n~~~\ncode start\n~~~")
    expect(repaired[1]).toBe("~~~\ncode end\n~~~\ndone")
  })

  it("treats a backtick line inside a tilde block as content, not a closer", () => {
    // The ``` line is inside an open ~~~ block: still open at the boundary.
    const chunks = ["~~~\nshell\n```\nmore", "end\n~~~"]
    const repaired = repairSplitFences(chunks)
    expect(repaired[0]).toBe("~~~\nshell\n```\nmore\n~~~")
    expect(repaired[1]).toBe("~~~\nend\n~~~")
  })
})

/* -------------------------------------------------------------------------- */
/* subscribeAndDeliver: tool-call/tool-result step indicators                 */
/* -------------------------------------------------------------------------- */

describe("delivery — stream-edit tool step indicators", () => {
  it("delivers status line on tool-call and tool-result frames", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("se-tools-1", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "se-tools-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          // Emit a tool-call frame
          yield* PubSub.publish(pub, {
            type: "tool-call",
            threadId,
            turnId: "t1",
            toolCallId: "tc-1",
            name: "Read",
            input: {},
          } satisfies ChatFrame)
          yield* Effect.sleep("30 millis")

          // Emit a tool-result frame
          yield* PubSub.publish(pub, {
            type: "tool-result",
            threadId,
            toolCallId: "tc-1",
            status: "ok",
            output: "file content",
            truncated: false,
          } satisfies ChatFrame)
          yield* Effect.sleep("30 millis")

          // Emit turn-complete to finalize
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // For stream-edit: at least one deliver call should have been made for tool status
    // The first delivery after tool-call should contain the "⚙ Read…" indicator
    expect(fakeCtx.deliveries.length).toBeGreaterThanOrEqual(1)
    const toolCallDelivery = fakeCtx.deliveries.find((d) => d.content.includes("⚙ Read…"))
    expect(toolCallDelivery).toBeDefined()
  })

  it("throttles follow-up tool status edits after the first status placeholder", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("se-tools-throttle", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "se-tools-throttle-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, {
            type: "tool-call",
            threadId,
            turnId: "t1",
            toolCallId: "tc-1",
            name: "Read",
            input: {},
          } satisfies ChatFrame)
          yield* PubSub.publish(pub, {
            type: "tool-result",
            threadId,
            toolCallId: "tc-1",
            status: "ok",
            output: "file content",
            truncated: false,
          } satisfies ChatFrame)

          yield* Effect.sleep("100 millis")
          expect(fakeCtx.deliveries).toHaveLength(1)
          expect(fakeCtx.deliveries[0]?.content).toContain("⚙ Read…")

          yield* Effect.sleep(`${streamEditThrottleMs + 100} millis`)
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    expect(fakeCtx.deliveries.length).toBeGreaterThanOrEqual(2)
    expect(fakeCtx.deliveries.at(-1)?.content).toContain("✓ Read")
  })

  it("keeps status edits within the adapter max length when the status line is longer than the limit", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("se-tools-long", "stream-edit", 24)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "se-tools-long-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, "current assistant text"))
          yield* Effect.sleep("20 millis")
          yield* PubSub.publish(pub, {
            type: "tool-call",
            threadId,
            turnId: "t1",
            toolCallId: "tc-long",
            name: "ExtremelyLongToolNameThatWouldOverflow",
            input: {},
          } satisfies ChatFrame)
          yield* Effect.sleep(`${streamEditThrottleMs + 100} millis`)
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    expect(fakeCtx.deliveries.every((d) => d.content.length <= 24)).toBe(true)
    expect(fakeCtx.deliveries.at(-1)?.content.startsWith("\n\n")).toBe(false)
    expect(fakeCtx.deliveries.at(-1)?.content.startsWith("xt")).toBe(false)
  })

  it("finalizes a status-only stream-edit turn on turn-complete", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("se-tools-final", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "se-tools-final-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, {
            type: "tool-call",
            threadId,
            turnId: "t1",
            toolCallId: "tc-1",
            name: "Read",
            input: {},
          } satisfies ChatFrame)
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    expect(fakeCtx.deliveries.at(-1)?.opts.isFinal).toBe(true)
  })

  it("delivers error notice on assistant-error frame", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("se-err-1", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "se-err-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          // Emit an assistant-delta first (to set editStarted=true)
          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, "Starting..."))
          yield* Effect.sleep("30 millis")

          // Emit assistant-error
          yield* PubSub.publish(pub, {
            type: "assistant-error",
            threadId,
            turnId: "t1",
            error: { kind: "sdk" as const, message: "model error" },
          } satisfies ChatFrame)
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // Should have delivered an error message
    const errorDelivery = fakeCtx.deliveries.find((d) =>
      d.content.includes("Something went wrong"),
    )
    expect(errorDelivery).toBeDefined()
  })

  it("delivers an assistant-error as final even when no placeholder exists yet", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("se-err-no-placeholder", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)

          const msg = makeMessage({ platformMessageId: "se-err-no-placeholder-pm-1" })
          yield* svc.handleMessage(msg)
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, {
            type: "assistant-error",
            threadId,
            turnId: "t1",
            error: { kind: "sdk" as const, message: "model error" },
          } satisfies ChatFrame)
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    expect(fakeCtx.deliveries).toHaveLength(1)
    expect(fakeCtx.deliveries[0]?.content).toContain("Something went wrong")
    expect(fakeCtx.deliveries[0]?.opts.isPartial).toBe(false)
    expect(fakeCtx.deliveries[0]?.opts.isFinal).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Built-in channel commands                                                   */
/* -------------------------------------------------------------------------- */

describe("channel commands", () => {
  it("/help replies with the command list and never reaches the LLM", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    let sendCount = 0
    let createCount = 0
    const tracked = {
      ...chatService,
      send: (threadId: string, text: string) => {
        sendCount++
        return chatService.send(threadId, text)
      },
      createThread: (opts: CreateThreadOptions) => {
        createCount++
        return chatService.createThread(opts)
      },
    }
    const fakeCtx = makeFakeAdapterClean("cmd-help", "stream-edit")

    await run(tracked as unknown as ReturnType<typeof makeStubChatService>["service"], Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(fakeCtx.adapter)
      const accepted = yield* svc.handleMessage(makeMessage({ text: "/help" }))
      expect(accepted).toBe(true)
    }))

    expect(sendCount).toBe(0)
    expect(createCount).toBe(0)
    expect(fakeCtx.deliveries).toHaveLength(1)
    const reply = fakeCtx.deliveries[0]
    expect(reply?.opts.isFinal).toBe(true)
    expect(reply?.content).toContain("/new")
    expect(reply?.content).toContain("/stop")
    // Double-asterisk = bold through the Telegram converter (single would
    // render italic — regression guard for the greeting's emphasis).
    expect(reply?.content).toContain("**Hi, I'm Luna.**")
  })

  it("/start behaves exactly like /help (Telegram first contact)", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("cmd-start", "stream-edit")

    await run(chatService, Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(fakeCtx.adapter)
      yield* svc.handleMessage(makeMessage({ text: "/start" }))
    }))

    expect(fakeCtx.deliveries).toHaveLength(1)
    expect(fakeCtx.deliveries[0]?.content).toContain("/new")
  })

  it("/new resets the mapping so the next message starts a fresh thread", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    let createCount = 0
    const tracked = {
      ...chatService,
      createThread: (opts: CreateThreadOptions) => {
        createCount++
        return chatService.createThread(opts)
      },
    }
    const fakeCtx = makeFakeAdapterClean("cmd-new", "stream-edit")
    const base = { channelId: "cmd-ch-1", threadingKey: "cmd-ch-1" }

    await run(tracked as unknown as ReturnType<typeof makeStubChatService>["service"], Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(fakeCtx.adapter)
      yield* svc.handleMessage(makeMessage({ ...base, platformMessageId: "n-1", text: "hi" }))
      yield* svc.handleMessage(makeMessage({ ...base, platformMessageId: "n-2", text: "again" }))
      expect(createCount).toBe(1) // same thread reused

      yield* svc.handleMessage(makeMessage({ ...base, platformMessageId: "n-3", text: "/new" }))
      expect(createCount).toBe(1) // command itself creates nothing

      yield* svc.handleMessage(makeMessage({ ...base, platformMessageId: "n-4", text: "fresh" }))
      expect(createCount).toBe(2) // mapping was dropped → fresh thread
    }))

    const newReply = fakeCtx.deliveries.find((d) => d.content.includes("Fresh conversation"))
    expect(newReply).toBeDefined()
  })

  it("/stop interrupts the mapped thread and confirms", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    const interrupted: string[] = []
    const tracked = {
      ...chatService,
      interrupt: (threadId: string) => {
        interrupted.push(threadId)
        return Effect.void
      },
    }
    const fakeCtx = makeFakeAdapterClean("cmd-stop", "stream-edit")
    const base = { channelId: "cmd-ch-2", threadingKey: "cmd-ch-2" }

    await run(tracked as unknown as ReturnType<typeof makeStubChatService>["service"], Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(fakeCtx.adapter)
      yield* svc.handleMessage(makeMessage({ ...base, platformMessageId: "s-1", text: "long task" }))
      yield* svc.handleMessage(makeMessage({ ...base, platformMessageId: "s-2", text: "/stop" }))
    }))

    expect(interrupted).toHaveLength(1)
    const reply = fakeCtx.deliveries.find((d) => d.content.includes("⏹ Stopped."))
    expect(reply).toBeDefined()
  })

  it("/stop without a mapped thread reports nothing to stop", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    const interrupted: string[] = []
    const tracked = {
      ...chatService,
      interrupt: (threadId: string) => {
        interrupted.push(threadId)
        return Effect.void
      },
    }
    const fakeCtx = makeFakeAdapterClean("cmd-stop-idle", "stream-edit")

    await run(tracked as unknown as ReturnType<typeof makeStubChatService>["service"], Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(fakeCtx.adapter)
      yield* svc.handleMessage(makeMessage({ channelId: "cmd-ch-3", text: "/stop" }))
    }))

    expect(interrupted).toHaveLength(0)
    expect(fakeCtx.deliveries[0]?.content).toContain("Nothing is running")
  })

  it("unknown slash commands fall through to the LLM (skills path)", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    const sent: string[] = []
    const tracked = {
      ...chatService,
      send: (threadId: string, text: string) => {
        sent.push(text)
        return chatService.send(threadId, text)
      },
    }
    const fakeCtx = makeFakeAdapterClean("cmd-unknown", "stream-edit")

    await run(tracked as unknown as ReturnType<typeof makeStubChatService>["service"], Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(fakeCtx.adapter)
      yield* svc.handleMessage(makeMessage({ text: "/remind me in an hour" }))
    }))

    expect(sent).toEqual(["/remind me in an hour"])
    expect(fakeCtx.deliveries).toHaveLength(0) // no command reply
  })

  it("command replies go only to adapters of the same transport", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("cmd-same", "stream-edit")
    const otherCtx = makeFakeAdapterClean("cmd-other", "stream-edit")
    const otherAdapter: ChannelAdapter = { ...otherCtx.adapter, transport: "other" }

    await run(chatService, Effect.gen(function* () {
      const svc = yield* ChannelService
      yield* svc.registerAdapter(fakeCtx.adapter)
      yield* svc.registerAdapter(otherAdapter)
      yield* svc.handleMessage(makeMessage({ text: "/help" })) // transport "fake"
    }))

    expect(fakeCtx.deliveries).toHaveLength(1)
    expect(otherCtx.deliveries).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Stream-edit finalization: turn summary, interrupts, long answers            */
/* -------------------------------------------------------------------------- */

describe("delivery — stream-edit finalization", () => {
  it("prepends the collapsed step summary to the final text after tool steps", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("fin-summary", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)
          yield* svc.handleMessage(makeMessage({ platformMessageId: "fin-pm-1" }))
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, {
            type: "tool-call",
            threadId,
            turnId: "t1",
            toolCallId: "tc-fin-1",
            name: "Read",
            input: {},
          } satisfies ChatFrame)
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, {
            type: "tool-result",
            threadId,
            toolCallId: "tc-fin-1",
            status: "ok",
            output: "content",
            truncated: false,
          } satisfies ChatFrame)
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, "The answer."))
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("150 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    const last = fakeCtx.deliveries[fakeCtx.deliveries.length - 1]
    expect(last?.opts.isFinal).toBe(true)
    expect(last?.content).toBe(">! ⚙ Worked for 1 step\n>! ✓ Read\n\nThe answer.")
  })

  it("labels Agent steps with their description in the live status", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("fin-agent", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)
          yield* svc.handleMessage(makeMessage({ platformMessageId: "fin-pm-2" }))
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, {
            type: "tool-call",
            threadId,
            turnId: "t1",
            toolCallId: "tc-agent-1",
            name: "Agent",
            input: { description: "Research lunar cycles", subagent_type: "Explore" },
          } satisfies ChatFrame)
          yield* Effect.sleep("60 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    const status = fakeCtx.deliveries.find((d) =>
      d.content.includes("⚙ Agent - Research lunar cycles…"),
    )
    expect(status).toBeDefined()
    expect(status?.content).toContain("⏳ Working on it…")
  })

  it("finalizes an interrupted turn as Stopped, preserving partial text", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("fin-stop", "stream-edit", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)
          yield* svc.handleMessage(makeMessage({ platformMessageId: "fin-pm-3" }))
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, "Halfway there"))
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, {
            type: "assistant-error",
            threadId,
            turnId: "t1",
            error: { kind: "interrupted", message: "user interrupted" },
          } satisfies ChatFrame)
          yield* Effect.sleep("100 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    const last = fakeCtx.deliveries[fakeCtx.deliveries.length - 1]
    expect(last?.opts.isFinal).toBe(true)
    expect(last?.content).toBe("Halfway there\n\n⏹ Stopped.")
  })

  it("splits a long final answer into follow-up chunks instead of truncating", async () => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    // Tiny limit so the final text needs three chunks.
    const fakeCtx = makeFakeAdapterClean("fin-long", "stream-edit", 40)

    const longText = [
      "First paragraph with some words.",
      "Second paragraph, also present.",
      "Third paragraph closes it out.",
    ].join("\n\n")

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)
          yield* svc.handleMessage(makeMessage({ platformMessageId: "fin-pm-4" }))
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, longText))
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("150 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    const finals = fakeCtx.deliveries.filter((d) => !d.opts.isPartial)
    expect(finals.length).toBeGreaterThanOrEqual(3)
    // Every chunk respects the limit; only the last is isFinal.
    for (const f of finals) expect(f.content.length).toBeLessThanOrEqual(40)
    expect(finals[finals.length - 1]?.opts.isFinal).toBe(true)
    expect(finals.slice(0, -1).every((f) => !f.opts.isFinal)).toBe(true)
    // The full text survives across chunks.
    expect(finals.map((f) => f.content).join(" ")).toContain("Third paragraph")
  })
})

/* -------------------------------------------------------------------------- */
/* Dedup ordering: markSeen deferred until send returns Option.some            */
/* -------------------------------------------------------------------------- */

describe("dedup ordering (markSeen deferred)", () => {
  it("when send returns Option.none, seenBefore stays false so the adapter can redeliver", async () => {
    // Stub that returns Option.none for sends — simulates a Case C (unknown thread)
    // or any other scenario where send drops the message.
    const { service: chatService } = makeStubChatService(new Map())
    const rejectionService = {
      ...chatService,
      send: (_threadId: string, _text: string) =>
        Effect.succeed(Option.none<import("@luna/core").ChatMessage>()),
    }

    let secondCallResult: boolean | null = null

    await run(
      rejectionService as unknown as ReturnType<typeof makeStubChatService>["service"],
      Effect.gen(function* () {
        const svc = yield* ChannelService
        yield* svc.registerAdapter(makeFakeAdapterClean("dedup-none-1", "final-only").adapter)

        const msg = makeMessage({ platformMessageId: "dedup-none-pm-1" })

        // First call: send returns none → should NOT mark seen
        yield* svc.handleMessage(msg)

        // Second call with same platformMessageId:
        // If markSeen was NOT called on the first (as expected), this should NOT be filtered as a dup.
        const r2 = yield* svc.handleMessage(msg)
        secondCallResult = r2
      }),
    )

    // The second call was allowed through (not treated as a dup) because
    // the first send() returning none means we did not mark it seen.
    expect(secondCallResult).toBe(true)
  })

  it("when send returns Option.some, seenBefore is true on the next call (normal dedup)", async () => {
    const { service: chatService } = makeStubChatService(new Map())
    // Default stub already returns Option.some after our fix

    let sendCount = 0
    const trackedService = {
      ...chatService,
      send: (threadId: string, text: string) => {
        sendCount++
        return chatService.send(threadId, text)
      },
    }

    await run(
      trackedService as unknown as ReturnType<typeof makeStubChatService>["service"],
      Effect.gen(function* () {
        const svc = yield* ChannelService
        yield* svc.registerAdapter(makeFakeAdapterClean("dedup-some-1", "final-only").adapter)

        const msg = makeMessage({ platformMessageId: "dedup-some-pm-1" })

        const r1 = yield* svc.handleMessage(msg)
        const r2 = yield* svc.handleMessage(msg) // same platformMessageId

        expect(r1).toBe(true)
        expect(r2).toBe(false) // correctly deduped because first send returned some
      }),
    )

    // Only one send() call — the second message was deduped before send
    expect(sendCount).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* startAdapters idempotency                                                   */
/* -------------------------------------------------------------------------- */

describe("startAdapters idempotency", () => {
  /**
   * Wrap a stock fake adapter so start() calls are COUNTED. makeFakeAdapterClean
   * only records a boolean, which cannot tell "started" from "started twice" —
   * precisely the distinction under test. Wrapping (rather than hand-rolling a
   * second ChannelAdapter) keeps deliver/stop/setMessageHandler on the real
   * implementations, so this test cannot drift from the contract.
   */
  const wrapCounting = (base: ChannelAdapter) => {
    const state = { starts: 0 }
    const adapter: ChannelAdapter = {
      ...base,
      start() {
        state.starts += 1
        return base.start()
      },
    }
    return { adapter, state }
  }

  it("a second startAdapters() does not re-fork an already-started adapter", async () => {
    // chat-server registers telegram and discord in SEPARATE blocks, and each
    // block calls startAdapters(). Without the started-id guard in the service,
    // the second call re-forks every adapter the first call already started.
    // For a real bot that is two gateway connections on one token: Telegram
    // 409-flaps between competing long-polls, Discord drops the duplicate
    // session. Both fail silently from the operator's point of view.
    const { service: chatService } = makeStubChatService(new Map())
    const a = wrapCounting(makeFakeAdapterClean("idem-a", "final-only").adapter)
    const b = wrapCounting(makeFakeAdapterClean("idem-b", "final-only").adapter)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(a.adapter)
          yield* svc.startAdapters() // telegram-style first call
          yield* svc.registerAdapter(b.adapter)
          yield* svc.startAdapters() // discord-style second call
          // start() is forked into the service scope; give those fibers a turn
          // so a double-fork would actually be observable rather than pending.
          yield* Effect.sleep("50 millis")
        }),
        baseLayer(
          chatService as unknown as ReturnType<typeof makeStubChatService>["service"],
        ),
      ) as Effect.Effect<void, never>,
    )

    // Before the guard, `a` started twice (registered before both calls).
    expect(a.state.starts).toBe(1)
    expect(b.state.starts).toBe(1)
  })

  it("an adapter registered after the first start still starts on the next call", async () => {
    // The guard must skip only adapters ALREADY started. A late registration
    // (exactly what the discord block is) must still get its start() forked,
    // otherwise the fix would trade a double-start for a never-start.
    const { service: chatService } = makeStubChatService(new Map())
    const late = wrapCounting(makeFakeAdapterClean("idem-late", "final-only").adapter)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.startAdapters() // nothing registered yet
          yield* svc.registerAdapter(late.adapter)
          yield* svc.startAdapters()
          yield* Effect.sleep("50 millis")
        }),
        baseLayer(
          chatService as unknown as ReturnType<typeof makeStubChatService>["service"],
        ),
      ) as Effect.Effect<void, never>,
    )

    expect(late.state.starts).toBe(1)
  })

  it("an adapter stopped via stopAdapters() is re-forked by the next startAdapters()", async () => {
    // The guard must mean "currently started", not "ever started".
    // stopAdapters() stops every registered adapter, so a following
    // startAdapters() must fork start() again — without clearing
    // startedAdapterIds in stopAdapters the restart is a silent no-op: the
    // adapter stays fully dead with no error and no log line. (Task #8's
    // service-layer landmine; it fires BEFORE the telegram typingSwept flag
    // can even matter.)
    //
    // The double-start pin above ("a second startAdapters() does not re-fork
    // an already-started adapter") is deliberately UNCHANGED by this: it
    // never stops between its two calls, so the no-double-fork property and
    // this restart property pin two DIFFERENT transitions of the same guard.
    const { service: chatService } = makeStubChatService(new Map())
    const a = wrapCounting(makeFakeAdapterClean("idem-restart", "final-only").adapter)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(a.adapter)
          yield* svc.startAdapters()
          yield* Effect.sleep("50 millis")

          yield* svc.stopAdapters()
          yield* svc.startAdapters()
          yield* Effect.sleep("50 millis")
        }),
        baseLayer(
          chatService as unknown as ReturnType<typeof makeStubChatService>["service"],
        ),
      ) as Effect.Effect<void, never>,
    )

    // "Started, stopped, started" must re-fork; "started twice without
    // stopping" (the pin above) must not. Exactly 2, not ≥2: a restart that
    // double-forks would recreate the 409-flapping the guard exists to stop.
    expect(a.state.starts).toBe(2)
  })
})

/* -------------------------------------------------------------------------- */
/* Transport fan-out — delivery fibers                                         */
/* -------------------------------------------------------------------------- */

/**
 * REGRESSION RAIL. The behavior under test is ALREADY CORRECT on this branch:
 * the delivery fan-out loop in service.ts skips adapters whose transport does
 * not match the inbound message. This block is therefore GREEN on arrival BY
 * DESIGN — it is a rail that must fail loudly if the guard is ever dropped, not
 * a red-green cycle. Its load-bearingness is proven by mutation: comment out
 * `if (adapter.transport !== msg.transport) continue` in the delivery fan-out
 * loop of packages/channels/src/service.ts and this test fails.
 *
 * OUT OF SCOPE — do NOT modify, in this scenario, any of:
 *   - packages/channels/src/service.ts (the delivery-fan-out filter is already
 *     correct; its command-reply twin is covered by "command replies go only to
 *     adapters of the same transport", above)
 *   - packages/channels/src/delivery.ts
 *   - packages/channels/src/adapters/*
 *   - anything else under packages/channels/src/
 *   - the startAdapters double-start guard or the "startAdapters idempotency"
 *     tests directly above (fixed in 654b2a8a)
 */
describe("transport fan-out", () => {
  it("delivery fiber forks only for the owning transport", async () => {
    // GIVEN a channels service with BOTH a discord adapter and a telegram
    //       adapter registered,
    // WHEN  one inbound message whose transport is "discord" is dispatched and
    //       its thread emits a completed reply turn,
    // THEN  the telegram adapter's deliver is never called, exactly one
    //       delivery fiber is forked, and the discord adapter receives the
    //       reply addressed to the discord transport.
    //
    // Real-world stake: boot registers telegram AND discord against one
    // service. Without the guard, every registered adapter forks a delivery
    // fiber for every turn, so a Discord turn is also pushed at Telegram using
    // a foreign channel id — silently failing on every message.
    const { service: stubChat, threads } = makeStubChatService(new Map())

    // Delivery fibers are counted through their one-per-fiber chat.subscribe()
    // call: subscribeAndDeliver subscribes exactly once per forked fiber, so
    // an unfiltered fan-out over N adapters shows up as N subscriptions.
    let subscribeCalls = 0
    const chatService = {
      ...stubChat,
      subscribe: (threadId: string) => {
        subscribeCalls++
        return stubChat.subscribe(threadId)
      },
    }

    // Both fakes come from this suite's existing helper; only the id and the
    // transport differ. Nothing is hand-rolled, so this rail cannot drift away
    // from the real ChannelAdapter contract — and because the two fakes are
    // otherwise identical, the discord fake delivering proves the telegram
    // fake's zero deliveries mean "filtered out", not "helper wired wrong".
    const discordCtx = makeFakeAdapterClean("fanout-discord", "final-only", 4096)
    const telegramCtx = makeFakeAdapterClean("fanout-telegram", "final-only", 4096)
    const discordAdapter: ChannelAdapter = { ...discordCtx.adapter, transport: "discord" }
    const telegramAdapter: ChannelAdapter = { ...telegramCtx.adapter, transport: "telegram" }

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(discordAdapter)
          yield* svc.registerAdapter(telegramAdapter)

          yield* svc.handleMessage(
            makeMessage({
              transport: "discord",
              channelId: "guild-chan-1",
              senderId: "user-42",
              platformMessageId: "fanout-pm-1",
              text: "who delivers this turn?",
            }),
          )

          // Let the thread be created and the delivery fiber(s) subscribe.
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread created")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub for thread")

          yield* PubSub.publish(pub, makeAssistantDoneFrame(threadId, "Owning transport only."))
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))

          // Wait for the delivery fiber(s) to consume and forward the frames.
          yield* Effect.sleep("150 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // 1. The foreign transport never sees the turn.
    expect(telegramCtx.deliveries).toHaveLength(0)

    // 2. Exactly one delivery fiber was forked for this turn — the owner's.
    expect(subscribeCalls).toBe(1)

    // 3. The owning transport DID receive the reply. Without this, assertion 1
    //    could pass vacuously on a service that delivers to nobody at all.
    expect(discordCtx.deliveries).toHaveLength(1)
    expect(discordCtx.deliveries[0]?.content).toBe("Owning transport only.")
    expect(discordCtx.deliveries[0]?.opts.isFinal).toBe(true)

    // 4. ...addressed to the discord transport, not to a foreign id.
    expect(discordCtx.deliveries[0]?.target.address.transport).toBe("discord")
    expect(discordCtx.deliveries[0]?.target.inReplyTo.transport).toBe("discord")

    // 5. ...and to the ORIGINATING channel. The transport assertions above pin
    //    "which adapter", but this rail's stated stake is "a foreign channel
    //    id", and a reply that reaches the right adapter in the WRONG channel is
    //    a disclosure, not a routing nit: the delivery target is built once from
    //    the FIRST inbound of a thread (service.ts:236-248) and then reused for
    //    every later turn, so a mis-built address leaks quietly and forever.
    expect(discordCtx.deliveries[0]?.target.address.channelId).toBe("guild-chan-1")
    expect(discordCtx.deliveries[0]?.target.inReplyTo.channelId).toBe("guild-chan-1")
  })
})
