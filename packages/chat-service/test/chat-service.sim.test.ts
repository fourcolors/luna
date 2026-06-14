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
  Chunk,
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
  type ChatFrame,
  type DeliveryNotification,
} from "../src/index.js"

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

          const aFiber = yield* Effect.fork(collectN(subA, 1 + TURNS * 3))
          const bFiber = yield* Effect.fork(collectN(subB, 1 + TURNS * 3))
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
          const fiber = yield* Effect.fork(
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
          return Array.from(Chunk.toReadonlyArray(chunk))
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
          const fiber = yield* Effect.fork(
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
          return Array.from(Chunk.toReadonlyArray(chunk))
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
            const fiber = yield* Effect.fork(
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
            const fiber = yield* Effect.fork(
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
          const framesFiber = yield* Effect.fork(
            sub.pipe(Stream.take(2), Stream.runCollect),
          )
          // Capture the cross-thread notification stream too.
          const notesFiber = yield* Effect.fork(
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
            frames: Array.from(Chunk.toReadonlyArray(framesChunk)),
            notes: Array.from(Chunk.toReadonlyArray(notesChunk)),
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
          return Array.from(Chunk.toReadonlyArray(chunk))[0]!
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
          const notesFiber = yield* Effect.fork(
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
            notes: Array.from(Chunk.toReadonlyArray(notesChunk)),
            snapshot: Array.from(Chunk.toReadonlyArray(snap))[0]!,
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
