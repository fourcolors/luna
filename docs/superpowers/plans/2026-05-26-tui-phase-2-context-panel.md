# TUI Phase 2 — Context Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is dispatched to a fresh implementer subagent and reviewed by spec compliance + code quality subagents before being marked complete.

**Goal:** Add a right-side context panel to the Luna TUI with three tabs (Memories / Events / Artifacts), wired to live data via the existing headless session.

**Architecture:** Wrap the Phase-1 single-column layout in a flex-row; the existing chat column becomes the left child, a new `<ContextPanel>` becomes the right child (fixed width 40 cols). The store gains four new pieces of state (active tab, last user message, raw-frame ring buffer, memory results, artifacts-by-thread). The headless session gains one new event (`rawFrame`) so the TUI can observe the unfiltered protocol stream for the Events tab. Memory results come from a debounced `Effect.runPromise(memory.search({...}))` keyed off `lastUserMessage`. Tab switching is keyboard-only (Tab cycles, Ctrl-1/2/3 jumps directly).

**Tech Stack:** OpenTUI + `@opentui/solid` v0.2.15, Solid.js 1.9.12 (reactive build via existing bunfig preload), `@luna/memory` Effect-based search, `@luna/ui-ws` `ServerFrame` discriminated union, Vitest for tests.

**Scope boundary (deliberately deferred to a later phase):**
- ApprovalModal overlay (still uses Phase 1's readline `/dev/tty` prompt)
- Markdown rendering in chat (still raw text)
- Narrow-terminal Ctrl-B overlay (panel only renders at width ≥ 100; below that, panel hidden)
- Slash completion popover
- Multi-line input

These are explicitly **not** in Phase 2. The panel is the user-visible deliverable.

---

## File Structure

**Create:**
- `apps/agent-cli/src/tui/ContextPanel.tsx` — panel shell with tab header + body slot
- `apps/agent-cli/src/tui/MemoriesTab.tsx` — memory search results list
- `apps/agent-cli/src/tui/EventsTab.tsx` — raw-frame ring-buffer view
- `apps/agent-cli/src/tui/ArtifactsTab.tsx` — artifacts list keyed off current thread
- `apps/agent-cli/src/tui/panel-types.ts` — shared `ContextTab` union + label table
- `apps/agent-cli/src/tui/memory-search.ts` — debounced search effect (unit-testable)
- `apps/agent-cli/test/panel-store.test.ts` — store reducers for new state
- `apps/agent-cli/test/memory-search.test.ts` — debounce + bulkhead behavior

**Modify:**
- `apps/agent-cli/src/chat/headless.ts` — emit `rawFrame` event for every received `ServerFrame`
- `apps/agent-cli/test/headless.test.ts` — assert `rawFrame` event fires
- `apps/agent-cli/src/tui/store.ts` — new signals + actions for panel state
- `apps/agent-cli/src/tui/App.tsx` — wrap chat column, add `<ContextPanel>` right child
- `apps/agent-cli/src/tui/mount.ts` — subscribe to `rawFrame`, capture `lastUserMessage`, kick off memory search, route artifacts, dispatch tab hotkeys
- `apps/agent-cli/package.json` — add `@luna/chat-service` as a workspace dep (for the `Artifact` type)

---

## Task 1: Add `rawFrame` event to `LunaHeadlessSession`

**Files:**
- Modify: `apps/agent-cli/src/chat/headless.ts`
- Modify: `apps/agent-cli/test/headless.test.ts`

**Context:** The headless session's `handleFrame` method (around line 181) currently consumes each `ServerFrame` and emits high-level events (`assistantDelta`, `threadChange`, `localShellRequest`, etc.). The Events tab needs to see every frame regardless of whether the high-level event was emitted (e.g., `hello`, `ping`, `drop`, generic `event`). Add a new `rawFrame` event that fires for **every** received `ServerFrame`, before the type-specific dispatch. Subscribers should never affect dispatch — emit first, then dispatch as today.

- [ ] **Step 1: Write the failing test**

In `apps/agent-cli/test/headless.test.ts`, locate the existing test setup pattern (mock `LunaWsClient`, instantiate `LunaHeadlessSession`, attach `vi.fn()` listeners). Add this test:

```typescript
it("emits rawFrame for every received ServerFrame, before dispatch", async () => {
  const { session, client } = makeSessionUnderTest()
  const rawFrameListener = vi.fn()
  const threadChangeListener = vi.fn()
  session.on("rawFrame", rawFrameListener)
  session.on("threadChange", threadChangeListener)

  void session.run() // start the consume loop

  client.emit({ type: "hello", protocolVersion: 1, kinds: [], capabilities: {} })
  client.emit({ type: "ping", ts: 1234 })
  client.emit({
    type: "thread-created",
    thread: { id: "thr_test", title: null, model: "x", profileName: "dev", createdAt: 0, updatedAt: 0 },
  })

  await new Promise((r) => setTimeout(r, 5))

  expect(rawFrameListener).toHaveBeenCalledTimes(3)
  expect(rawFrameListener.mock.calls[0]?.[0]).toMatchObject({ type: "hello" })
  expect(rawFrameListener.mock.calls[1]?.[0]).toMatchObject({ type: "ping" })
  expect(rawFrameListener.mock.calls[2]?.[0]).toMatchObject({ type: "thread-created" })

  // rawFrame fires BEFORE the high-level dispatch
  const rawFrameOrder = rawFrameListener.mock.invocationCallOrder[2] ?? 0
  const threadChangeOrder = threadChangeListener.mock.invocationCallOrder[0] ?? 0
  expect(rawFrameOrder).toBeLessThan(threadChangeOrder)
})
```

If `makeSessionUnderTest` does not exist in this file, extract a helper following the existing test's setup pattern (read the first existing test in the file to copy its mock-client shape).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-cli && bun run test --run headless` (or `bunx vitest run -t "emits rawFrame"`)
Expected: FAIL with `expected "spy" to have been called 3 times, but got 0` (or equivalent — the listener never fires because `rawFrame` is not emitted yet).

- [ ] **Step 3: Add the event type**

In `headless.ts`, find the `LunaHeadlessEvents` type definition (around line 19). Add this line alongside the other event signatures:

```typescript
rawFrame: (frame: ServerFrame) => void
```

If `ServerFrame` is not already imported, add to the top:

```typescript
import type { ServerFrame } from "@luna/ui-ws"
```

- [ ] **Step 4: Emit at the top of `handleFrame`**

Locate the private `handleFrame(frame: ServerFrame): void` method (around line 181). Insert the emit as the very first statement of the method body, before any switch / type discrimination:

```typescript
private handleFrame(frame: ServerFrame): void {
  this.emit("rawFrame", frame)
  // ...existing dispatch logic unchanged...
}
```

The existing dispatch logic — every `case` of the type discrimination, every internal state mutation, every subsequent emit — remains exactly as-is. Do not reorder or combine.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/agent-cli && bun run test --run headless`
Expected: PASS, including the new rawFrame test and all pre-existing headless tests (regression check).

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/src/chat/headless.ts apps/agent-cli/test/headless.test.ts
git commit -m "feat(headless): emit rawFrame event for every received ServerFrame"
```

---

## Task 2: Extend `createTuiStore` with panel state

**Files:**
- Modify: `apps/agent-cli/src/tui/store.ts`
- Create: `apps/agent-cli/src/tui/panel-types.ts`
- Create: `apps/agent-cli/test/panel-store.test.ts`

**Context:** The panel needs five new pieces of reactive state: which tab is active, the last user message (for memory search keying), a ring buffer of raw frames (for the Events tab), memory search results + error, and artifacts-by-thread. Tab values are an enum; the cycle order is `memories → events → artifacts → memories`. The ring buffer is capped at 200 frames (drop oldest on overflow). Artifacts are keyed by thread id because the user may switch threads (a future capability) and we want to show artifacts for the *current* thread.

- [ ] **Step 1: Create `panel-types.ts`**

```typescript
import type { ServerFrame } from "@luna/ui-ws"
import type { Artifact } from "@luna/chat-service"

export type ContextTab = "memories" | "events" | "artifacts"

export const CONTEXT_TAB_ORDER: readonly ContextTab[] = ["memories", "events", "artifacts"] as const

export const CONTEXT_TAB_LABEL: Readonly<Record<ContextTab, string>> = {
  memories: "Memories",
  events: "Events",
  artifacts: "Artifacts",
}

export const cycleContextTab = (current: ContextTab): ContextTab => {
  const idx = CONTEXT_TAB_ORDER.indexOf(current)
  return CONTEXT_TAB_ORDER[(idx + 1) % CONTEXT_TAB_ORDER.length] ?? "memories"
}

export const FRAME_RING_CAPACITY = 200

export type FrameRingEntry = {
  readonly receivedAt: number
  readonly frame: ServerFrame
}

export type MemorySearchHit = {
  readonly id: string
  readonly kind: string
  readonly content: string
  readonly score: number
}

export type MemorySearchState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly query: string }
  | { readonly status: "ready"; readonly query: string; readonly hits: readonly MemorySearchHit[] }
  | { readonly status: "error"; readonly query: string; readonly message: string }

export type ArtifactsByThread = ReadonlyMap<string, readonly Artifact[]>
```

`Artifact` lives in `@luna/chat-service` (re-imported by `@luna/ui-ws/src/protocol.ts` but not re-exported). Add `"@luna/chat-service": "workspace:*"` to `apps/agent-cli/package.json` dependencies as part of this task if it isn't already present, then run `bun install` (or `bun run install:safe` from the repo root if you hit EACCES on bun's babel cache).

