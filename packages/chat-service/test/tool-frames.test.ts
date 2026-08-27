import { afterAll, describe, expect, it } from "vitest"
import { Cause, Chunk, Effect, Fiber, Layer, Stream } from "effect"
import { SDKError } from "@luna/core"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionStore,
  Clock as CoreClock,
  MESSAGE_ENVELOPE_VERSION,
  ObservabilityService,
  TelemetryService,
  type ChatMessage,
  type StoredMessage,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ChatService, type ChatFrame } from "../src/index.js"
import {
  attachHistoryToolResults,
  formatStreamFailureReason,
  normalizeToolResultContent,
  truncateOutput,
} from "../src/chat-service.js"

describe("normalizeToolResultContent", () => {
  it("returns a string payload unchanged", () => {
    expect(normalizeToolResultContent("hello")).toBe("hello")
  })
  it("joins text blocks from an array payload", () => {
    const content = [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ]
    expect(normalizeToolResultContent(content)).toBe("line one\nline two")
  })
  it("stringifies non-text payloads as JSON", () => {
    expect(normalizeToolResultContent({ a: 1 })).toBe('{"a":1}')
  })
  it("returns an empty string for undefined (optional SDK content)", () => {
    expect(normalizeToolResultContent(undefined)).toBe("")
  })
  it("returns an empty string for null", () => {
    expect(normalizeToolResultContent(null)).toBe("")
  })
})

describe("formatStreamFailureReason", () => {
  it("surfaces an SDKError failure's real cause", () => {
    const cause = Cause.fail(
      new SDKError({
        op: "iterate",
        sessionId: "thr-1",
        cause: new Error("native binary not found"),
      }),
    )
    const r = formatStreamFailureReason(cause)
    expect(r).toContain("native binary not found")
    expect(r).not.toContain("An error has occurred")
  })
  it("falls back to the first pretty line for a defect (no typed failure)", () => {
    const cause = Cause.die(new Error("boom defect"))
    const r = formatStreamFailureReason(cause)
    expect(r).toContain("boom defect")
    // First line only — no multi-line stack dump in the user reason.
    expect(r.split("\n").length).toBe(1)
  })
  it("bounds an over-long reason", () => {
    const long = "x".repeat(1000)
    const cause = Cause.fail(new SDKError({ op: "iterate", cause: long }))
    const r = formatStreamFailureReason(cause)
    expect(r.length).toBeLessThanOrEqual(401)
    expect(r.endsWith("…")).toBe(true)
  })
})

describe("truncateOutput", () => {
  it("passes short output through untouched", () => {
    expect(truncateOutput("short")).toEqual({ output: "short", truncated: false })
  })
  it("truncates by line count and marks truncated", () => {
    const many = Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n")
    const r = truncateOutput(many)
    expect(r.truncated).toBe(true)
    expect(r.output.split("\n").length).toBeLessThanOrEqual(41)
    expect(r.output).toContain("… (truncated)")
  })
})

/* -------------------------------------------------------------------------- */
/* Integration: drive the full ChatService with a fake SDK and assert that    */
/* tool-call / tool-result frames flow over the subscribe Stream. Mirrors the */
/* layer construction in chat-service.sim.test.ts.                            */
/* -------------------------------------------------------------------------- */

const testClock = CoreClock.Test(1_700_000_000_000)

const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("x"),
  get: () => Effect.die("x"),
  query: () => Stream.die("x"),
  delete: () => Effect.die("x"),
  backendFor: () => {
    throw new Error("x")
  },
  exportAll: () => Effect.die("x"),
}

