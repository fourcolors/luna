# Full-featured TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent-cli TUI a single-column transcript that renders assistant markdown and live tool-call cards (running → ok/error + output), driven by two new streamed `ChatFrame` variants.

**Architecture:** chat-service projects `tool_use` (assistant messages) and `tool_result` (user messages, currently dropped) into `tool-call` / `tool-result` frames. ui-ws forwards them unchanged; the agent-cli session re-emits them as `toolCall` / `toolResult` events; the TUI maintains an ordered timeline of blocks and renders it single-column.

**Tech Stack:** TypeScript, Effect (chat-service/ui-ws), OpenTUI + Solid (TUI), vitest, bun.

**Spec:** `docs/superpowers/specs/2026-05-28-tui-full-featured-design.md`

**Deviation from spec:** the `seq` field is omitted from both new frames (YAGNI — the TUI orders by arrival and merges results by `toolCallId`).

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/chat-service/src/types.ts` | `ChatToolCall` / `ChatToolResult` + `ChatFrame` union | modify |
| `packages/chat-service/src/chat-service.ts` | emit tool frames in `handleSdkMessage` | modify |
| `packages/chat-service/test/tool-frames.test.ts` | backend projection tests | create |
| `packages/ui-ws/src/protocol.ts` | `ToolCallFrame` / `ToolResultFrame` + `ServerFrame` union | modify |
| `packages/ui-ws/test/tool-frames.protocol.test.ts` | passthrough forwarding test | create |
| `apps/agent-cli/src/chat/headless.ts` | `toolCall` / `toolResult` events | modify |
| `apps/agent-cli/test/headless-tools.test.ts` | session event tests | create |
| `apps/agent-cli/src/tui/timeline.ts` | pure timeline reducer + `Block` types | create |
| `apps/agent-cli/test/timeline.test.ts` | reducer tests | create |
| `apps/agent-cli/src/tui/markdown.ts` | markdown → node-tree (pure) | create |
| `apps/agent-cli/test/markdown.test.ts` | markdown parser tests | create |
| `apps/agent-cli/src/tui/slash.ts` | slash-command filter (pure) | create |
| `apps/agent-cli/test/slash.test.ts` | slash filter tests | create |
| `apps/agent-cli/src/tui/store.ts` | hold timeline signal; drop panel signals | modify |
| `apps/agent-cli/src/tui/Transcript.tsx`, `ToolCard.tsx`, `AssistantBlock.tsx`, `Input.tsx`, `SlashMenu.tsx`, `StatusBar.tsx` | render components | create |
| `apps/agent-cli/src/tui/App.tsx`, `mount.ts` | wire timeline + new events; remove panel | modify |
| `apps/agent-cli/src/tui/{ContextPanel,MemoriesTab,EventsTab,ArtifactsTab,panel-types,memory-search}.{tsx,ts}` | old side panel | delete |

---

## Phase 1 — chat-service: tool frames

### Task 1: Add `ChatToolCall` / `ChatToolResult` to the frame union

**Files:**
- Modify: `packages/chat-service/src/types.ts`

- [ ] **Step 1: Add the two interfaces + union members**

In `packages/chat-service/src/types.ts`, after `ChatArtifactsExtracted` (before `export type ChatFrame`):

```ts
/** A tool the agent invoked, surfaced live when the assistant turn lands.
 *  `toolCallId` equals the SDK `tool_use.id` and links to its result. */
export interface ChatToolCall {
  readonly type: "tool-call"
  readonly threadId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly name: string
  readonly input: unknown
}

/** The result of a previously-announced tool call. `toolCallId` equals the
 *  SDK `tool_result.tool_use_id`. `output` is normalized text, truncated. */
export interface ChatToolResult {
  readonly type: "tool-result"
  readonly threadId: string
  readonly toolCallId: string
  readonly status: "ok" | "error"
  readonly output: string
  readonly truncated: boolean
}
```

Add both to the `ChatFrame` union:

```ts
export type ChatFrame =
  | ChatSnapshot
  | ChatAssistantDelta
  | ChatAssistantDone
  | ChatAssistantError
  | ChatUserAccepted
  | ChatArtifactsExtracted
  | ChatToolCall
  | ChatToolResult
```

- [ ] **Step 2: Typecheck the package**

Run: `bun run --filter '@luna/chat-service' typecheck` (or `bunx tsc --noEmit -p packages/chat-service/tsconfig.json`)
Expected: PASS (no usages yet).

- [ ] **Step 3: Commit**

```bash
git add packages/chat-service/src/types.ts
git commit -m "feat(chat-service): add tool-call/tool-result ChatFrame variants"
```

### Task 2: Output normalization + truncation helpers (TDD)

**Files:**
- Modify: `packages/chat-service/src/chat-service.ts` (add exported helpers near the SDK-probe helpers, ~line 115)
- Test: `packages/chat-service/test/tool-frames.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/chat-service/test/tool-frames.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { normalizeToolResultContent, truncateOutput } from "../src/chat-service.js"

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
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun run --filter '@luna/chat-service' test -- tool-frames`
Expected: FAIL — `normalizeToolResultContent is not a function`.

- [ ] **Step 3: Implement the helpers**

In `packages/chat-service/src/chat-service.ts`, add (exported) after `extractStreamEventText` (~line 114):

```ts
const MAX_TOOL_OUTPUT_CHARS = 2048
const MAX_TOOL_OUTPUT_LINES = 40