- [ ] **Step 2: Write the failing store test**

Create `apps/agent-cli/test/panel-store.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { createTuiStore } from "../src/tui/store.js"
import { CONTEXT_TAB_ORDER, FRAME_RING_CAPACITY } from "../src/tui/panel-types.js"
import type { ServerFrame } from "@luna/ui-ws"

const makeFrame = (i: number): ServerFrame => ({ type: "ping", ts: i })

describe("tui store panel state", () => {
  it("defaults contextPanelTab to memories", () => {
    const store = createTuiStore()
    expect(store.contextPanelTab()).toBe("memories")
  })

  it("setContextPanelTab updates the active tab", () => {
    const store = createTuiStore()
    store.setContextPanelTab("events")
    expect(store.contextPanelTab()).toBe("events")
  })

  it("cycleContextPanelTab walks the canonical order and wraps", () => {
    const store = createTuiStore()
    expect(store.contextPanelTab()).toBe("memories")
    store.cycleContextPanelTab()
    expect(store.contextPanelTab()).toBe("events")
    store.cycleContextPanelTab()
    expect(store.contextPanelTab()).toBe("artifacts")
    store.cycleContextPanelTab()
    expect(store.contextPanelTab()).toBe("memories")
  })

  it("lastUserMessage defaults to empty string and setLastUserMessage updates it", () => {
    const store = createTuiStore()
    expect(store.lastUserMessage()).toBe("")
    store.setLastUserMessage("hi luna")
    expect(store.lastUserMessage()).toBe("hi luna")
  })

  it("pushRawFrame appends frames in order with timestamps", () => {
    const store = createTuiStore()
    store.pushRawFrame(makeFrame(1))
    store.pushRawFrame(makeFrame(2))
    const frames = store.rawFrames()
    expect(frames.length).toBe(2)
    expect(frames[0]?.frame).toMatchObject({ type: "ping", ts: 1 })
    expect(frames[1]?.frame).toMatchObject({ type: "ping", ts: 2 })
    expect(typeof frames[0]?.receivedAt).toBe("number")
  })

  it("pushRawFrame drops oldest when ring buffer exceeds capacity", () => {
    const store = createTuiStore()
    for (let i = 0; i < FRAME_RING_CAPACITY + 5; i++) store.pushRawFrame(makeFrame(i))
    const frames = store.rawFrames()
    expect(frames.length).toBe(FRAME_RING_CAPACITY)
    expect(frames[0]?.frame).toMatchObject({ ts: 5 })
    expect(frames[FRAME_RING_CAPACITY - 1]?.frame).toMatchObject({ ts: FRAME_RING_CAPACITY + 4 })
  })

  it("memorySearch defaults to idle and setMemorySearch updates state", () => {
    const store = createTuiStore()
    expect(store.memorySearch().status).toBe("idle")
    store.setMemorySearch({ status: "loading", query: "hi" })
    expect(store.memorySearch()).toEqual({ status: "loading", query: "hi" })
    store.setMemorySearch({
      status: "ready",
      query: "hi",
      hits: [{ id: "m1", kind: "feedback", content: "test", score: 0.9 }],
    })
    expect(store.memorySearch().status).toBe("ready")
  })

  it("setArtifactsForThread stores artifacts keyed by thread id", () => {
    const store = createTuiStore()
    expect(store.artifactsByThread().size).toBe(0)
    store.setArtifactsForThread("thr_a", [
      { kind: "file", path: "/x.txt", mime: "text/plain", bytes: 10 } as never,
    ])
    expect(store.artifactsByThread().get("thr_a")?.length).toBe(1)
    expect(store.artifactsByThread().get("thr_b")).toBeUndefined()
  })

  it("CONTEXT_TAB_ORDER matches store cycle", () => {
    expect(CONTEXT_TAB_ORDER).toEqual(["memories", "events", "artifacts"])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/agent-cli && bun run test --run panel-store`
