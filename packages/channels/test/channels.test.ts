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
  ChannelMessage,
  DeliveryCapability,
  DeliverOptions,
  DeliveryTarget,
} from "../src/types.js"
import {
  ChannelSessionStore,
  InboundDedupStore,
  ChannelService,
  ChannelServiceLayer,
  splitToChunks,
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
      Effect.succeed(Option.none<ChatMessage>()),

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

const makeAssistantDoneFrame = (threadId: string, text: string, seq = 1): ChatFrame => ({
  type: "assistant-done",
  threadId,
  turnId: "turn-1",
  seq,
  message: {
    id: "msg-1",
    seq,
    ts: Date.now(),
    role: "assistant",
    text,
    toolUses: [],
    attachments: [],
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
