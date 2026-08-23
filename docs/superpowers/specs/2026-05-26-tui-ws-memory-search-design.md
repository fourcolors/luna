# TUI WS Memory Search Design

Date: 2026-05-26
Status: Drafted, pending user review
Builds on: [2026-05-26-tui-shape-design.md](./2026-05-26-tui-shape-design.md)

## Summary

Replace the TUI's local memory router (currently `InMemoryBackend` — no vector search) with a WebSocket-mediated query to the chat-service's existing `SqliteVectorBackend`. The TUI's Memories tab becomes read-only and source-of-truth-consistent with what the agent on the server side stores via `memory.save`.

## Context

Phase 2 wired the Memories tab to a Solid `createEffect` that calls `runMemorySearch(router, query, topK)`. The router is constructed in `mount.ts` from `InMemoryBackend`, which does not implement `MemoryVectorBackend.search` — so `router.search` immediately fails with "no vector backends registered" and the panel shows `error: An error has occurred`.

The real backend is the chat-service's `SqliteVectorBackend` (`packages/memory/src/backends/sqlite-vector.ts`) running on whichever host the server is on (luna-server in dev). It owns `~/.luna/memory.db` and has Vectorlite HNSW + FTS5 hybrid search wired and ready. The TUI can't reach this directly — they're on different machines.

The operator's framing: the panel is informational, not load-bearing. Stability and minimalism beat features. The protocol must mirror existing infrastructure (the `list-threads` request/response pattern) rather than introduce new conventions.

## Goals

- Memories tab queries the server's real memory store, not a local stub.
- Same panel state machine (`idle → loading → ready | error`) — no UI change.
- Protocol shape mirrors the existing `list-threads → thread-list` request/response.
- No new infrastructure: reuse the chat-service's already-constructed `MemoryRouter`.
- Search-only. No save, no delete, no admin operations from the TUI.

## Non-Goals

- TUI-side memory writes. The agent saves; the TUI reads.
- Live push of new memories (no `memory-added` notify frame). The next debounced query catches new entries.
- Correlation IDs. The debounced effect serializes queries; result frames echo `queryText` so the TUI can drop stale results.
- Multi-namespace search. Default namespace only.
- Pagination, filters, tag queries. Single `queryText` + `topK`.
- Authentication beyond what the existing WS auth provides. Memory namespace access is per-connection, owned by the server.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Protocol style | Request/response, no correlation id | Mirrors `list-threads`; TUI debounce serializes |
| Result format | One success frame (`memory-search-result`) + one error frame (`memory-search-error`) | Mirrors `AssistantErrorFrame` pattern; aligns with existing infrastructure |
| Stale-result handling | `queryText` echoed in result; client compares to current draft | Cheap (one string field); no protocol bloat |
| Hit type location | `MemorySearchHit` defined in `@luna/ui-ws/protocol.ts`; `panel-types.ts` re-exports | Type crosses the wire — canonical home is the wire definition |
| Content coercion | Server-side. `MemoryRecord.content` (`unknown`) → `string` before serialization | Protocol type promises `string`; server must honor it |
| topK default | 10 (server-side default if client omits) | Same default Phase 2 used; tab won't render more than fits anyway |

## Architecture

Three change points, all small:

```
┌─────────────────────┐         ┌──────────────────────────┐         ┌─────────────────────┐
│ TUI (mount.ts)      │  WS     │ ui-ws server.ts          │   call  │ chat-service        │
│                     │ ──────▶ │   case "memory-search-   │ ──────▶ │   searchMemory()    │
│ runMemorySearch     │         │     request":            │         │     ↓               │
│   (now WS query)    │ ◀────── │   send(memory-search-    │ ◀────── │   MemoryRouter.     │
│                     │  WS     │     result) or error     │         │     search()        │
└─────────────────────┘         └──────────────────────────┘         └─────────────────────┘
```

