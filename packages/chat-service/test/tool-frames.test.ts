import { afterAll, describe, expect, it } from "vitest"
import { Chunk, Effect, Fiber, Layer, Stream } from "effect"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  TelemetryService,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ChatService, type ChatFrame } from "../src/index.js"
import {
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
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
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
        const fiber = yield* Effect.fork(
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
