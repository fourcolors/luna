# Luna TUI Shape Design

Date: 2026-05-26
Status: Drafted, pending user review
Supersedes UX layer of: [2026-05-24-luna-terminal-client-design.md](./2026-05-24-luna-terminal-client-design.md)

## Summary

Evolve `luna chat` from a line-based readline loop into a full-screen TUI built on OpenTUI + SolidJS, while preserving the existing protocol, recovery loop, local-shell semantics, and `LunaWsClient` integration. Add `--no-tui` as a first-class headless mode so CI, scripting, and `luna chat | grep` still work.

The non-chat commands (`luna account`, `luna memory`) move under a single `citty`-routed binary and stay line-based; they never enter the TUI.

## Context

The current CLI (see prior spec) wraps `runLunaCli(argv, io)` around a single readline loop. The seam is good — I/O is injected, slash parsing is pure, frames flow through one switch — but the surface is text-only: no scrollback, no panes, no live status, no markdown rendering, and shell-approval prompts inline with chat (`/dev/tty`).

A separate process is finishing work on `master`. This spec targets the `dev` branch and assumes the protocol-layer changes in flight there land cleanly before TUI work begins.

## Goals

- Replace the readline chat surface with a full-screen TUI that streams deltas, renders markdown, shows a contextual side panel, and pops a modal for shell approval.
- Keep the headless path (`--no-tui`) as a first-class mode for CI, pipes, and degraded environments.
- Share state and protocol logic with `ui-web` via Solid signals; do not share DOM components.
- Unify all CLI commands under one `citty`-routed binary (`luna`).
- Make the TUI testable from Vitest/`bun test` without spawning a real terminal.

## Non-Goals

- No replacement for `ui-web`. The web client continues to evolve independently.
- No support for Tauri. `apps/ui-tauri` is dormant; we stop designing around it. *(Update 2026-06-03: `apps/ui-tauri` has since been removed from the tree.)*
- No mouse support in v1.
- No node-pty / vt100 integration tests.
- No second renderer (we do not abstract the component tree to render to DOM and terminal both).
- No reactive auto-extension of the input area beyond 8 visible rows.

## Decisions

Locked during brainstorming:

| Decision | Choice |
|---|---|
| TUI renderer | **OpenTUI** with `@opentui/solid` |
| Command router | **citty** for subcommands; `@clack/prompts` for one-shot prompts |
| Layout | Chat column + context panel; single active thread |
| Context panel tabs | Memories · Events · Artifacts (no thread-list pane) |
| Input model | Single line → multi-line on shift-enter; slash completion popover; hotkeys for panel |
| Shell approval | Full-screen modal overlay (`y` once / `a` session / `n` deny / `esc` deny) |
| Component reuse | Share `createUiStore`, `ServerFrame`, protocol logic; write fresh TUI components |
| v1 scope | Chat stream + context panel + approval modal + markdown rendering — all included |

## Architecture

### Binary model

One binary. `citty` routes subcommands. Only `chat` enters alt-screen + raw mode.

```
luna <command> [args]
  ├── chat     → OpenTUI app (full-screen, alt-screen, raw stdin)
  ├── account  → plain stdout (list / rm) + @clack/prompts (add)
  ├── memory   → plain stdout (ls / search / save)
  └── --help   → citty-generated help
```

### Package layout

```
apps/agent-cli/
  src/
    luna.ts                  # bin entry: citty.runMain(rootCommand)
    commands/
      chat.ts                # mounts TUI via @opentui/solid (or --no-tui)
      account/{add,list,rm}.ts
      memory.ts
    tui/
      App.tsx
      ChatStream.tsx
      InputArea.tsx
      ContextPanel.tsx       # tabs: Memories | Events | Artifacts
      MemoriesTab.tsx
      EventsTab.tsx
      ArtifactsTab.tsx
      ApprovalModal.tsx
      StatusFooter.tsx
      SlashCompletion.tsx
      MarkdownTerm.tsx
      store.ts               # createTuiStore — wraps createUiStore
      keymap.ts               # central keybinding table
      hooks/
        useFrameStream.ts    # ServerFrame → store actions
        useApprovalQueue.ts  # local-shell-request queue
        useTerminalSize.ts
    chat/                    # existing — extracted to headless layer
      headless.ts            # NEW: WS connect + recovery + shell exec + slash dispatch
      ws-client.ts           # unchanged
      slash.ts               # additive: export SLASH_COMMANDS registry
      config.ts, recovery.ts, args.ts, local-shell.ts  # unchanged
```