Expected: FAIL — `store.contextPanelTab is not a function` and similar for every new property.

- [ ] **Step 4: Implement store extensions**

Open `apps/agent-cli/src/tui/store.ts`. Add imports at the top:

```typescript
import {
  type ContextTab,
  type FrameRingEntry,
  type MemorySearchState,
  type ArtifactsByThread,
  CONTEXT_TAB_ORDER,
  cycleContextTab,
  FRAME_RING_CAPACITY,
} from "./panel-types.js"
import type { ServerFrame, Artifact } from "@luna/ui-ws"
```

Inside the `createTuiStore` function, add these signal declarations alongside the existing ones:

```typescript
const [contextPanelTab, setContextPanelTab] = createSignal<ContextTab>("memories")
const [lastUserMessage, setLastUserMessage] = createSignal<string>("")
const [rawFrames, setRawFrames] = createSignal<readonly FrameRingEntry[]>([])
const [memorySearch, setMemorySearch] = createSignal<MemorySearchState>({ status: "idle" })
const [artifactsByThread, setArtifactsByThread] = createSignal<ArtifactsByThread>(new Map())
```

Add these actions immediately above the `return` statement:

```typescript
const cycleContextPanelTab = (): void => {
  setContextPanelTab((curr) => cycleContextTab(curr))
}

const pushRawFrame = (frame: ServerFrame): void => {
  setRawFrames((curr) => {
    const next = [...curr, { receivedAt: Date.now(), frame }]
    return next.length > FRAME_RING_CAPACITY
      ? next.slice(next.length - FRAME_RING_CAPACITY)
      : next
  })
}

const setArtifactsForThread = (threadId: string, artifacts: readonly Artifact[]): void => {
  setArtifactsByThread((curr) => {
    const next = new Map(curr)
    next.set(threadId, artifacts)
    return next
  })
}
```

Add all new bindings to the returned object literal, alongside the existing ones:

```typescript
return {
  // ...existing entries...
  contextPanelTab,
  setContextPanelTab,
  cycleContextPanelTab,
  lastUserMessage,
  setLastUserMessage,
  rawFrames,
  pushRawFrame,
  memorySearch,
  setMemorySearch,
  artifactsByThread,
  setArtifactsForThread,
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/agent-cli && bun run test --run panel-store`
Expected: PASS — all eight test cases.

Also run the full test suite to verify no regression: `bun run test`.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/src/tui/store.ts apps/agent-cli/src/tui/panel-types.ts apps/agent-cli/test/panel-store.test.ts
git commit -m "feat(tui): extend store with context panel state (tab, lastUserMessage, rawFrames, memorySearch, artifacts)"
```

---

## Task 3: Build `<ContextPanel>` shell with tab header

**Files:**
- Create: `apps/agent-cli/src/tui/ContextPanel.tsx`

**Context:** This is a pure-view Solid component. It receives the store, reads `contextPanelTab`, renders three tab labels in a horizontal header row (active tab visually distinguished — bracketed or bold), and renders the body of whichever tab is active by delegating to `<MemoriesTab>` / `<EventsTab>` / `<ArtifactsTab>` (created in subsequent tasks). For this task, the three tab body components do not exist yet — use placeholder `<text>` nodes returning "(memories tab)" / etc. Subsequent tasks replace those placeholders.

OpenTUI components are tested via real-terminal/manual smoke (no Vitest TUI test infrastructure). This task adds no unit test; the component is validated end-to-end at the final smoke test.

- [ ] **Step 1: Create the component**

Create `apps/agent-cli/src/tui/ContextPanel.tsx`:

```typescript
import { Show } from "solid-js"
import type { TuiStore } from "./store.js"
import { CONTEXT_TAB_LABEL, CONTEXT_TAB_ORDER, type ContextTab } from "./panel-types.js"

