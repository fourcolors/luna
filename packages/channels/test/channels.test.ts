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
import { describe, expect, it, vi } from "vitest"
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

      return Stream.unwrapScoped(
        Effect.gen(function* () {
          const queue = yield* PubSub.subscribe(pub)
          return Stream.fromQueue(queue)
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
    // (captured by Layer.scoped via yield* Effect.scope) stays alive for the
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
          // is not applied (Effect.fork instead of forkIn(serviceScope)), the
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
    // Slice 2 (PRE-AUTHORISED EDIT, the ONLY change to a pre-existing assertion
    // in this slice): this previously asserted a BARE "```" reopen, which froze
    // Defect 1 into a green test. The continuation must carry the info string.
    expect(repaired[1]).toBe("```ts\nconst b = 2\n```\ndone")
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

  /* ------------------------------------------------------------------------ */
  /* Slice 2 — fence-repair hardening (D1 info string, D3 info-string closer)  */
  /*                                                                          */
  /* SCOPE GUARD for this slice. Implementation is confined to:               */
  /*     packages/channels/src/delivery.ts                                    */
  /* Pong MUST NOT touch, in this slice:                                       */
  /*     packages/channels/src/service.ts                                      */
  /*     packages/channels/src/adapters/*.ts                                   */
  /*     packages/channels/src/types.ts                                        */
  /*     packages/channels/src/index.ts  (both functions are already exported)  */
  /*     any other package or app in the monorepo                              */
  /* splitToChunks (delivery.ts:64) must stay FENCE-BLIND: repair happens       */
  /* afterwards. Making the splitter fence-aware is out of scope and a FAIL.    */
  /* delivery.ts is SHARED WITH TELEGRAM: telegram-format.test.ts and           */
  /* telegram-adapter.test.ts must stay green.                                  */
  /*                                                                          */
  /* Exactly ONE pre-existing assertion changes in this slice, and it is       */
  /* pre-authorised: the reopen assertion in "closes an open fence at a chunk  */
  /* boundary and reopens it in the next" above. Any other edit or deletion    */
  /* of a pre-existing assertion is spec-tampering.                            */
  /* ------------------------------------------------------------------------ */

  // Scenario 1 — D1: the language tag survives the boundary.
  it("reopens a split ```typescript block with its language tag", () => {
    const chunks = ["intro\n```typescript\nconst a: number = 1", "const b = 2\n```\ndone"]
    const repaired = repairSplitFences(chunks)
    expect(repaired[0]).toBe("intro\n```typescript\nconst a: number = 1\n```")
    expect(repaired[1]).toBe("```typescript\nconst b = 2\n```\ndone")
  })

  // Scenario 1 — D1, full info string (not just the first word), and the
  // INSERTED CLOSER stays BARE: per CommonMark a closing fence may not carry
  // an info string, so only the REOPEN echoes it.
  it("carries the full info string on reopen and closes with a bare marker", () => {
    const chunks = [
      "intro\n```typescript title=example.ts\nconst a = 1",
      "const b = 2\n```\ndone",
    ]
    const repaired = repairSplitFences(chunks)
    expect(repaired[0]).toBe("intro\n```typescript title=example.ts\nconst a = 1\n```")
    expect(repaired[1]).toBe("```typescript title=example.ts\nconst b = 2\n```\ndone")
    expect(repaired[0]?.endsWith("\n```")).toBe(true)
  })

  // Scenario 2 — D1 for tilde fences.
  it("reopens a split ~~~ block with its info string", () => {
    const chunks = ["intro\n~~~python\nx = 1", "y = 2\n~~~\ndone"]
    const repaired = repairSplitFences(chunks)
    expect(repaired[0]).toBe("intro\n~~~python\nx = 1\n~~~")
    expect(repaired[1]).toBe("~~~python\ny = 2\n~~~\ndone")
  })

  // Scenario 4 — D3: same idea as the ~~~/``` isolation test above, for the
  // info-string case. A ```json line INSIDE an open ``` block is CONTENT (a
  // closing fence may not carry an info string), so the block is still open at
  // the end of the chunk and must be closed and reopened.
  it("treats an info-string fence line inside an open block as content, not a closer", () => {
    const chunks = ["a\n```ts\nx", "y\n```json\nz"]
    const repaired = repairSplitFences(chunks)
    expect(repaired[0]).toBe("a\n```ts\nx\n```")
    expect(repaired[1]).toBe("```ts\ny\n```json\nz\n```")
  })

  // Scenario 4 — the other half: a BARE marker does close the block, so a
  // balanced chunk that merely contains an info-string line stays untouched.
  it("closes an open block only on a bare marker line", () => {
    const chunks = ["```ts\na\n```json\nb\n```", "tail"]
    expect(repairSplitFences(chunks)).toEqual(["```ts\na\n```json\nb\n```", "tail"])
  })

  // Scenario 6 — boundary lands exactly ON the opening fence line.
  it("does not corrupt a boundary landing exactly on the opening fence line", () => {
    const chunks = ["intro\n```ts", "const a = 1\n```\ndone"]
    const repaired = repairSplitFences(chunks)
    expect(repaired[0]).toBe("intro\n```ts\n```")
    expect(repaired[1]).toBe("```ts\nconst a = 1\n```\ndone")
  })

  // Scenario 6 — boundary lands exactly ON the closing fence line. The
  // reopened-then-immediately-closed empty block is ACCEPTABLE output (it
  // renders as an empty code block, not as corruption). Do NOT special-case
  // it away; the contract is "every chunk parses as complete markdown".
  it("does not corrupt a boundary landing exactly on the closing fence line", () => {
    const chunks = ["intro\n```ts\nconst a = 1", "```\ndone"]
    const repaired = repairSplitFences(chunks)
    expect(repaired[0]).toBe("intro\n```ts\nconst a = 1\n```")
    expect(repaired[1]).toBe("```ts\n```\ndone")
  })
})

/* -------------------------------------------------------------------------- */
/* Slice 2 — fence repair must stay inside the platform's message budget       */
/*                                                                            */
/* THE COUPLING TEST. delivery.ts computes the split budget as                 */
/* `Math.max(1, maxLen - 8)`; that 8 is exactly 4 ("\n```") + 4 ("```\n") for  */
/* BARE markers. The moment D1 lands and the reopen carries an info string,    */
/* "```typescript title=…\n" alone is far more than 4 chars, so a repaired     */
/* chunk overflows maxMessageLength — on Discord (2000) that is a rejected or  */
/* truncated message. This test therefore goes RED if D1 is fixed and the      */
/* headroom is not. The headroom must be DERIVED from the longest reopen +     */
/* close actually needed for the text; a bigger magic constant is a FAIL       */
/* (the chunk-count bound below is what catches an oversized constant).        */
/* -------------------------------------------------------------------------- */

describe("delivery — fence repair budget", () => {
  it("keeps every repaired chunk within maxMessageLength for a long info string", async () => {
    const MAX = 120
    const TAG = "typescript title=fence-budget-example.ts"
    const CODE = [
      "export const alpha = (n: number): number => n * 2",
      "export const beta = (n: number): number => n + 41",
      "export const gamma = (n: number): number => n - 7",
      "export const delta = (n: number): number => n / 3",
    ].join("\n")
    const TEXT = `Here is the code you asked for.\n\`\`\`${TAG}\n${CODE}\n\`\`\`\nThat is all of it.`

    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("fence-budget", "stream-edit", MAX)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)
          yield* svc.handleMessage(makeMessage({ platformMessageId: "fence-budget-pm-1" }))
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, TEXT))
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("200 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // The finalized chunks are the non-partial deliveries; live stream edits
    // are isPartial: true and are not what this test is about.
    const finals = fakeCtx.deliveries.filter((d) => d.opts.isPartial === false)

    // The repair path is actually exercised (text > maxLen, so it splits).
    expect(finals.length).toBeGreaterThan(1)
    // Headroom is DERIVED, not "reserve a huge constant": an oversized reserve
    // collapses the budget and shatters the answer into many tiny messages.
    expect(finals.length).toBeLessThanOrEqual(8)

    // D2: nothing may exceed the platform limit, info string included.
    for (const d of finals) {
      expect(d.content.length).toBeLessThanOrEqual(MAX)
    }

    // D1 at the call site: every continuation chunk that reopens the block
    // carries the FULL info string, not a bare marker.
    const reopened = finals.slice(1).filter((d) => d.content.startsWith("```"))
    expect(reopened.length).toBeGreaterThan(0)
    for (const d of reopened) {
      expect(d.content.startsWith("```" + TAG + "\n")).toBe(true)
    }

    expect(finals[finals.length - 1]?.opts.isFinal).toBe(true)
  })

  /* ------------------------------------------------------------------------ */
  /* Slice 2b — THE SHATTERING WINDOW (added by pp-ping 2026-08-05)            */
  /*                                                                          */
  /* Slice 2 landed the derived reserve plus a degenerate-case guard. The      */
  /* guard's DOC COMMENT states the right predicate ("when the reserve does    */
  /* not leave a USABLE BODY, fall back to the bare-marker minimum"); the CODE */
  /* implements a weaker one (`reserve < maxLen`), i.e. it only falls back     */
  /* when the reserve exceeds the ENTIRE message budget. Doc and code          */
  /* disagree, and the code is the wrong one.                                  */
  /*                                                                          */
  /* Strictly BELOW that threshold there is a window where the guard stays     */
  /* inactive and the split limit collapses toward 1. Because splitToChunks is */
  /* fence-blind, prose that merely MENTIONS ``` mid-sentence inside one very  */
  /* long line drives the reserve arbitrarily high, so one ordinary answer is  */
  /* delivered as hundreds of tiny Discord messages. Note the guard, WHEN IT   */
  /* FIRES, produces the sane result — the bug is only that it fires too late. */
  /*                                                                          */
  /* Why the test above cannot see this: in the shattering window NO chunk     */
  /* exceeds the limit (they are all tiny), and its 40-char tag is nowhere     */
  /* near the window. Green gate, real defect.                                 */
  /*                                                                          */
  /* SCOPE GUARD for Slice 2b. Implementation is confined to:                  */
  /*     packages/channels/src/delivery.ts                                     */
  /* Pong MUST NOT touch, in this micro-cycle:                                 */
  /*     packages/channels/src/service.ts                                      */
  /*     packages/channels/src/adapters/*.ts                                   */
  /*     packages/channels/src/types.ts                                        */
  /*     packages/channels/src/index.ts                                        */
  /*     any test file (this one included)                                     */
  /*     any other package or app in the monorepo                              */
  /* splitToChunks must STILL stay fence-blind. No pre-existing assertion may  */
  /* be weakened, edited, renamed or deleted — the Slice 2 pre-authorisation   */
  /* was spent and does not extend to this micro-cycle.                        */
  /*                                                                          */
  /* This test pins the OBSERVABLE property (a bounded number of messages),    */
  /* NOT a formula. Any predicate that treats "the reserve leaves no usable    */
  /* body" as the fallback condition satisfies it; the fraction is pong's.     */
  /* ------------------------------------------------------------------------ */
  it("does not shatter one answer into many tiny messages when prose mentions a fence mid-line", async () => {
    // Discord's real limit. The defect is only interesting at production scale.
    const MAX = 2000

    // A single physical line that MENTIONS ``` in passing and then keeps going.
    // The derived reserve is 3 (marker) + PAD (the rest of the line, which the
    // reserve treats as a possible info string) + 1 + 1 + 3.
    //   PAD_LEN = 1980  =>  reserve ~= 1988, which is still < MAX = 2000,
    // so today's `reserve < maxLen` guard does NOT fire and the split limit
    // collapses to ~12 characters.
    const PAD_LEN = 1980
    const PAD =
      "which is the shape a long single-line explanation takes when the model never breaks the paragraph, "
        .repeat(30)
        .slice(0, PAD_LEN)
    const CODE = [
      "export const alpha = (n: number): number => n * 2",
      "export const beta = (n: number): number => n + 41",
      "export const gamma = (n: number): number => n - 7",
      "export const delta = (n: number): number => n / 3",
      "export const epsilon = (n: number): number => n % 5",
    ].join("\n")
    const TEXT = [
      "Here is how the delivery path behaves end to end.",
      "",
      "One caveat before the code: a fenced block opens with ``` " + PAD,
      "",
      "```typescript",
      CODE,
      "```",
      "",
      "That is the whole answer.",
    ].join("\n")

    // Preconditions, so neither assertion below can pass vacuously.
    expect(TEXT.length).toBeGreaterThan(MAX)
    expect(TEXT.includes("```")).toBe(true)

    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean("fence-shatter", "stream-edit", MAX)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)
          yield* svc.handleMessage(makeMessage({ platformMessageId: "fence-shatter-pm-1" }))
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, TEXT))
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("200 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    const finals = fakeCtx.deliveries.filter((d) => d.opts.isPartial === false)

    // The split path is actually exercised (GREEN today and after the fix).
    expect(finals.length).toBeGreaterThan(1)

    // THE BOUND, from arithmetic — not a round number picked by feel.
    // Whatever predicate replaces `reserve < maxLen`, a reserve may only be
    // honoured if it leaves a usable body. Take "usable" at its most permissive
    // defensible value: HALF the platform budget, i.e. an effective split limit
    // of at least MAX / 2 = 1000. splitToChunks packs greedily up to the limit,
    // so the answer needs at least
    //     ceil(TEXT.length / (MAX / 2)) = ceil(2387 / 1000) = 3
    // messages, plus 2 of slack, because a chunk ends at the last paragraph /
    // sentence break inside the window (so it can fall short of the limit) and
    // because repair may prepend a reopen line. Bound = 5.
    // Measured with the real splitToChunks + repairSplitFences on this exact
    // TEXT at MAX = 2000:
    //     limit 1992 (bare-marker fallback)          ->   3 chunks, 0 over MAX
    //     limit 1000 (worst still-defensible limit)  ->   4 chunks, 0 over MAX
    //     limit   12 (today: guard inactive)         -> 269 chunks, min len 3
    // The observed failure count today is a LOWER BOUND (~218): the delivery
    // fiber is still draining its 269 sends when this test's sleep expires.
    // That number is timing-dependent PRE-fix only, and is two orders of
    // magnitude above the bound. Post-fix it is 3-4 and drains instantly.
    const MAX_CHUNKS = Math.ceil(TEXT.length / (MAX / 2)) + 2
    expect(finals.length).toBeLessThanOrEqual(MAX_CHUNKS)

    // Must not regress: sane counts may NOT be bought back with overflow.
    for (const d of finals) {
      expect(d.content.length).toBeLessThanOrEqual(MAX)
    }

    expect(finals[finals.length - 1]?.opts.isFinal).toBe(true)
  })

  /* ------------------------------------------------------------------------ */
  /* Slice 2d — THE CLAMPED BAND OVERFLOWS (added by pp-ping 2026-08-05)       */
  /* NAME: this is 2d, NOT 2c. Task #9 ("2c") is a DIFFERENT and pre-existing  */
  /* defect: the single-chunk FAST PATH reserves nothing while                 */
  /* repairSplitFences appends a closer unconditionally. That one is present   */
  /* at HEAD and is not this slice's invariant to restore. Do not merge them.  */
  /*                                                                          */
  /* Slice 2 landed a floor under the split limit:                            */
  /*     bodyFloor = floor(maxLen * MIN_USABLE_BODY_FRACTION)   (0.5)         */
  /*     limit     = max(1, maxLen - reserve, bodyFloor)                      */
  /* Its doc comment calls the residual "a bound, not an observation" and     */
  /* reports that sweeps found no over-limit chunk. Both halves are false.    */
  /* The overflow is ANALYTIC, not merely possible:                           */
  /*                                                                          */
  /*   every fence-line candidate inside a repaired chunk is at most `limit`, */
  /*   so a carried info string is at most `limit - 3`, so a REOPENED chunk   */
  /*   is at most  limit + 1 + limit + 1 + FENCE_MARKER_LEN = 2*limit + 5.    */
  /*                                                                          */
  /* Whenever the clamp BINDS, `limit` sits at its floor, and at a floor of   */
  /* half the budget that bound is maxLen + 5. Measured: exactly 5 over, at   */
  /* maxLen 500, 1000, 2000 and 4096 alike.                                   */
  /*                                                                          */
  /* >>> THE PREFIX IS LOAD-BEARING, FOR **TWO** SEPARATE REASONS.        <<< */
  /* >>> DO NOT "SIMPLIFY" IT. BOTH PROPERTIES MUST HOLD SIMULTANEOUSLY.  <<< */
  /*                                                                          */
  /* (1) IT MUST END A SENTENCE. The Slice 2 sweep that reported "608         */
  /* configurations, zero overflows" prefixed every fixture with "intro\n" —  */
  /* SIX characters, which is precisely enough slack to keep the fence line's */
  /* chunk-portion under the limit and hide the defect completely. Verified:  */
  /* the SAME fixture with prefix "intro\n" overflows 0 configs; with "" or   */
  /* "intro. " it overflows 236 of 608. A prefix that ENDS A SENTENCE makes   */
  /* splitToChunks cut at the sentence boundary (strategy 2), so the next     */
  /* chunk begins exactly at the fence run and the run gets the FULL window.  */
  /* That is ordinary model output, not an adversarial construction.          */
  /*                                                                          */
  /* (2) IT MUST NOT END IN A NEWLINE. Discovered by the auditor's mutation   */
  /* battery, 2026-08-05; this is the second property and it is why these two */
  /* tests are the ONLY coverage of a separately load-bearing decision.       */
  /* Because "Here is the answer. " ends in a SPACE, the fence marker lands   */
  /* MID-LINE in the text that fenceRepairReserve scans. That function's      */
  /* fence regex is deliberately UNANCHORED. Anchoring it (the natural        */
  /* "tidy-up") then finds no fence at all, computes reserve 0, returns       */
  /* limit = maxLen, and the repair's insertions land on top of a full-width  */
  /* chunk: these tests go RED with [2004, 4005, 2032]. That was audit        */
  /* finding F3 — "the load-bearing unanchored regex has zero tests" — and it */
  /* is closed HERE, by consequence rather than by construction.              */
  /* Terminating PREFIX with "\n" puts the fence at line start, an anchored   */
  /* regex then behaves identically to the unanchored one, and F3's coverage  */
  /* DIES SILENTLY while both tests stay green. Do not do it.                 */
  /*                                                                          */
  /* Net: shortening PREFIX disarms (1); newline-terminating it disarms both  */
  /* (1) and (2). Neither failure is visible in a green run.                  */
  /*                                                                          */
  /* The RUN must also be unbroken (no space, newline, . ! or ?) so           */
  /* splitToChunks falls through to strategy 4, the hard cut, which pins the  */
  /* carried info string at exactly `limit - 3` — the worst case, not a       */
  /* shortened one. The Slice 2 doc comment has this mechanism inverted.      */
  /*                                                                          */
  /* WHAT IS ASSERTED: the invariant this whole slice exists to establish —   */
  /* no delivered chunk exceeds the adapter's maxMessageLength. NOT a chunk   */
  /* count, NOT a formula, NOT a fraction. Any floor that makes               */
  /* 2*limit + 5 <= maxLen an identity satisfies this; which one is pong's.   */
  /* The opposite failure (shattering into tiny legal chunks) is already      */
  /* railed by the Slice 2b test above, so it is deliberately NOT re-pinned   */
  /* here — the two tests are a pair and neither may be deleted alone.        */
  /*                                                                          */
  /* ...AND, ADDED 2026-08-05, THE SECOND HALF OF THAT INVARIANT: the chunks  */
  /* must fit the budget WITHOUT LOSING ANYTHING. A length bound alone is     */
  /* satisfiable by TRUNCATION, and truncation is not a hypothetical wrong    */
  /* fix — it is what this exact code path USED to do (see the comment        */
  /* preserved at delivery.ts, "Long answers no longer truncate at            */
  /* maxMessageLength"). A rail that cannot tell the fix apart from a         */
  /* regression to the behaviour the feature was built to remove is pinning a */
  /* number, not an invariant. So each test also asserts CONTENT SURVIVAL and */
  /* FENCE BALANCE; see the two helpers below for what each one catches and   */
  /* for the measured reason a character-count sum is NOT used.               */
  /*                                                                          */
  /* SCOPE GUARD for Slice 2d. Implementation is confined to:                 */
  /*     packages/channels/src/delivery.ts                                    */
  /* Pong MUST NOT touch, in this micro-cycle:                                */
  /*     packages/channels/src/service.ts                                     */
  /*     packages/channels/src/adapters/*.ts                                  */
  /*     packages/channels/src/types.ts                                       */
  /*     packages/channels/src/index.ts                                       */
  /*     any test file (this one included)                                    */
  /*     any other package or app in the monorepo                             */
  /* splitToChunks must STILL stay fence-blind. No pre-existing assertion may */
  /* be weakened, edited, renamed or deleted — in particular the Slice 2b     */
  /* test above must stay byte-identical.                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * One realistic answer whose fence run fills the entire split window.
   *
   * Shape: a sentence-ending prose prefix, then a fence marker immediately
   * followed by a long UNBROKEN token (a base64 blob is the everyday way a
   * model produces one), then a short tail. See the PREFIX warning above.
   */
  const makeUnbrokenFenceRunText = (maxLen: number): string => {
    const PREFIX = "Here is the answer. "
    const BLOB = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamts"
    // Long enough to outlast more than one window at ANY defensible limit.
    const runLen = 2 * maxLen
    const run = BLOB.repeat(Math.ceil(runLen / BLOB.length)).slice(0, runLen)
    return PREFIX + "```" + run + "\nThat is the whole file."
  }

  /**
   * CONTENT SURVIVAL. Returns null when every NON-WHITESPACE character of
   * `text` still appears, IN ORDER, somewhere across the delivered chunks;
   * otherwise a message naming the first character that was dropped.
   *
   * Why a subsequence and not equality: splitToChunks legitimately DROPS
   * WHITESPACE at a cut (`trimStart()` after a sentence boundary, the space
   * itself at a word boundary) and fence repair legitimately ADDS characters
   * (a reopen line carrying the info string, a closer). Both are allowed by a
   * whitespace-stripped subsequence; deleting any content character is not.
   * Verified against three non-truncating floors — the shipped one, the old
   * floor(maxLen*0.5), floor(maxLen/3), and the degenerate bodyFloor=1 — all
   * pass at maxLen 500/2000/4096, so this does NOT lock pong's technique.
   *
   * WHY NOT THE CHARACTER-COUNT SUM. The obvious cheaper form,
   *   sum(chunk.length) >= text.length
   * was measured and REJECTED: it is vacuous on this fixture. Fence repair
   * roughly DOUBLES the payload here (2058/8058/16442 delivered against
   * 1047/4047/8239 of text, because each reopen line carries a ~maxLen/2 info
   * string), so the sum keeps a margin of thousands of characters even while
   * a quarter of the answer is being deleted. Measured against a truncating
   * implementation (`chunkLimit = maxLen` then `slice(0, maxLen)`): the sum is
   * 6019 >= 4047 and PASSES, while 15 non-whitespace characters of the user's
   * answer are gone and this helper reports the gap at index 4023. Do not
   * "simplify" this back into a sum.
   */
  const contentSurvivalGap = (text: string, joined: string): string | null => {
    const want = text.replace(/\s+/g, "")
    const got = joined.replace(/\s+/g, "")
    let i = 0
    for (let j = 0; j < got.length && i < want.length; j++) {
      if (got[j] === want[i]) i++
    }
    if (i === want.length) return null
    return (
      `content dropped: ${i} of ${want.length} non-whitespace chars survived; ` +
      `first missing at index ${i}: ${JSON.stringify(want.slice(i, i + 24))}`
    )
  }

  /**
   * FENCE BALANCE. Every delivered chunk must carry an EVEN number of fence
   * markers — repair either leaves a chunk fence-free or gives it both a
   * reopen and a closer. Shipped: [0,2,2,2,2,2] at all three scales.
   *
   * This catches the truncation flavour that content survival alone does not.
   * A truncating implementation that keeps the reserve and merely clamps the
   * result eats only the APPENDED CLOSER off the back of each over-limit
   * chunk: measured [0,2,1,1,1,2], every content character intact, the sum
   * still passing, and three of six messages rendering as a code block that
   * never closes. That is the visible half of the bug the closer exists to
   * prevent, so it gets its own assertion rather than being folded in.
   */
  const unbalancedFenceChunks = (
    chunks: readonly string[],
  ): Array<{ chunkIndex: number; markers: number }> =>
    chunks.flatMap((c, chunkIndex) => {
      const markers = (c.match(/```/g) ?? []).length
      return markers % 2 === 0 ? [] : [{ chunkIndex, markers }]
    })

  /** Drive the real stream-edit turn-complete path and return its final chunks. */
  const deliverFinalChunks = async (
    text: string,
    maxLen: number,
    id: string,
  ): Promise<DeliveredItem[]> => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    const fakeCtx = makeFakeAdapterClean(id, "stream-edit", maxLen)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(fakeCtx.adapter)
          yield* svc.handleMessage(makeMessage({ platformMessageId: `${id}-pm-1` }))
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, text))
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("200 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )

    // Finalized chunks only; live stream edits are isPartial: true.
    return fakeCtx.deliveries.filter((d) => d.opts.isPartial === false)
  }

  it("keeps every repaired chunk within maxMessageLength when an unbroken fence run fills the split window", async () => {
    // Discord's real limit (DISCORD_MAX_MESSAGE_LENGTH). No adapter re-clamps
    // before send, and delivery.ts swallows the send failure, so an over-limit
    // chunk is a Discord 400 and a SILENTLY LOST message.
    const MAX = 2000
    const TEXT = makeUnbrokenFenceRunText(MAX)

    // Preconditions, so nothing below can pass vacuously.
    expect(TEXT.length).toBeGreaterThan(MAX)
    expect(TEXT.includes("```")).toBe(true)

    const finals = await deliverFinalChunks(TEXT, MAX, "fence-clamp-discord")

    // The split + repair path really ran; a single chunk could not overflow.
    expect(finals.length).toBeGreaterThan(1)

    // THE INVARIANT. Listing the offending lengths rather than asserting each
    // one in turn makes the RED output name the overflow directly.
    const overLimit = finals.map((d) => d.content.length).filter((n) => n > MAX)
    expect(overLimit).toEqual([])

    // ...AND IT WAS EARNED BY RESERVING, NOT BY CUTTING. Truncation satisfies
    // the bound above; it is also the behaviour this path was built to remove.
    const contents = finals.map((d) => d.content)
    expect(contentSurvivalGap(TEXT, contents.join(""))).toBe(null)
    expect(unbalancedFenceChunks(contents)).toEqual([])
  })

  it("keeps every repaired chunk within maxMessageLength at every adapter scale", async () => {
    // Scale invariance is the point: the defect is not an artifact of one
    // magic number. It reproduces at 500, 1000, 2000 and 4096, over by
    // exactly 5 every time, which is what identifies it as the 2*limit + 5
    // bound rather than a fixture accident. 2000 is covered by the test
    // above; these are the small and large ends (4096 is Telegram's).
    const overflows: Array<{ maxLen: number; chunkLen: number }> = []
    // Same pairing as the test above: the bound is only meaningful alongside
    // proof that nothing was truncated to reach it. Collected across scales so
    // the RED output names every offending adapter size at once.
    const contentGaps: Array<{ maxLen: number; gap: string }> = []
    const unbalanced: Array<{ maxLen: number; chunkIndex: number; markers: number }> = []

    for (const MAX of [500, 4096]) {
      const TEXT = makeUnbrokenFenceRunText(MAX)
      expect(TEXT.length).toBeGreaterThan(MAX)
      expect(TEXT.includes("```")).toBe(true)

      const finals = await deliverFinalChunks(TEXT, MAX, `fence-clamp-scale-${MAX}`)
      expect(finals.length).toBeGreaterThan(1)

      for (const d of finals) {
        if (d.content.length > MAX) overflows.push({ maxLen: MAX, chunkLen: d.content.length })
      }

      const contents = finals.map((d) => d.content)
      const gap = contentSurvivalGap(TEXT, contents.join(""))
      if (gap !== null) contentGaps.push({ maxLen: MAX, gap })
      for (const u of unbalancedFenceChunks(contents)) unbalanced.push({ maxLen: MAX, ...u })
    }

    expect(overflows).toEqual([])
    expect(contentGaps).toEqual([])
    expect(unbalanced).toEqual([])
  })

  /* ------------------------------------------------------------------------ */
  /* Slice 2c — HEADROOM BUDGET (task #9, ported from Sol Agent)               */
  /*                                                                          */
  /* The single-chunk fast path (delivery.ts: finalContent.length <= maxLen   */
  /* => chunkLimit = maxLen) reserves nothing, yet repairSplitFences still    */
  /* appends a bare closer ("\n" + a 3-char marker, +4) when the content ends */
  /* inside an open fence. At the old budget of 2000 a 1997..2000-char answer */
  /* repaired to 2001..2004 chars, Discord rejected it, delivery.ts swallowed */
  /* the rejection, and the user received NOTHING. Fix: Sol Agent's headroom  */
  /* posture (lib/discord/markdown.ts, MAX_LEN = 1900) — budget the Discord   */
  /* adapter at 1900 so repair overhead can never cross the platform limit.   */
  /* Fast path worst case 1900 + 4 = 1904 <= 2000; split-path chunks are      */
  /* bounded by maxLen = 1900 <= 2000.                                        */
  /* ------------------------------------------------------------------------ */

  // The Discord adapter's chunking budget (DISCORD_MAX_MESSAGE_LENGTH in
  // adapters/discord.ts, not exported; its value is pinned by the
  // fail-closed-construction test in discord-adapter.test.ts).
  const DISCORD_BUDGET = 1900
  // This is Discord's limit, distinct from our budget: the budget sits 100
  // below it precisely so repaired chunks always fit.
  const DISCORD_PLATFORM_LIMIT = 2000

  it("delivers the old total-loss window (1997..2000 chars ending inside an open fence) within the platform limit", async () => {
    for (const total of [1997, 2000]) {
      const head = "Here is the fix:\n```typescript\n"
      const TEXT = head + "x".repeat(total - head.length)
      // Preconditions: exact length, and the text really ends inside an OPEN
      // fence (odd marker count), so repair has a closer to append.
      expect(TEXT.length).toBe(total)
      expect((TEXT.match(/```/g) ?? []).length % 2).toBe(1)

      const finals = await deliverFinalChunks(TEXT, DISCORD_BUDGET, `headroom-old-window-${total}`)

      // The answer is delivered rather than silently lost...
      expect(finals.length).toBeGreaterThan(0)
      expect(contentSurvivalGap(TEXT, finals.map((d) => d.content).join(""))).toBe(null)
      // ...and no emitted chunk can be rejected by the platform.
      const overLimit = finals.map((d) => d.content.length).filter((n) => n > DISCORD_PLATFORM_LIMIT)
      expect(overLimit).toEqual([])
    }
  })

  it("keeps the residual fast-path window safe: exactly 1900 chars in an open fence repairs to 1904 in one chunk", async () => {
    const head = "Here is the fix:\n```typescript\n"
    const TEXT = head + "x".repeat(DISCORD_BUDGET - head.length)
    expect(TEXT.length).toBe(DISCORD_BUDGET)
    expect((TEXT.match(/```/g) ?? []).length % 2).toBe(1)

    const finals = await deliverFinalChunks(TEXT, DISCORD_BUDGET, "headroom-fastpath-1900")

    // length <= budget takes the single-chunk fast path...
    expect(finals.length).toBe(1)
    // ...where repair appends the bare closer ("\n```"): the +4 worst case.
    expect(finals[0]?.content.length).toBe(DISCORD_BUDGET + 4)
    expect(finals[0]?.content.length).toBeLessThanOrEqual(DISCORD_PLATFORM_LIMIT)
  })

  it("does not shatter a ~4000-char fenced answer under the 1900 budget", async () => {
    const line = "export const alpha = (n: number): number => n * 2"
    const TEXT =
      "Here is the full module.\n```typescript\n" +
      Array.from({ length: 78 }, () => line).join("\n") +
      "\n```\nThat is all of it."
    // Long enough that the split path must run at the 1900 budget.
    expect(TEXT.length).toBeGreaterThan(2 * DISCORD_BUDGET)

    const finals = await deliverFinalChunks(TEXT, DISCORD_BUDGET, "headroom-no-shatter")

    // The split really happened, and the 100 chars of headroom did not
    // collapse the budget: a ~4000-char answer stays a handful of messages.
    expect(finals.length).toBeGreaterThan(1)
    expect(finals.length).toBeLessThanOrEqual(4)
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

/* ========================================================================== */
/* SLICE 1b+11 — stop-at-first-failure delivery loop (task #7)                 */
/* ========================================================================== */

/**
 * EXECUTABLE SPEC (written before the implementation; RED on arrival).
 *
 * GIVEN a stream-edit turn whose final content splits into 6 chunks and an
 * adapter whose deliver() fails for one scripted chunk,
 * WHEN the turn-complete finalize loop runs,
 * THEN the delivered chunks are a CONTIGUOUS PREFIX (nothing after the first
 * failure is ever attempted), the failure cause is LOGGED, and an explicit
 * truncation marker reaches the user whenever at least one chunk landed.
 *
 * Today the loop (delivery.ts, turn-complete case) pipes EVERY chunk through
 * `Effect.catchAllCause(() => Effect.void)`: a mid-stream failure yields a
 * reply with a SILENT HOLE in the middle, the exact defect Sol Agent measured
 * and fixed (donor: test/discord-multichunk-loss.test.ts, 12 tests).
 *
 * CONTRACT DETAILS pong implements against:
 *   - Stop at the FIRST failure of any kind, not the first PERMANENT one: the
 *     adapter (Slice 1b classifier, discord-adapter.test.ts) already spent its
 *     one retry before a failure surfaces here. The loop adds NO retry of its
 *     own; a retried chunk shows up as a duplicate attempt and fails the
 *     prefix assertion below. The exported `deliveryRetrySchedule` (:788) is
 *     dead code at this seam and must NOT be wired into this loop.
 *   - Truncation marker (wording is ping's choice, canonical form):
 *       "⚠️ Reply truncated: 2 of 6 parts delivered. Ask me to resend the rest."
 *     Pinned pieces: /reply truncated/i, the literal "<delivered> of <total>"
 *     counts, /resend/i, and the marker line stays <= 100 chars so it rides
 *     inside the 100-char headroom DISCORD_MAX_MESSAGE_LENGTH (1900 vs 2000,
 *     Slice 2c) reserves, whether pong appends it to the last delivered chunk
 *     or sends it as its own message. It must arrive through adapter.deliver()
 *     with isPartial false (the user must SEE it).
 *   - Marker only when delivered > 0 (donor rule): if the FIRST chunk fails
 *     there is no evidence the channel can receive anything, so log loudly and
 *     send nothing further.
 *   - The failure cause must reach a log line (console.log/warn/error union,
 *     so Effect's default logger and direct console.* both qualify). WHERE to
 *     log (per-chunk catch or the fiber's outer catchAllCause) is pong's
 *     choice; the delivery fiber itself must not die unhandled.
 *   - Deadline: donor caps a turn's delivery at DELIVERY_DEADLINE_MS=120_000.
 *     Wall-clock-testing 120s is impractical and TestClock cannot reach this
 *     fiber (it is forked via Effect.forkIn(serviceScope) onto the default
 *     runtime), so per the brief the constant's existence and value are pinned
 *     here and the WIRING (the loop abandons remaining chunks once the
 *     deadline passes) is verified by the auditor from the diff.
 *
 * OUT OF SCOPE — the implementation for Slice 1b+11 may modify ONLY:
 *   - packages/channels/src/adapters/discord.ts
 *   - packages/channels/src/delivery.ts
 *   - packages/channels/test/channels.test.ts (additions below existing tests
 *     only; never edit or weaken an existing test)
 *   - packages/channels/test/discord-adapter.test.ts (same constraint)
 * It must NOT touch: src/types.ts, src/index.ts, src/service.ts,
 * src/session-map.ts, src/commands.ts, src/dedup.ts, src/adapters/telegram*,
 * telegram tests, or any other package. The auditor enforces this from the
 * diff. (This is why the deadline pin imports "../src/delivery.js" directly:
 * requiring an index.js re-export would drag index.ts into scope.)
 *
 * Tier B: donor constants are CLOSED (120000ms, 750ms, one-retry, 1900).
 *
 * FIXTURE: six 120-char paragraphs at maxMessageLength 150. One paragraph
 * fits a chunk (120 <= 150), two never pack together (242 > 150), the text is
 * fence-free so the fence reserve is 0 and chunkLimit === maxLen. Therefore
 * chunk i === paragraph i, computed below through the REAL splitToChunks +
 * repairSplitFences. The CONTROL test asserts the clean run delivers exactly
 * these chunks, so if chunking internals ever drift, the control fails
 * LOUDLY instead of the FIXED tests failing cryptically.
 *
 * TALLY for this block: 6 tests, 5 RED on arrival, 1 control (labelled
 * CONTROL, green on arrival).
 */

const SLICE_1B_PARAS = Array.from({ length: 6 }, (_, i) => {
  const head = `PARA-${i + 1} `
  return head + "x".repeat(120 - head.length)
})
const SLICE_1B_TEXT = SLICE_1B_PARAS.join("\n\n")
const SLICE_1B_MAXLEN = 150
const SLICE_1B_CHUNKS = repairSplitFences(splitToChunks(SLICE_1B_TEXT, SLICE_1B_MAXLEN))

interface ScriptedAttempt {
  readonly content: string
  readonly opts: DeliverOptions
}

/**
 * A ChannelAdapter whose deliver() fails exactly where the script says, via
 * Effect.die: a defect typechecks under the frozen `Effect.Effect<void>`
 * deliver signature (types.ts is out of scope) and is precisely what the
 * loop's catchAllCause swallows today. Records EVERY attempt, including the
 * failed one, BEFORE failing, so never-attempted and attempted-but-failed are
 * distinguishable.
 */
const makeScriptedFailureAdapter = (
  id: string,
  failWhen: (content: string, opts: DeliverOptions) => boolean,
) => {
  const attempts: ScriptedAttempt[] = []
  const adapter: ChannelAdapter = {
    id,
    transport: "fake",
    capability: "stream-edit",
    maxMessageLength: SLICE_1B_MAXLEN,
    setMessageHandler() {},
    start() {
      return Effect.void as Effect.Effect<void, never, import("effect").Scope.Scope>
    },
    stop() {
      return Effect.void
    },
    deliver(_target, content, opts) {
      attempts.push({ content, opts })
      if (failWhen(content, opts)) {
        return Effect.die(
          new Error(`INJECTED-DELIVERY-FAILURE: socket hang up for ${content.slice(0, 8)}`),
        )
      }
      return Effect.void
    },
  }
  return { adapter, attempts }
}

describe("Slice 1b+11 — stop-at-first-failure delivery loop", () => {
  /** Drive one stream-edit turn over SLICE_1B_TEXT (the 2c drive pattern). */
  const driveScriptedTurn = async (
    ctx: ReturnType<typeof makeScriptedFailureAdapter>,
    pmId: string,
  ): Promise<void> => {
    const { service: chatService, threads } = makeStubChatService(new Map())
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(ctx.adapter)
          yield* svc.handleMessage(makeMessage({ platformMessageId: pmId }))
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub")

          yield* PubSub.publish(pub, makeAssistantDeltaFrame(threadId, SLICE_1B_TEXT))
          yield* Effect.sleep("30 millis")
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("300 millis")
        }),
        baseLayer(chatService as unknown as ReturnType<typeof makeStubChatService>["service"]),
      ) as Effect.Effect<void, never>,
    )
  }

  /** Finalize-loop attempts only; live stream edits are isPartial: true. */
  const finalsOf = (ctx: ReturnType<typeof makeScriptedFailureAdapter>): ScriptedAttempt[] =>
    ctx.attempts.filter((a) => a.opts.isPartial === false)
  const chunkFinals = (finals: readonly ScriptedAttempt[]): string[] =>
    finals.filter((a) => SLICE_1B_CHUNKS.includes(a.content)).map((a) => a.content)
  const markerFinals = (finals: readonly ScriptedAttempt[]): ScriptedAttempt[] =>
    finals.filter((a) => /reply truncated/i.test(a.content))
  const failChunk3 = (c: string, o: DeliverOptions): boolean =>
    o.isPartial === false && c === SLICE_1B_CHUNKS[2]
  /** Spy union: Effect's default logger and direct console.* both land here. */
  const withConsoleCapture = async (body: (logs: string[]) => Promise<void>): Promise<void> => {
    const logs: string[] = []
    const spies = (["log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "))
      }),
    )
    try {
      await body(logs)
    } finally {
      for (const s of spies) s.mockRestore()
    }
  }

  it("CONTROL (GREEN ON ARRIVAL): a clean 6-chunk turn delivers every chunk in order, no marker, no failure logs", async () => {
    // Doubles as the fixture calibration: proves paragraph i really becomes
    // chunk i through the production chunkLimit path, and that the marker and
    // failure-log rails below cannot pass vacuously against a happy turn.
    await withConsoleCapture(async (logs) => {
      const ctx = makeScriptedFailureAdapter("1b-clean", () => false)
      await driveScriptedTurn(ctx, "1b-clean-pm1")
      const finals = finalsOf(ctx)
      expect(SLICE_1B_CHUNKS).toHaveLength(6)
      expect(finals.map((a) => a.content)).toEqual([...SLICE_1B_CHUNKS])
      expect(markerFinals(finals)).toHaveLength(0)
      expect(logs.filter((l) => /truncat|INJECTED-DELIVERY-FAILURE/i.test(l))).toEqual([])
    })
  })

  it("stops at the FIRST failed chunk: chunks 1-2 delivered, 3 attempted, 4-6 NEVER attempted", async () => {
    expect(SLICE_1B_CHUNKS).toHaveLength(6) // fixture precondition
    const ctx = makeScriptedFailureAdapter("1b-stop", failChunk3)
    await driveScriptedTurn(ctx, "1b-stop-pm1")
    // The contiguous prefix, exactly once each: attempts 1, 2 (delivered) and
    // 3 (failed), then NOTHING. Today this is all six. A loop-level retry of
    // chunk 3 would also fail here, as a duplicate.
    expect(chunkFinals(finalsOf(ctx))).toEqual(SLICE_1B_CHUNKS.slice(0, 3))
  })

  it("appends an explicit truncation marker the user can see: counts, resend hint, <= 100 chars, after the failure", async () => {
    expect(SLICE_1B_CHUNKS).toHaveLength(6)
    const ctx = makeScriptedFailureAdapter("1b-marker", failChunk3)
    await driveScriptedTurn(ctx, "1b-marker-pm1")
    const markers = markerFinals(finalsOf(ctx))
    expect(markers).toHaveLength(1) // RED today: no marker exists
    const text = markers[0]!.content
    expect(text).toContain("2 of 6") // delivered of total
    expect(text).toMatch(/resend/i) // the user's recovery path
    const line = text.match(/[^\n]*reply truncated[^\n]*/i)?.[0] ?? text
    expect(line.length).toBeLessThanOrEqual(100) // rides inside the 1900 headroom
    // Reports, not predicts: the marker attempt comes AFTER the failed chunk.
    const failedAt = ctx.attempts.findIndex(
      (a) => a.opts.isPartial === false && a.content === SLICE_1B_CHUNKS[2],
    )
    const markerAt = ctx.attempts.findIndex((a) => /reply truncated/i.test(a.content))
    expect(failedAt).toBeGreaterThanOrEqual(0)
    expect(markerAt).toBeGreaterThan(failedAt)
  })

  it("LOGS the failure cause: the injected error's message reaches a log line", async () => {
    await withConsoleCapture(async (logs) => {
      const ctx = makeScriptedFailureAdapter("1b-log", failChunk3)
      await driveScriptedTurn(ctx, "1b-log-pm1")
      // RED today: catchAllCause(() => Effect.void) logs nothing at all.
      expect(
        logs.filter((l) => l.includes("INJECTED-DELIVERY-FAILURE")).length,
      ).toBeGreaterThanOrEqual(1)
    })
  })

  it("a turn whose FIRST chunk fails is observable: logged, NO marker, nothing further attempted", async () => {
    expect(SLICE_1B_CHUNKS).toHaveLength(6)
    await withConsoleCapture(async (logs) => {
      const ctx = makeScriptedFailureAdapter(
        "1b-first",
        (c, o) => o.isPartial === false && c === SLICE_1B_CHUNKS[0],
      )
      await driveScriptedTurn(ctx, "1b-first-pm1")
      const finals = finalsOf(ctx)
      // RED today: the loop marches on and attempts all six.
      expect(chunkFinals(finals)).toEqual([SLICE_1B_CHUNKS[0]!])
      // delivered === 0: nothing suggests the channel can receive, so no
      // marker send is attempted (donor rule). The LOG carries the evidence.
      expect(markerFinals(finals)).toHaveLength(0)
      expect(
        logs.filter((l) => l.includes("INJECTED-DELIVERY-FAILURE")).length,
      ).toBeGreaterThanOrEqual(1)
    })
  })

  it("pins the delivery deadline: deliveryDeadlineMs === 120_000 (wiring verified by the auditor from the diff)", async () => {
    // Donor DELIVERY_DEADLINE_MS. Wall-clocking 120s in a unit test is
    // impractical and TestClock cannot reach the forkIn(serviceScope) fiber,
    // so the constant's existence and value are the executable pin; the brief
    // assigns the wiring check (the loop stops once the deadline passes) to
    // the stash-red audit. Dynamic import + cast: a static named import of a
    // not-yet-existing export would kill this whole file at load time. Direct
    // module path, NOT index.js: index.ts is out of scope for this slice.
    const mod = (await import("../src/delivery.js")) as unknown as Record<string, unknown>
    expect(mod["deliveryDeadlineMs"]).toBe(120_000) // RED today: export absent
  })
})

/* ========================================================================== */
/* SLICE 3b — R3 rider: reserved reply-address keys win over metadata (H4)     */
/* ========================================================================== */

/**
 * EXECUTABLE SPEC (written before the implementation; RED on arrival).
 *
 * buildDeliveryTarget (service.ts:104-113) spreads `msg.metadata` into the
 * reply address AFTER the four reserved routing keys, so a metadata key named
 * `channelId` (or senderId/transport/threadingKey) silently REROUTES every
 * reply of the thread — hazard H4, a disclosure bug on a bot fronting a
 * shell. 3a's invariant file pins that no CURRENT adapter manufactures a
 * colliding key (static, source-scan); THIS test pins the service-level
 * behavior for any adapter, present or future. The fix the advisor mandated
 * (R3, riding with 3b) is a one-line reorder: spread the metadata FIRST so
 * the reserved keys win. That reorder is pong's ONLY permitted service.ts
 * change in this slice.
 *
 * OUT OF SCOPE — pong may touch ONLY discord.ts, service.ts (the one-line
 * spread reorder in buildDeliveryTarget, nothing else), and the new
 * apps/ui-web/scripts/discord-commands.ts. This file, delivery.ts,
 * telegram.ts, commands.ts, index.ts, types.ts stay untouched.
 */
describe("Slice 3b — reserved reply-address keys win over inbound metadata (R3/H4)", () => {
  it("a metadata key colliding with a reserved address key LOSES; namespaced metadata still rides along", async () => {
    // GIVEN a registered adapter and an inbound message whose metadata
    //       (an untyped adapter-owned bag) carries keys colliding with the
    //       reserved routing keys, plus one honest namespaced key,
    // WHEN  the turn completes and the reply is delivered,
    // THEN  the reply address routes by the MESSAGE's own routing fields
    //       (reserved keys win), while the honest metadata key still rides
    //       in the address (the spread must move, not vanish).
    const { service: stubChat, threads } = makeStubChatService(new Map())
    const ctx = makeFakeAdapterClean("r3-fake", "final-only", 4096)

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const svc = yield* ChannelService
          yield* svc.registerAdapter(ctx.adapter)
          yield* svc.handleMessage(
            makeMessage({
              channelId: "real-chan-1",
              senderId: "real-sender-1",
              platformMessageId: "r3-pm-1",
              text: "route me honestly",
              metadata: {
                // The attack shape H4 describes — NOT manufactured by any
                // current adapter (the 3a invariant test proves that), but
                // one metadata-emitting slice away at any time.
                channelId: "evil-chan-9",
                senderId: "evil-sender-9",
                // The honest key: proves the fix is a REORDER, not a
                // deletion of the metadata spread (a spread-less address
                // would pass the two assertions above and break Telegram's
                // chatType-carrying replies).
                guildId: "meta-guild-1",
              },
            }),
          )
          yield* Effect.sleep("50 millis")

          const threadId = [...threads.keys()][0]
          if (threadId === undefined) throw new Error("no thread created")
          const pub = threads.get(threadId)
          if (pub === undefined) throw new Error("no pubsub for thread")
          yield* PubSub.publish(pub, makeAssistantDoneFrame(threadId, "Routed reply."))
          yield* PubSub.publish(pub, makeTurnCompleteFrame(threadId))
          yield* Effect.sleep("150 millis")
        }),
        baseLayer(stubChat),
      ) as Effect.Effect<void, never>,
    )

    expect(ctx.deliveries).toHaveLength(1)
    const address = ctx.deliveries[0]?.target.address as Record<string, unknown>
    // RED today: metadata spreads LAST, so these two read "evil-*".
    expect(address["channelId"], "reserved channelId wins over metadata").toBe("real-chan-1")
    expect(address["senderId"], "reserved senderId wins over metadata").toBe("real-sender-1")
    expect(address["transport"], "transport stays the adapter's own").toBe("fake")
    // GREEN today by design (survival guard): the metadata spread must
    // SURVIVE the reorder — deleting it would satisfy the pins above while
    // silently breaking every adapter that routes replies off metadata.
    expect(address["guildId"], "non-reserved metadata still rides").toBe("meta-guild-1")
  })
})
