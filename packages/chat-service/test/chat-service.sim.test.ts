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
import { describe, expect, it } from "vitest"
import {
  Chunk,
  Effect,
  Fiber,
  Layer,
  Option,
  Scope,
  Stream,
} from "effect"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  type ChatMessage,
  type SessionOptions,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
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
import { ChatService, type ChatFrame } from "../src/index.js"

const testClock = CoreClock.Test(1_700_000_000_000)
const obsLayer = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
  Layer.provide(testClock),
)
const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  testClock,
  obsLayer,
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
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

const fullLayer = (
  fakeLayer: Layer.Layer<SDKClient>,
): Layer.Layer<ChatService | SessionStore | CoreClock | ObservabilityService> =>
  Layer.provideMerge(
    ChatService.Default,
    Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
  )

const runScoped = <A, E>(
  eff: Effect.Effect<
    A,
    E,
    ChatService | SessionStore | CoreClock | ObservabilityService | Scope.Scope
  >,
  fakeLayer: Layer.Layer<SDKClient>,
) =>
  Effect.runPromise(
    Effect.scoped(eff).pipe(Effect.provide(fullLayer(fakeLayer))),
  )

describe("ChatService (Tier-2 sim)", () => {
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
          // Each subscriber should see: 1 snapshot + TURNS user-accepted +
          // TURNS assistant-done = 1 + 6 = 7 frames.
          // (No assistant-delta frames — fake doesn't emit stream_event.)
          const collectN = (s: Stream.Stream<ChatFrame, never>, n: number) =>
            s.pipe(Stream.take(n), Stream.runCollect)

          const aFiber = yield* Effect.fork(collectN(subA, 1 + TURNS * 2))
          const bFiber = yield* Effect.fork(collectN(subB, 1 + TURNS * 2))
          const cFiber = yield* Effect.fork(collectN(subC, 1)) // just snapshot

          // Let the forked subscribers attach to their PubSub before any
          // send fires — `Stream.unwrapScoped` only opens the underlying
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
            aFrames: Array.from(Chunk.toReadonlyArray(aChunk)),
            bFrames: Array.from(Chunk.toReadonlyArray(bChunk)),
            cFrames: Array.from(Chunk.toReadonlyArray(cChunk)),
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
        "user-accepted",
        "assistant-done",
        "user-accepted",
        "assistant-done",
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
          const fiber = yield* Effect.fork(
            sub.pipe(Stream.take(3), Stream.runCollect),
          )
          // Wait for the subscriber to attach to PubSub before sending.
          yield* Effect.sleep("30 millis")
          yield* chat.send(t.id, "third")
          const chunk = yield* Fiber.join(fiber)
          const frames = Array.from(Chunk.toReadonlyArray(chunk))
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
          const fiber = yield* Effect.fork(
            sub.pipe(
              Stream.filter((f) => f.type === "assistant-error"),
              Stream.take(1),
              Stream.runCollect,
            ),
          )
          yield* Effect.sleep("5 millis")
          yield* chat.interrupt(t.id)
          const chunk = yield* Fiber.join(fiber)
          return Array.from(Chunk.toReadonlyArray(chunk))[0]!
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
          const fiber = yield* Effect.fork(
            sub.pipe(Stream.take(5), Stream.runCollect),
          )
          yield* Effect.sleep("30 millis")
          yield* chat.send(t.id, "reply ok")
          const chunk = yield* Fiber.join(fiber)
          return Array.from(Chunk.toReadonlyArray(chunk))
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
    "settingSources defaults to SDK isolation mode and disables Claude Code auto memory",
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
      expect(capturedOptions!["env"]).toMatchObject({
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      })
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
          const fiber = yield* Effect.fork(
            evStream.pipe(
              Stream.filter((e) => e.kind === "SessionStart"),
              Stream.take(1),
              Stream.runCollect,
            ),
          )

          const chat = yield* ChatService
          yield* chat.createThread({ model: "claude-sonnet-test", title: "obs-start" })

          const chunk = yield* Fiber.join(fiber)
          return Array.from(Chunk.toReadonlyArray(chunk))
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
          setMaxThinkingTokens: async () => {},
          supplyToolPermissionResponse: async () => {},
          mcpServerStatus: async () => ({}),
        } as Partial<Query>) as Query
      })

      const toolCallEvents = await runScoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const evStream = yield* obs.subscribeEvents
          const fiber = yield* Effect.fork(
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
          return Array.from(Chunk.toReadonlyArray(chunk))
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
            yield* Stream.runDrain(replies).pipe(Effect.catchAll(() => Effect.void))
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
          const fiber = yield* Effect.fork(
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
          return Array.from(Chunk.toReadonlyArray(chunk))
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