### Key seam

The existing `runLunaCli` splits in two:

- **`chat/headless.ts`** owns the WS lifecycle, recovery, local-shell execution, slash dispatch, and thread-state machine. Exposes a typed event surface (`onFrame`, `onApprovalNeeded`) and a typed command surface (`sendUser`, `sendSlash`, `quit`). No stdin/stdout.
- **`tui/App.tsx`** subscribes to that surface and renders Solid components through `@opentui/solid`.
- **`commands/chat.ts`** wires the two together. Default is TUI; `--no-tui` (or detected non-TTY stdout) falls back to today's readline loop pointed at the same headless layer.

The headless layer is the test seam *and* the product feature. CI uses it. Pipes use it. The TUI is one of two consumers.

### Pre-TUI / in-TUI phase split

Connection failures, config errors, and recovery output stay pre-TUI on stderr. The TUI only mounts after `connectWithRecovery` succeeds. This keeps startup debuggable and prevents the TUI from taking stdout hostage when something is already broken.

## Components

The TUI is eight components plus three hooks. All read from one store; components are pure views.

### Root surface

**`<App>`** — root. Owns alt-screen lifecycle, `useTerminalSize`, top-level keymap dispatch. Selects layout from cols:

- **wide** (cols ≥ 100): `[ ChatStream | ContextPanel ]` row + `StatusFooter` + modal overlay
- **narrow**: `ChatStream` only; `Ctrl-B` toggles `ContextPanel` as full-screen overlay

### Chat column

**`<ChatStream>`** — scrollable message log. Reads `store.messages` (settled turns) + `store.currentTurn` (in-flight delta). Assistant rows use `<MarkdownTerm>`. Auto-scrolls on new content unless the user has scrolled up (sticky-bottom).

**`<InputArea>`** — input box. Single-line default, shift-enter grows to multi-line (cap 8 rows then internal scroll). Owns input history navigation and slash detection.

**`<SlashCompletion>`** — popover above input when first char is `/`. Reads the `SLASH_COMMANDS` registry exported from `chat/slash.ts`. Tab completes; esc closes.

**`<MarkdownTerm>`** — terminal markdown renderer. Uses `shiki` (already a workspace dep via `ui-web`) for fenced code; inline parser handles bold, italic, links. Stream-safe: re-tokenizes on each delta using a tolerant parser; re-renders through the strict parser once on `assistant-done`.

### Context column

**`<ContextPanel>`** — tabbed container. Header shows tab name and count. Tab key cycles; `Ctrl-1/2/3` jumps.

| Tab | Source | Refresh |
|---|---|---|
| Memories | `@luna/memory` search keyed off `store.lastUserMessage` | debounced 300ms |
| Events | `useFrameStream` side-effect (ring buffer, last 200) | live |
| Artifacts | `artifacts-extracted` frames | live |

Each tab is its own component (`<MemoriesTab>`, `<EventsTab>`, `<ArtifactsTab>`) so they can be stubbed or tested in isolation.

### Overlays & chrome

**`<ApprovalModal>`** — full-modal pause when `useApprovalQueue` has a head entry. Keys: `y` once, `a` session-allow (this command string only, in-memory only), `n`/`esc` deny. Shows `(N/M)` if multiple queued.

**`<StatusFooter>`** — single line: `profile • thread <id…> • shell on/off • connection ↑/↓ • pending: N`. Cells light up red on error, green on connect.

### State & hooks

**`createTuiStore`** composes from existing `createUiStore` (Solid signals for messages, turn, thread) plus TUI-only signals: `panelTab`, `inputDraft`, `inputHistory`, `approvalQueue`, `viewportSize`, `scrollPinned`, `slashCompletionOpen`.

**`useFrameStream(client)`** subscribes to `client.nextFrame()` and dispatches to the store. The frame-type switch that lives in today's `chat/app.ts:399` moves here.

**`useApprovalQueue(localShell, client)`** replaces the `/dev/tty` `approveLocalCommand` function. Pushes to the modal queue; awaits store resolution.

**`useTerminalSize()`** observes resize; drives wide/narrow layout.

**`keymap.ts`** is a data table consumed by `<App>`. Each entry: `{ keys, scope, action, label }`. Reused by a future `?` help overlay.

### Reuse without rewrite