- **`@luna/ui-ws`** gains: `MemorySearchRequestFrame` (client-frame union), `MemorySearchResultFrame` + `MemorySearchErrorFrame` (server-frame union), `MemorySearchHit` (shared interface).
- **`@luna/ui-ws/src/server.ts`** gains one case in the existing client-frame switch (around line 618 — the same switch that handles `list-threads`).
- **`@luna/chat-service`** gains a `searchMemory` function on the closure-returned object at `chat-service.ts:811`. Takes `{ queryText, topK }`, returns `Effect<{ hits: MemorySearchHit[] }, never>` (errors surface as a left-shifted error result, not Effect failure).
- **`apps/agent-cli/src/tui/`**:
  - `mount.ts` deletes the local `InMemoryBackend` + `makeRouter` construction (lines 48–53 from Phase 2 Task 10).
  - `memory-search.ts` replaces its `MemoryRouter` import with a WS-mediated implementation that sends `memory-search-request` and awaits the matching `memory-search-result` (or `memory-search-error`).
  - The store, `MemoriesTab.tsx`, and the debounced `createEffect` are untouched.

## Protocol

```typescript
// packages/ui-ws/src/protocol.ts (additions)

// ── shared ──────────────────────────────────────
export interface MemorySearchHit {
  readonly id: string
  readonly kind: string
  readonly content: string
  readonly score: number
}

// ── client → server ─────────────────────────────
export interface MemorySearchRequestFrame {
  readonly type: "memory-search-request"
  readonly queryText: string
  readonly topK?: number   // server defaults to 10 if omitted
}

// ── server → client (success) ───────────────────
export interface MemorySearchResultFrame {
  readonly type: "memory-search-result"
  readonly queryText: string                       // echoed for stale-result drop
  readonly hits: ReadonlyArray<MemorySearchHit>
}

// ── server → client (failure) ───────────────────
export interface MemorySearchErrorFrame {
  readonly type: "memory-search-error"
  readonly queryText: string                       // echoed; same drop-stale logic
  readonly message: string                         // user-visible string
  readonly kind: "no-vector-backend" | "internal"  // for future telemetry; UI shows message
}
```

Added to the unions:
- `ServerFrame |= MemorySearchResultFrame | MemorySearchErrorFrame`
- `ClientFrame |= MemorySearchRequestFrame`

`MemorySearchHit` is re-exported from `apps/agent-cli/src/tui/panel-types.ts` as a type alias so `MemoriesTab.tsx` continues to import from its existing path (no churn on the consumer side).

## Data Flow

### Happy path

1. User types in the chat input; `submit` fires; `store.setLastUserMessage(text)`.
2. `createEffect` in `RootApp` observes the change, debounces 300ms.
3. `runMemorySearch(client, query, topK)` (new signature: WS client instead of MemoryRouter) sends `{ type: "memory-search-request", queryText, topK: 10 }`.
4. WS server receives, switches on `type`, calls `chat.searchMemory({ queryText, topK })`.
5. chat-service runs `Stream.runCollect(memoryRouter.search({ queryText, topK }))`, maps records to hits, coerces `content: unknown → string`.
6. chat-service returns `Effect<{ hits }>`. Server sends `{ type: "memory-search-result", queryText, hits }`.
7. TUI's `runMemorySearch` receives, compares echoed `queryText` to `store.lastUserMessage()` — if drift, drop. Otherwise calls `store.setMemorySearch({ status: "ready", query, hits })`.
8. MemoriesTab re-renders with hits.

### Error path

5'. chat-service catches a failure (no vector backend, backend exception, etc.). Server sends `{ type: "memory-search-error", queryText, message, kind }`.
6'. TUI's `runMemorySearch` receives, compares echoed queryText, calls `store.setMemorySearch({ status: "error", query, message })`.

### Stale result drop

User types "ab" while result for "a" is still in flight:
- TUI sends request for "ab"; old request for "a" is still pending server-side.
- Server returns result for "a" first (with `queryText: "a"`).
- TUI's response handler compares to `store.lastUserMessage()` ("ab") — mismatch → drop silently. No store update.
- Server returns result for "ab"; matches → store updates.

## Server Implementation

### chat-service addition