const obsJsonlPath = join(
  tmpdir(),
  `luna-toolframes-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
)

afterAll(() => {
  try {
    unlinkSync(obsJsonlPath)
  } catch {
    /* ignore */
  }
})

const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  testClock,
  ObservabilityService.makeLayer({
    logToConsole: false,
    jsonlPath: obsJsonlPath,
  }).pipe(Layer.provide(testClock)),
  TelemetryService.makeLayer().pipe(Layer.provide(testClock)),
  Layer.succeed(MemoryRouterTag, noopMemoryRouter),
)

const fullLayer = (fakeLayer: Layer.Layer<SDKClient>) =>
  Layer.provideMerge(
    ChatService.Default,
    Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
  )

/** Fake Query that yields a fixed list of SDK messages once a user prompt
 *  arrives, then parks forever (so the long-lived query stays open). */
const queryYielding = (
  prompt: AsyncIterable<SDKUserMessage>,
  msgs: ReadonlyArray<SDKMessage>,
): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for await (const _u of prompt) {
      for (const m of msgs) yield m
      await new Promise<void>(() => {})
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

/** Fake Query whose iteration THROWS once a prompt arrives — models the SDK
 *  subprocess failing to spawn / handshake (e.g. a bad pathToClaudeCodeExecutable).
 *  The throw surfaces in the adapter producer's catch → SDKError → the
 *  chat-service `adapter stream failed` path. */
const queryThrowingOnTurn = (
  prompt: AsyncIterable<SDKUserMessage>,
  errMessage: string,
): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for await (const _u of prompt) {
      throw new Error(errMessage)
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

/** Like collectFrames, but the fake SDK throws on the turn so the run exercises
 *  the adapter-stream-failure surfacing path. */
const collectFramesFailing = (
  errMessage: string,
): Promise<ReadonlyArray<ChatFrame>> => {
  const fakeLayer = SDKClient.fake((p) =>
    queryThrowingOnTurn(p.prompt as AsyncIterable<SDKUserMessage>, errMessage),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* ChatService
        const t = yield* chat.createThread({ model: "claude-test" })
        const sub = chat.subscribe(t.id)
        const collected: ChatFrame[] = []
        const fiber = yield* Effect.forkChild(
          sub.pipe(
            Stream.tap((f) => Effect.sync(() => collected.push(f))),
            Stream.runDrain,
          ),
        )
        yield* Effect.sleep("30 millis")
        yield* chat.send(t.id, "go")
        yield* Effect.sleep("1 second")
        yield* Fiber.interrupt(fiber)
        return collected as ReadonlyArray<ChatFrame>
      }),
    ).pipe(Effect.provide(fullLayer(fakeLayer))),
  )
}

/** Subscribe, drive one user turn, and collect all frames within ~1s. */
const collectFrames = (
  msgs: ReadonlyArray<SDKMessage>,
): Promise<ReadonlyArray<ChatFrame>> => {
  const fakeLayer = SDKClient.fake((p) =>
    queryYielding(p.prompt as AsyncIterable<SDKUserMessage>, msgs),
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const chat = yield* ChatService
        const t = yield* chat.createThread({ model: "claude-test" })
        const sub = chat.subscribe(t.id)
        const collected: ChatFrame[] = []
        const fiber = yield* Effect.forkChild(
          sub.pipe(
            Stream.tap((f) => Effect.sync(() => collected.push(f))),
            Stream.runDrain,
          ),
        )
        // Let the subscriber attach before driving the SDK.
        yield* Effect.sleep("30 millis")
        yield* chat.send(t.id, "go")
        // Give the fake SDK time to emit; then stop collecting.
        yield* Effect.sleep("1 second")
        yield* Fiber.interrupt(fiber)
        return collected as ReadonlyArray<ChatFrame>
      }),
    ).pipe(Effect.provide(fullLayer(fakeLayer))),
  )
}

const makeAssistantWithToolUse = (sessionId: string): SDKMessage =>
  ({
    type: "assistant",
    session_id: sessionId,
    uuid: "tu_assistant",
    parent_tool_use_id: null,
    message: {
      id: "tu_assistant",
      role: "assistant",
      model: "claude-test",
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "mcp__memory__memory_search",
          input: { query: "deploy" },
        },
        { type: "text", text: "searching" },
      ],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }) as unknown as SDKMessage

const makeUserWithToolResult = (sessionId: string): SDKMessage =>
  ({
    type: "user",
    session_id: sessionId,
    uuid: "tr_user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          is_error: false,
          content: [{ type: "text", text: "3 hits found" }],
        },
      ],
    },
  }) as unknown as SDKMessage

const makeUserWithToolError = (sessionId: string): SDKMessage =>
  ({
    type: "user",
    session_id: sessionId,
    uuid: "tr_user_err",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_2",
          is_error: true,
          content: [{ type: "text", text: "boom" }],
        },
      ],
    },
  }) as unknown as SDKMessage

describe("ChatService tool-call frames", () => {
  it(
    "emits a tool-call frame for each assistant tool_use block",
    async () => {
      const frames = await collectFrames([
        makeAssistantWithToolUse("thr-tc"),
      ])
      const toolCall = frames.find((f) => f.type === "tool-call")
      expect(toolCall).toBeDefined()
      if (toolCall && toolCall.type === "tool-call") {
        expect(toolCall.toolCallId).toBe("tu_1")
        expect(toolCall.name).toBe("mcp__memory__memory_search")
        expect(toolCall.input).toEqual({ query: "deploy" })
      }
    },
    { timeout: 10_000 },
  )
})

describe("ChatService tool-result frames", () => {
  it(
    "emits a tool-result frame for each user tool_result block",
    async () => {
      const frames = await collectFrames([
        makeUserWithToolResult("thr-tr"),
      ])
      const toolResult = frames.find((f) => f.type === "tool-result")
      expect(toolResult).toBeDefined()
      if (toolResult && toolResult.type === "tool-result") {
        expect(toolResult.toolCallId).toBe("tu_1")
        expect(toolResult.status).toBe("ok")
        expect(toolResult.output).toBe("3 hits found")
        expect(toolResult.truncated).toBe(false)
      }
    },
    { timeout: 10_000 },
  )

  it(
    "marks the frame status 'error' when is_error is true",
    async () => {
      const frames = await collectFrames([makeUserWithToolError("thr-tre")])
      const toolResult = frames.find((f) => f.type === "tool-result")
      expect(toolResult).toBeDefined()
      if (toolResult && toolResult.type === "tool-result") {
        expect(toolResult.toolCallId).toBe("tu_2")
        expect(toolResult.status).toBe("error")
        expect(toolResult.output).toBe("boom")
      }
    },
    { timeout: 10_000 },
  )
})

/* -------------------------------------------------------------------------- */
/* Subagent (parent_tool_use_id) handling. The SDK forwards a subagent's      */
/* tool_use / tool_result blocks and seed prompt onto the parent stream with  */
/* parent_tool_use_id set. They must surface as TAGGED tool frames and never  */
/* drive top-level turn state (assistant-done / in-flight streaming text).    */
/* -------------------------------------------------------------------------- */

/** Assistant message emitted from INSIDE a subagent (its own tool_use). */
const makeParentedAssistantToolUse = (sessionId: string): SDKMessage =>
  ({
    type: "assistant",
    session_id: sessionId,
    uuid: "sub_assistant",
    parent_tool_use_id: "agent_call_1",
    message: {
      id: "sub_assistant",
      role: "assistant",
      model: "claude-test",
      content: [
        {
          type: "tool_use",
          id: "sub_tu_1",
          name: "Read",
          input: { file_path: "/tmp/x" },
        },
      ],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }) as unknown as SDKMessage

/** The subagent's SEED PROMPT — a parented user message with text only. */
const makeParentedSeedPrompt = (sessionId: string): SDKMessage =>
  ({
    type: "user",
    session_id: sessionId,
    uuid: "sub_seed",
    parent_tool_use_id: "agent_call_1",
    message: {
      role: "user",
      content: [{ type: "text", text: "You are a subagent. Do the thing." }],
    },
  }) as unknown as SDKMessage

/** A tool_result produced INSIDE the subagent. */
const makeParentedToolResult = (sessionId: string): SDKMessage =>
  ({
    type: "user",
    session_id: sessionId,
    uuid: "sub_result",
    parent_tool_use_id: "agent_call_1",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "sub_tu_1",
          is_error: false,
          content: [{ type: "text", text: "file contents" }],
        },
      ],
    },
  }) as unknown as SDKMessage

/** A parented stream_event (future forwardSubagentText) — must be dropped. */
const makeParentedStreamEvent = (sessionId: string): SDKMessage =>
  ({
    type: "stream_event",
    session_id: sessionId,
    uuid: "sub_se",
    parent_tool_use_id: "agent_call_1",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "LEAK" } },
  }) as unknown as SDKMessage

/** A top-level (unparented) stream_event for the parent's own streaming. */
const makeStreamEvent = (sessionId: string, uuid: string, text: string): SDKMessage =>
  ({
    type: "stream_event",
    session_id: sessionId,
    uuid,
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  }) as unknown as SDKMessage

describe("ChatService subagent (parented) frames", () => {
  it(
    "tags a subagent-internal tool_use as a parented tool-call and emits no assistant-done",
    async () => {
      const frames = await collectFrames([
        makeParentedAssistantToolUse("thr-sub-tc"),
      ])
      const toolCall = frames.find((f) => f.type === "tool-call")
      expect(toolCall).toBeDefined()
      if (toolCall && toolCall.type === "tool-call") {
        expect(toolCall.toolCallId).toBe("sub_tu_1")
        expect(toolCall.name).toBe("Read")
        expect(toolCall.parentToolUseId).toBe("agent_call_1")
      }
      // A parented assistant message is NOT a top-level turn.
      expect(frames.find((f) => f.type === "assistant-done")).toBeUndefined()
    },
    { timeout: 10_000 },
  )

  it(
    "tags a subagent-internal tool_result as a parented tool-result",
    async () => {
      const frames = await collectFrames([makeParentedToolResult("thr-sub-tr")])
      const toolResult = frames.find((f) => f.type === "tool-result")
      expect(toolResult).toBeDefined()
      if (toolResult && toolResult.type === "tool-result") {
        expect(toolResult.toolCallId).toBe("sub_tu_1")
        expect(toolResult.parentToolUseId).toBe("agent_call_1")
        expect(toolResult.status).toBe("ok")
      }
    },
    { timeout: 10_000 },
  )

  it(
    "leaves top-level tool frames untagged (no parentToolUseId key)",
    async () => {
      const frames = await collectFrames([
        makeAssistantWithToolUse("thr-untagged"),
        makeUserWithToolResult("thr-untagged"),
      ])
      const toolCall = frames.find((f) => f.type === "tool-call")
      const toolResult = frames.find((f) => f.type === "tool-result")
      expect(toolCall).toBeDefined()
      expect(toolResult).toBeDefined()
      if (toolCall && toolCall.type === "tool-call") {
        expect(toolCall.parentToolUseId).toBeUndefined()
      }
      if (toolResult && toolResult.type === "tool-result") {
        expect("parentToolUseId" in toolResult).toBe(false)
      }
    },
    { timeout: 10_000 },
  )

  it(
    "drops the subagent seed prompt (parented user text) entirely",
    async () => {
      const frames = await collectFrames([makeParentedSeedPrompt("thr-seed")])
      // No user-visible frame for the seed prompt. (The harness's own
      // `send("go")` echoes a `user-accepted` frame — that one is expected.)
      expect(
        frames.filter(
          (f) => f.type !== "snapshot" && f.type !== "user-accepted",
        ).length,
      ).toBe(0)
    },
    { timeout: 10_000 },
  )

  it(
    "drops parented stream_events instead of appending them to the parent's streaming text",
    async () => {
      const frames = await collectFrames([
        makeStreamEvent("thr-leak", "se_1", "parent says "),
        makeParentedStreamEvent("thr-leak"),
        makeStreamEvent("thr-leak", "se_2", "hello"),
      ])
      const deltas = frames.filter((f) => f.type === "assistant-delta")
      expect(deltas.length).toBe(2)
      const last = deltas[deltas.length - 1]
      if (last && last.type === "assistant-delta") {
        // Cumulative text must NOT contain the subagent's leaked delta.
        expect(last.text).toBe("parent says hello")
      }
    },
    { timeout: 10_000 },
  )

  it(
    "preserves the parent's in-flight streaming state across subagent traffic (corruption regression)",
    async () => {
      // Parent streams a delta (establishing the in-flight turn), then the
      // whole subagent lifecycle plays out, then the parent streams MORE.
      // Before the parented guards, the parented assistant message wiped
      // inFlightTurnId/inFlightText — the second delta would restart under a
      // new turn id with reset text.
      const frames = await collectFrames([
        makeStreamEvent("thr-corrupt", "se_a", "thinking… "),
        makeParentedSeedPrompt("thr-corrupt"),
        makeParentedAssistantToolUse("thr-corrupt"),
        makeParentedToolResult("thr-corrupt"),
        makeStreamEvent("thr-corrupt", "se_b", "done"),
      ])
      const deltas = frames.filter((f) => f.type === "assistant-delta")
      expect(deltas.length).toBe(2)
      const [first, second] = deltas
      if (
        first &&
        second &&
        first.type === "assistant-delta" &&
        second.type === "assistant-delta"
      ) {
        // Same wire turn id (state survived) and cumulative text intact.
        expect(second.turnId).toBe(first.turnId)
        expect(second.text).toBe("thinking… done")
      }
    },
    { timeout: 10_000 },
  )
})

describe("ChatService adapter-stream failure surfacing", () => {
  it(
    "surfaces the underlying SDK cause, not an opaque 'An error has occurred'",
    async () => {
      // The exact shape the SDK throws when its bundled binary can't spawn —
      // the real production failure that this regression guards (see
      // dream-reasoner.ts musl/glibc landmine + the new-chat-panel bug).
      const marker =
        "Claude Code native binary not found at /x/musl/claude. Please specify a valid path with options.pathToClaudeCodeExecutable."
      const frames = await collectFramesFailing(marker)
      const errFrame = frames.find((f) => f.type === "assistant-error")
      expect(errFrame).toBeDefined()
      const msg =
        errFrame && errFrame.type === "assistant-error"
          ? errFrame.error.message
          : ""
      // Still tagged as an adapter stream failure...
      expect(msg).toContain("adapter stream failed")
      // ...but now the REAL reason is visible (the whole point of the fix).
      expect(msg).toContain("native binary not found")
      expect(msg).toContain("pathToClaudeCodeExecutable")
      // And the opaque Effect default must NOT be the surfaced text.
      expect(msg).not.toContain("An error has occurred")
      if (errFrame && errFrame.type === "assistant-error") {
        expect(errFrame.error.kind).toBe("sdk")
      }
    },
    { timeout: 10_000 },
  )
})

describe("attachHistoryToolResults", () => {
  // A live turn draws its tool steps from two frames (tool-call, then
  // tool-result). Only the first survived into history, so a replayed
  // transcript showed every past tool as still-pending. This folds the
  // outcome back on so history and live render identically.
  const env = (id: string, seq: number, kind: "user" | "assistant", payload: unknown): StoredMessage => ({
    id,
    sessionId: "s",
    seq,
    ts: seq * 1000,
    parentId: null,
    kind,
    schemaVersion: MESSAGE_ENVELOPE_VERSION,
    payload,
  })
  const resultEnv = (id: string, seq: number, toolUseId: string, content: unknown, isError = false) =>
    env(id, seq, "user", {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content }],
      },
    })
  const msg = (id: string, toolUses: ReadonlyArray<{ id: string; name: string; input: unknown }>): ChatMessage => ({
    id,
    seq: 1,
    ts: 1000,
    role: "assistant",
    text: "working",
    toolUses,
    attachments: [],
  })

  it("attaches each result to the tool_use it answers", () => {
    const out = attachHistoryToolResults(
      [resultEnv("u1", 2, "c1", "3 lines"), resultEnv("u2", 4, "c2", "boom", true)],
      [msg("a1", [{ id: "c1", name: "Read", input: {} }, { id: "c2", name: "Bash", input: {} }])],
    )
    expect(out[0]?.toolUses[0]?.result).toEqual({ ok: true, output: "3 lines", truncated: false })
    expect(out[0]?.toolUses[1]?.result).toEqual({ ok: false, output: "boom", truncated: false })
  })

  it("truncates exactly where the live path does - a snapshot is sent on EVERY subscribe", () => {
    const huge = "x".repeat(5000)
    const out = attachHistoryToolResults(
      [resultEnv("u1", 2, "c1", huge)],
      [msg("a1", [{ id: "c1", name: "Read", input: {} }])],
    )
    const result = out[0]?.toolUses[0]?.result
    const live = truncateOutput(normalizeToolResultContent(huge))
    expect(result?.truncated).toBe(true)
    expect(result?.output).toBe(live.output)
  })

  it("drops a result with no matching tool_use (the snapshot window can cut a run)", () => {
    const out = attachHistoryToolResults(
      [resultEnv("u1", 2, "orphan", "nobody asked")],
      [msg("a1", [{ id: "c1", name: "Read", input: {} }])],
    )
    expect(out[0]?.toolUses[0]?.result).toBeUndefined()
  })

  it("returns the input untouched when there are no results at all", () => {
    const messages = [msg("a1", [{ id: "c1", name: "Read", input: {} }])]
    expect(attachHistoryToolResults([env("u1", 2, "user", { type: "user", message: { role: "user", content: "hi" } })], messages)).toBe(messages)
  })

  it("keeps the first answer for a reused tool_use id", () => {
    const out = attachHistoryToolResults(
      [resultEnv("u1", 2, "c1", "first"), resultEnv("u2", 4, "c1", "second")],
      [msg("a1", [{ id: "c1", name: "Read", input: {} }])],
    )
    expect(out[0]?.toolUses[0]?.result?.output).toBe("first")
  })
})