| Reused | From | Touched? |
|---|---|---|
| `parseSlashCommand` | `chat/slash.ts` | Additive: export `SLASH_COMMANDS` |
| `LunaWsClient` | `chat/ws-client.ts` | No |
| `executeLocalCommand` | `chat/local-shell.ts` | No |
| `loadChatConfig`, `connectWithRecovery` | `chat/config.ts`, `chat/recovery.ts` | No |
| `ServerFrame` types | `@luna/ui-ws` | No |
| `createUiStore` | `@luna/ui-shared-solid` | No |
| `shiki` highlighter | workspace dep via `ui-web` | No |
| `@luna/memory` lookup | direct import | No |

## Data Flow

### Server → UI

```
WS socket
  ↓ binary frames
LunaWsClient.nextFrame()
  ↓ ServerFrame
useFrameStream() — switch(frame.type)
  ↓ store action
createTuiStore
  ↓ reactive read
Components
```

Per-frame routing carries over from today's `renderFrame`. New frame kinds add one case to one hook.

| Frame | Mutation | Effect |
|---|---|---|
| `thread-created`, `thread-snapshot`, `user-accepted` | `setThread(id, …messages)` | Header + ChatStream replays history |
| `assistant-delta` | `appendTurnDelta(turnId, text)` | ChatStream re-renders `MarkdownTerm` |
| `assistant-done` | `finalizeTurn(turnId)` | Strict markdown re-render |
| `assistant-error` | `pushError(err)` (stale-resume branch unchanged) | Error row + auto-recovery |
| `thread-list` | `setThreads([...])` | `/threads` output |
| `local-shell-status` | `setLocalShellStatus(msg)` | Footer + toast |
| `local-shell-request` | `useApprovalQueue.push(request)` | Modal mounts |
| `artifacts-extracted` | `setArtifacts(thread, list)` | Artifacts tab |
| `event`, `drop`, `hello`, `ping` | sometimes `events[]` | Events tab |
| `bye` | `setFatal(reason)` | Shutdown |

### UI → Server

```
keypress
  ↓
InputArea or keymap.ts
  ↓ on enter
parseSlashCommand(line)
  ↓
client.send(...) per command type
```

Pre-thread messages buffer in `pendingUserMessages` and flush when `setThread` fires — same behavior as today.

### Approval pipeline

```
WS local-shell-request frame
  ↓
useApprovalQueue.push(request)
  ↓ reactive
<ApprovalModal> mounts
  ↓ user keypress
useApprovalQueue.resolve(decision)
  ↓
  approve → executeLocalCommand → client.send(result)
  session → allowlist + executeLocalCommand → client.send(result)
  deny    → client.send(deniedLocalShellResult(...))
```

`executeLocalCommand` is unchanged. Only the `approve` callback wiring changes — instead of `/dev/tty` readline, it awaits the queue. The session allowlist uses exact-string match for v1 (no globbing) and lives only in memory.

### Lifecycle

**Startup** (pre-TUI through step 3):

1. `citty` resolves `luna chat …` → `commands/chat.ts`.
2. `loadChatConfig` validates; on error, exit 2 with plain stdout.
3. `connectWithRecovery` blocks until connect or recovery exhaustion; status to stderr.
4. Mount OpenTUI alt-screen and Solid root.
5. `useFrameStream` attaches; dispatch subscribe or new-thread per config.
6. First `thread-created` / `thread-snapshot` flips the `ready` signal; footer goes green.

**Shutdown**:

1. `/quit` or `Ctrl-D` → `store.beginQuit()`.
2. Abort in-flight local-shell controllers (existing logic).
3. Wait bounded (`QUIT_DRAIN_MS = 1000`) for pending turns.
4. `client.close()`.
5. OpenTUI unmount → alt-screen restored.
6. Exit with code from store.

## Error Handling

### Connection & network

| Failure | User sees | System does |
|---|---|---|
| Initial connect fails, no recovery | stderr error, exit 1, no TUI | reused |
| Initial connect fails, recovery enabled | stderr recovery messages, retries | reused |
| Mid-session WS drop | footer red, input accepts and queues locally | reconnect with backoff (1s, 2s, 4s, 8s, cap 30s); messages buffered |
| Reconnect succeeds | footer green, queued flushed | re-subscribe, replay buffer |
| Reconnect exhausted (10 tries) | modal: `Connection lost. [r]etry [q]uit` | user decides |
| `bye` frame | modal: `Server closed: <reason>. [q]uit` | no auto-restart |