In `packages/chat-service/src/chat-service.ts`, alongside the existing closure declarations (between `listThreads` at line 789 and `closeThread` at line 800):

```typescript
const searchMemory = (args: { queryText: string; topK?: number }): Effect.Effect<
  { hits: ReadonlyArray<MemorySearchHit> } | { error: { message: string; kind: "no-vector-backend" | "internal" } },
  never
> =>
  Effect.gen(function* () {
    const router = yield* MemoryRouter
    const collect = Stream.runCollect(router.search({ queryText: args.queryText, topK: args.topK ?? 10 }))
    const chunk = yield* Effect.either(collect)
    if (chunk._tag === "Left") {
      const err = chunk.left
      const kind = err.cause instanceof Error && err.cause.message.includes("no vector backends")
        ? "no-vector-backend"
        : "internal"
      return { error: { message: err.cause instanceof Error ? err.cause.message : String(err.cause), kind } }
    }
    const hits = Array.from(chunk.right).map(({ record, score }) => ({
      id: record.id,
      kind: record.kind,
      content: typeof record.content === "string" ? record.content : JSON.stringify(record.content),
      score,
    }))
    return { hits }
  })
```

Add `searchMemory` to the return-object at line 811. The `MemoryRouter` Effect dependency needs to flow into the ChatService context — verified during plan phase (likely already in scope via `MemoryToolsLayer`).

### ui-ws server case

In `packages/ui-ws/src/server.ts`, add a new case to the switch around line 618 (alongside `list-threads`):

```typescript
case "memory-search-request": {
  if (chat === null) return
  const result = yield* chat.searchMemory({
    queryText: frame.queryText,
    ...(frame.topK !== undefined ? { topK: frame.topK } : {}),
  })
  if ("error" in result) {
    send(ws, {
      type: "memory-search-error",
      queryText: frame.queryText,
      message: result.error.message,
      kind: result.error.kind,
    })
  } else {
    send(ws, {
      type: "memory-search-result",
      queryText: frame.queryText,
      hits: result.hits,
    })
  }
  return
}
```

## TUI Implementation

### memory-search.ts rewrite

New signature uses the existing `LunaWsClient` to send/receive frames:

```typescript
import type { LunaWsClient } from "../chat/ws-client.js"
import type { MemorySearchHit, MemorySearchState } from "./panel-types.js"

export const runMemorySearch = async (
  client: LunaWsClient,
  query: string,
  topK: number,
): Promise<MemorySearchState> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { status: "idle" }

  // Send the request frame; await the matching response.
  client.send({ type: "memory-search-request", queryText: trimmed, topK })

  // Subscribe to the next memory-search-result OR memory-search-error
  // whose echoed queryText matches `trimmed`. (Implementation depends on
  // the actual LunaWsClient API — likely .nextFrame() with a predicate
  // or a one-shot subscription via session events.)
  const matched = await waitForMatchingFrame(client, trimmed)

  if (matched.type === "memory-search-error") {
    return { status: "error", query: trimmed, message: matched.message }
  }
  return {
    status: "ready",
    query: trimmed,
    hits: matched.hits.map((h) => ({ ...h })),  // detach readonly wire shape
  }
}
```

The exact `waitForMatchingFrame` helper depends on whether the existing `LunaHeadlessSession` already exposes a way to filter frames, or whether we need to add one. Most likely: use the `rawFrame` event added in Phase 2 Task 1, with a one-shot listener that resolves when a matching frame arrives. Plan-phase detail.

### mount.ts cleanup

Delete from `apps/agent-cli/src/tui/mount.ts`:
- The `InMemoryBackend` + `makeRouter` block (Phase 2 Task 10, lines ~48–53).
- The `@luna/memory` import (if nothing else uses it).

Update the `runMemorySearch` call site in the debounced `createEffect`:
- Old: `runMemorySearch(memoryRouter, query, 10)`
- New: `runMemorySearch(client, query, 10)`

The `client` is the already-resolved `LunaWsClient` from `connectWithRecovery`, in scope inside `mountTui`.

## Error Handling

