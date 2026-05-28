# Full-featured TUI: live tool streaming + rich single-column render

Date: 2026-05-28
Status: Approved (design) — pending implementation plan
Branch target: `dev` (then `master` separately)

## Goal

Make the `agent-cli` TUI feel like Claude Code / opencode: a single-column
transcript that shows what Luna is actually doing — assistant text rendered as
markdown, and **live tool-call cards** that transition running → ok/error with
their output. Eliminate the "empty response" problem (turns that are pure tool
calls currently render blank) by surfacing tool activity end-to-end.

## Non-goals (v1)

- Thinking/reasoning blocks, tables in markdown, image rendering.
- **Persisting tool results into snapshots.** Tool results stream live; after a
  reconnect/replay, completed tool calls render from `ChatMessage.toolUses` but
  without their result output. Persisting results into the projection is a
  fast-follow.
- master/luna-stable rollout (handled after dev is validated).

## Why this is feasible

The data already exists in the SDK stream (`packages/chat-service/src/chat-service.ts`,
`handleSdkMessage`):
- Tool **calls** arrive as `tool_use` content blocks on the `assistant` message
  (already read today, but only emitted as obs events).
- Tool **results** arrive as `tool_result` blocks on `user` messages, which
  chat-service currently **drops** (`// user (echoed by real SDK) — not surfaced`).
- Calls and results link by id: `tool_use.id` == `tool_result.tool_use_id`.

So "live plumbing" is projecting data we already receive, not inventing it.

## Architecture & data flow

```
SDK stream ─► chat-service.handleSdkMessage ─► ChatFrame (pubsub) ─► ui-ws ─► session events ─► TUI timeline ─► render
  stream_event              → assistant-delta            (unchanged)
  assistant (text)          → assistant-done             (unchanged)
  assistant (tool_use[])    → tool-call (running)         NEW
  user (tool_result[])      → tool-result (ok|error)      NEW  (was dropped)
  result                    → obs CostAccrued/SessionEnd (unchanged)
```

Five layers, each independently tested:
1. `packages/chat-service` — project the two new frames.
2. `packages/ui-ws` — protocol shapes + server forwarding.
3. `apps/agent-cli` session (`headless.ts`) — emit `toolCall` / `toolResult` events.
4. `apps/agent-cli/src/tui` store — timeline reducer.
5. `apps/agent-cli/src/tui` render — components.

## 1. Frame protocol (`packages/chat-service/src/types.ts`)

Add two variants to `ChatFrame`:

```ts
export interface ChatToolCall {
  readonly type: "tool-call"
  readonly threadId: string
  readonly turnId: string
  readonly toolCallId: string   // = tool_use.id
  readonly name: string         // e.g. "mcp__memory__memory_search"
  readonly input: unknown       // tool args, opaque to chat-service
  readonly seq: number          // per-thread monotonic order hint
}

export interface ChatToolResult {
  readonly type: "tool-result"
  readonly threadId: string
  readonly toolCallId: string   // = tool_result.tool_use_id
  readonly status: "ok" | "error"
  readonly output: string       // text, truncated
  readonly truncated: boolean
  readonly seq: number
}
```

`output` is capped at ~2 KB / ~40 lines; on overflow set `truncated: true` and
append an elision marker. `seq` is a per-thread monotonic counter (separate from
SessionStore seq) used as an ordering hint; the TUI primarily orders by arrival
and merges results by `toolCallId`.

`ui-ws` `ServerFrame` (`packages/ui-ws/src/protocol.ts`) mirrors both variants 1:1.

## 2. Backend projection (`handleSdkMessage`)

- **assistant message**: keep `assistant-done`; additionally, for each `tool_use`
  block, publish a `tool-call` frame (`toolCallId = block.id`, `name`, `input`).
  Keep the existing obs `ToolCall` emission.
- **user message** (currently dropped): for each `tool_result` block, publish a
  `tool-result` frame: `toolCallId = block.tool_use_id`,
  `status = block.is_error ? "error" : "ok"`, `output = stringify+truncate(block.content)`.
  `content` may be a string or an array of blocks — normalize to text.

