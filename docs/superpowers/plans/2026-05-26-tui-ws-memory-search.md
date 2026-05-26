# TUI WS Memory Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the TUI's local stub memory router with a WebSocket round-trip to the chat-service's `SqliteVectorBackend`, so the Memories tab shows what the server actually has stored.

**Architecture:** Three new frame types in `@luna/ui-ws` (request + success result + error). One new case in the existing `ui-ws/server.ts` client-frame switch (mirrors `list-threads`). One new method `searchMemory` on `ChatService` that delegates to the already-provided `MemoryRouterTag`. One new method `searchMemory` on `LunaHeadlessSession` that wraps the send + filtered-await over `rawFrame`. The TUI's existing `runMemorySearch` swaps from `MemoryRouter` to session-mediated.

**Tech Stack:** TypeScript strict, Effect.ts (already used throughout chat-service), Vitest, OpenTUI Solid (TUI side), `@luna/memory`'s existing `MemoryRouterTag` + `SqliteVectorBackend`.

---

## File Structure

**Modify:**
- `packages/ui-ws/src/protocol.ts` — three new interfaces + union additions
- `packages/chat-service/src/chat-service.ts` — `searchMemory` function + return-object entry
- `packages/ui-ws/src/server.ts` — one new case in the client-frame switch
- `apps/agent-cli/src/chat/headless.ts` — `searchMemory` method on `LunaHeadlessSession`
- `apps/agent-cli/src/tui/memory-search.ts` — rewrite to use session, drop `MemoryRouter` import
- `apps/agent-cli/src/tui/panel-types.ts` — drop local `MemorySearchHit`, re-export from `@luna/ui-ws`
- `apps/agent-cli/src/tui/mount.ts` — delete `InMemoryBackend`/`makeRouter` block, pass session to `runMemorySearch`

**Test files affected:**
- `packages/chat-service/test/*` — new test for `searchMemory` (create file if no existing test fits)
- `apps/agent-cli/test/headless.test.ts` — new test for session `searchMemory`
- `apps/agent-cli/test/memory-search.test.ts` — rewrite test cases for new signature

---

## Task 1: Add memory-search frames to `@luna/ui-ws/protocol.ts`

**Files:**
- Modify: `packages/ui-ws/src/protocol.ts`

**Context:** Adds three new frame interfaces to the protocol package and extends the two discriminated unions. The new `MemorySearchHit` interface is the canonical wire shape; `panel-types.ts` will re-export it in Task 2 so existing TUI consumers don't break. The error frame's `kind` literal lets future telemetry distinguish "server misconfigured" from "transient" without UI changes.

- [ ] **Step 1: Add the new interfaces**

Open `packages/ui-ws/src/protocol.ts`. After the existing `LocalShellStatusFrame` definition (around line 153), and before the `ServerFrame =` union (around line 155), insert:

```typescript
/* ── memory search ──────────────────────────────────────────────────── */

export interface MemorySearchHit {
  readonly id: string
  readonly kind: string
  readonly content: string
  readonly score: number
}

export interface MemorySearchResultFrame {
  readonly type: "memory-search-result"
  readonly queryText: string
  readonly hits: ReadonlyArray<MemorySearchHit>
}

export type MemorySearchErrorKind = "no-vector-backend" | "internal"

export interface MemorySearchErrorFrame {
  readonly type: "memory-search-error"
  readonly queryText: string
  readonly message: string
  readonly kind: MemorySearchErrorKind
}
```

- [ ] **Step 2: Add to the `ServerFrame` union**

Locate the `ServerFrame =` union (currently around line 155). Add the two new variants alongside the others. The result should look like:

```typescript
export type ServerFrame =
  | HelloFrame
  | EventFrame
  | DropFrame
  | PingFrame
  | ByeFrame
  | ThreadListFrame
  | ThreadCreatedFrame
  | ThreadSnapshotFrame
  | UserAcceptedFrame
  | AssistantDeltaFrame
  | AssistantDoneFrame
  | AssistantErrorFrame
  | ArtifactsExtractedFrame
  | AccountListFrame
  | LocalShellRequestFrame
  | LocalShellStatusFrame
  | MemorySearchResultFrame
  | MemorySearchErrorFrame
```

(Preserve the order of existing variants; just append the two new ones at the end.)

- [ ] **Step 3: Add the request frame interface**

After the existing `LocalShellResultFrame` definition (the last client-frame interface, around line 243), insert:

```typescript
export interface MemorySearchRequestFrame {
  readonly type: "memory-search-request"
  readonly queryText: string
  readonly topK?: number
}
```

- [ ] **Step 4: Add to the `ClientFrame` union**

Locate the `ClientFrame =` union (currently around line 255). Append `| MemorySearchRequestFrame` at the end:

```typescript
export type ClientFrame =
  | PongFrame
  | SubscribeThreadFrame
  | UnsubscribeThreadFrame
  | ListThreadsFrame
  | NewThreadFrame
  | UserMessageFrame
  | InterruptFrame
  | LocalShellCapabilityFrame
  | LocalShellResultFrame
  | MemorySearchRequestFrame
```

- [ ] **Step 5: Typecheck**

Run: `cd packages/ui-ws && bun run typecheck` (or from repo root: `bun --filter @luna/ui-ws run typecheck`)
Expected: passes — no consumers of `ServerFrame`/`ClientFrame` should break because the unions only grew.

If a consumer does break (e.g., an exhaustive switch missing the new cases), STOP and report. That's a regression risk that needs the broken consumer fixed too — likely in a downstream task, but we need to know now.

- [ ] **Step 6: Commit**

```bash
git add packages/ui-ws/src/protocol.ts
git commit -m "feat(ui-ws): add memory-search request/result/error frames"
```

---

## Task 2: Re-export `MemorySearchHit` from `panel-types.ts`

**Files:**
- Modify: `apps/agent-cli/src/tui/panel-types.ts`

**Context:** Phase 2 defined `MemorySearchHit` locally in `panel-types.ts`. Now that the wire-shape canonical version exists in `@luna/ui-ws` (Task 1), the local definition needs to become a re-export so the two can never drift. Existing imports from `panel-types.ts` continue to work — they just resolve to the wire type.

- [ ] **Step 1: Replace the local definition with a re-export**

Open `apps/agent-cli/src/tui/panel-types.ts`. The current file (from Phase 2) defines `MemorySearchHit` directly:

```typescript
export type MemorySearchHit = {
  readonly id: string
  readonly kind: string
  readonly content: string
  readonly score: number
}
```

Replace those 6 lines with this single re-export line:

```typescript
export type { MemorySearchHit } from "@luna/ui-ws"
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/agent-cli && bun run typecheck`
Expected: passes. All existing `MemoriesTab.tsx`, `memory-search.ts`, and store consumers continue to compile because the structural shape is identical.

- [ ] **Step 3: Run the full test suite**