### Terminal & render

| Failure | User sees | System does |
|---|---|---|
| Terminal < 50×12 | `Terminal too small (need ≥ 50×12). Resize to continue.` | renderer suspended; re-enable on resize |
| Resize | layout snaps wide ↔ narrow | `useTerminalSize` signal updates |
| OpenTUI render throws | stderr stack + crash dump at `~/.luna/crash-<ts>.json`; alt-screen restored | Solid `ErrorBoundary` + `uncaughtException` handler |
| Renderer hung > 5s | no automatic recovery in v1 | out of scope |

**Terminal restoration is non-negotiable.** Every exit path (clean, error, signal, panic) runs the same `restoreTerminal()` — direct ANSI writes via `fs.writeSync(2, …)`, not through OpenTUI. `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException`, and `unhandledRejection` all funnel through it.

### WS protocol errors

| `error.kind` | Behavior |
|---|---|
| `unknown-thread` + auto-resumed id | Silent — clear persisted id, reset thread, start new one. **Reused from today.** |
| `unknown-thread` + user-supplied id | Modal: `Thread <id> not found. [n]ew thread [q]uit` |
| `rate-limited` | Toast in chat with retry hint |
| `auth-failed` | Blocking modal; `[q]uit` only |
| Other | Inline error row; chat continues |

### Local shell

| Failure | Effect |
|---|---|
| Timeout (`DEFAULT_LOCAL_COMMAND_TIMEOUT_MS = 30s`) | Tool row shows `timed out`; server gets `timedOut: true` |
| Output > 64KB | Truncated with marker |
| User abort (new `Ctrl-X` keybind) | Tool row shows `aborted by user`; result `exitCode: null` |
| Approval queue entry expires (60s no decision) | Modal vanishes; chat shows auto-deny notice |
| Shell disabled mid-command | All controllers aborted |
| cwd outside `--dangerously-auto-approve-local-shell` root | Denied silently to server with reason |

### Subsystem degradation

Each context tab is bulkheaded.

| Failure | Effect |
|---|---|
| `memory.search()` throws | MemoriesTab shows error string; chat unaffected; auto-retry after 30s |
| `shiki` highlight throws | Block falls back to plain monospace; logged |
| MarkdownTerm parser throws | Message falls back to raw text; logged |
| Artifacts payload malformed | Row shows `(malformed payload)`; siblings render |

Pattern: every subsystem boundary has a try/catch that produces a user-visible string instead of propagating.

### Approval queue invariants

- Every push has a resolution — user, timeout, abort, or shutdown.
- On `beginQuit()`, all remaining entries get a deny sent to the server.
- `resolve()` is idempotent (double-fire is a no-op, not a crash).

### Process-level

```
SIGINT  ─┐
SIGTERM ─┤
SIGHUP  ─┤
uncaughtException  ─┼─► restoreTerminal() ─► drain shell tasks (100ms cap) ─► client.close() ─► exit
unhandledRejection ─┘
```

`restoreTerminal()` is reentrant and synchronous. It must succeed under partially torn-down state.

Crash dump (`~/.luna/crash-<ts>.json`) includes the last 50 frames, the last 20 store mutations (ring buffer), terminal dimensions, and the error stack. Opt-out via `LUNA_NO_CRASH_DUMP=1`.

## Testing

Goal: make the TUI testable without a real terminal. The architecture already does the hard part — separating headless brain from renderer — so most tests run as plain Vitest with no special harness.

### Test pyramid

```
┌────────────────────┐
│  Smoke (manual)    │  ← real terminal, opt-in, ~2–3 scenarios
├────────────────────┤
│  TUI render        │  ← @opentui/solid testRender + captureCharFrame
│                    │     under `bun test`, ~5–8 snapshots
├────────────────────┤
│  Headless E2E      │  ← stub WS, drive ServerFrame fixtures
│                    │     under Vitest, ~15–20 scenarios
├────────────────────┤
│  Hooks / store     │  ← Solid testing utils + StubWsClient
│                    │     under Vitest, ~30–50 specs
├────────────────────┤
│  Unit (pure fns)   │  ← slash parser, keymap, md tokenizer
│                    │     under Vitest, many
└────────────────────┘
```

### Why two runners

OpenTUI Solid JSX requires Bun's preload mechanism to install the `babel-preset-solid` transform plugin (`bun --preload @opentui/solid/preload`). Confirmed in the spike at `.scratch/opentui-spike/`:

