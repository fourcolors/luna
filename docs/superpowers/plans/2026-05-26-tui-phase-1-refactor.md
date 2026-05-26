# Luna TUI — Phase 1: Foundational Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a headless chat layer from today's `runLunaCli`, route all CLI commands through `citty`, and unify the `luna` and `luna-account` binaries — without changing user-visible behavior. This is the seam Phase 2 mounts a TUI onto.

**Architecture:** `apps/agent-cli/src/chat/app.ts` today owns WS connect, recovery, slash dispatch, the frame-render loop, *and* stdin readline. We split it into (a) a pure headless layer that exposes a typed event/command surface and (b) a thin readline view that consumes the surface. We move argv parsing from a hand-rolled parser in `chat/args.ts` to `citty`, and merge `luna-account` (today's `src/index.ts`) into the same `luna` root command.

**Tech Stack:** Bun ≥ 1.1, TypeScript strict, Effect 3.x, Vitest, `citty` (new dependency), existing `@luna/ui-ws` protocol.

**Spec:** [2026-05-26-tui-shape-design.md](../specs/2026-05-26-tui-shape-design.md)

**Companion plans (to be written after Phase 1 ships):**
- Phase 2 — TUI core (OpenTUI mount, ChatStream, InputArea, snapshot tests, `--no-tui`)
- Phase 3 — Rich features (ContextPanel + tabs, MarkdownTerm, ApprovalModal)

---

## Pre-flight

**Branch hygiene.** The session you executed brainstorming in started on `master`. Phase 1 work should land on `dev` (or a feature branch off it) because another process is active on `master`. Task 1 handles this.

**Test floor.** Every task ends with `bun run --filter @luna/agent-cli test` passing. The existing 790-line `chat-app.integration.test.ts` is the canary — if it stays green, behavior is preserved.

**Conventional commits.** Every task ends with a commit. Commit messages follow the existing pattern (`refactor(agent-cli): …`, `feat(agent-cli): …`).

---

## File Structure

**Created in this plan:**

```
apps/agent-cli/src/
  chat/
    headless.ts                  # Pure headless surface (no stdin/stdout)
    slash-registry.ts            # SLASH_COMMANDS metadata array
  commands/
    chat.ts                      # citty command — wraps headless w/ readline view
    account/
      index.ts                   # citty subcommand group
      add.ts                     # already exists; rewrapped for citty
      list.ts                    # already exists; rewrapped for citty
      rm.ts                      # already exists; rewrapped for citty
    memory.ts                    # citty command — already exists at src/memory.ts; moved here
  views/
    readline.ts                  # Today's readline loop, extracted from chat/app.ts

apps/agent-cli/test/
  headless.test.ts               # Hook-style tests against headless surface
  citty-routing.test.ts          # End-to-end citty subcommand dispatch
```

**Modified:**

```
apps/agent-cli/
  package.json                   # bin entries collapse to one (luna); add citty dep
  src/luna.ts                    # bin entry — calls citty runMain(rootCommand)
  src/chat/app.ts                # becomes a thin re-export of headless + readline view (kept for back-compat of the integration test import)
  src/chat/slash.ts              # additive: re-exports SLASH_COMMANDS from slash-registry
```

**Deleted at the end of Phase 1:**

```
apps/agent-cli/src/index.ts      # luna-account entry — merged into luna citty root
```

---

## Task 1 — Branch hygiene + dependency on `citty`

**Files:**
- Modify: `apps/agent-cli/package.json`

- [ ] **Step 1: Confirm starting state, switch to dev**

Run:
```bash
git status --short
git fetch origin
git checkout dev
git pull --ff-only origin dev
git status --short
```

Expected: working tree clean (your spec commit on `master` stays on `master`; that's fine — the spec is the same file regardless). On `dev` now.

- [ ] **Step 2: Create the feature branch**

Run:
```bash
git checkout -b feat/tui-phase-1-refactor
```

- [ ] **Step 3: Add `citty` to `@luna/agent-cli`**

Edit `apps/agent-cli/package.json`. In `dependencies`, add `"citty": "^0.1.6"` (alphabetically among existing deps):

```json
"dependencies": {
  "@luna/core": "workspace:*",
  "@luna/memory": "workspace:*",
  "@luna/ui-ws": "workspace:*",
  "citty": "^0.1.6",
  "effect": "^3.21.0",
  "ws": "^8.18.0"
}
```

- [ ] **Step 4: Install**

Run:
```bash
bun install
```

Expected: `citty` resolves; no other lockfile changes. If `bun install` errors on unrelated workspace deps, use `bun install --filter @luna/agent-cli`.

- [ ] **Step 5: Smoke that nothing broke**

Run:
```bash
bun run --filter @luna/agent-cli test
```

Expected: all existing tests pass (including the 790-line integration test).

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/package.json bun.lock
git commit -m "chore(agent-cli): add citty dependency for upcoming command router"
```

---

## Task 2 — Export `SLASH_COMMANDS` registry from `slash.ts`

The TUI's slash completion popover (Phase 2) needs a programmatic list of commands. This task adds it without touching parser behavior.

**Files:**
- Create: `apps/agent-cli/src/chat/slash-registry.ts`
- Modify: `apps/agent-cli/src/chat/slash.ts:24` (after `HELP_TEXT` definition)
- Test: `apps/agent-cli/test/chat-slash.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Edit `apps/agent-cli/test/chat-slash.test.ts`. At the end, append:

```ts
import { SLASH_COMMANDS } from "../src/chat/slash.js"

describe("SLASH_COMMANDS registry", () => {
  it("exports every command name referenced by HELP_TEXT", () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    for (const expected of ["/help", "/threads", "/new", "/switch", "/interrupt", "/quit", "/exit", "/local-shell"]) {
      expect(names).toContain(expected)
    }
  })

  it("each entry has a one-line description", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.description.length).toBeGreaterThan(0)
      expect(cmd.description).not.toContain("\n")
    }
  })

  it("entries with arguments declare argHint", () => {
    const withArgs = SLASH_COMMANDS.find((c) => c.name === "/switch")
    expect(withArgs?.argHint).toBe("<thread-id>")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run --filter @luna/agent-cli test chat-slash.test
```

Expected: FAIL — `SLASH_COMMANDS is not exported from "../src/chat/slash.js"`.

- [ ] **Step 3: Create the registry module**

Create `apps/agent-cli/src/chat/slash-registry.ts`:

```ts
export type SlashSpec = {
  readonly name: string
  readonly description: string
  readonly argHint?: string
}

export const SLASH_COMMANDS: readonly SlashSpec[] = [
  { name: "/help",        description: "show slash commands" },
  { name: "/threads",     description: "list threads" },
  { name: "/new",         description: "start a new thread" },
  { name: "/switch",      description: "switch to a thread", argHint: "<thread-id>" },
  { name: "/interrupt",   description: "interrupt the current response" },
  { name: "/quit",        description: "quit Luna" },
  { name: "/exit",        description: "quit Luna" },
  { name: "/local-shell", description: "toggle or check local shell", argHint: "<on|off|status>" },
]
```

- [ ] **Step 4: Re-export from `slash.ts`**

Edit `apps/agent-cli/src/chat/slash.ts`. After the `HELP_TEXT` export (line ~24), add:

```ts
export { SLASH_COMMANDS, type SlashSpec } from "./slash-registry.js"
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun run --filter @luna/agent-cli test chat-slash.test
```

Expected: PASS (all original cases + the three new ones).

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/src/chat/slash-registry.ts apps/agent-cli/src/chat/slash.ts apps/agent-cli/test/chat-slash.test.ts
git commit -m "feat(agent-cli): export SLASH_COMMANDS registry for upcoming TUI completion"
```

---

## Task 3 — Extract the readline view from `chat/app.ts`

`chat/app.ts` mixes WS lifecycle (headless logic) with `createInterface(process.stdin)` + `write(io.stdout, ...)` (view logic). This task moves the *view* parts to a new file. No behavior changes.

**Files:**
- Create: `apps/agent-cli/src/views/readline.ts`
- Modify: `apps/agent-cli/src/chat/app.ts`

This is the largest task in the plan. Take it slow — the integration test will scream if you nick anything.

- [ ] **Step 1: Run the baseline test to confirm starting state**

```bash
bun run --filter @luna/agent-cli test chat-app.integration
```

Expected: PASS.

- [ ] **Step 2: Create the new view file with the readline-specific helpers**

Create `apps/agent-cli/src/views/readline.ts`:

```ts
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

export type ReadlineIo = {
  stdin: Readable
  stdout: Writable
  stderr: Writable
}

export const writeOut = (io: ReadlineIo, text: string): void => {
  io.stdout.write(text)
}

export const writeErr = (io: ReadlineIo, text: string): void => {
  io.stderr.write(text)
}

export const writeError = (io: ReadlineIo, message: string): void => {
  io.stderr.write(`error: ${message}\n`)
}

export const createLineReader = (io: ReadlineIo): ReturnType<typeof createInterface> =>
  createInterface({
    input: io.stdin,
    crlfDelay: Infinity,
    terminal: false,
  })
```

- [ ] **Step 3: Replace inline `write` / `writeError` definitions in `chat/app.ts`**

Edit `apps/agent-cli/src/chat/app.ts`. Add at the top of imports (alongside existing imports):

```ts
import { createLineReader, writeError, writeOut as write, writeErr } from "../views/readline.js"
```

Then **delete** these inline helpers (currently lines ~74–86 in `chat/app.ts`):

```ts
const write = (stream: Writable, text: string): void => {
  stream.write(text)
}

const writeError = (io: LunaCliIO, message: string): void => {
  write(io.stderr, `error: ${message}\n`)
}
```

Replace **all call sites** within `chat/app.ts`:
- `write(io.stdout, ...)` → `write(io, ...)` (the new `write` takes io, not a stream)
- `write(io.stderr, ...)` → `writeErr(io, ...)`
- `writeError(io, ...)` stays the same signature

**Important:** the new `write` is `writeOut`; the import aliases it. Check every call. Use:

```bash
grep -n "write(io\." apps/agent-cli/src/chat/app.ts
```

to find them. Expected count: roughly 14.

- [ ] **Step 4: Replace `createInterface` call with `createLineReader`**

In `chat/app.ts`, find (around line ~256):

```ts
const lineReader = createInterface({
  input: io.stdin,
  crlfDelay: Infinity,
  terminal: false,
})
```

Replace with:

```ts
const lineReader = createLineReader(io)
```

Remove the now-unused `createInterface` import from `node:readline`.

- [ ] **Step 5: Run the integration test**

```bash
bun run --filter @luna/agent-cli test chat-app.integration
```

Expected: PASS. Behavior is identical; only the helper sources changed.

- [ ] **Step 6: Run the full agent-cli test suite**

```bash
bun run --filter @luna/agent-cli test
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-cli/src/views/readline.ts apps/agent-cli/src/chat/app.ts
git commit -m "refactor(agent-cli): extract readline io helpers from chat/app.ts"
```

---

## Task 4 — Extract the headless layer

Now we lift the protocol-shaped parts of `runLunaCli` (WS connect, frame routing, slash dispatch, thread state, local-shell wiring) into a `LunaHeadlessSession` class with a typed event surface. The readline view becomes a consumer of that surface.

**Files:**
- Create: `apps/agent-cli/src/chat/headless.ts`
- Modify: `apps/agent-cli/src/chat/app.ts` (rewritten as a thin orchestrator)
- Test: `apps/agent-cli/test/headless.test.ts`

- [ ] **Step 1: Sketch the API surface in the test first**

Create `apps/agent-cli/test/headless.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import type { ServerFrame, ClientFrame } from "@luna/ui-ws"
import { LunaHeadlessSession } from "../src/chat/headless.js"

class StubWsClient {
  readonly sent: ClientFrame[] = []
  private queue: ServerFrame[] = []
  private waiters: ((f: ServerFrame) => void)[] = []
  send(f: ClientFrame) { this.sent.push(f) }
  nextFrame(): Promise<ServerFrame> {
    const head = this.queue.shift()
    if (head !== undefined) return Promise.resolve(head)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
  emit(frame: ServerFrame) {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else this.queue.push(frame)
  }
  async close() {}
}

describe("LunaHeadlessSession", () => {
  it("emits onThreadChange when a thread-created frame arrives", async () => {
    const client = new StubWsClient()
    const session = new LunaHeadlessSession({
      client: client as never,
      profileName: "stable",
      model: "claude-sonnet-4-5",
      saveLastThread: () => undefined,
      clearLastThread: () => undefined,
    })
    const onThread = vi.fn()
    session.on("threadChange", onThread)
    void session.run()
    client.emit({
      type: "thread-created",
      thread: { id: "t1", parentId: null, title: null, tags: [], createdAt: 1, updatedAt: 1, status: "open" },
    } as never)
    await new Promise((r) => setTimeout(r, 5))
    expect(onThread).toHaveBeenCalledWith("t1")
    expect(client.sent).toContainEqual({ type: "subscribe", threadId: "t1" })
  })

  it("buffers user messages until a thread is bound", async () => {
    const client = new StubWsClient()
    const session = new LunaHeadlessSession({
      client: client as never,
      profileName: "stable",
      model: "claude-sonnet-4-5",
      saveLastThread: () => undefined,
      clearLastThread: () => undefined,
    })
    void session.run()
    session.sendUser("hello")
    expect(client.sent.filter((f) => f.type === "user-message")).toHaveLength(0)
    client.emit({
      type: "thread-created",
      thread: { id: "t2", parentId: null, title: null, tags: [], createdAt: 1, updatedAt: 1, status: "open" },
    } as never)
    await new Promise((r) => setTimeout(r, 5))
    expect(client.sent).toContainEqual({ type: "user-message", threadId: "t2", text: "hello" })
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
bun run --filter @luna/agent-cli test headless
```

Expected: FAIL — `LunaHeadlessSession` is not exported.

- [ ] **Step 3: Create the headless module**

Create `apps/agent-cli/src/chat/headless.ts`. This is a substantial file — type-event-emitter wrapping the per-frame routing currently in `chat/app.ts:399–486` (the `renderFrame` switch) and the slash dispatch from `chat/app.ts:509–567`.

```ts
import { EventEmitter } from "node:events"
import type { ClientFrame, ServerFrame } from "@luna/ui-ws"
import type { LunaWsClient } from "./ws-client.js"
import { parseSlashCommand, type SlashCommand } from "./slash.js"

export type AssistantTurnState = {
  readonly turnId: string
  readonly text: string
  readonly done: boolean
}

export type SessionErrorEvent = {
  readonly message: string
  readonly kind?: string
  readonly turnId: string | null
}

export type LunaHeadlessEvents = {
  threadChange: (threadId: string) => void
  ready: () => void
  assistantDelta: (turn: AssistantTurnState) => void
  assistantDone: (turn: AssistantTurnState) => void
  assistantError: (event: SessionErrorEvent) => void
  threadList: (threads: ReadonlyArray<{ id: string; title: string | null; status: string }>) => void
  localShellRequest: (frame: Extract<ServerFrame, { type: "local-shell-request" }>) => void
  localShellStatus: (message: string, accepted: boolean) => void
  fatal: (reason: string) => void
  helpText: (text: string) => void
  info: (text: string) => void
  errorText: (text: string) => void
}

export type LunaHeadlessConfig = {
  readonly client: LunaWsClient
  readonly profileName: string
  readonly model: string
  readonly initialThreadId?: string | null
  readonly autoResumedThreadId?: string | null
  readonly newThread?: boolean
  readonly saveLastThread: (threadId: string) => void
  readonly clearLastThread: () => void
}

export class LunaHeadlessSession extends EventEmitter {
  private readonly client: LunaWsClient
  private readonly profileName: string
  private readonly model: string
  private currentThreadId: string | null
  private pendingAutoResumedThreadId: string | null
  private readonly pendingUserMessages: string[] = []
  private readonly assistantTextByTurn = new Map<string, string>()
  private quitting = false
  private fatalMessage: string | null = null
  private readonly saveLastThread: (threadId: string) => void
  private readonly clearLastThread: () => void

  constructor(cfg: LunaHeadlessConfig) {
    super()
    this.client = cfg.client
    this.profileName = cfg.profileName
    this.model = cfg.model
    this.currentThreadId = cfg.initialThreadId ?? null
    this.pendingAutoResumedThreadId = cfg.autoResumedThreadId ?? null
    this.saveLastThread = cfg.saveLastThread
    this.clearLastThread = cfg.clearLastThread
    if (cfg.newThread === true) {
      this.client.send({ type: "new-thread", model: this.model })
    } else if (this.currentThreadId !== null) {
      this.client.send({ type: "subscribe", threadId: this.currentThreadId })
    }
  }

  override on<K extends keyof LunaHeadlessEvents>(event: K, listener: LunaHeadlessEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  override emit<K extends keyof LunaHeadlessEvents>(event: K, ...args: Parameters<LunaHeadlessEvents[K]>): boolean {
    return super.emit(event, ...(args as unknown[]))
  }

  get threadId(): string | null { return this.currentThreadId }
  get fatalReason(): string | null { return this.fatalMessage }

  sendUser(text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    if (this.currentThreadId === null) {
      this.pendingUserMessages.push(text)
      return
    }
    this.client.send({ type: "user-message", threadId: this.currentThreadId, text })
  }

  dispatchSlash(line: string): SlashCommand {
    const cmd = parseSlashCommand(line)
    switch (cmd.type) {
      case "help":
        this.emit("helpText", "")
        break
      case "threads":
        this.client.send({ type: "list-threads", limit: 50 })
        break
      case "new-thread":
        this.resetThread()
        this.client.send({ type: "new-thread", model: this.model })
        break
      case "switch-thread":
        this.bindThread(cmd.threadId)
        this.client.send({ type: "subscribe", threadId: cmd.threadId })
        break
      case "interrupt":
        if (this.currentThreadId !== null) {
          this.client.send({ type: "interrupt", threadId: this.currentThreadId })
        }
        break
      case "quit":
        this.quitting = true
        break
      case "message":
        this.sendUser(cmd.text)
        break
      case "local-shell":
      case "local-shell-status":
      case "error":
        // Forwarded to caller — local-shell semantics still live in chat/app.ts
        // for v1; Phase 2 moves them inside the headless session.
        break
    }
    return cmd
  }

  async run(): Promise<void> {
    try {
      for (;;) {
        if (this.quitting) return
        const frame = await this.client.nextFrame()
        this.handleFrame(frame)
        if (this.fatalMessage !== null) return
      }
    } catch (error) {
      if (!this.quitting) {
        this.fatalMessage = error instanceof Error ? error.message : String(error)
        this.emit("fatal", this.fatalMessage)
      }
    }
  }

  beginQuit(): void {
    this.quitting = true
  }

  private bindThread(threadId: string): void {
    this.currentThreadId = threadId
    this.pendingAutoResumedThreadId = null
    try { this.saveLastThread(threadId) } catch { /* best-effort */ }
    this.emit("threadChange", threadId)
    this.flushPending()
  }

  private resetThread(): void {
    this.currentThreadId = null
  }

  private flushPending(): void {
    if (this.currentThreadId === null) return
    while (this.pendingUserMessages.length > 0) {
      const text = this.pendingUserMessages.shift()
      if (text !== undefined) {
        this.client.send({ type: "user-message", threadId: this.currentThreadId, text })
      }
    }
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "hello":
      case "event":
      case "drop":
      case "account-list":
      case "artifacts-extracted":
        return
      case "ping":
        this.client.send({ type: "pong", ts: frame.ts })
        return
      case "bye":
        this.fatalMessage = frame.reason
        this.emit("fatal", frame.reason)
        return
      case "thread-created":
        this.bindThread(frame.thread.id)
        this.client.send({ type: "subscribe", threadId: frame.thread.id })
        this.emit("ready")
        return
      case "thread-snapshot":
        this.bindThread(frame.threadId)
        this.emit("ready")
        return
      case "user-accepted":
        this.bindThread(frame.threadId)
        return
      case "assistant-delta": {
        const previous = this.assistantTextByTurn.get(frame.turnId) ?? ""
        this.assistantTextByTurn.set(frame.turnId, frame.text)
        this.emit("assistantDelta", { turnId: frame.turnId, text: frame.text, done: false })
        // Caller (readline view) computes increment for printing.
        void previous
        return
      }
      case "assistant-done": {
        const text = this.assistantTextByTurn.get(frame.turnId) ?? ""
        this.assistantTextByTurn.delete(frame.turnId)
        this.emit("assistantDone", { turnId: frame.turnId, text, done: true })
        return
      }
      case "assistant-error": {
        if (
          frame.error.kind === "unknown-thread" &&
          this.pendingAutoResumedThreadId !== null &&
          frame.threadId === this.pendingAutoResumedThreadId
        ) {
          try { this.clearLastThread() } catch { /* best-effort */ }
          this.pendingAutoResumedThreadId = null
          this.resetThread()
          this.client.send({ type: "new-thread", model: this.model })
          this.emit("info", `luna: resumed thread no longer exists — starting a new one`)
          return
        }
        this.emit("assistantError", {
          message: frame.error.message,
          kind: frame.error.kind,
          turnId: frame.turnId,
        })
        return
      }
      case "thread-list":
        this.emit("threadList", frame.threads)
        return
      case "local-shell-status":
        this.emit("localShellStatus", frame.message, frame.accepted)
        return
      case "local-shell-request":
        this.emit("localShellRequest", frame)
        return
    }
  }
}
```

- [ ] **Step 4: Run the new test to verify it passes**

```bash
bun run --filter @luna/agent-cli test headless
```

Expected: both new tests PASS.

- [ ] **Step 5: Run the full suite to confirm no regressions**

```bash
bun run --filter @luna/agent-cli test
```

Expected: all PASS. The integration test still uses `runLunaCli`, which we haven't rewired yet — that's task 5.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/src/chat/headless.ts apps/agent-cli/test/headless.test.ts
git commit -m "feat(agent-cli): extract LunaHeadlessSession from chat/app.ts"
```

---

## Task 5 — Rewire `runLunaCli` to delegate to `LunaHeadlessSession`

`chat/app.ts` keeps its public signature (`runLunaCli(argv, io)`) so the existing integration test passes unchanged. Internally it constructs a `LunaHeadlessSession` and a readline view that subscribes to the session's events.

**Files:**
- Modify: `apps/agent-cli/src/chat/app.ts`

- [ ] **Step 1: Baseline test pass before changes**

```bash
bun run --filter @luna/agent-cli test chat-app.integration
```

Expected: PASS.

- [ ] **Step 2: Replace `renderFrame` and the slash dispatch in `runLunaCli`**

Edit `apps/agent-cli/src/chat/app.ts`. Inside `runLunaCli`, replace the `renderFrame` function (lines ~399–486) and the slash switch (lines ~509–567) with subscribing to a `LunaHeadlessSession` and rendering its events as text on `io.stdout`.

The shape becomes:

```ts
import { LunaHeadlessSession } from "./headless.js"

// ...inside runLunaCli, after `client = await connectWithRecovery(cfg, io)`:

const session = new LunaHeadlessSession({
  client,
  profileName: cfg.profileName,
  model: io.env["LUNA_MODEL"] ?? DEFAULT_MODEL,
  initialThreadId: cfg.threadId,
  autoResumedThreadId: cfg.threadIdAutoResumed ? cfg.threadId : null,
  newThread: cfg.newThread,
  saveLastThread: (id) => {
    try { writeLastThread(io.homeDir ?? homedir(), cfg.profileName, id) } catch {}
  },
  clearLastThread: () => {
    try { clearLastThread(io.homeDir ?? homedir(), cfg.profileName) } catch {}
  },
})

const printedTextByTurn = new Map<string, string>()
const announceReady = (() => {
  let done = false
  return () => {
    if (done) return
    done = true
    const name = cfg.profileName === "stable" ? "Luna" : `Luna ${cfg.profileName}`
    write(io, `${name} ready. Type a message, /help, or /quit.\n`)
  }
})()

session.on("ready", announceReady)
session.on("threadChange", () => announceReady())
session.on("assistantDelta", ({ turnId, text }) => {
  const previous = printedTextByTurn.get(turnId) ?? ""
  const next = text.startsWith(previous) ? text.slice(previous.length) : text
  printedTextByTurn.set(turnId, text)
  if (previous.length === 0) write(io, "Luna: ")
  write(io, next)
})
session.on("assistantDone", ({ turnId }) => {
  printedTextByTurn.delete(turnId)
  write(io, "\n")
})
session.on("assistantError", ({ message, kind }) => {
  writeErr(io, `luna: ${kind ?? "error"}: ${message}\n`)
})
session.on("threadList", (threads) => {
  for (const t of threads) write(io, `${t.id}\t${t.title ?? ""}\t${t.status}\n`)
})
session.on("localShellStatus", (message, accepted) => {
  if (!accepted) writeErr(io, `local shell: ${message}\n`)
})
session.on("localShellRequest", (frame) => runLocalShellRequest(frame))
session.on("fatal", (reason) => { fatalErrorMessage = reason; lineReader.close() })
session.on("info", (text) => writeErr(io, `${text}\n`))
session.on("helpText", () => write(io, `${HELP_TEXT}\n`))

const sessionLoop = session.run()
```

Then replace the slash-switch in the `for await (const rawLine of lineReader)` block with:

```ts
for await (const rawLine of lineReader) {
  const line = String(rawLine).trimEnd()
  const command = parseSlashCommand(line)

  // Local-shell toggle still lives in the readline view because it
  // owns the LocalShellState object. Phase 2 moves this into the session.
  if (command.type === "local-shell") {
    localShell = setLocalShellEnabled(localShell, command.action === "on")
    if (!localShell.enabled) abortLocalShellTasks()
    write(io, `local shell: ${localShell.enabled ? "on" : "off"}\n`)
    sendLocalShellCapability(client, session.threadId, localShell)
    continue
  }
  if (command.type === "local-shell-status") {
    write(io, `local shell: ${localShell.enabled ? "on" : "off"}\n`)
    sendLocalShellCapability(client, session.threadId, localShell)
    continue
  }
  if (command.type === "error") {
    writeError(io, command.message)
    continue
  }
  if (command.type === "quit") {
    quitting = true
    session.beginQuit()
    abortLocalShellTasks()
    await waitForAssistantDrain(QUIT_DRAIN_MS)
    lineReader.close()
    break
  }

  session.dispatchSlash(line)
}

await sessionLoop
```

**Important:** `runLocalShellRequest`, `sendLocalShellCapability`, `localShell`, `abortLocalShellTasks`, `quitting`, `fatalErrorMessage`, and `lineReader` all keep their existing definitions in `chat/app.ts` for this task. Phase 2 will move them inside the headless session.

**Delete:** `renderFrame`, `markThread`, `resetThreadWaiter`, `sendUserMessage`, `flushPendingUserMessages`, `assistantTextByTurn`, `pendingUserMessages`, `threadWaiter`, `createThreadWaiter`, `pendingAssistantCount`, `trackPendingAssistant`, `finishPendingAssistant`, `pendingAssistantDrain`, `resolvePendingAssistantDrain`, and the `waitForAssistantDrain` helper. The session owns user-message buffering and thread-waiting now; the view derives drain state from `printedTextByTurn.size`.

Add this drain helper near the top of the event handler block:

```ts
const waitForAssistantDrain = async (timeoutMs: number): Promise<void> => {
  const start = Date.now()
  while (printedTextByTurn.size > 0 && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20))
  }
}
```

Polling with a 20ms tick is good enough for a 1000ms-bounded wait. The set shrinks on every `assistantDone` event handler we registered above.

Also update the assistant-error handler to clear the per-turn map:

```ts
session.on("assistantError", ({ message, kind, turnId }) => {
  writeErr(io, `luna: ${kind ?? "error"}: ${message}\n`)
  if (turnId !== null) printedTextByTurn.delete(turnId)
})
```

- [ ] **Step 3: Run integration test**

```bash
bun run --filter @luna/agent-cli test chat-app.integration
```

Expected: PASS. If any assertion fails, the most likely cause is a missing event handler — diff against the original `renderFrame` switch in `chat/app.ts:399–486` to find the gap.

- [ ] **Step 4: Run the full suite**

```bash
bun run --filter @luna/agent-cli test
```

Expected: all PASS.

- [ ] **Step 5: Manual smoke (no agent required)**

```bash
echo "/help" | bun run --filter @luna/agent-cli luna chat --help
```

Expected: prints `USAGE`, exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-cli/src/chat/app.ts
git commit -m "refactor(agent-cli): runLunaCli delegates protocol to LunaHeadlessSession"
```

---

## Task 6 — Replace `chat/args.ts` with a `citty` command

Today `chat/args.ts` is a hand-rolled parser invoked from `runLunaCli`. We replace it with a `citty` `defineCommand` whose `args` produce the same shape (`ParsedChatArgs`).

**Files:**
- Create: `apps/agent-cli/src/commands/chat.ts`
- Modify: `apps/agent-cli/src/chat/app.ts` (accept pre-parsed args alongside argv)
- Keep `apps/agent-cli/src/chat/args.ts` for now — it backs the integration test until task 7

- [ ] **Step 1: Create the citty command**

Create `apps/agent-cli/src/commands/chat.ts`:

```ts
import { defineCommand } from "citty"
import { runLunaCli } from "../chat/app.js"

export const chatCommand = defineCommand({
  meta: {
    name: "chat",
    description: "Interactive Luna chat session",
  },
  args: {
    profile: { type: "string", description: "named profile from ~/.luna/.env" },
    dev: { type: "boolean", description: "shortcut for --profile dev" },
    url: { type: "string", description: "UI WebSocket URL" },
    "fallback-url": { type: "string", description: "fallback UI WebSocket URL" },
    token: { type: "string", description: "UI WebSocket bearer token" },
    thread: { type: "string", description: "subscribe to an existing thread" },
    new: { type: "boolean", description: "force creation of a new thread" },
    "local-shell": { type: "boolean", description: "enable local shell capability" },
    "no-local-shell": { type: "boolean", description: "disable local shell capability" },
    "dangerously-auto-approve-local-shell": {
      type: "boolean",
      description: "auto-approve local shell requests inside a marked container",
    },
    "start-mode": { type: "string", description: "recovery mode: local, ssh, or none" },
    "start-command": { type: "string", description: "recovery command" },
    "start-ssh": { type: "string", description: "recovery SSH target" },
    "fallback-start-ssh": { type: "string", description: "fallback recovery SSH target" },
    "start-timeout-ms": { type: "string", description: "recovery timeout (ms)" },
  },
  async run({ args }) {
    const argv: string[] = []
    if (args.profile !== undefined) argv.push("--profile", args.profile)
    if (args.dev === true) argv.push("--dev")
    if (args.url !== undefined) argv.push("--url", args.url)
    if (args["fallback-url"] !== undefined) argv.push("--fallback-url", args["fallback-url"])
    if (args.token !== undefined) argv.push("--token", args.token)
    if (args.thread !== undefined) argv.push("--thread", args.thread)
    if (args.new === true) argv.push("--new")
    if (args["local-shell"] === true) argv.push("--local-shell")
    if (args["no-local-shell"] === true) argv.push("--no-local-shell")
    if (args["dangerously-auto-approve-local-shell"] === true) {
      argv.push("--dangerously-auto-approve-local-shell")
    }
    if (args["start-mode"] !== undefined) argv.push("--start-mode", args["start-mode"])
    if (args["start-command"] !== undefined) argv.push("--start-command", args["start-command"])
    if (args["start-ssh"] !== undefined) argv.push("--start-ssh", args["start-ssh"])
    if (args["fallback-start-ssh"] !== undefined) {
      argv.push("--fallback-start-ssh", args["fallback-start-ssh"])
    }
    if (args["start-timeout-ms"] !== undefined) {
      argv.push("--start-timeout-ms", args["start-timeout-ms"])
    }

    const { approveLocalCommand } = await import("../luna.js")
    const result = await runLunaCli(argv, {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      cwd: process.cwd(),
      approveLocalCommand,
    })
    process.exit(result.exitCode)
  },
})
```

**Note:** the `approveLocalCommand` re-import is intentionally circular and resolved at runtime — `luna.ts` exports it as a named function during task 8.

- [ ] **Step 2: Add a typecheck**

```bash
bun run --filter @luna/agent-cli typecheck
```

Expected: PASS (no usages of `chatCommand` yet, but the file must type-check).

- [ ] **Step 3: Commit**

```bash
git add apps/agent-cli/src/commands/chat.ts
git commit -m "feat(agent-cli): citty command wrapper for chat (not yet wired to bin)"
```

---

## Task 7 — Move account commands under citty

Today `src/index.ts` (the `luna-account` bin) wraps `commands/add.ts`, `commands/list.ts`, `commands/rm.ts` with its own argv parser. We re-wrap them as citty subcommands.

**Files:**
- Create: `apps/agent-cli/src/commands/account/index.ts`
- Modify: `apps/agent-cli/src/commands/{add,list,rm}.ts` — extract shared `runX(args)` helpers
- Test: `apps/agent-cli/test/citty-routing.test.ts`

- [ ] **Step 1: Inspect today's account command shape**

```bash
sed -n '1,50p' apps/agent-cli/src/commands/add.ts
```

Note the existing function signatures.

- [ ] **Step 2: Write a routing test**

Create `apps/agent-cli/test/citty-routing.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { defineCommand } from "citty"
import { accountCommand } from "../src/commands/account/index.js"

describe("citty account routing", () => {
  it("exposes list/add/rm subcommands", () => {
    // citty defineCommand returns a structure with subCommands metadata.
    expect(accountCommand.meta?.name).toBe("account")
    const subs = accountCommand.subCommands as Record<string, ReturnType<typeof defineCommand>>
    expect(Object.keys(subs).sort()).toEqual(["add", "list", "rm"])
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun run --filter @luna/agent-cli test citty-routing
```

Expected: FAIL — `accountCommand` not exported.

- [ ] **Step 4: Refactor add/list/rm to expose pure handlers**

Open `apps/agent-cli/src/commands/list.ts`. It currently contains an inline `async function listAccounts({ env }: …)`. Wrap it for export. Example shape (preserve the existing logic):

```ts
export type ListAccountsArgs = {
  env: Record<string, string | undefined>
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
}

export const listAccounts = async (args: ListAccountsArgs): Promise<number> => {
  // ...existing body, returning the exit code instead of calling process.exit
}
```

Do the same for `add.ts` and `rm.ts`. Adjust their bodies so they return an exit code (0 / 1 / 2) instead of calling `process.exit`. **Do not change behavior** — only the I/O boundary.

- [ ] **Step 5: Create the citty account command**

Create `apps/agent-cli/src/commands/account/index.ts`:

```ts
import { defineCommand } from "citty"
import { addAccount } from "../add.js"
import { listAccounts } from "../list.js"
import { removeAccount } from "../rm.js"

const list = defineCommand({
  meta: { name: "list", description: "list accounts" },
  async run() {
    const code = await listAccounts({ env: process.env, stdout: process.stdout, stderr: process.stderr })
    process.exit(code)
  },
})

const add = defineCommand({
  meta: { name: "add", description: "add an account" },
  args: {
    name: { type: "positional", description: "account name", required: true },
    token: { type: "string", description: "account token" },
  },
  async run({ args }) {
    const code = await addAccount({
      name: String(args.name),
      token: typeof args.token === "string" ? args.token : undefined,
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
    })
    process.exit(code)
  },
})

const rm = defineCommand({
  meta: { name: "rm", description: "remove an account" },
  args: {
    name: { type: "positional", description: "account name", required: true },
  },
  async run({ args }) {
    const code = await removeAccount({
      name: String(args.name),
      env: process.env,
      stdout: process.stdout,
      stderr: process.stderr,
    })
    process.exit(code)
  },
})

export const accountCommand = defineCommand({
  meta: { name: "account", description: "manage Luna accounts" },
  subCommands: { add, list, rm },
})
```

Adjust the calls to `addAccount` / `removeAccount` to match whatever signatures task-4 left in place after your refactor in step 4. The point is the shape, not the exact prop names.

- [ ] **Step 6: Run the routing test to verify it passes**

```bash
bun run --filter @luna/agent-cli test citty-routing
```

Expected: PASS.

- [ ] **Step 7: Run the full suite**

```bash
bun run --filter @luna/agent-cli test
```

Expected: all PASS. The existing `cli.test.ts` integration test for `luna-account` still uses the old `src/index.ts` entry — that's OK, we delete it in task 9.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-cli/src/commands/account/ apps/agent-cli/src/commands/add.ts apps/agent-cli/src/commands/list.ts apps/agent-cli/src/commands/rm.ts apps/agent-cli/test/citty-routing.test.ts
git commit -m "feat(agent-cli): citty subcommands for luna account add/list/rm"
```

---

## Task 8 — Wrap memory command in citty, unify bin entry

`luna memory` is currently handled inside `runLunaCli` via an argv prefix check (`chat/app.ts:209–214`). We extract it to its own citty command and rewire `luna.ts` to a citty `runMain`.

**Files:**
- Create: `apps/agent-cli/src/commands/memory.ts`
- Modify: `apps/agent-cli/src/luna.ts` — becomes citty `runMain`
- Modify: `apps/agent-cli/src/chat/app.ts` — remove the `argv[0] === "memory"` branch
- Modify: `apps/agent-cli/src/memory.ts` — ensure `runMemoryCommand` returns an exit-code shape consumable by citty

- [ ] **Step 1: Inspect current memory entrypoint**

```bash
sed -n '1,40p' apps/agent-cli/src/memory.ts
```

Confirm the exported `runMemoryCommand` signature (it returns `{ stdout, stderr, exitCode }`).

- [ ] **Step 2: Create the citty memory command**

Create `apps/agent-cli/src/commands/memory.ts`:

```ts
import { defineCommand } from "citty"
import { runMemoryCommand } from "../memory.js"

export const memoryCommand = defineCommand({
  meta: { name: "memory", description: "manage Luna memory store" },
  args: {
    _: { type: "positional", description: "memory subcommand and args", required: false },
  },
  async run({ rawArgs }) {
    const result = await runMemoryCommand(rawArgs, { env: process.env })
    if (result.stdout.length > 0) process.stdout.write(result.stdout)
    if (result.stderr.length > 0) process.stderr.write(result.stderr)
    process.exit(result.exitCode)
  },
})
```

`rawArgs` (provided by citty) is the slice of argv after `luna memory`. Verify by reading `node_modules/citty/dist/index.d.ts` if uncertain.

- [ ] **Step 3: Rewrite `luna.ts` as a citty root**

Open `apps/agent-cli/src/luna.ts`. Replace its body with:

```ts
#!/usr/bin/env bun
import { defineCommand, runMain } from "citty"
import { createReadStream, createWriteStream, openSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { accountCommand } from "./commands/account/index.js"
import { chatCommand } from "./commands/chat.js"
import { memoryCommand } from "./commands/memory.js"

export const approveLocalCommand = async (command: string): Promise<boolean> => {
  let input: ReturnType<typeof createReadStream> | undefined
  let output: ReturnType<typeof createWriteStream> | undefined
  try {
    input = createReadStream("", { fd: openSync("/dev/tty", "r"), autoClose: true })
    output = createWriteStream("", { fd: openSync("/dev/tty", "w"), autoClose: true })
    const rl = createInterface({ input, output })
    try {
      const answer = await rl.question(`Allow local shell command?\n${command}\n[y/N] `)
      const normalized = answer.trim().toLowerCase()
      return normalized === "y" || normalized === "yes"
    } finally {
      rl.close()
    }
  } catch {
    return false
  } finally {
    input?.destroy()
    output?.end()
  }
}

const root = defineCommand({
  meta: {
    name: "luna",
    description: "Luna agent client",
  },
  subCommands: {
    chat: chatCommand,
    account: accountCommand,
    memory: memoryCommand,
  },
})

if ((import.meta as { main?: boolean }).main === true) {
  runMain(root)
}
```

- [ ] **Step 4: Remove the memory-prefix branch from `chat/app.ts`**

In `apps/agent-cli/src/chat/app.ts`, delete the block:

```ts
if (argv[0] === "memory") {
  const result = await runMemoryCommand(argv.slice(1), { env: io.env })
  if (result.stdout.length > 0) write(io.stdout, result.stdout)
  if (result.stderr.length > 0) write(io.stderr, result.stderr)
  return { exitCode: result.exitCode }
}
```

And remove the now-unused `runMemoryCommand` import.

- [ ] **Step 5: Update the unit tests for memory dispatch**

Open `apps/agent-cli/test/memory-cli.test.ts`. If any test imports `runLunaCli` and asserts memory routing, switch it to import `runMemoryCommand` directly (it already exists; the test is just exercising the dispatcher).

- [ ] **Step 6: Run the suite**

```bash
bun run --filter @luna/agent-cli test
```

Expected: all PASS.

- [ ] **Step 7: Manual smoke**

```bash
bun run --filter @luna/agent-cli luna --help
bun run --filter @luna/agent-cli luna chat --help
bun run --filter @luna/agent-cli luna account --help
bun run --filter @luna/agent-cli luna memory --help
```

Each prints help text and exits 0.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-cli/src/luna.ts apps/agent-cli/src/commands/memory.ts apps/agent-cli/src/chat/app.ts apps/agent-cli/test/memory-cli.test.ts
git commit -m "feat(agent-cli): unify luna bin under citty (chat/account/memory subcommands)"
```

---

## Task 9 — Delete `luna-account` bin and `chat/args.ts`

The legacy entries are dead code now. Removing them shrinks the surface area.

**Files:**
- Delete: `apps/agent-cli/src/index.ts`
- Delete: `apps/agent-cli/src/chat/args.ts`
- Modify: `apps/agent-cli/package.json` — drop the `luna-account` bin entry
- Modify: `apps/agent-cli/src/chat/app.ts` — replace `parseChatArgs` call with inline arg-shape construction

- [ ] **Step 1: Find every importer of `parseChatArgs`**

```bash
grep -rn "parseChatArgs\|chat/args" apps/agent-cli/src apps/agent-cli/test
```

Expected: imports in `chat/app.ts` and `test/cli.test.ts` (or similar). The new path is: `chat.ts` (citty command) builds the legacy argv array and `runLunaCli` parses it. We can keep `parseChatArgs` *for now* and only delete it once `runLunaCli` is gone in Phase 2.

**Decision:** **don't delete `chat/args.ts` yet**. Just delete `src/index.ts`.

- [ ] **Step 2: Delete the `luna-account` bin**

```bash
rm apps/agent-cli/src/index.ts
```

- [ ] **Step 3: Update `apps/agent-cli/package.json`**

Edit `bin`. Replace:

```json
"bin": {
  "luna": "./src/luna.ts",
  "luna-account": "./src/index.ts"
},
```

with:

```json
"bin": {
  "luna": "./src/luna.ts"
},
```

Also remove the `luna-account` script entry under `"scripts"`:

```diff
- "luna-account": "bun run src/index.ts",
```

- [ ] **Step 4: Update or remove tests that invoke the deleted bin**

Check `apps/agent-cli/test/cli.test.ts`:

```bash
grep -n "luna-account\|index.ts" apps/agent-cli/test/cli.test.ts
```

If the test spawns `bun run src/index.ts` to exercise `luna-account`, rewrite it to spawn `bun run src/luna.ts account <subcommand>` instead. The behavior assertions stay the same.

- [ ] **Step 5: Run the suite**

```bash
bun run --filter @luna/agent-cli test
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A apps/agent-cli/
git commit -m "refactor(agent-cli): retire luna-account bin (subsumed by 'luna account')"
```

---

## Task 10 — README + typecheck + final integration smoke

Sanity pass before opening a PR.

**Files:**
- Modify: `apps/agent-cli/README.md` (if it exists; otherwise create with command reference)

- [ ] **Step 1: Typecheck**

```bash
bun run --filter @luna/agent-cli typecheck
```

Expected: PASS.

- [ ] **Step 2: Workspace-wide test**

```bash
bun run test
```

Expected: all PASS across workspaces. Some packages may take a while; allow up to a minute.

- [ ] **Step 3: README**

Check if `apps/agent-cli/README.md` exists:

```bash
ls apps/agent-cli/README.md 2>/dev/null && echo "exists" || echo "missing"
```

If it exists, update the command synopsis. If it's missing, skip (README authoring is not in this plan's scope).

If updating, change command examples from `luna-account <subcommand>` to `luna account <subcommand>`. Use:

```bash
grep -l "luna-account" apps/agent-cli/
```

to find references.

- [ ] **Step 4: Manual end-to-end smoke**

The integration test covers the WS path; this checks help / version / error paths.

```bash
bun run --filter @luna/agent-cli luna --help
bun run --filter @luna/agent-cli luna chat --help
bun run --filter @luna/agent-cli luna account list
bun run --filter @luna/agent-cli luna memory --help
bun run --filter @luna/agent-cli luna fakecommand 2>&1 | head -5
```

Last one should print a usage error and exit non-zero.

- [ ] **Step 5: Commit any README changes**

```bash
git add apps/agent-cli/README.md
git commit -m "docs(agent-cli): update CLI command reference for citty routing"
```

(Skip if no README changes were made.)

---

## Task 11 — Open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/tui-phase-1-refactor
```

- [ ] **Step 2: Open the PR**

Run:

```bash
gh pr create --base dev --title "feat(agent-cli): TUI phase 1 — extract headless layer, adopt citty" --body "$(cat <<'EOF'
## Summary

Foundational refactor for the TUI work described in `docs/superpowers/specs/2026-05-26-tui-shape-design.md`. No user-visible behavior changes.

- Extract `LunaHeadlessSession` from `chat/app.ts` — protocol logic now lives in a typed event-emitter class with no stdin/stdout coupling
- Unify CLI commands under one `luna` binary via `citty`: `luna chat`, `luna account add/list/rm`, `luna memory ...`
- Retire `luna-account` bin (subsumed by `luna account`)
- Export `SLASH_COMMANDS` registry from `slash.ts` for the upcoming TUI slash completion

## Test plan

- [ ] `bun run --filter @luna/agent-cli test` — all PASS (existing 790-line integration test is the canary)
- [ ] `bun run --filter @luna/agent-cli typecheck` — PASS
- [ ] Manual: `luna --help`, `luna chat --help`, `luna account list`, `luna memory --help` all render correctly
- [ ] Manual: `luna chat --dev` against the dev server reaches `Luna ready.` prompt

## Follow-ups

- Phase 2 plan (TUI core) — to be written after this lands
- Phase 3 plan (rich features) — to be written after Phase 2 lands
EOF
)"
```

Expected: PR URL prints; the agent's job is done.

---

## Spec Coverage Self-Check

| Spec requirement | Task |
|---|---|
| One binary, `citty` routes subcommands | 6, 7, 8, 9 |
| Headless layer with typed event/command surface | 4, 5 |
| `parseSlashCommand` exports `SLASH_COMMANDS` registry | 2 |
| Pre-TUI lifecycle (config validation, recovery) stays pre-TUI | Preserved by task 5 (runLunaCli untouched in startup) |
| `ServerFrame` routing centralized in one switch | 4 (now lives in `LunaHeadlessSession.handleFrame`) |
| Existing 790-line integration test stays green | Verified at every task |
| `chat/local-shell.ts`, `chat/ws-client.ts`, `chat/config.ts`, `chat/recovery.ts` unchanged | Confirmed — no edits to any of these files |
| Future TUI mounts on the headless surface | Task 4 produces the seam; Phase 2 uses it |

**Not in this plan (defer to Phase 2):**

- OpenTUI mount + alt-screen lifecycle
- ChatStream, InputArea, StatusFooter components
- `bun test` snapshot infrastructure
- `--no-tui` flag (not needed yet — the readline view is still the only view)
- Local-shell logic migration into the headless session (currently still in `chat/app.ts`)

**Not in this plan (defer to Phase 3):**

- ContextPanel + Memories/Events/Artifacts tabs
- MarkdownTerm rendering
- ApprovalModal + queue
- Slash completion popover
- Error boundary + crash dump + signal handlers

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Task 5 (rewire `runLunaCli`) is the biggest behavior-preserving change. A subtle event-handler gap could fail the integration test in opaque ways. | Diff against the original `renderFrame` switch line-by-line. Run the integration test after every step inside task 5. |
| `citty`'s typed args API may not exactly match the existing `parseChatArgs` shape. | Task 6 keeps the legacy `parseChatArgs` and just shims through to `runLunaCli` with a constructed argv array. Phase 2 retires `parseChatArgs`. |
| Workspace-wide tests are slow; running them after every task is wasteful. | Only run `bun run --filter @luna/agent-cli test` after each task; run `bun run test` (full workspace) only at task 10. |
| `luna-account` may have external callers (CI, docs). | Search before deleting: `grep -rn "luna-account" .`. If hits, deprecate with a shim that prints `"use 'luna account' instead"` for one release cycle. The plan currently assumes no external callers. |