export type ContextPanelProps = {
  store: TuiStore
  width: number
  height: number
}

export const ContextPanel = (props: ContextPanelProps) => {
  const tabCount = (tab: ContextTab): number => {
    if (tab === "memories") {
      const state = props.store.memorySearch()
      return state.status === "ready" ? state.hits.length : 0
    }
    if (tab === "events") return props.store.rawFrames().length
    const threadId = props.store.threadId()
    if (threadId === null) return 0
    return props.store.artifactsByThread().get(threadId)?.length ?? 0
  }

  const renderHeader = () => {
    const active = props.store.contextPanelTab()
    return CONTEXT_TAB_ORDER.map((tab: ContextTab) => {
      const label = `${CONTEXT_TAB_LABEL[tab]} (${tabCount(tab)})`
      return tab === active ? `[${label}]` : ` ${label} `
    }).join("  ")
  }

  return (
    <box
      style={{
        flexDirection: "column",
        width: props.width,
        height: props.height,
        borderStyle: "single",
      }}
    >
      <box style={{ width: props.width - 2, padding: 1 }}>
        <text>{renderHeader()}</text>
      </box>
      <box style={{ flexDirection: "column", flexGrow: 1, width: props.width - 2, padding: 1 }}>
        <Show when={props.store.contextPanelTab() === "memories"}>
          <text>(memories tab — populated in Task 4)</text>
        </Show>
        <Show when={props.store.contextPanelTab() === "events"}>
          <text>(events tab — populated in Task 5)</text>
        </Show>
        <Show when={props.store.contextPanelTab() === "artifacts"}>
          <text>(artifacts tab — populated in Task 6)</text>
        </Show>
      </box>
    </box>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/agent-cli && bun run typecheck`
Expected: passes (the component is not yet wired into `<App>`, so it's only checked for self-consistency).

- [ ] **Step 3: Commit**

```bash
git add apps/agent-cli/src/tui/ContextPanel.tsx
git commit -m "feat(tui): add ContextPanel shell with tab header and placeholder bodies"
```

---

## Task 4: Build `<MemoriesTab>`

**Files:**
- Create: `apps/agent-cli/src/tui/MemoriesTab.tsx`

**Context:** Renders the four states of `store.memorySearch()`: idle (no message yet), loading (search in flight), ready (list of hits — id, kind, score, content snippet), error (error message). Use `<scrollbox>` if available in `@opentui/solid` (per Phase 1 inventory it ships one); otherwise plain stacked text. Truncate content snippets to 80 characters.

- [ ] **Step 1: Create the component**

Create `apps/agent-cli/src/tui/MemoriesTab.tsx`:

```typescript
import { For, Match, Switch } from "solid-js"
import type { TuiStore } from "./store.js"
import type { MemorySearchHit } from "./panel-types.js"

export type MemoriesTabProps = {
  store: TuiStore
}

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max - 1) + "…"

const formatHit = (hit: MemorySearchHit): string => {
  const score = hit.score.toFixed(2)
  return `${hit.kind} (${score}) ${truncate(hit.content.replace(/\s+/g, " "), 80)}`
}

export const MemoriesTab = (props: MemoriesTabProps) => {
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Switch>
        <Match when={props.store.memorySearch().status === "idle"}>
          <text>(send a message to search memories)</text>
        </Match>
        <Match when={props.store.memorySearch().status === "loading"}>
          <text>searching memories…</text>
        </Match>
        <Match when={props.store.memorySearch().status === "ready"}>
          {(() => {
            const state = props.store.memorySearch()
            if (state.status !== "ready") return <></>
            if (state.hits.length === 0) return <text>(no memories found)</text>
            return (
              <For each={state.hits}>
                {(hit) => <text>{formatHit(hit)}</text>}
              </For>
            )
          })()}
        </Match>
        <Match when={props.store.memorySearch().status === "error"}>
          {(() => {
            const state = props.store.memorySearch()
            if (state.status !== "error") return <></>
            return <text>error: {state.message}</text>
          })()}
        </Match>
      </Switch>
    </box>
  )
}
```

- [ ] **Step 2: Wire into `<ContextPanel>`**

In `apps/agent-cli/src/tui/ContextPanel.tsx`, add at the top:

```typescript
import { MemoriesTab } from "./MemoriesTab.js"
```

Replace the placeholder for the memories tab:

```typescript
<Show when={props.store.contextPanelTab() === "memories"}>
  <MemoriesTab store={props.store} />
</Show>
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/agent-cli && bun run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-cli/src/tui/MemoriesTab.tsx apps/agent-cli/src/tui/ContextPanel.tsx
git commit -m "feat(tui): MemoriesTab renders memory search states"
```

---

## Task 5: Build `<EventsTab>`

**Files:**
- Create: `apps/agent-cli/src/tui/EventsTab.tsx`

**Context:** Renders the ring buffer of raw frames in reverse-chronological order (newest at top). Each entry shows: HH:MM:SS timestamp, frame type, and a one-line summary derived from the frame's distinguishing field (turnId for assistant frames, requestId for shell, threadId for thread frames, etc.).

- [ ] **Step 1: Create the component**

Create `apps/agent-cli/src/tui/EventsTab.tsx`:

```typescript
import { For } from "solid-js"
import type { ServerFrame } from "@luna/ui-ws"
import type { TuiStore } from "./store.js"
import type { FrameRingEntry } from "./panel-types.js"