Run: `cd apps/agent-cli && bun run test`
Expected: 118 passed, 7 skipped — no regressions. (Phase 2's tests use `MemorySearchHit` only by reference; the re-export is transparent.)

- [ ] **Step 4: Commit**

```bash
git add apps/agent-cli/src/tui/panel-types.ts
git commit -m "refactor(tui): re-export MemorySearchHit from @luna/ui-ws"
```

---

## Task 3: Add `searchMemory` to `ChatService`

**Files:**
- Modify: `packages/chat-service/src/chat-service.ts`
- Create or modify: `packages/chat-service/test/search-memory.test.ts` (create new test file)

**Context:** `ChatService` is an `Effect.Service`-based class with its capabilities returned from a `scoped: Effect.gen(...)` block. The scoped block already pulls in `SessionStore`, `SDKAdapter`, `CoreClock`, `ObservabilityService`, `TelemetryService` via `yield* ServiceName`. We add `MemoryRouterTag` to that list, declare a new closure function `searchMemory`, and add it to the return-object at the end (currently `{ createThread, send, interrupt, subscribe, listThreads, closeThread }`). The Layer composition in `chat-server.ts` already provides `MemoryRouterTag` via `MemoryToolsLayer`, so no Layer wiring is needed.

The return type uses a tagged result `{ hits: ... } | { error: { ... } }` rather than Effect failure so the WS handler can pattern-match cleanly and the chat-service doesn't have to swallow the Effect itself.

- [ ] **Step 1: Write the failing test**

Create `packages/chat-service/test/search-memory.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { ChatService } from "../src/chat-service.js"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"

// Other ChatService dependencies still need to be provided. Look at an
// existing ChatService test for the canonical "test dependencies layer"
// (likely something like packages/chat-service/test/test-layers.ts or
// inline test setup in chat-service.test.ts). Reuse that.

const makeFakeRouter = (
  results: Array<{ id: string; kind: string; content: unknown; score: number }>,
): MemoryRouter => ({
  search: (_args: { queryText: string; topK?: number }) =>
    Stream.fromIterable(
      results.map((r) => ({
        record: {
          id: r.id,
          namespace: "default",
          kind: r.kind,
          content: r.content,
          schemaVersion: 1,
          createdAt: 0,
          updatedAt: 0,
          tags: [],
        },
        score: r.score,
      })),
    ),
  // The MemoryRouter interface has other methods (put, get, list, delete,
  // exportAll, importAll). Stub them as Effect/Stream that should never be
  // called during search tests:
  put: () => Effect.die("router.put unused in searchMemory tests"),
  get: () => Effect.die("router.get unused in searchMemory tests"),
  list: () => Stream.die("router.list unused in searchMemory tests"),
  delete: () => Effect.die("router.delete unused in searchMemory tests"),
  exportAll: () => Effect.die("router.exportAll unused in searchMemory tests"),
  importAll: () => Effect.die("router.importAll unused in searchMemory tests"),
})

describe("ChatService.searchMemory", () => {
  it("returns hits with content coerced to string for string content", async () => {
    const router = makeFakeRouter([
      { id: "m1", kind: "feedback", content: "hello world", score: 0.9 },
      { id: "m2", kind: "project", content: "another", score: 0.8 },
    ])

    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "hello", topK: 5 })
    }).pipe(
      Effect.provide(Layer.succeed(MemoryRouterTag, router)),
      // Provide ChatService.Default plus any other deps it needs —
      // copy from an existing passing ChatService test.
    )

    const result = await Effect.runPromise(program)
    if ("error" in result) throw new Error(`expected hits, got error: ${result.error.message}`)
    expect(result.hits.length).toBe(2)
    expect(result.hits[0]).toEqual({ id: "m1", kind: "feedback", content: "hello world", score: 0.9 })
  })

  it("coerces non-string content via JSON.stringify", async () => {
    const router = makeFakeRouter([
      { id: "m1", kind: "feedback", content: { note: "structured" }, score: 0.7 },
    ])
    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "x", topK: 5 })
    }).pipe(Effect.provide(Layer.succeed(MemoryRouterTag, router)))
    const result = await Effect.runPromise(program)
    if ("error" in result) throw new Error("expected hits")
    expect(result.hits[0]?.content).toBe('{"note":"structured"}')
  })

  it("returns error with kind=no-vector-backend when search fails with that message", async () => {
    const router: MemoryRouter = {
      ...makeFakeRouter([]),
      search: () => Stream.fail(new Error("no vector backends registered")),
    }
    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "x", topK: 5 })
    }).pipe(Effect.provide(Layer.succeed(MemoryRouterTag, router)))
    const result = await Effect.runPromise(program)
    if (!("error" in result)) throw new Error("expected error")
    expect(result.error.kind).toBe("no-vector-backend")
    expect(result.error.message).toContain("no vector backends")
  })

  it("returns error with kind=internal for other failures", async () => {
    const router: MemoryRouter = {
      ...makeFakeRouter([]),
      search: () => Stream.fail(new Error("DB locked")),
    }
    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "x", topK: 5 })
    }).pipe(Effect.provide(Layer.succeed(MemoryRouterTag, router)))
    const result = await Effect.runPromise(program)
    if (!("error" in result)) throw new Error("expected error")
    expect(result.error.kind).toBe("internal")
    expect(result.error.message).toContain("DB locked")
  })

  it("uses topK=10 default when omitted", async () => {
    let receivedTopK: number | undefined
    const router: MemoryRouter = {
      ...makeFakeRouter([]),
      search: (args) => {
        receivedTopK = args.topK
        return Stream.fromIterable([])
      },
    }
    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "x" })
    }).pipe(Effect.provide(Layer.succeed(MemoryRouterTag, router)))
    await Effect.runPromise(program)
    expect(receivedTopK).toBe(10)
  })
})
```

NOTE: The implementer must find the ChatService test setup (likely `packages/chat-service/test/chat-service.test.ts` or similar) and reuse its dependency-provision pattern for all ChatService deps other than `MemoryRouterTag`. Don't invent a parallel test harness — use the existing one. If unclear, dispatch the test against a single existing fixture and the failures will tell you what to add.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/chat-service && bun run test --run search-memory`
Expected: FAIL — `svc.searchMemory is not a function`.

- [ ] **Step 3: Add `MemoryRouterTag` import**

Open `packages/chat-service/src/chat-service.ts`. At the top of the file with the other imports, add:

```typescript
import { MemoryRouterTag } from "@luna/memory"
import { Chunk } from "effect"  // if not already imported
```

(`Chunk` may already be imported via the existing imports — check first.)

- [ ] **Step 4: Pull in the router in the scoped block**

Locate the `scoped: Effect.gen(function* () {` block (around line 172). Just after the existing `yield* TelemetryService` line (around line 177), add:

```typescript
const memoryRouter = yield* MemoryRouterTag
```

Final order of the dependency block should look like:

```typescript
scoped: Effect.gen(function* () {
  const store = yield* SessionStore
  const adapter = yield* SDKAdapter
  const clock = yield* CoreClock
  const obs = yield* ObservabilityService
  const tel = yield* TelemetryService
  const memoryRouter = yield* MemoryRouterTag
  const serviceScope = yield* Effect.scope
```

- [ ] **Step 5: Add the `searchMemory` function**

Find the `listThreads` definition (around line 789). Immediately after `listThreads` ends (around line 795–796, before `closeThread` at ~800), insert:

```typescript
      /** Read-only memory search delegating to the wired MemoryRouter.
       *  Errors are tagged in the result rather than failing the Effect,
       *  so the WS handler can pattern-match cleanly. */
      const searchMemory = (args: {
        readonly queryText: string
        readonly topK?: number
      }): Effect.Effect<
        | { readonly hits: ReadonlyArray<{ id: string; kind: string; content: string; score: number }> }
        | { readonly error: { readonly message: string; readonly kind: "no-vector-backend" | "internal" } },
        never
      > =>
        Effect.gen(function* () {
          const collect = Stream.runCollect(
            memoryRouter.search({ queryText: args.queryText, topK: args.topK ?? 10 }),
          )
          const either = yield* Effect.either(collect)
          if (either._tag === "Left") {
            const cause = either.left.cause
            const msg = cause instanceof Error ? cause.message : String(cause)
            const kind: "no-vector-backend" | "internal" = msg.includes("no vector backends")
              ? "no-vector-backend"
              : "internal"
            return { error: { message: msg, kind } }
          }
          const hits = Array.from(either.right).map(({ record, score }) => ({
            id: record.id,
            kind: record.kind,
            content:
              typeof record.content === "string"
                ? record.content
                : JSON.stringify(record.content),
            score,
          }))
          return { hits }
        })
```

`Stream` is already imported at the top of the file (used by `listThreads`). Verify, and only add the import if absent.

- [ ] **Step 6: Add `searchMemory` to the return-object**

Find the `return {` block (around line 811). Add `searchMemory,` alongside the other returned functions:

```typescript
      return {
        createThread,
        send,
        interrupt,
        subscribe,
        listThreads,
        searchMemory,
        closeThread,
      } as const
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd packages/chat-service && bun run test --run search-memory`
Expected: 5/5 pass.

Also run the full chat-service test suite: `cd packages/chat-service && bun run test`
Expected: no regressions in any existing chat-service test.

- [ ] **Step 8: Commit**

```bash
git add packages/chat-service/src/chat-service.ts packages/chat-service/test/search-memory.test.ts
git commit -m "feat(chat-service): add searchMemory delegating to MemoryRouter"
```

---

## Task 4: Add `memory-search-request` handler to `ui-ws/server.ts`

**Files:**
- Modify: `packages/ui-ws/src/server.ts`

**Context:** The server-side handler. Mirrors the `list-threads` case at server.ts:618 — pulls in the `chat` service (already in scope), calls `chat.searchMemory(...)`, sends one of two result frames depending on the result shape. The `chat === null` guard matches `list-threads`'s safety check.

There's no dedicated test file scaffolding for adding new case branches to this switch; the existing approach in this package is integration-testing via the actual server boot + WS handshake. The Task 5 + Task 6 tests against `LunaHeadlessSession.searchMemory` and the TUI `runMemorySearch` exercise this path end-to-end. So this task ships without an in-package unit test — the integration coverage from downstream tasks suffices. (If a regression appears later, add a focused server test then.)

- [ ] **Step 1: Locate the switch**

Open `packages/ui-ws/src/server.ts`. Find the `case "list-threads":` block (around line 618). The new case goes immediately after it, before `case "new-thread":` (around line 624).

- [ ] **Step 2: Add the case**

Insert this between `list-threads` (line ~622) and `new-thread` (line ~624):

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

Indentation should match the surrounding cases (20 spaces leading).

- [ ] **Step 3: Typecheck**

Run from repo root: `bun --filter @luna/ui-ws run typecheck`
Expected: passes. The `frame` type narrows correctly because TypeScript discriminates on the `case`'s string literal against the `ClientFrame` union.

- [ ] **Step 4: Run the full ui-ws test suite**

Run: `cd packages/ui-ws && bun run test`
Expected: no regressions. (No new tests in this task; existing tests should continue to pass since the switch only gained a case.)

- [ ] **Step 5: Commit**

```bash
git add packages/ui-ws/src/server.ts
git commit -m "feat(ui-ws): handle memory-search-request, emit result or error frame"
```

---

## Task 5: Add `searchMemory` method to `LunaHeadlessSession`

**Files:**
- Modify: `apps/agent-cli/src/chat/headless.ts`
- Modify: `apps/agent-cli/test/headless.test.ts`

**Context:** The TUI's reactive code wants a Promise-based API: send a query, get back a result or error, no manual frame plumbing. The session is the right home because it already owns the WS client and the `rawFrame` event (added in Phase 2 Task 1). The method sends the request via `client.send`, registers a one-shot `rawFrame` listener that filters for the matching `memory-search-result` or `memory-search-error` (matched on `queryText`), resolves the Promise with the matched frame, and unregisters itself.

Echoed-query-text matching protects against stale results: if a previous in-flight query is still racing back, its response won't satisfy the current listener and is silently dropped.

- [ ] **Step 1: Write the failing tests**

Open `apps/agent-cli/test/headless.test.ts`. After the existing `rawFrame` test (added in Phase 2 Task 1), add this block:

```typescript
describe("LunaHeadlessSession.searchMemory", () => {
  it("resolves with the matching result frame", async () => {
    const { session, client } = makeSessionUnderTest()
    void session.run()

    const promise = session.searchMemory({ queryText: "hello", topK: 5 })

    // Simulate server-side handler responding.
    await new Promise((r) => setTimeout(r, 5))
    client.emit({
      type: "memory-search-result",
      queryText: "hello",
      hits: [{ id: "m1", kind: "feedback", content: "hello world", score: 0.9 }],
    })

    const result = await promise
    expect(result.type).toBe("memory-search-result")
    if (result.type !== "memory-search-result") throw new Error("unreachable")
    expect(result.hits.length).toBe(1)
    expect(result.hits[0]?.id).toBe("m1")
  })

  it("resolves with the matching error frame", async () => {
    const { session, client } = makeSessionUnderTest()
    void session.run()

    const promise = session.searchMemory({ queryText: "hello", topK: 5 })
    await new Promise((r) => setTimeout(r, 5))
    client.emit({
      type: "memory-search-error",
      queryText: "hello",
      message: "no vector backends registered",
      kind: "no-vector-backend",
    })

    const result = await promise
    expect(result.type).toBe("memory-search-error")
    if (result.type !== "memory-search-error") throw new Error("unreachable")
    expect(result.message).toContain("no vector backends")
    expect(result.kind).toBe("no-vector-backend")
  })

  it("ignores stale results whose queryText does not match", async () => {
    const { session, client } = makeSessionUnderTest()
    void session.run()

    const promise = session.searchMemory({ queryText: "ab", topK: 5 })

    // Stale: earlier query "a" result arrives first.
    await new Promise((r) => setTimeout(r, 5))
    client.emit({
      type: "memory-search-result",
      queryText: "a",
      hits: [],
    })

    // Then the matching one.
    client.emit({
      type: "memory-search-result",
      queryText: "ab",
      hits: [{ id: "m2", kind: "project", content: "ab match", score: 0.5 }],
    })

    const result = await promise
    if (result.type !== "memory-search-result") throw new Error("unreachable")
    expect(result.queryText).toBe("ab")
    expect(result.hits[0]?.id).toBe("m2")
  })

  it("sends the request frame with the queryText and topK", async () => {
    const { session, client } = makeSessionUnderTest()
    void session.run()

    void session.searchMemory({ queryText: "test", topK: 7 })
    await new Promise((r) => setTimeout(r, 5))

    expect(client.sent).toContainEqual({
      type: "memory-search-request",
      queryText: "test",
      topK: 7,
    })
  })

  it("omits topK from the request when not provided", async () => {
    const { session, client } = makeSessionUnderTest()
    void session.run()

    void session.searchMemory({ queryText: "test" })
    await new Promise((r) => setTimeout(r, 5))

    expect(client.sent).toContainEqual({
      type: "memory-search-request",
      queryText: "test",
    })
  })
})
```

Note: this test assumes `makeSessionUnderTest()` from the existing test file returns `{ session, client }` where `client` is a `StubWsClient` with a `sent: ClientFrame[]` array and an `emit(frame)` method. That's the pattern already in use from the Phase 1 + Phase 2 tests. If the existing helper doesn't expose `sent`, add it as a one-line change in the test-file's helper.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent-cli && bun run test --run headless`
Expected: FAIL — `session.searchMemory is not a function` (or equivalent).

- [ ] **Step 3: Implement `searchMemory` on the session**

Open `apps/agent-cli/src/chat/headless.ts`. Find the `sendUser` method (around line 87). After `sendUser` and before the `run` method (around line 100), add:

```typescript
  searchMemory(args: {
    readonly queryText: string
    readonly topK?: number
  }): Promise<
    | import("@luna/ui-ws").MemorySearchResultFrame
    | import("@luna/ui-ws").MemorySearchErrorFrame
  > {
    return new Promise((resolve) => {
      const onFrame = (frame: import("@luna/ui-ws").ServerFrame): void => {
        if (
          (frame.type === "memory-search-result" ||
            frame.type === "memory-search-error") &&
          frame.queryText === args.queryText
        ) {
          this.off("rawFrame", onFrame)
          resolve(frame)
        }
      }
      this.on("rawFrame", onFrame)
      this.client.send({
        type: "memory-search-request",
        queryText: args.queryText,
        ...(args.topK !== undefined ? { topK: args.topK } : {}),
      })
    })
  }
```

If the existing file already imports `ServerFrame`, `MemorySearchResultFrame`, `MemorySearchErrorFrame` from `@luna/ui-ws`, replace the inline `import("@luna/ui-ws").X` with the named types for cleaner code. Otherwise keep the inline imports — they're correct and don't require touching the existing import block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/agent-cli && bun run test --run headless`
Expected: 5/5 new searchMemory tests pass; existing 3 headless tests still pass.

Also run full suite: `cd apps/agent-cli && bun run test`
Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-cli/src/chat/headless.ts apps/agent-cli/test/headless.test.ts
git commit -m "feat(headless): add searchMemory with stale-result drop"
```

---

## Task 6: Rewrite TUI `runMemorySearch` to use the session

**Files:**
- Modify: `apps/agent-cli/src/tui/memory-search.ts`
- Modify: `apps/agent-cli/test/memory-search.test.ts`

**Context:** The function's external contract (return `Promise<MemorySearchState>`, return `idle` for empty/whitespace query) stays the same. The internals replace the local Effect/Stream path with a single `session.searchMemory(...)` call. The existing tests need their fake `MemoryRouter` swapped for a fake session — the new test fixture is much simpler (just a mock with a `searchMemory` method).

- [ ] **Step 1: Replace existing tests with the new fixture-driven cases**

Open `apps/agent-cli/test/memory-search.test.ts`. Replace the entire file contents with:

```typescript
import { describe, expect, it } from "vitest"
import { runMemorySearch } from "../src/tui/memory-search.js"
import type {
  MemorySearchResultFrame,
  MemorySearchErrorFrame,
} from "@luna/ui-ws"

type SessionLike = Parameters<typeof runMemorySearch>[0]

const makeFakeSession = (
  respond: (args: { queryText: string; topK?: number }) =>
    | MemorySearchResultFrame
    | MemorySearchErrorFrame,
): SessionLike => {
  return {
    searchMemory: async (args) => respond(args),
  } as SessionLike
}

describe("runMemorySearch (WS-mediated)", () => {
  it("returns ready with hits on success", async () => {
    const session = makeFakeSession((args) => ({
      type: "memory-search-result",
      queryText: args.queryText,
      hits: [
        { id: "m1", kind: "feedback", content: "hello", score: 0.9 },
        { id: "m2", kind: "project", content: "world", score: 0.7 },
      ],
    }))
    const result = await runMemorySearch(session, "hello world", 10)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("unreachable")
    expect(result.hits.length).toBe(2)
    expect(result.hits[0]).toEqual({ id: "m1", kind: "feedback", content: "hello", score: 0.9 })
    expect(result.query).toBe("hello world")
  })

  it("returns ready with empty hits when server returns no matches", async () => {
    const session = makeFakeSession((args) => ({
      type: "memory-search-result",
      queryText: args.queryText,
      hits: [],
    }))
    const result = await runMemorySearch(session, "nothing", 10)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("unreachable")
    expect(result.hits.length).toBe(0)
  })

  it("returns error when server replies with memory-search-error frame", async () => {
    const session = makeFakeSession((args) => ({
      type: "memory-search-error",
      queryText: args.queryText,
      message: "no vector backends registered",
      kind: "no-vector-backend",
    }))
    const result = await runMemorySearch(session, "x", 10)
    expect(result.status).toBe("error")
    if (result.status !== "error") throw new Error("unreachable")
    expect(result.message).toContain("no vector backends")
  })

  it("returns idle for empty query", async () => {
    let called = false
    const session = makeFakeSession((args) => {
      called = true
      return {
        type: "memory-search-result",
        queryText: args.queryText,
        hits: [],
      }
    })
    const result = await runMemorySearch(session, "  ", 10)
    expect(result.status).toBe("idle")
    expect(called).toBe(false) // empty query should NOT send a request
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/agent-cli && bun run test --run memory-search`
Expected: FAIL — type error or runtime error because `runMemorySearch` currently takes `MemoryRouter`, not session.

- [ ] **Step 3: Rewrite `memory-search.ts`**

Open `apps/agent-cli/src/tui/memory-search.ts`. Replace the entire file with:

```typescript
import type { LunaHeadlessSession } from "../chat/headless.js"
import type { MemorySearchHit, MemorySearchState } from "./panel-types.js"

type SessionWithSearchMemory = Pick<LunaHeadlessSession, "searchMemory">

export const runMemorySearch = async (
  session: SessionWithSearchMemory,
  query: string,
  topK: number,
): Promise<MemorySearchState> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { status: "idle" }

  const frame = await session.searchMemory({ queryText: trimmed, topK })

  if (frame.type === "memory-search-error") {
    return { status: "error", query: trimmed, message: frame.message }
  }

  const hits: MemorySearchHit[] = frame.hits.map((h) => ({
    id: h.id,
    kind: h.kind,
    content: h.content,
    score: h.score,
  }))
  return { status: "ready", query: trimmed, hits }
}
```

The `SessionWithSearchMemory` type lets tests pass a stub without instantiating the full `LunaHeadlessSession`. This is the same `Pick` pattern used throughout the codebase for testability.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/agent-cli && bun run test --run memory-search`
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-cli/src/tui/memory-search.ts apps/agent-cli/test/memory-search.test.ts
git commit -m "feat(tui): runMemorySearch uses session.searchMemory instead of local router"
```

---

## Task 7: Wire `mount.ts` to the new signature; delete the local router

**Files:**
- Modify: `apps/agent-cli/src/tui/mount.ts`

**Context:** With the session-based `runMemorySearch` in place, the local `InMemoryBackend` + `makeRouter` construction in `mountTui` (Phase 2 Task 10, around lines 48–53) is no longer needed. Removing it eliminates the source of the "no vector backends registered" error message the panel was showing. The `createEffect` call site updates from `runMemorySearch(memoryRouter, query, 10)` to `runMemorySearch(session, query, 10)`.

- [ ] **Step 1: Locate the InMemoryBackend block in mount.ts**

Open `apps/agent-cli/src/tui/mount.ts`. Find the construction of `memoryRouter` (per Phase 2 Task 10, around lines 48–53). It looks like:

```typescript
  const memoryBackend = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* InMemoryBackend
    }).pipe(Effect.provide(InMemoryBackend.Default)),
  )
  const memoryRouter = makeRouter([{ pattern: "*", backend: memoryBackend }])
```

(Exact line range may vary slightly — search for `memoryRouter` or `InMemoryBackend`.)

- [ ] **Step 2: Delete the block**

Remove the `memoryBackend` construction and `memoryRouter` assignment in their entirety. Also remove these imports if they're no longer used anywhere else in `mount.ts`:

- `import { Effect } from "effect"` (verify nothing else in mount.ts uses Effect; the `createEffect` is from `solid-js`, not `effect`)
- `import { InMemoryBackend, makeRouter } from "@luna/memory"`

If `Effect` is still needed for something else in the file, keep it. If not, delete its line.

- [ ] **Step 3: Update the runMemorySearch call site**

Find the `createEffect` block in `RootApp` that calls `runMemorySearch` (added in Phase 2 Task 10). It currently looks like:

```typescript
    const result = await runMemorySearch(memoryRouter, query, 10)
```

Change to:

```typescript
    const result = await runMemorySearch(session, query, 10)
```

`session` is the `LunaHeadlessSession` instance already in scope from `mountTui` (used by the rest of the mount code; if it isn't currently in scope of `RootApp`'s closure, it's because `RootApp` is defined inside `mountTui` and `session` is declared earlier — verify by reading the surrounding function).

- [ ] **Step 4: Typecheck**

Run: `cd apps/agent-cli && bun run typecheck`
Expected: passes. If a phantom import error appears (e.g., `Effect` no longer referenced), delete the import.

- [ ] **Step 5: Full test suite**

Run: `cd apps/agent-cli && bun run test`
Expected: no regressions. The behavior change is functional, not type-level.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/src/tui/mount.ts
git commit -m "refactor(tui): drop local InMemoryBackend; pass session to runMemorySearch"
```

---

## Task 8: End-to-end smoke test against jax-box

**Files:** None modified.

**Context:** Final manual verification. Drive `luna chat --dev` under tmux and watch the Memories tab populate (or surface a real error message from the server) instead of the bulkhead "An error has occurred". The Phase 1 + 2 debug logging (`LUNA_TUI_DEBUG=/tmp/luna-ws-memory.log`) remains useful.

The expectation: if jax-box's dev server has the stub embedder (the default), the memory store will accept saves but the queries will return either zero hits or low-quality matches (the stub is deterministic but semantically empty). What matters here is that:
1. The WS round-trip completes — Memories tab transitions out of `loading` and into `ready` (with whatever hits the server has) or `error` (with a real server-side message, not the local stub error).
2. Subsequent searches work without hanging.
3. The chat itself is unaffected.

- [ ] **Step 1: Launch in tmux**

```bash
tmux kill-server 2>/dev/null || true
tmux new-session -d -s luna-mem -x 200 -y 50 -e "LUNA_TUI_DEBUG=/tmp/luna-ws-memory.log" "luna chat --dev"
sleep 6
tmux capture-pane -t luna-mem -p | head -55
```

Verify the panel renders with `[Memories (0)]   Events (N)   Artifacts (0)` and Memories body shows `(send a message to search memories)`.

- [ ] **Step 2: Send a message**

```bash
tmux send-keys -t luna-mem "remember the number 42" Enter
sleep 5
tmux capture-pane -t luna-mem -p | head -55
```

The chat column should show `you: remember the number 42` and an assistant response. The Memories tab body should transition: `loading` (briefly) → `ready` with hits OR `error` with a real server-side message.

Inspect debug log for the WS round-trip:

```bash
grep "memory-search" /tmp/luna-ws-memory.log
```

Expect to see the request frame go out and either a `memory-search-result` or `memory-search-error` come back.

- [ ] **Step 3: Verify Events tab shows the round-trip frames**

```bash
tmux send-keys -t luna-mem Tab
sleep 1
tmux capture-pane -t luna-mem -p | head -25
```

The Events tab should list the recent frames including `memory-search-result` or `memory-search-error` near the top (newest first).

- [ ] **Step 4: Second query**

```bash
tmux send-keys -t luna-mem M-1
sleep 1
tmux send-keys -t luna-mem "what number am I remembering" Enter
sleep 5
tmux capture-pane -t luna-mem -p | head -55
```

Verify the chat works and the Memories tab updates again. If hits include any match to the previous "42" turn, the cross-session round-trip is fully working. If not (e.g., stub embedder), the tab still completes — no hang.

- [ ] **Step 5: Clean exit**

```bash
tmux send-keys -t luna-mem "/quit" Enter
sleep 2
tmux has-session -t luna-mem 2>/dev/null && echo "STILL RUNNING - FAIL" || echo "CLEAN EXIT"
tmux kill-server 2>/dev/null
```

- [ ] **Step 6: Report**

If everything above worked: phase complete. If the Memories tab still shows `An error has occurred` (the Phase 2 generic message, not a real server-side one), attach the relevant `/tmp/luna-ws-memory.log` lines — the round-trip is failing somewhere and we need to diagnose.

No code commit for this task — it's verification only. If a bug is found, fix it in a focused follow-up commit and re-run from Step 1.

---

## Done Criteria

- All 8 tasks completed.
- All Vitest tests passing (incremental count: Phase 2 ended at 118 passed; Task 3 adds 5, Task 5 adds 5, Task 6 keeps 4 — final around 132 passed).
- `bun run typecheck` clean across all touched packages.
- TUI Memories tab transitions out of `idle` when a message is sent.
- The bulkhead "An error has occurred" message no longer appears; if there's an error, it's a real server-side message.
- Events tab shows `memory-search-result` or `memory-search-error` frames flowing live.
- `/quit` exits cleanly; terminal restored.