- `testRender` + `captureCharFrame` work end-to-end on Bun with no TTY.
- Output is plain Unicode (no ANSI escapes) — snapshot diffs are visually inspectable in PRs.
- 2/2 tests passed in 251ms; clean teardown via `renderer.destroy()`.

Vitest does not run inside Bun's preload context, so the snapshot-test layer lives under `bun test`. The two runners are API-compatible (same `test`, `expect`, `describe`, `afterEach`, `toMatchSnapshot`); only the import differs.

```
package.json scripts:
  test       → vitest run                              # unit, hook, headless E2E
  test:tui   → bun test --preload @opentui/solid/preload apps/agent-cli/tui-tests
```

CI runs both. Each PR shows snapshot diffs as ASCII art.

### Unit layer

- `parseSlashCommand` extended for the `SLASH_COMMANDS` registry export.
- `keymap.ts` as a pure data table → trivial.
- `MarkdownTerm` tolerant parser (unclosed fences, partial emphasis).
- Session-allowlist match (exact string for v1).
- `connectWithRecovery` (existing seam preserved).

### Hooks & store

Test reducers like reducers: induce frames, assert store. `test/fixtures/frames.ts` exports canned `ServerFrame` sequences — happy turn, streaming + tool call, unknown-thread auto-resume, shell-request + approve, drop + reconnect. Tests compose from fixtures.

`StubWsClient` (~30 LOC) exposes `emit(frame)`, `nextFrame()`, and a `sent: ServerCommand[]` array for assertions.

Coverage targets at this layer:

- Pre-thread message buffering and flush.
- Approval queue ordering and timeout auto-deny.
- Stale-resumed-thread auto-recovery (today's `app.ts:447–467`).
- Bulkheading: induce `memory.search()` to throw; assert chat unaffected.

### Headless E2E

`runLunaHeadless(argv, io)` preserves today's `runLunaCli` shape. Existing tests against it carry over unchanged. New tests cover the `--no-tui` path of the new binary.

### TUI render snapshots

One per major surface:

- empty chat (ready, no messages)
- mid-stream turn (assistant typing)
- approval modal mounted
- narrow layout (panel overlay)
- error toast row
- artifacts tab populated
- terminal too small
- tool-call group expanded

```typescript
import { test, expect, afterEach } from "bun:test"
import { testRender } from "@opentui/solid"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => { setup?.renderer.destroy(); setup = undefined })

test("approval modal at 100x30", async () => {
  const store = createTuiStore()
  seedStore(store, fixtures.approvalQueued)
  setup = await testRender(() => <App store={store} />, { width: 100, height: 30 })
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toMatchSnapshot()
})
```

### Smoke (manual)

`scripts/tui-smoke.ts` drives a real `luna chat` against a fake chat-server with scripted responses. Not in `bun run test`. Two or three flows: connect → send → receive → approve → quit.

We do not automate full terminal emulation (node-pty + vt100). The cost-benefit fails against the snapshot layer above.

### Not tested

- OpenTUI internal rendering (their job).
- Exact ANSI escape sequences.
- Terminal hardware variations.
- Shell-out interactivity (vim from a tool call).

## Out of Scope (for v1; on the roadmap)

- Vim-style modal navigation. The minimal Claude-Code-like input is v1.
- Command palette (`Ctrl-K` fuzzy).
- Mouse support.
- Session-allowlist with command-pattern globbing.
- Persistent session-allowlist across runs.
- Multi-thread split view.
- Inline tool-call output streaming (today's chat renders tool calls inline; v1 keeps that, v2 may add structured collapse/expand).
- Theme system. v1 uses OpenTUI defaults plus targeted color choices for status cells.

## Open Questions

None blocking implementation. Two to revisit during planning:

1. Does `@luna/memory.search` already expose a method shape that `<MemoriesTab>` can call without changes? If not, the spec adds one trivially.
2. Does `chat-service` already emit `artifacts-extracted` frames for the cases we want surfaced, or are some artifact types not yet wired? Inventory during planning.

## References

- Prior spec: [2026-05-24-luna-terminal-client-design.md](./2026-05-24-luna-terminal-client-design.md)
- OpenTUI repo: https://github.com/anomalyco/opentui
- Spike artifacts: `.scratch/opentui-spike/`
- Existing chat surface: `apps/agent-cli/src/chat/app.ts`
- Solid components reused: `packages/ui-shared-solid/src/store.ts`