## 3. Session events (`apps/agent-cli/src/chat/headless.ts`)

Extend the rawFrame handler: `tool-call` → `emit("toolCall", {...})`,
`tool-result` → `emit("toolResult", {...})`. Add both to the session event-map types.

## 4. TUI timeline (`apps/agent-cli/src/tui/store.ts`)

Replace the flat `messages[]` with an ordered **timeline of blocks**:

```ts
type Block =
  | { kind: "user"; text: string }
  | { kind: "assistant"; turnId: string; text: string; done: boolean }
  | { kind: "tool"; toolCallId: string; name: string; input: unknown;
      status: "running" | "ok" | "error"; output?: string; truncated?: boolean }
```

Reducer (pure, unit-tested):
- `assistantDelta` → upsert assistant block by `turnId` (cumulative text).
- `assistantDone` → mark block done.
- `toolCall` → append a `tool` block (`status: "running"`).
- `toolResult` → find tool block by `toolCallId`, set `status`/`output`/`truncated`.
- `user` submit → append `user` block.

## 5. TUI render (single-column)

Components under `apps/agent-cli/src/tui/`:
- `Transcript` — scroll viewport over the timeline (PageUp/Down + mouse wheel).
  **Scrollback is included** (a live transcript is unusable without it).
- `UserBlock`, `AssistantBlock` (markdown), `ToolCard`
  (`⚙ name(arg-summary) · ⏳ running | ✓ ok | ✗ error` + indented output).
- `Input` — multiline (shift-enter = newline, enter = submit), up-arrow history.
- `SlashMenu` — popup filtered list when input starts with `/`, sourced from the
  existing slash registry.
- `StatusBar` — profile · thread · shell · connection.

**Deleted:** `ContextPanel`, `MemoriesTab`, `EventsTab`, `ArtifactsTab`,
`panel-types.ts`, and the panel's `memory-search.ts` (TUI wrapper). The backend
`session.searchMemory` stays; only the side-panel UI is removed.

## 6. Markdown (`apps/agent-cli/src/tui/markdown.ts`)

OpenTUI has no markdown renderer, so a custom pure function
`markdown(text) → node-tree`: headings, bold/italic, inline code, lists, fenced
code blocks with light syntax highlighting. Links render as visible text. Pure
and unit-tested independent of rendering.

## Testing strategy (TDD)

- **chat-service**: feed synthetic SDK `assistant` (with `tool_use`) and `user`
  (with `tool_result`) messages; assert emitted `tool-call`/`tool-result` frames —
  content, `toolCallId` linkage, `is_error` → status, output truncation.
- **ui-ws**: both new frames round-trip protocol encode/decode + server forwarding.
- **session**: `rawFrame(tool-call|tool-result)` → correct `toolCall`/`toolResult` events.
- **TUI (pure units)**: timeline reducer (frames → ordered blocks, in-place result
  merge by `toolCallId`); markdown parser; slash filter; input key handling.
- **Component render**: verified manually against luna-dev (OpenTUI rendering isn't
  unit-tested).

## Phasing (one spec, phased implementation)

1. Backend `tool-call`/`tool-result` frames + chat-service tests.
2. ui-ws protocol + forwarding + session events + tests.
3. TUI timeline reducer + `ToolCard` + single-column transcript with scrollback.
4. Markdown renderer.
5. Slash menu + multiline input + history.
6. Delete the old context panel + cleanup.

## Deploy

Lands on `dev`. Protocol change → redeploy luna-dev (`git pull` + `bun install`
if deps changed + `systemctl restart luna-dev-chat-server.service`). master/luna-stable
rollout handled separately after dev validation.

## Risks / open questions

- **Ordering**: within one turn, assistant text vs tool cards — v1 renders text
  block then tool cards by arrival; `seq` reserved for future precise ordering.
- **tool_result content shape** varies (string vs block array) — normalize defensively.
- **Snapshot replay** does not re-render tool results in v1 (see non-goals).
- **OpenTUI capabilities** — confirm scroll-viewport + multiline input primitives
  during implementation; build minimal shims if missing.
- **Code-fence highlighting** library/approach — decide in plan (lightweight
  tokenizer vs existing dep).