const formatTime = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const summarize = (f: ServerFrame): string => {
  switch (f.type) {
    case "assistant-delta":
    case "assistant-done":
    case "assistant-error":
      return `turn=${f.turnId.slice(0, 8)}`
    case "thread-created":
      return `thread=${f.thread.id.slice(0, 8)}`
    case "thread-snapshot":
      return `thread=${f.threadId.slice(0, 8)} seq=${f.throughSeq}`
    case "user-accepted":
      return `thread=${f.threadId.slice(0, 8)} seq=${f.seq}`
    case "thread-list":
      return `count=${f.threads.length}`
    case "local-shell-request":
      return `req=${f.requestId.slice(0, 8)}`
    case "local-shell-status":
      return `enabled=${f.enabled} accepted=${f.accepted}`
    case "artifacts-extracted":
      return `thread=${f.threadId.slice(0, 8)} n=${f.artifacts.length}`
    case "drop":
      return `n=${f.n}`
    case "ping":
      return `ts=${f.ts}`
    case "event":
      return f.event.kind ?? "(event)"
    case "bye":
      return f.reason
    case "hello":
      return `v${f.protocolVersion}`
    case "account-list":
      return `n=${f.accounts.length}`
    default:
      return ""
  }
}

const formatEntry = (entry: FrameRingEntry): string => {
  return `${formatTime(entry.receivedAt)} ${entry.frame.type.padEnd(20)} ${summarize(entry.frame)}`
}

export type EventsTabProps = {
  store: TuiStore
}

export const EventsTab = (props: EventsTabProps) => {
  const reversed = () => [...props.store.rawFrames()].reverse()
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <For each={reversed()} fallback={<text>(no events yet)</text>}>
        {(entry) => <text>{formatEntry(entry)}</text>}
      </For>
    </box>
  )
}
```

If any `ServerFrame` variant added in `@luna/ui-ws` after this plan is written is missing from `summarize`, the `default` returns empty string — safe degradation.

- [ ] **Step 2: Wire into `<ContextPanel>`**

```typescript
import { EventsTab } from "./EventsTab.js"
```

Replace the placeholder:

```typescript
<Show when={props.store.contextPanelTab() === "events"}>
  <EventsTab store={props.store} />
</Show>
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/agent-cli && bun run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-cli/src/tui/EventsTab.tsx apps/agent-cli/src/tui/ContextPanel.tsx
git commit -m "feat(tui): EventsTab renders raw frame ring buffer with summaries"
```

---

## Task 6: Build `<ArtifactsTab>`

**Files:**
- Create: `apps/agent-cli/src/tui/ArtifactsTab.tsx`

**Context:** Renders artifacts for the current thread (`store.threadId()` → `store.artifactsByThread().get(currentThreadId)`). The `Artifact` interface (defined at `packages/chat-service/src/artifacts.ts:21`) is a flat record (not a discriminated union by `kind`). Its fields are: `id`, `source` (`"code-fence" | "tool-write"`), `path` (`string | null`), `lang` (`string | null`), `title`, `content`. Each row in the tab shows `title` plus either the file path (for tool-write artifacts) or the language (for code-fence artifacts).

- [ ] **Step 1: Create the component**

Create `apps/agent-cli/src/tui/ArtifactsTab.tsx`:

```typescript
import { For, Show } from "solid-js"
import type { Artifact } from "@luna/chat-service"
import type { TuiStore } from "./store.js"

const summarize = (artifact: Artifact): string => {
  if (artifact.source === "tool-write" && artifact.path !== null) {
    return `${artifact.title} — ${artifact.path}`
  }
  if (artifact.lang !== null) return `${artifact.title} [${artifact.lang}]`
  return artifact.title
}

export type ArtifactsTabProps = {
  store: TuiStore
}

export const ArtifactsTab = (props: ArtifactsTabProps) => {
  const items = (): readonly Artifact[] => {
    const tid = props.store.threadId()
    if (tid === null) return []
    return props.store.artifactsByThread().get(tid) ?? []
  }
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Show when={items().length === 0}>
        <text>(no artifacts yet)</text>
      </Show>
      <For each={items()}>
        {(a) => <text>{summarize(a)}</text>}
      </For>
    </box>
  )
}
```

The implementer is responsible for replacing the `// case "..."` comments with the real `Artifact` variants and fields from `packages/ui-ws/src/protocol.ts`. If the type is wide enough that the switch becomes long, that's fine — exhaustiveness matters more than brevity here.

- [ ] **Step 2: Wire into `<ContextPanel>`**

```typescript
import { ArtifactsTab } from "./ArtifactsTab.js"
```

```typescript
<Show when={props.store.contextPanelTab() === "artifacts"}>
  <ArtifactsTab store={props.store} />
</Show>
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/agent-cli && bun run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-cli/src/tui/ArtifactsTab.tsx apps/agent-cli/src/tui/ContextPanel.tsx
git commit -m "feat(tui): ArtifactsTab renders thread artifacts"
```

---

## Task 7: Splice `<ContextPanel>` into `<App>` layout

**Files:**
- Modify: `apps/agent-cli/src/tui/App.tsx`

**Context:** Replace the Phase-1 single column with a flex-row when the terminal is wide enough (≥ 100 cols). The left child contains the existing chat-stream + input + status (existing structure, just nested one level deeper). The right child is `<ContextPanel>` with a fixed width of 40 cols. When the terminal is narrower than 100 cols, the panel is hidden (the layout falls back to the Phase-1 single column). Narrow-overlay (Ctrl-B toggle) is deferred to a later phase.

- [ ] **Step 1: Read current `App.tsx`**

Open `apps/agent-cli/src/tui/App.tsx` to confirm the current structure matches the inventory's report (root column box containing message-list-box / input-box / status-box).

- [ ] **Step 2: Rewrite the component**

Replace the body of `App` with:

```typescript
import { For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { KeyEvent } from "@opentui/core"
import type { TuiStore } from "./store.js"
import { ContextPanel } from "./ContextPanel.js"

export type AppProps = {
  store: TuiStore
  onSubmit: (text: string) => void
  onKey: (key: KeyEvent) => void
}

const PANEL_WIDTH = 40
const PANEL_MIN_TERM_WIDTH = 100

export const App = (props: AppProps) => {
  const dims = useTerminalDimensions()
  const showPanel = () => dims().width >= PANEL_MIN_TERM_WIDTH
  const chatWidth = () => (showPanel() ? dims().width - PANEL_WIDTH : dims().width)

  const formatStatus = () => {
    const id = props.store.threadId()
    const idStr = id === null ? "—" : id.slice(0, 8)
    return (
      props.store.profileName() +
      " • thread " +
      idStr +
      " • shell " +
      (props.store.localShellEnabled() ? "on" : "off") +
      " • " +
      props.store.connection() +
      " • tab " +
      props.store.contextPanelTab()
    )
  }

  return (
    <box style={{ flexDirection: "row", width: dims().width, height: dims().height }}>
      <box style={{ flexDirection: "column", width: chatWidth(), height: dims().height }}>
        <box style={{ flexDirection: "column", flexGrow: 1, width: chatWidth(), padding: 1 }}>
          <For each={props.store.messages()}>
            {(msg) => (
              <text>{(msg.role === "user" ? "you: " : "Luna: ") + msg.text}</text>
            )}
          </For>
        </box>
        <box style={{ borderStyle: "single", width: chatWidth(), height: 3, padding: 1 }}>
          <text>{"> " + props.store.inputDraft()}</text>
        </box>
        <box style={{ width: chatWidth(), padding: 1 }}>
          <text>{formatStatus()}</text>
        </box>
      </box>
      <Show when={showPanel()}>
        <ContextPanel store={props.store} width={PANEL_WIDTH} height={dims().height} />
      </Show>
    </box>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/agent-cli && bun run typecheck`
Expected: passes.

- [ ] **Step 4: Visual sanity (manual)**

This step does not block the commit, but the implementer should: launch `luna chat --dev` in their terminal, verify the panel renders on the right with `[Memories]  Events  Artifacts` in the header, and `(send a message to search memories)` in the body. Exit with `/quit`. If the rendering is broken, fix before committing.