/** Normalize an SDK tool_result `content` payload (string | block array |
 *  arbitrary object) into plain text. */
export const normalizeToolResultContent = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts = content.map((b) =>
      isObj(b) && typeof b["text"] === "string"
        ? (b["text"] as string)
        : JSON.stringify(b),
    )
    return parts.join("\n")
  }
  return JSON.stringify(content)
}

/** Cap tool output to keep the wire small. Returns the (possibly clipped)
 *  text plus whether it was clipped. */
export const truncateOutput = (
  s: string,
): { readonly output: string; readonly truncated: boolean } => {
  let out = s
  let truncated = false
  const lines = out.split("\n")
  if (lines.length > MAX_TOOL_OUTPUT_LINES) {
    out = lines.slice(0, MAX_TOOL_OUTPUT_LINES).join("\n")
    truncated = true
  }
  if (out.length > MAX_TOOL_OUTPUT_CHARS) {
    out = out.slice(0, MAX_TOOL_OUTPUT_CHARS)
    truncated = true
  }
  if (truncated) out = out + "\n… (truncated)"
  return { output: out, truncated }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun run --filter '@luna/chat-service' test -- tool-frames`
Expected: PASS (3 + 2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/chat-service/src/chat-service.ts packages/chat-service/test/tool-frames.test.ts
git commit -m "feat(chat-service): tool-result content normalization + truncation"
```

### Task 3: Emit `tool-call` frames from the assistant message (TDD)

**Files:**
- Modify: `packages/chat-service/src/chat-service.ts` (`handleSdkMessage`, assistant branch, ~line 578-596)
- Test: `packages/chat-service/test/tool-frames.test.ts` (append an integration test)

- [ ] **Step 1: Write the failing test (drives ChatService end-to-end with a fake SDK)**

Append to `packages/chat-service/test/tool-frames.test.ts`. This mirrors the harness in `chat-service.sim.test.ts` (copy its `baseLayer`, `noopMemoryRouter`, `makeChatLoopQuery`/fake setup if not already shared). Minimal version:

```ts
import { Chunk, Effect, Layer, Stream, Scope } from "effect"
import {
  SessionStore, Clock as CoreClock, ObservabilityService, TelemetryService,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ChatService } from "../src/index.js"

const testClock = CoreClock.Test(1_700_000_000_000)
const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("x"), get: () => Effect.die("x"),
  query: () => Stream.die("x"), delete: () => Effect.die("x"),
  backendFor: () => { throw new Error("x") }, exportAll: () => Effect.die("x"),
}

// A Query that yields a fixed list of SDK messages then parks.
const queryYielding = (msgs: ReadonlyArray<SDKMessage>) => {
  async function* gen(): AsyncGenerator<SDKMessage> {
    for (const m of msgs) yield m
    await new Promise<void>(() => {})
  }
  return {
    [Symbol.asyncIterator]: gen,
    interrupt: async () => {}, setPermissionMode: async () => {},
    supplyToolPermissionResponse: async () => {}, mcpServerStatus: async () => ({}),
  } as unknown as ReturnType<SDKClient["query"]>
}

describe("tool-call frame emission", () => {
  it("publishes a tool-call frame for each tool_use block in the assistant turn", async () => {
    const assistantMsg = {
      type: "assistant",
      uuid: "turn-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "let me search" },
          { type: "tool_use", id: "tu_1", name: "mcp__memory__memory_search", input: { query: "deploy" } },
        ],
      },
    } as unknown as SDKMessage

    const fakeLayer = SDKClient.fake(() => queryYielding([assistantMsg]))
    const base = Layer.mergeAll(
      SessionStore.Default, testClock,
      ObservabilityService.makeLayer({ logToConsole: false, jsonlPath: "/tmp/luna-toolframes.jsonl" }).pipe(Layer.provide(testClock)),
      TelemetryService.makeLayer().pipe(Layer.provide(testClock)),
      Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    )
    const full = Layer.provideMerge(ChatService.Default, Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, base)))

    const frames = await Effect.runPromise(
      Effect.scoped(Effect.gen(function* () {
        const chat = yield* ChatService
        const t = yield* chat.createThread({ model: "claude-test" })
        const collected: string[] = []
        yield* chat.subscribe(t.id).pipe(
          Stream.tap((f) => Effect.sync(() => collected.push(f.type))),
          Stream.takeUntil((f) => f.type === "tool-call"),
          Stream.runDrain,
          Effect.timeout("3 seconds"),
          Effect.either,
        )
        // pull the actual tool-call frame
        const toolCall = yield* chat.subscribe(t.id).pipe(
          Stream.filter((f) => f.type === "tool-call"),
          Stream.take(1), Stream.runCollect, Effect.timeout("3 seconds"),
          Effect.map((c) => Chunk.toReadonlyArray(c)[0]), Effect.orElseSucceed(() => undefined),
        )
        return { collected, toolCall }
      })).pipe(Effect.provide(full)),
    )
    expect(frames.toolCall).toMatchObject({
      type: "tool-call", toolCallId: "tu_1",
      name: "mcp__memory__memory_search", input: { query: "deploy" },
    })
  })
})
```

> Note for implementer: if driving the subscribe stream twice is awkward, instead subscribe once and collect all frames into an array within a 3s window, then assert the array contains a `tool-call` with the expected fields. The assertion on fields is what matters.

- [ ] **Step 2: Run it, verify it fails**

Run: `bun run --filter '@luna/chat-service' test -- tool-frames`
Expected: FAIL — no `tool-call` frame emitted (assertion on `frames.toolCall` fails / undefined).

- [ ] **Step 3: Emit the frame**

In `handleSdkMessage`, assistant branch, replace the existing tool_use loop (~line 578-596) so it ALSO publishes a frame. The block type read must include `id` and `input`:

```ts
const blocks = (
  args.msg as {
    message?: {
      content?: ReadonlyArray<{ type?: string; id?: string; name?: string; input?: unknown }>
    }
  }
).message?.content ?? []
for (const b of blocks) {
  if (b.type === "tool_use" && typeof b.name === "string" && typeof b.id === "string") {
    yield* inc("luna.chat.tool_uses.reported", { tool: b.name })
    yield* obs.emit({
      kind: "ToolCall",
      ts: new Date().toISOString(),
      level: "info",
      sessionId: args.threadId,
      toolName: b.name,
      durationMs: 0,
      status: "success",
    })
    yield* PubSub.publish(args.pubsub, {
      type: "tool-call",
      threadId: args.threadId,
      turnId: wireTurnId,
      toolCallId: b.id,
      name: b.name,
      input: b.input,
    })
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun run --filter '@luna/chat-service' test -- tool-frames`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chat-service/src/chat-service.ts packages/chat-service/test/tool-frames.test.ts
git commit -m "feat(chat-service): emit tool-call frames from assistant tool_use blocks"
```

### Task 4: Emit `tool-result` frames from user messages (TDD)

**Files:**
- Modify: `packages/chat-service/src/chat-service.ts` (`handleSdkMessage`, add a `user` branch before the trailing comment ~line 638)
- Test: `packages/chat-service/test/tool-frames.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append an `it(...)` that yields a `user` message carrying a `tool_result` block and asserts a `tool-result` frame:

```ts
it("publishes a tool-result frame from a user tool_result block", async () => {
  const userMsg = {
    type: "user",
    uuid: "u-1",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", is_error: false,
          content: [{ type: "text", text: "3 hits found" }] },
      ],
    },
  } as unknown as SDKMessage

  const fakeLayer = SDKClient.fake(() => queryYielding([userMsg]))
  // ...build `full` exactly as in the previous test...
  const result = await Effect.runPromise(
    Effect.scoped(Effect.gen(function* () {
      const chat = yield* ChatService
      const t = yield* chat.createThread({ model: "claude-test" })
      return yield* chat.subscribe(t.id).pipe(
        Stream.filter((f) => f.type === "tool-result"),
        Stream.take(1), Stream.runCollect, Effect.timeout("3 seconds"),
        Effect.map((c) => Chunk.toReadonlyArray(c)[0]), Effect.orElseSucceed(() => undefined),
      )
    })).pipe(Effect.provide(full)),
  )
  expect(result).toMatchObject({
    type: "tool-result", toolCallId: "tu_1", status: "ok",
    output: "3 hits found", truncated: false,
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun run --filter '@luna/chat-service' test -- tool-frames`
Expected: FAIL — no `tool-result` frame.

- [ ] **Step 3: Add the `user` branch in `handleSdkMessage`**

Immediately before the trailing `// system / hook / status …` comment (~line 638):

```ts
if (t === "user") {
  const content = (
    args.msg as {
      message?: {
        content?: ReadonlyArray<{
          type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown
        }>
      }
    }
  ).message?.content ?? []
  for (const b of content) {
    if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const { output, truncated } = truncateOutput(normalizeToolResultContent(b.content))
      yield* PubSub.publish(args.pubsub, {
        type: "tool-result",
        threadId: args.threadId,
        toolCallId: b.tool_use_id,
        status: b.is_error === true ? "error" : "ok",
        output,
        truncated,
      })
    }
  }
  return
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun run --filter '@luna/chat-service' test -- tool-frames`
Expected: PASS.

- [ ] **Step 5: Run the whole chat-service suite (no regressions)**

Run: `bun run --filter '@luna/chat-service' test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/chat-service/src/chat-service.ts packages/chat-service/test/tool-frames.test.ts
git commit -m "feat(chat-service): emit tool-result frames from user tool_result blocks"
```

---

## Phase 2 — ui-ws: protocol forwarding

### Task 5: Add the two wire frames + forwarding test

**Files:**
- Modify: `packages/ui-ws/src/protocol.ts`
- Test: `packages/ui-ws/test/tool-frames.protocol.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ui-ws/test/tool-frames.protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { ServerFrame } from "../src/protocol.js"
import type { ChatFrame } from "@luna/chat-service"

describe("tool frames are wire-compatible", () => {
  it("a ChatToolCall is assignable to ServerFrame (passthrough forwarding)", () => {
    const f: ChatFrame = {
      type: "tool-call", threadId: "t", turnId: "u", toolCallId: "tu_1",
      name: "bash", input: { cmd: "ls" },
    }
    const wire: ServerFrame = f as ServerFrame // compiles only if the variant exists
    expect(wire.type).toBe("tool-call")
  })
  it("a ChatToolResult is assignable to ServerFrame", () => {
    const f: ChatFrame = {
      type: "tool-result", threadId: "t", toolCallId: "tu_1",
      status: "ok", output: "done", truncated: false,
    }
    const wire: ServerFrame = f as ServerFrame
    expect(wire.type).toBe("tool-result")
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun run --filter '@luna/ui-ws' test -- tool-frames.protocol`
Expected: FAIL at typecheck/compile — `ServerFrame` has no `tool-call` member (the test won't compile / the `.type` literal narrows wrong).

- [ ] **Step 3: Add the wire frames**

In `packages/ui-ws/src/protocol.ts`, after `ArtifactsExtractedFrame` (~line 126):

```ts
export interface ToolCallFrame {
  readonly type: "tool-call"
  readonly threadId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly name: string
  readonly input: unknown
}

export interface ToolResultFrame {
  readonly type: "tool-result"
  readonly threadId: string
  readonly toolCallId: string
  readonly status: "ok" | "error"
  readonly output: string
  readonly truncated: boolean
}
```

Add both to the `ServerFrame` union (after `ArtifactsExtractedFrame`):

```ts
  | ArtifactsExtractedFrame
  | ToolCallFrame
  | ToolResultFrame
```

- [ ] **Step 4: Run it, verify it passes + typecheck**

Run: `bun run --filter '@luna/ui-ws' test -- tool-frames.protocol`
Then: `bun run --filter '@luna/ui-ws' typecheck`
Expected: PASS. (`chatFrameToWire`'s `return f` passthrough now forwards both new variants — no server.ts change needed.)

- [ ] **Step 5: Run the ui-ws suite (no regressions)**

Run: `bun run --filter '@luna/ui-ws' test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-ws/src/protocol.ts packages/ui-ws/test/tool-frames.protocol.test.ts
git commit -m "feat(ui-ws): add tool-call/tool-result wire frames (passthrough forwarded)"
```

---

## Phase 3 — agent-cli session: events

### Task 6: Emit `toolCall` / `toolResult` events (TDD)

**Files:**
- Modify: `apps/agent-cli/src/chat/headless.ts` (event-map type ~line 19; `handleFrame` switch ~line 233)
- Test: `apps/agent-cli/test/headless-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Look at an existing `apps/agent-cli/test/headless.test.ts` for how `LunaHeadlessSession` is constructed with a fake client. Create `apps/agent-cli/test/headless-tools.test.ts` following that pattern; the key behavior:

```ts
// Construct a session with a fake LunaWsClient (see headless.test.ts helper).
// Capture emitted events:
const calls: unknown[] = []
session.on("toolCall", (e) => calls.push(e))
const results: unknown[] = []
session.on("toolResult", (e) => results.push(e))

// Feed frames as if from the server (use the same hook headless.test.ts uses
// to deliver a ServerFrame into handleFrame — e.g. fakeClient.emitFrame(...)):
fakeClient.deliver({ type: "tool-call", threadId: "t", turnId: "u",
  toolCallId: "tu_1", name: "bash", input: { cmd: "ls" } })
fakeClient.deliver({ type: "tool-result", threadId: "t",
  toolCallId: "tu_1", status: "ok", output: "ok", truncated: false })

expect(calls).toEqual([{ toolCallId: "tu_1", name: "bash", input: { cmd: "ls" }, turnId: "u" }])
expect(results).toEqual([{ toolCallId: "tu_1", status: "ok", output: "ok", truncated: false }])
```

> Implementer: match the existing test's frame-delivery mechanism exactly (headless.test.ts already exercises `handleFrame` via the fake client). Reuse its fake-client factory.

- [ ] **Step 2: Run it, verify it fails**

Run: `bun run --filter '@luna/agent-cli' test -- headless-tools`
Expected: FAIL — no `toolCall` / `toolResult` events emitted.

- [ ] **Step 3: Extend the event-map type**

In `apps/agent-cli/src/chat/headless.ts`, in `LunaHeadlessEvents` (~line 19), add:

```ts
  toolCall: (e: { toolCallId: string; name: string; input: unknown; turnId: string }) => void
  toolResult: (e: { toolCallId: string; status: "ok" | "error"; output: string; truncated: boolean }) => void
```

- [ ] **Step 4: Handle the frames in `handleFrame`**

In the `handleFrame` switch (~line 233), add two cases (before the closing `}`):

```ts
      case "tool-call":
        this.emit("toolCall", {
          toolCallId: frame.toolCallId, name: frame.name,
          input: frame.input, turnId: frame.turnId,
        })
        return
      case "tool-result":
        this.emit("toolResult", {
          toolCallId: frame.toolCallId, status: frame.status,
          output: frame.output, truncated: frame.truncated,
        })
        return
```

- [ ] **Step 5: Run it, verify it passes + suite**

Run: `bun run --filter '@luna/agent-cli' test -- headless-tools`
Then: `bun run --filter '@luna/agent-cli' test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/src/chat/headless.ts apps/agent-cli/test/headless-tools.test.ts
git commit -m "feat(agent-cli): session emits toolCall/toolResult events"
```

---

## Phase 4 — TUI timeline reducer (pure)

### Task 7: `timeline.ts` block model + reducer (TDD)

**Files:**
- Create: `apps/agent-cli/src/tui/timeline.ts`
- Test: `apps/agent-cli/test/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/agent-cli/test/timeline.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { emptyTimeline, applyUser, applyAssistantDelta, applyAssistantDone, applyToolCall, applyToolResult, type Block } from "../src/tui/timeline.js"

describe("timeline reducer", () => {
  it("appends a user block", () => {
    const t = applyUser(emptyTimeline(), "hi")
    expect(t).toEqual([{ kind: "user", text: "hi" }])
  })
  it("upserts assistant text by turnId", () => {
    let t = applyAssistantDelta(emptyTimeline(), "turn-1", "he")
    t = applyAssistantDelta(t, "turn-1", "hello")
    expect(t).toEqual([{ kind: "assistant", turnId: "turn-1", text: "hello", done: false }])
    t = applyAssistantDone(t, "turn-1", "hello")
    expect((t[0] as Extract<Block, { kind: "assistant" }>).done).toBe(true)
  })
  it("appends a running tool block, then merges its result by toolCallId", () => {
    let t = applyToolCall(emptyTimeline(), { toolCallId: "tu_1", name: "bash", input: { cmd: "ls" }, turnId: "turn-1" })
    expect(t).toEqual([{ kind: "tool", toolCallId: "tu_1", name: "bash", input: { cmd: "ls" }, status: "running" }])
    t = applyToolResult(t, { toolCallId: "tu_1", status: "ok", output: "a\nb", truncated: false })
    expect(t[0]).toEqual({ kind: "tool", toolCallId: "tu_1", name: "bash", input: { cmd: "ls" }, status: "ok", output: "a\nb", truncated: false })
  })
  it("ignores a tool-result with no matching call", () => {
    const t = applyToolResult(emptyTimeline(), { toolCallId: "nope", status: "ok", output: "x", truncated: false })
    expect(t).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun run --filter '@luna/agent-cli' test -- timeline`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `timeline.ts`**

```ts
export type Block =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly turnId: string; readonly text: string; readonly done: boolean }
  | {
      readonly kind: "tool"; readonly toolCallId: string; readonly name: string; readonly input: unknown
      readonly status: "running" | "ok" | "error"; readonly output?: string; readonly truncated?: boolean
    }

export type Timeline = ReadonlyArray<Block>
export const emptyTimeline = (): Timeline => []

export const applyUser = (t: Timeline, text: string): Timeline => [...t, { kind: "user", text }]

export const applyAssistantDelta = (t: Timeline, turnId: string, text: string): Timeline => {
  const i = t.findIndex((b) => b.kind === "assistant" && b.turnId === turnId)
  if (i === -1) return [...t, { kind: "assistant", turnId, text, done: false }]
  const next = [...t]
  next[i] = { kind: "assistant", turnId, text, done: false }
  return next
}

export const applyAssistantDone = (t: Timeline, turnId: string, text: string): Timeline => {
  const i = t.findIndex((b) => b.kind === "assistant" && b.turnId === turnId)
  if (i === -1) return [...t, { kind: "assistant", turnId, text, done: true }]
  const next = [...t]
  next[i] = { kind: "assistant", turnId, text, done: true }
  return next
}

export const applyToolCall = (
  t: Timeline,
  e: { toolCallId: string; name: string; input: unknown; turnId: string },
): Timeline => [
  ...t,
  { kind: "tool", toolCallId: e.toolCallId, name: e.name, input: e.input, status: "running" },
]

export const applyToolResult = (
  t: Timeline,
  e: { toolCallId: string; status: "ok" | "error"; output: string; truncated: boolean },
): Timeline => {
  const i = t.findIndex((b) => b.kind === "tool" && b.toolCallId === e.toolCallId)
  if (i === -1) return t
  const prev = t[i] as Extract<Block, { kind: "tool" }>
  const next = [...t]
  next[i] = { ...prev, status: e.status, output: e.output, truncated: e.truncated }
  return next
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun run --filter '@luna/agent-cli' test -- timeline`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-cli/src/tui/timeline.ts apps/agent-cli/test/timeline.test.ts
git commit -m "feat(tui): pure timeline reducer for chat blocks + tool cards"
```

---

## Phase 5 — TUI markdown parser (pure)

### Task 8: `markdown.ts` → token tree (TDD)

**Files:**
- Create: `apps/agent-cli/src/tui/markdown.ts`
- Test: `apps/agent-cli/test/markdown.test.ts`

Scope: a line/inline tokenizer producing a renderer-agnostic tree. The TUI render task (Phase 7) maps this tree to OpenTUI text nodes. Keeping it pure makes it unit-testable.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { parseMarkdown } from "../src/tui/markdown.js"

describe("parseMarkdown", () => {
  it("parses a heading", () => {
    expect(parseMarkdown("# Title")).toEqual([{ kind: "heading", level: 1, text: "Title" }])
  })
  it("parses a fenced code block with language", () => {
    expect(parseMarkdown("```ts\nconst x = 1\n```")).toEqual([
      { kind: "code", lang: "ts", lines: ["const x = 1"] },
    ])
  })
  it("parses a bullet list", () => {
    expect(parseMarkdown("- a\n- b")).toEqual([
      { kind: "list", ordered: false, items: ["a", "b"] },
    ])
  })
  it("parses a paragraph with inline spans", () => {
    expect(parseMarkdown("hello **world** and `code`")).toEqual([
      { kind: "paragraph", spans: [
        { type: "text", text: "hello " },
        { type: "bold", text: "world" },
        { type: "text", text: " and " },
        { type: "code", text: "code" },
      ] },
    ])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun run --filter '@luna/agent-cli' test -- markdown`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `markdown.ts`**

```ts
export type Span =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "bold"; readonly text: string }
  | { readonly type: "italic"; readonly text: string }
  | { readonly type: "code"; readonly text: string }

export type MdNode =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly spans: ReadonlyArray<Span> }
  | { readonly kind: "code"; readonly lang: string | null; readonly lines: ReadonlyArray<string> }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: ReadonlyArray<string> }

const parseInline = (s: string): ReadonlyArray<Span> => {
  const spans: Span[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) spans.push({ type: "text", text: s.slice(last, m.index) })
    if (m[1] !== undefined) spans.push({ type: "bold", text: m[1] })
    else if (m[2] !== undefined) spans.push({ type: "code", text: m[2] })
    else if (m[3] !== undefined) spans.push({ type: "italic", text: m[3] })
    last = re.lastIndex
  }
  if (last < s.length) spans.push({ type: "text", text: s.slice(last) })
  return spans
}

export const parseMarkdown = (src: string): ReadonlyArray<MdNode> => {
  const lines = src.split("\n")
  const nodes: MdNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || null
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith("```")) { body.push(lines[i]!); i++ }
      i++ // closing fence
      nodes.push({ kind: "code", lang, lines: body })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { nodes.push({ kind: "heading", level: h[1]!.length, text: h[2]! }); i++; continue }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) { items.push(lines[i]!.replace(/^[-*]\s+/, "")); i++ }
      nodes.push({ kind: "list", ordered: false, items })
      continue
    }
    if (line.trim() === "") { i++; continue }
    // paragraph: gather until blank line
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() !== "" && !lines[i]!.startsWith("```") && !/^(#{1,6})\s/.test(lines[i]!) && !/^[-*]\s+/.test(lines[i]!)) {
      para.push(lines[i]!); i++
    }
    nodes.push({ kind: "paragraph", spans: parseInline(para.join(" ")) })
  }
  return nodes
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun run --filter '@luna/agent-cli' test -- markdown`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-cli/src/tui/markdown.ts apps/agent-cli/test/markdown.test.ts
git commit -m "feat(tui): pure markdown parser (headings, code, lists, inline spans)"
```

---

## Phase 6 — TUI slash filter (pure)

### Task 9: `slash.ts` command filter (TDD)

**Files:**
- Create: `apps/agent-cli/src/tui/slash.ts`
- Test: `apps/agent-cli/test/slash.test.ts`

First inspect `apps/agent-cli/src/chat/slash-registry.ts` to reuse the existing command list/shape rather than inventing one.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { slashState } from "../src/tui/slash.js"

const cmds = [
  { name: "new", help: "start a new thread" },
  { name: "newish", help: "x" },
  { name: "help", help: "show help" },
]

describe("slashState", () => {
  it("is inactive when input does not start with /", () => {
    expect(slashState("hello", cmds).active).toBe(false)
  })
  it("lists all commands for a bare slash", () => {
    expect(slashState("/", cmds).matches.map((c) => c.name)).toEqual(["new", "newish", "help"])
  })
  it("filters by prefix", () => {
    expect(slashState("/new", cmds).matches.map((c) => c.name)).toEqual(["new", "newish"])
  })
  it("is active but empty when nothing matches", () => {
    const s = slashState("/zzz", cmds)
    expect(s.active).toBe(true)
    expect(s.matches).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `bun run --filter '@luna/agent-cli' test -- slash`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `slash.ts`**

```ts
export interface SlashCommand { readonly name: string; readonly help: string }
export interface SlashState {
  readonly active: boolean
  readonly query: string
  readonly matches: ReadonlyArray<SlashCommand>
}

export const slashState = (
  input: string,
  commands: ReadonlyArray<SlashCommand>,
): SlashState => {
  if (!input.startsWith("/")) return { active: false, query: "", matches: [] }
  const query = input.slice(1)
  const matches = commands.filter((c) => c.name.startsWith(query))
  return { active: true, query, matches }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `bun run --filter '@luna/agent-cli' test -- slash`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/agent-cli/src/tui/slash.ts apps/agent-cli/test/slash.test.ts
git commit -m "feat(tui): pure slash-command filter"
```

---

## Phase 7 — TUI render + wiring (manual verification)

> OpenTUI rendering is not unit-tested. Each task here ends with a manual check against luna-dev (Phase 8). **Task 10 first confirms the OpenTUI primitives.**

### Task 10: Confirm OpenTUI primitives + store timeline signal

**Files:**
- Read: `node_modules/@opentui/solid` exports + existing `apps/agent-cli/src/tui/App.tsx` usage
- Modify: `apps/agent-cli/src/tui/store.ts`

- [ ] **Step 1: Identify the scroll + multiline-input primitives**

Inspect `@opentui/solid` (and `@opentui/core`) for: a scroll/viewport element (e.g. `<scrollbox>` or a scroll-capable `<box>`), text-input/textarea, and key handling (already used: `KeyEvent`, `useTerminalDimensions`). Record the exact element/prop names in a comment at the top of `store.ts`. If a scroll primitive is absent, the Transcript (Task 11) renders a windowed slice of the timeline (last N blocks) and PageUp/Down adjusts the window offset — note which path you're taking.

- [ ] **Step 2: Replace panel signals with a timeline signal**

In `apps/agent-cli/src/tui/store.ts`: remove the panel signals (`contextPanelTab`, `rawFrames`, `memorySearch`, `artifactsByThread`, `lastUserMessage` and their setters/helpers) and the `messages`/`upsertAssistant`/`appendUser` signals. Add:

```ts
import { createSignal } from "solid-js"
import { emptyTimeline, applyUser, applyAssistantDelta, applyAssistantDone, applyToolCall, applyToolResult, type Timeline } from "./timeline.js"

// ...inside createTuiStore:
const [timeline, setTimeline] = createSignal<Timeline>(emptyTimeline())
const appendUser = (text: string) => setTimeline((t) => applyUser(t, text))
const onAssistantDelta = (turnId: string, text: string) => setTimeline((t) => applyAssistantDelta(t, turnId, text))
const onAssistantDone = (turnId: string, text: string) => setTimeline((t) => applyAssistantDone(t, turnId, text))
const onToolCall = (e: { toolCallId: string; name: string; input: unknown; turnId: string }) => setTimeline((t) => applyToolCall(t, e))
const onToolResult = (e: { toolCallId: string; status: "ok" | "error"; output: string; truncated: boolean }) => setTimeline((t) => applyToolResult(t, e))
const [scrollOffset, setScrollOffset] = createSignal(0)
```

Export `timeline`, `appendUser`, `onAssistantDelta`, `onAssistantDone`, `onToolCall`, `onToolResult`, `scrollOffset`, `setScrollOffset`, plus the still-needed `threadId/connection/profileName/localShellEnabled/inputDraft/fatalReason` signals.

- [ ] **Step 3: Typecheck (will fail until App/mount updated — expected)**

Run: `bun run --filter '@luna/agent-cli' typecheck`
Expected: errors only in `App.tsx`/`mount.ts`/panel files (fixed in Tasks 11–13). Note them; don't fix yet.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-cli/src/tui/store.ts
git commit -m "feat(tui): store holds block timeline instead of flat messages + panel state"
```

### Task 11: Render components — Transcript, blocks, ToolCard, AssistantBlock

**Files:**
- Create: `apps/agent-cli/src/tui/AssistantBlock.tsx`, `ToolCard.tsx`, `Transcript.tsx`

- [ ] **Step 1: `AssistantBlock.tsx`** — render `parseMarkdown(text)` to OpenTUI `<text>`/`<box>` nodes (heading bold, code block in a bordered box, list with `• ` prefixes, inline bold/italic/code via styled `<text>` spans). Use the element/prop names confirmed in Task 10.

- [ ] **Step 2: `ToolCard.tsx`** — one line `⚙ {name}({argSummary}) · {statusGlyph}` where statusGlyph is `⏳` running / `✓` ok / `✗` error; when `output` present, render it indented (dim) below, with `… (truncated)` already in the text. `argSummary` = one-line JSON of `input`, truncated to ~50 chars.

- [ ] **Step 3: `Transcript.tsx`** — iterate the timeline with `<For>`, dispatch on `block.kind` to `UserBlock` (inline: `you: {text}`), `AssistantBlock`, `ToolCard`. Wrap in the scroll primitive (or windowed slice) from Task 10, honoring `scrollOffset`.

- [ ] **Step 4: Manual smoke** — deferred to Phase 8 (needs a running server). Commit the components.

```bash
git add apps/agent-cli/src/tui/AssistantBlock.tsx apps/agent-cli/src/tui/ToolCard.tsx apps/agent-cli/src/tui/Transcript.tsx
git commit -m "feat(tui): Transcript, AssistantBlock (markdown), ToolCard render components"
```

### Task 12: Input + SlashMenu + StatusBar; rewrite App.tsx single-column

**Files:**
- Create: `apps/agent-cli/src/tui/Input.tsx`, `SlashMenu.tsx`, `StatusBar.tsx`
- Modify: `apps/agent-cli/src/tui/App.tsx`

- [ ] **Step 1: `Input.tsx`** — multiline input bound to `inputDraft`; Enter submits (calls `props.onSubmit`), Shift+Enter inserts `\n`, Up-arrow recalls last submitted input when the draft is empty. Use the input primitive + `KeyEvent` handling confirmed in Task 10.

- [ ] **Step 2: `SlashMenu.tsx`** — given `slashState(inputDraft(), commands)`, when `active` render the `matches` as a popup list above the input (highlight first match). Source `commands` from `slash-registry`.

- [ ] **Step 3: `StatusBar.tsx`** — `{profile} · thread {id8} · shell {on|off} · {connection}` (reuse the existing `formatStatus` text, minus the `tab` segment).

- [ ] **Step 4: Rewrite `App.tsx`** — single column: `<Transcript>` (flex-grow), `<SlashMenu>` (conditional), `<Input>`, `<StatusBar>`. Remove `ContextPanel`, `PANEL_WIDTH`, `showPanel`, `chatWidth`. Full width = `dims().width`.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-cli/src/tui/Input.tsx apps/agent-cli/src/tui/SlashMenu.tsx apps/agent-cli/src/tui/StatusBar.tsx apps/agent-cli/src/tui/App.tsx
git commit -m "feat(tui): single-column App with Input, SlashMenu, StatusBar"
```

### Task 13: Rewire mount.ts; delete the old panel; green typecheck

**Files:**
- Modify: `apps/agent-cli/src/tui/mount.ts`
- Delete: `apps/agent-cli/src/tui/{ContextPanel,MemoriesTab,EventsTab,ArtifactsTab}.tsx`, `apps/agent-cli/src/tui/{panel-types,memory-search}.ts`

- [ ] **Step 1: Rewire session events in `mount.ts`**

Replace `store.upsertAssistant(...)` calls with `store.onAssistantDelta(turnId, text)` / `store.onAssistantDone(turnId, text)`. Add:

```ts
session.on("toolCall", (e) => store.onToolCall(e))
session.on("toolResult", (e) => store.onToolResult(e))
```

Remove panel-related wiring: the Tab / Alt-1/2/3 `cycleContextPanelTab` / `setContextPanelTab` key handlers, the debounced `runMemorySearch` call, `pushRawFrame`, and `setArtifactsForThread`. Wire PageUp/PageDown to `store.setScrollOffset`.

- [ ] **Step 2: Delete the panel files**

```bash
git rm apps/agent-cli/src/tui/ContextPanel.tsx apps/agent-cli/src/tui/MemoriesTab.tsx apps/agent-cli/src/tui/EventsTab.tsx apps/agent-cli/src/tui/ArtifactsTab.tsx apps/agent-cli/src/tui/panel-types.ts apps/agent-cli/src/tui/memory-search.ts
```

Also delete `apps/agent-cli/test/panel-store.test.ts` and `apps/agent-cli/test/memory-search.test.ts` if they reference deleted modules (`git rm` them).

- [ ] **Step 3: Typecheck + full agent-cli suite**

Run: `bun run --filter '@luna/agent-cli' typecheck`
Then: `bun run --filter '@luna/agent-cli' test`
Expected: PASS (pure-logic suites green; no references to deleted modules).

- [ ] **Step 4: Commit**

```bash
git add -A apps/agent-cli/src/tui apps/agent-cli/test
git commit -m "feat(tui): wire tool/timeline events in mount; remove old context panel"
```

---

## Phase 8 — deploy + manual verification

### Task 14: Deploy to luna-dev and verify live

- [ ] **Step 1: Land on dev**

```bash
git checkout dev && git merge --ff-only <feature-branch> && git push origin dev && git checkout <feature-branch>
```

- [ ] **Step 2: Deploy luna-dev (server has protocol change)**

```bash
ssh root@luna-server 'incus exec luna-dev -- bash -lc "cd /root/luna && git fetch origin && git pull --ff-only origin dev && /root/.bun/bin/bun install && systemctl restart luna-dev-chat-server.service"'
```
Then confirm boot: `journalctl -u luna-dev-chat-server.service -n 20` shows `[luna/boot] MCP servers registered: …` and `✅ ui-ws chat server`.

- [ ] **Step 3: Manual UX check**

Run the TUI (`luna chat --dev`). Verify: (a) ask Luna something that triggers a tool (e.g. "search your memory for X") → a `⚙` tool card appears, transitions `⏳ → ✓`, shows output; (b) assistant markdown renders (code block, bold); (c) `/` opens the slash menu and filters; (d) Shift+Enter adds a newline, Enter submits; (e) PageUp/Down scrolls; (f) no side panel.

- [ ] **Step 4: Note master rollout as a follow-up** (master lacks searchMemory; the tool-frame changes are independent and cherry-pickable — separate effort).

---

## Self-review notes

- **Spec coverage:** frames (Tasks 1,5) ✓; backend projection of tool_use/tool_result (Tasks 3,4) ✓; truncation (Task 2) ✓; session events (Task 6) ✓; timeline (Task 7) ✓; markdown (Task 8) ✓; slash (Task 9) ✓; single-column render + ToolCard + scrollback + multiline input (Tasks 10–13) ✓; delete panel (Task 13) ✓; deploy (Task 14) ✓.
- **Deviation:** `seq` dropped from frames (recorded at top) — keeps spec/plan consistent by explicit note.
- **Known v1 limits (from spec):** tool results not persisted into snapshots (re-render after reconnect shows calls without output); within-turn ordering is by arrival.
- **OpenTUI uncertainty** is isolated to Task 10 (confirm primitives) with an explicit windowed-slice fallback for scroll; render tasks are verified manually in Phase 8, not by unit tests.