| Failure | Behavior |
|---|---|
| Server returns `memory-search-error` (no-vector-backend) | Panel shows `error: no vector backends registered`. Future memory writes won't help — this means the server itself is misconfigured (e.g., `LUNA_MEMORY_DB` not set or backend layer not provided). |
| Server returns `memory-search-error` (internal) | Panel shows `error: <message>`. Subsequent queries retry. |
| WS connection drops mid-query | The pending request never resolves. The `createEffect` will re-fire on the next `lastUserMessage` change (or never). Acceptable for v1 — no timeout. **Plan phase decides** whether to add a 10s safety timeout that returns an error state. |
| Server malformed response | The frame parser will reject; existing WS error handling kicks in. Out of scope. |
| Stale result (race) | Echoed `queryText` mismatch → drop silently. No user-visible artifact. |
| chat-service receives request before MemoryRouter is in context | `chat === null` guard at the top of the case. Returns silently. UI shows `loading` until next query. (Same behavior as `list-threads` in the same edge case.) |

## Testing

### Unit tests (Vitest)

**Protocol layer** (`packages/ui-ws/test/`):
- Encode/decode `MemorySearchRequestFrame`, `MemorySearchResultFrame`, `MemorySearchErrorFrame`. Existing frame round-trip test pattern (if any) extended; otherwise tablestakes parse-and-reserialize.

**chat-service** (`packages/chat-service/test/`):
- `searchMemory` happy path: fake MemoryRouter returns 2 hits; assert `{ hits }` with content coerced to string.
- `searchMemory` empty: returns `{ hits: [] }`.
- `searchMemory` Effect failure: returns `{ error: { ..., kind: "internal" } }`.
- `searchMemory` no-vector-backend specifically: returns `{ error: { ..., kind: "no-vector-backend" } }`.
- Content coercion: `record.content = { foo: "bar" }` → hit.content is `'{"foo":"bar"}'`.

**TUI memory-search** (`apps/agent-cli/test/memory-search.test.ts`):
- Update existing 4-case test to mock the WS client instead of a MemoryRouter.
- Add stale-result drop case: send query "ab", emit result for "a" → state unchanged.

**ui-ws server case** (`packages/ui-ws/test/server.test.ts` if it exists; otherwise integration via the existing test harness):
- Client sends `memory-search-request` → server calls `chat.searchMemory` → server emits result or error frame.

### Smoke test (manual, tmux)

Same shape as Phase 2's Task 11. Launch `luna chat --dev`, send a message, observe Memories tab transitions through `loading → ready` (or `error` if the dev server has no embedder). Verify hit list renders when memories exist.

To prove the cross-machine round-trip:
1. SSH to luna-server, run `LUNA_EMBEDDER=ollama` (or stub) and pre-seed a memory via the agent's tool path.
2. From Mac TUI, query for that text. Verify hit appears.

## Open Questions

1. **`waitForMatchingFrame` helper shape.** Does `LunaHeadlessSession` already provide a frame filter, or do we add a one-shot listener via `rawFrame`? Plan-phase research.
2. **MemoryRouter Effect context wiring into chat-service.** Confirmed the chat-service has access to other Effect services (`store`, `clock`) — adding MemoryRouter follows the same pattern. Plan-phase verifies the Layer composition in `apps/ui-web/scripts/chat-server.ts`.
3. **Request timeout.** v1 doesn't add one (rely on connection-drop semantics). Re-evaluate if real usage shows hung queries.

## References

- Phase 2 plan: [2026-05-26-tui-phase-2-context-panel.md](../plans/2026-05-26-tui-phase-2-context-panel.md)
- TUI shape spec: [2026-05-26-tui-shape-design.md](./2026-05-26-tui-shape-design.md) (lives on master)
- Existing request/response precedent: `packages/ui-ws/src/server.ts:618` (`list-threads`)
- chat-service factory: `packages/chat-service/src/chat-service.ts:789–818`
- SqliteVectorBackend: `packages/memory/src/backends/sqlite-vector.ts`
- MemoryRouter interface: `packages/memory/src/router.ts:57`