If the implementer cannot reach a TTY, skip this step and document in the commit message that visual smoke deferred to the final task.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-cli/src/tui/App.tsx
git commit -m "feat(tui): splice ContextPanel into App as right-side flex-row child"
```

---

## Task 8: Wire Tab / Ctrl-1/2/3 hotkeys

**Files:**
- Modify: `apps/agent-cli/src/tui/mount.ts`

**Context:** The existing key handler in `mount.ts` (around line 218) dispatches Enter / Backspace / printable chars to the input draft. Phase 2 adds: Tab cycles the active context tab (`store.cycleContextPanelTab()`), Ctrl-1/2/3 jumps directly to memories/events/artifacts respectively. These hotkeys are **dispatched before** the existing printable-char handling so Tab/Ctrl-N don't accidentally land in the input. Ctrl-C and Enter behavior remain unchanged.

- [ ] **Step 1: Locate `handleKey` in `mount.ts`**

Find the `handleKey` function (around line 218 per Phase 1 inventory). Confirm the current order: ctrl-c → return → backspace → printable.

- [ ] **Step 2: Add tab + ctrl-N hotkey handling**

Modify `handleKey` to dispatch the new hotkeys after the ctrl-c check and before the return check:

```typescript
const handleKey = (evt: KeyPressEvent): void => {
  dbg(`key: name=${evt.name ?? ""} ctrl=${evt.ctrl ?? false} seq=${JSON.stringify(evt.sequence ?? "")}`)
  if (evt.ctrl === true && evt.name === "c") {
    session.beginQuit()
    void client.close().then(() => { rendererRef?.destroy() })
    return
  }
  if (evt.name === "tab") {
    store.cycleContextPanelTab()
    return
  }
  if (evt.ctrl === true && evt.name === "1") {
    store.setContextPanelTab("memories")
    return
  }
  if (evt.ctrl === true && evt.name === "2") {
    store.setContextPanelTab("events")
    return
  }
  if (evt.ctrl === true && evt.name === "3") {
    store.setContextPanelTab("artifacts")
    return
  }
  if (evt.name === "return") {
    submit(store.inputDraft())
    return
  }
  if (evt.name === "backspace") {
    store.setInputDraft((d) => d.slice(0, -1))
    return
  }
  if (evt.sequence !== undefined && evt.sequence.length === 1 && evt.sequence.charCodeAt(0) >= 0x20) {
    const seq = evt.sequence
    store.setInputDraft((d) => d + seq)
    dbg(`inputDraft now = ${JSON.stringify(store.inputDraft())}`)
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/agent-cli && bun run typecheck`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/agent-cli/src/tui/mount.ts
git commit -m "feat(tui): Tab and Ctrl-1/2/3 hotkeys cycle context panel tabs"
```

---

## Task 9: Build debounced memory search effect

**Files:**
- Create: `apps/agent-cli/src/tui/memory-search.ts`
- Create: `apps/agent-cli/test/memory-search.test.ts`

**Context:** Phase 2 needs a unit-testable function that takes a query string and produces a `MemorySearchState` via `@luna/memory`'s `MemoryRouter.search` (returns an Effect Stream). The integration into the TUI lifecycle (subscribing to `lastUserMessage` changes, debouncing, dispatching to the store) happens in Task 10. This task isolates the pure search-orchestration code so it has a unit test.

Memory search returns a `Stream.Stream<{record, score}, MemoryBackendError>`. We convert that to an array via `Stream.runCollect` and then to a plain array of `MemorySearchHit`.

- [ ] **Step 1: Write the failing test**

Create `apps/agent-cli/test/memory-search.test.ts`:

```typescript
import { describe, expect, it } from "vitest"
import { Effect, Stream } from "effect"
import { runMemorySearch } from "../src/tui/memory-search.js"

const makeFakeRouter = (results: Array<{ id: string; kind: string; content: string; score: number }>) => ({
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
      }))
    ),
}) as Parameters<typeof runMemorySearch>[0]

describe("runMemorySearch", () => {
  it("returns ready with hits on success", async () => {
    const router = makeFakeRouter([
      { id: "m1", kind: "feedback", content: "hello", score: 0.9 },
      { id: "m2", kind: "project", content: "world", score: 0.7 },
    ])
    const result = await runMemorySearch(router, "hello world", 10)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("unreachable")
    expect(result.hits.length).toBe(2)
    expect(result.hits[0]).toEqual({ id: "m1", kind: "feedback", content: "hello", score: 0.9 })
    expect(result.query).toBe("hello world")
  })

  it("returns ready with empty hits when no results", async () => {
    const router = makeFakeRouter([])
    const result = await runMemorySearch(router, "nothing", 10)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") throw new Error("unreachable")
    expect(result.hits.length).toBe(0)
  })

  it("returns error with message when search Effect fails", async () => {
    const failingRouter = {
      search: (_args: { queryText: string; topK?: number }) =>
        Stream.fail(new Error("backend down")) as ReturnType<ReturnType<typeof makeFakeRouter>["search"]>,
    } as Parameters<typeof runMemorySearch>[0]
    const result = await runMemorySearch(failingRouter, "x", 10)
    expect(result.status).toBe("error")
    if (result.status !== "error") throw new Error("unreachable")
    expect(result.message).toContain("backend down")
  })

  it("returns idle for empty query", async () => {
    const router = makeFakeRouter([])
    const result = await runMemorySearch(router, "  ", 10)
    expect(result.status).toBe("idle")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent-cli && bun run test --run memory-search`
Expected: FAIL — `Cannot find module './memory-search.js'`.

- [ ] **Step 3: Implement `runMemorySearch`**

Create `apps/agent-cli/src/tui/memory-search.ts`:

```typescript
import { Effect, Stream } from "effect"
import type { MemoryRouter } from "@luna/memory"
import type { MemorySearchHit, MemorySearchState } from "./panel-types.js"

export const runMemorySearch = async (
  router: MemoryRouter,
  query: string,
  topK: number,
): Promise<MemorySearchState> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return { status: "idle" }

  const program = Stream.runCollect(router.search({ queryText: trimmed, topK }))

  try {
    const chunk = await Effect.runPromise(program)
    const hits: MemorySearchHit[] = Array.from(chunk).map(({ record, score }) => ({
      id: record.id,
      kind: record.kind,
      content: record.content,
      score,
    }))
    return { status: "ready", query: trimmed, hits }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: "error", query: trimmed, message }
  }
}
```

`@luna/memory` is already a dep of `apps/agent-cli`. If `MemoryRouter` is not exported from `packages/memory/src/index.ts`, the implementer adds a single-line type export (no breaking change).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent-cli && bun run test --run memory-search`
Expected: PASS — all four cases.

- [ ] **Step 5: Commit**

```bash
git add apps/agent-cli/src/tui/memory-search.ts apps/agent-cli/test/memory-search.test.ts apps/agent-cli/package.json packages/memory/src/index.ts
git commit -m "feat(tui): runMemorySearch wrapper around MemoryRouter.search"
```

(Only stage `package.json` and `memory/src/index.ts` if they were actually modified.)

---

## Task 10: Wire data pipelines in `mount.ts`

**Files:**
- Modify: `apps/agent-cli/src/tui/mount.ts`

**Context:** Three pipelines to wire:
1. **Raw frames → store**: subscribe `session.on("rawFrame", store.pushRawFrame)`.
2. **Last user message → store**: in the `submit` function, after `store.appendUser(trimmed)`, also call `store.setLastUserMessage(trimmed)`.
3. **`lastUserMessage` → memory search**: use a Solid `createEffect` that fires when `lastUserMessage()` changes. Debounce 300ms (cancel pending timer on re-trigger). Inside the effect, set the store to `{status: "loading"}`, then `await runMemorySearch(...)`, then set the result. Bulkhead via try/catch so a memory failure cannot crash the TUI.
4. **Artifacts**: in the `rawFrame` listener (already added in step 1), also dispatch `artifacts-extracted` frames to `store.setArtifactsForThread(frame.threadId, frame.artifacts)`.

The `MemoryRouter` instance comes from `@luna/memory`'s default constructor. If the package exposes a `makeInMemoryRouter()` or similar (check `packages/memory/src/index.ts` exports), use that. If it requires Effect-based construction, run that once at startup and pass the resolved instance to the lifecycle. The implementer should keep this construction as small and isolated as possible — one helper at the top of `mountTui` before the `Pre-TUI: connect and recover` block.

- [ ] **Step 1: Locate insertion points**

Open `mount.ts`. Identify:
- Where event listeners on `session` are registered (around line 122–144) — for adding the `rawFrame` listener.
- The `submit` function body (around line 189) — for adding the `setLastUserMessage` call.
- A clean place to instantiate the `MemoryRouter` and set up the debounced effect — propose top of `mountTui`, before `loadChatConfig` is called.

- [ ] **Step 2: Construct the memory router**

Read `packages/memory/src/index.ts` to determine the actual constructor or factory exposed. Add an import in `mount.ts`:

```typescript
import { makeInMemoryRouter } from "@luna/memory"  // exact name TBD from index inspection
```

Inside `mountTui`, after the initial `dbg(...)` call:

```typescript
const memoryRouter = makeInMemoryRouter()
```

If construction is async / Effect-based, run it synchronously where possible. If it must be async, wrap before the `await render(...)` call.

- [ ] **Step 3: Add the rawFrame + artifacts listener**

After the existing `session.on(...)` listeners block, add:

```typescript
session.on("rawFrame", (frame) => {
  store.pushRawFrame(frame)
  if (frame.type === "artifacts-extracted") {
    store.setArtifactsForThread(frame.threadId, frame.artifacts)
  }
})
```

- [ ] **Step 4: Capture lastUserMessage**

In the `submit` function body, immediately after `store.appendUser(trimmed)`:

```typescript
store.setLastUserMessage(trimmed)
```

- [ ] **Step 5: Wire the debounced memory search effect**

Add imports at the top of `mount.ts`:

```typescript
import { createEffect } from "solid-js"
import { runMemorySearch } from "./memory-search.js"
```

Inside `mountTui`, after the store is created and after the memory router is constructed, set up the effect. Place this immediately before `await render(...)`:

```typescript
const MEMORY_SEARCH_DEBOUNCE_MS = 300
let memorySearchTimer: ReturnType<typeof setTimeout> | undefined

createEffect(() => {
  const query = store.lastUserMessage()
  if (memorySearchTimer !== undefined) clearTimeout(memorySearchTimer)
  if (query.trim().length === 0) {
    store.setMemorySearch({ status: "idle" })
    return
  }
  store.setMemorySearch({ status: "loading", query: query.trim() })
  memorySearchTimer = setTimeout(() => {
    void (async () => {
      try {
        const result = await runMemorySearch(memoryRouter, query, 10)
        store.setMemorySearch(result)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        store.setMemorySearch({ status: "error", query: query.trim(), message })
        dbg(`memory search error: ${message}`)
      }
    })()
  }, MEMORY_SEARCH_DEBOUNCE_MS)
})
```

Note: `createEffect` must run inside a Solid reactive owner. In a typical OpenTUI mount, the reactive root is established by `render()`. If `createEffect` outside `render()` is silently inert, the implementer must move this effect into a small top-level component mounted by `render()` instead — likely a sibling of `<App>` or a wrapper around it. The Phase-1 pattern of `createComponent(RootApp, ...)` is the right insertion site: add the effect at the top of `RootApp`'s function body.

- [ ] **Step 6: Typecheck**

Run: `cd apps/agent-cli && bun run typecheck`
Expected: passes.

- [ ] **Step 7: Run all tests**

Run: `cd apps/agent-cli && bun run test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-cli/src/tui/mount.ts
git commit -m "feat(tui): wire rawFrame, lastUserMessage, artifacts, and debounced memory search"
```

---

## Task 11: End-to-end smoke against jax-box (via tmux)

**Files:** None modified.

**Context:** Final manual verification. The implementer drives `luna chat --dev` from a tmux session pointed at jax-box, validates each tab renders and updates, and confirms hotkeys work. The Phase-1 debug logging pattern (`LUNA_TUI_DEBUG=/tmp/luna-tui.log`) remains available; turn it on if anything looks wrong.

- [ ] **Step 1: Launch in tmux**

```bash
tmux kill-server 2>/dev/null || true
tmux new-session -d -s luna-phase2 -x 200 -y 50 -e "LUNA_TUI_DEBUG=/tmp/luna-phase2.log" "luna chat --dev"
sleep 5
tmux capture-pane -t luna-phase2 -p
```

Verify the pane shows the right-side panel with `[Memories]  Events  Artifacts` header and the placeholder body for memories.

- [ ] **Step 2: Send a message, verify memories populate**

```bash
tmux send-keys -t luna-phase2 "remember the number 42" Enter
sleep 3
tmux capture-pane -t luna-phase2 -p
```

Verify Luna responds in the chat column and the Memories tab shows search results (or "no memories found" if the dev profile's memory store is empty — that is also a valid pass, as long as the state transitioned from `idle`).

- [ ] **Step 3: Cycle tabs**

```bash
tmux send-keys -t luna-phase2 Tab
sleep 1
tmux capture-pane -t luna-phase2 -p
```

Verify header now shows `Memories  [Events]  Artifacts` and the Events body lists raw frames received so far (at least: hello, thread-created, user-accepted, assistant-delta, assistant-done).

```bash
tmux send-keys -t luna-phase2 Tab
sleep 1
tmux capture-pane -t luna-phase2 -p
```

Verify header shows `Memories  Events  [Artifacts]` and the artifacts body shows either an artifact list or `(no artifacts yet)`.

- [ ] **Step 4: Direct-jump hotkeys**

```bash
tmux send-keys -t luna-phase2 C-1
sleep 1
tmux capture-pane -t luna-phase2 -p
```

Verify Ctrl-1 returns to `[Memories]`.

- [ ] **Step 5: Clean exit**

```bash
tmux send-keys -t luna-phase2 "/quit" Enter
sleep 2
tmux has-session -t luna-phase2 2>/dev/null && echo "still running — FAIL" || echo "exited cleanly"
tmux kill-server
```

Verify clean exit.

- [ ] **Step 6: Report**

If every step above passed (or transitioned to the expected state — empty memory store is fine), the phase is complete. If any step failed, attach the relevant section of `/tmp/luna-phase2.log` and report back without continuing.

- [ ] **Step 7: Final commit (if any cleanup needed)**

If the smoke test surfaced any bug, fix it in a follow-up commit and re-run from Step 1. Otherwise, no commit needed for this task — the work is verification.

---

## Done Criteria

- All 11 tasks completed.
- All Vitest tests passing.
- TUI mounts with right-side panel at width ≥ 100.
- Tab key cycles tabs in `memories → events → artifacts → memories` order.
- Ctrl-1/2/3 jumps directly to the named tab.
- Sending a message updates the Memories tab (loading → ready or error within ~500ms).
- Raw frames stream into the Events tab live.
- `artifacts-extracted` frames (if any are emitted by jax-box) populate the Artifacts tab.
- `/quit` exits cleanly and restores the terminal.
- `bun run typecheck` is clean.
