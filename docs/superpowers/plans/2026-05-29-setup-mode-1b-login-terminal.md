# Setup-Mode #1b — Embedded Login Terminal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In setup-mode, serve a **live embedded `claude setup-token` terminal** in the web UI: the operator opens the printed URL in their browser, logs into claude.ai, pastes the code back into the terminal; on success the server **seeds the `claude-code:login` account and restarts → the #1a gate boots it into normal chat-mode.** The visible payoff of the onboarding work.

**Architecture:** A `script`-based pty (util-linux `script -qec "<claude> setup-token" /dev/null` — verified to allocate a real TTY + stream under Bun, no native dep) bridged over the existing ui-ws WebSocket via three new frames (`pty-output` server→client, `pty-input`/`pty-resize` client→server). The setup-mode WS layer (#1a's `buildSetupServerLayer`) gains a pty handle, which also makes the inbound message handler register (today it's gated on chat/localShell/survey). The SolidJS client renders an `@xterm/xterm` terminal when `capabilities.setup` is true. On pty exit the server runs `claude auth status`; if logged in it seeds the account (`addAccount`) and `process.exit(0)` → the restart policy respawns → #1a's gate lands normal.

**Tech Stack:** bun, `node:child_process` (`script`), Effect, the ui-ws WS server + protocol, SolidJS + `@xterm/xterm` (new dep), vitest.

**Spec:** `docs/superpowers/specs/2026-05-29-server-setup-mode-onboarding-design.md` §4.C/§4.D. Builds on #1a (merged: `ef645a1`/`577ba9f`/`c60c8eb`/`b575204`) and PR 0.

## Scope
- **In:** pty frames; the `script`-pty↔WS bridge; setup-mode wiring (handle + inbound routing); seed-on-login + restart; the xterm.js setup view.
- **Out (deferred):** live lapse-detection→restart while in normal-mode — #1a's gate already routes a lapsed credential into setup-mode on the *next* restart; proactive auto-flip belongs with the cred-health timer / `luna doctor` (installer spec §6). The CLI `luna login` power-user path. `op://`/`api-key` setup flows (this terminal is the subscription path).
- **Security invariant (every task respects it):** the pty WS is gated by the same `UI_WS_TOKEN` upgrade auth as the chat WS — an unauthenticated client must never reach the terminal (it runs `claude`). #1a's setup-mode already starts the WS server with the token gate; do not weaken it.

## File structure
- **Modify** `packages/ui-ws/src/protocol.ts` — add `PtyOutputFrame` (ServerFrame), `PtyInputFrame` + `PtyResizeFrame` (ClientFrame).
- **Modify** `packages/ui-shared/src/wire.ts` — shadow the 3 frames.
- **Create** `apps/ui-web/scripts/setup-pty.ts` — the `script`-pty bridge (spawn, stream, onExit).
- **Modify** `packages/ui-ws/src/server.ts` — accept a `setupPty` handle; register the inbound handler when it's present; route `pty-input`/`pty-resize`; stream `pty-output`.
- **Modify** `apps/ui-web/scripts/chat-server.ts` — `buildSetupServerLayer` wires the pty + the on-success seed+restart.
- **Create** `apps/ui-web/src/SetupTerminal.tsx` — the xterm.js component.
- **Modify** `apps/ui-web/src/App.tsx` — render `<SetupTerminal>` when `capabilities.setup`.
- **Modify** `apps/ui-web/package.json` — add `@xterm/xterm` + `@xterm/addon-fit`.
- Tests alongside each.

---

### Task 1: pty WebSocket frames

**Files:** `packages/ui-ws/src/protocol.ts`, `packages/ui-shared/src/wire.ts`, test in `packages/ui-ws/test/`.

- [ ] **Step 1 — failing test.** Create `packages/ui-ws/test/pty-frames.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import type { PtyOutputFrame, PtyInputFrame, PtyResizeFrame } from "../src/protocol.js"

describe("pty frames", () => {
  it("output (server→client), input + resize (client→server) have the expected shapes", () => {
    const out: PtyOutputFrame = { type: "pty-output", data: "aGk=" } // base64
    const inp: PtyInputFrame = { type: "pty-input", data: "y" }
    const rsz: PtyResizeFrame = { type: "pty-resize", cols: 80, rows: 24 }
    expect(out.type).toBe("pty-output")
    expect(inp.type).toBe("pty-input")
    expect(rsz.cols).toBe(80)
  })
})
```
- [ ] **Step 2 — run, verify FAIL** (types missing): `bun run test packages/ui-ws/test/pty-frames.test.ts`.
- [ ] **Step 3 — add the frames.** In `packages/ui-ws/src/protocol.ts`, before the `ServerFrame`/`ClientFrame` unions, add:
```ts
/** Server→client: a chunk of pty stdout, base64-encoded (raw bytes, may include control codes). */
export interface PtyOutputFrame {
  readonly type: "pty-output"
  readonly data: string
}
/** Client→server: keystrokes for the pty stdin, base64-encoded. */
export interface PtyInputFrame {
  readonly type: "pty-input"
  readonly data: string
}
/** Client→server: terminal resize. */
export interface PtyResizeFrame {
  readonly type: "pty-resize"
  readonly cols: number
  readonly rows: number
}
```
Add `| PtyOutputFrame` to `ServerFrame` and `| PtyInputFrame | PtyResizeFrame` to `ClientFrame`.
- [ ] **Step 4 — shadow in ui-shared.** In `packages/ui-shared/src/wire.ts`, add the same three interfaces and extend its `ServerFrame`/`ClientFrame` shadow unions identically (the file mirrors protocol.ts — match it).
- [ ] **Step 5 — run, verify PASS** + the existing ui-ws/ui-shared suites: `bun run test packages/ui-ws/ packages/ui-shared/`. Run `tsc --noEmit -p packages/ui-shared/tsconfig.json`.
- [ ] **Step 6 — commit:** `git add packages/ui-ws/src/protocol.ts packages/ui-shared/src/wire.ts packages/ui-ws/test/pty-frames.test.ts && git commit -m "feat(ui-ws): pty-output/pty-input/pty-resize frames for the setup terminal"`

---

### Task 2: `script`-pty bridge + setup-mode wiring

**Files:** Create `apps/ui-web/scripts/setup-pty.ts`; modify `packages/ui-ws/src/server.ts`; test `apps/ui-web/scripts/__tests__/setup-pty.test.ts`.

- [ ] **Step 1 — failing test** for the bridge (no real claude — use a benign command via the injectable exe). Create `apps/ui-web/scripts/__tests__/setup-pty.test.ts`:
```ts
import { describe, expect, it } from "vitest"
import { spawnSetupPty } from "../setup-pty.js"

describe("spawnSetupPty", () => {
  it("streams pty output and reports exit", async () => {
    const chunks: string[] = []
    const exit = await new Promise<number>((resolve) => {
      const pty = spawnSetupPty({
        // benign command standing in for `<claude> setup-token`
        command: "printf PTYHELLO; exit 0",
        onData: (b64) => chunks.push(Buffer.from(b64, "base64").toString()),
        onExit: (code) => resolve(code),
      })
      // no input needed for this command
      void pty
    })
    expect(exit).toBe(0)
    expect(chunks.join("")).toContain("PTYHELLO")
  })
})
```
- [ ] **Step 2 — run, verify FAIL** (module missing): `bun run test apps/ui-web/scripts/__tests__/setup-pty.test.ts`.
- [ ] **Step 3 — implement the bridge.** Create `apps/ui-web/scripts/setup-pty.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process"

export interface SetupPty {
  readonly write: (utf8: string) => void
  readonly resize: (cols: number, rows: number) => void
  readonly kill: () => void
}
export interface SpawnSetupPtyOpts {
  /** Shell command to run inside the pty (e.g. `'<claudeExe>' setup-token`). */
  readonly command: string
  readonly onData: (base64: string) => void
  readonly onExit: (code: number) => void
  readonly _spawn?: typeof spawn // test seam
}

/**
 * Run `command` inside a real pty via util-linux `script` (verified to allocate
 * a TTY + stream under bun; no native dependency). `script -qec <cmd> /dev/null`
 * forwards the child's pty stdout to OUR stdout and OUR stdin to the child's pty
 * stdin, so we stream stdout out and write keystrokes in.
 */
export const spawnSetupPty = (opts: SpawnSetupPtyOpts): SetupPty => {
  const spawnFn = opts._spawn ?? spawn
  const child: ChildProcess = spawnFn("script", ["-qec", opts.command, "/dev/null"], {
    env: { ...process.env, TERM: "xterm-256color" },
  })
  child.stdout?.on("data", (b: Buffer) => opts.onData(b.toString("base64")))
  child.stderr?.on("data", (b: Buffer) => opts.onData(b.toString("base64")))
  child.on("exit", (code) => opts.onExit(code ?? 1))
  return {
    write: (utf8) => { child.stdin?.write(utf8) },
    resize: (cols, rows) => {
      // `script` honors COLUMNS/LINES at spawn; a live resize is best-effort —
      // send SIGWINCH so the child re-reads (works for most TUIs).
      try { process.env.COLUMNS = String(cols); process.env.LINES = String(rows); child.kill("SIGWINCH" as NodeJS.Signals) } catch { /* best-effort */ }
    },
    kill: () => { try { child.kill() } catch { /* best-effort */ } },
  }
}
```
- [ ] **Step 4 — wire into the WS server.** In `packages/ui-ws/src/server.ts`:
  - Add an optional config field `setupPty?: { onConnect: (send: (frame: PtyOutputFrame) => void) => { write(utf8: string): void; resize(cols: number, rows: number): void; close(): void } } | null` (a per-connection pty factory — the server gives it a `send`, gets back input/resize/close handles).
  - **Register the inbound handler when `setupPty` is present too.** Change the guard `if (chat !== null || localShellBridge !== null || survey !== null)` to also include `|| setupPty != null`.
  - In the `hello`-send path for a setup-mode connection (when `setupPty != null`), call `setupPty.onConnect((frame) => send(ws, frame))` to start the pty and stream its output; keep the returned handle per-connection (in a `Map`/closure) and close it on `ws` close.
  - In the inbound `switch (frame.type)`, add:
```ts
                  case "pty-input": {
                    setupHandle?.write(Buffer.from(frame.data, "base64").toString())
                    return
                  }
                  case "pty-resize": {
                    setupHandle?.resize(frame.cols, frame.rows)
                    return
                  }
```
  (where `setupHandle` is the per-connection handle from `onConnect`). On `ws` `close`, call `setupHandle?.close()`.
- [ ] **Step 5 — run** the bridge test + ui-ws suite: `bun run test apps/ui-web/scripts/__tests__/setup-pty.test.ts packages/ui-ws/`. Verify green.
- [ ] **Step 6 — commit:** `git add apps/ui-web/scripts/setup-pty.ts packages/ui-ws/src/server.ts apps/ui-web/scripts/__tests__/setup-pty.test.ts && git commit -m "feat(ui-web): script-based setup pty + ui-ws routing for pty frames"`

---

### Task 3: wire the pty into setup-mode + seed-and-restart on login success

**Files:** `apps/ui-web/scripts/chat-server.ts` (`buildSetupServerLayer`), test via smoke.

- [ ] **Step 1 — extend `buildSetupServerLayer`** to pass a `setupPty` factory to `startUIWebSocketServer`. The factory, per connection, runs `claude setup-token` via `spawnSetupPty` and, **on pty exit**, checks `claude auth status` (reuse the readiness probe's `_authStatus`/default) → if logged in, seed the account and restart:
```ts
const CLAUDE_EXE = process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]?.trim() || "claude"
const setupPty = {
  onConnect: (send: (f: { type: "pty-output"; data: string }) => void) => {
    const pty = spawnSetupPty({
      command: `'${CLAUDE_EXE.replace(/'/g, "'\\''")}' setup-token`,
      onData: (b64) => send({ type: "pty-output", data: b64 }),
      onExit: () => { void onLoginAttemptComplete() },
    })
    return { write: pty.write, resize: pty.resize, close: pty.kill }
  },
}
```
where `onLoginAttemptComplete()` runs `claude auth status --json`; if `loggedIn`, seeds `default`/`claude-code:login` via the agent-cli `addAccount` (import from `@luna/agent-cli` or shell `luna account add` against `LUNA_DB_PATH`), then `process.exit(0)` (the restart policy respawns → #1a gate → normal). If not logged in, send a `pty-output` note ("login not detected; try again") and leave setup-mode up.
- [ ] **Step 2 — confirm the WS server starts with the pty in setup-mode** — extend `apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts` to build `buildSetupServerLayer()` and assert it boots with a `setupPty` wired (the layer-boot assertion from #1a still passes). Run: `LUNA_UI_WS_TOKEN=smoke-test-token-ok bun run apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts`.
- [ ] **Step 3 — commit:** `git add apps/ui-web/scripts/chat-server.ts apps/ui-web/scripts/smoke/setup-mode-boot.smoke.ts && git commit -m "feat(ui-web): setup-mode runs claude setup-token in a pty; seed+restart on login"`

---

### Task 4: the xterm.js setup terminal in the web UI

**Files:** `apps/ui-web/package.json`, `apps/ui-web/src/SetupTerminal.tsx`, `apps/ui-web/src/App.tsx`.

- [ ] **Step 1 — GROUND the client transport (read before coding).** Read `apps/ui-web/src/App.tsx` + the transport/ws-client it uses (the thing behind `transport.status()` and `store`) + `packages/ui-shared/src/reducer.ts`. Document: how server→client frames reach the client (does the reducer expose a raw-frame subscription, or only reduced state?), and how the client SENDS frames (the `send`/transport API used for e.g. `new-thread`). The pty stream is **streamy, not state** — the SetupTerminal should subscribe to `pty-output` frames directly from the transport and send `pty-input`/`pty-resize` via the same send path the chat UI uses. Capture the exact API in a comment at the top of `SetupTerminal.tsx`. (This grounding decides the wiring; do not guess the transport API.)
- [ ] **Step 2 — add deps.** `bun add --cwd apps/ui-web @xterm/xterm @xterm/addon-fit`. Confirm it installs cleanly under bun (pure JS, no native build — unlike node-pty).
- [ ] **Step 3 — `SetupTerminal.tsx`.** A SolidJS component that, `onMount`: creates an xterm `Terminal` + `FitAddon`, opens it into a div ref, subscribes to `pty-output` frames (decode base64 → `term.write`), and wires `term.onData((d) => send({type:"pty-input", data: btoa(d)}))` + a resize observer → `send({type:"pty-resize", cols, rows})`. `onCleanup`: dispose the terminal + unsubscribe. Import `@xterm/xterm/css/xterm.css`. (Use the exact transport subscribe/send API documented in Step 1.) Include a short instruction header above the terminal: "Log in to Claude: a URL will appear below — open it, sign in, and paste the code back here."
- [ ] **Step 4 — slot it into App.tsx.** Add `const setupMode = createMemo(() => isConnected() && store.state.capabilities.setup)` (next to `chatEnabled`, ~line 263) and a `<Show when={setupMode()}><SetupTerminal /></Show>` block in the main view region (where chat/settings render). When `setupMode()` is true, the chat panes are naturally hidden (chat capability is false).
- [ ] **Step 5 — verify the UI builds.** `bun run --filter @luna/ui-web build` (or the typecheck script) → no errors. If there's a component test harness, add a shallow render test asserting `<SetupTerminal>` shows when `capabilities.setup` is true; otherwise rely on the manual test below.
- [ ] **Step 6 — commit:** `git add apps/ui-web/package.json apps/ui-web/src/SetupTerminal.tsx apps/ui-web/src/App.tsx bun.lock && git commit -m "feat(ui-web): embedded xterm.js setup terminal shown in setup-mode"`

---

## How to test this yourself (manual, end-to-end on luna-dev)

After #1b is built + merged to `dev` + deployed to `luna-dev` (`git pull` + `bun install` for the new xterm dep + restart):

**1. Put the server into setup-mode.** SSH in and move the credential aside so the gate enters setup-mode:
```
ssh root@luna-server
incus exec luna-dev -- mv /root/.luna/claude/.credentials.json /root/.luna/claude/.credentials.json.bak
incus exec luna-dev -- systemctl restart luna-dev-chat-server.service
# journalctl should show "🔧 setup-mode" and the server stays up.
```

**2. Open the web UI against luna-dev.** On your Mac, run the ui-web dev app pointed at luna-dev's WS, with the matching token:
```
# from your luna clone:
LUNA_DEV_WS_URL=ws://luna-server:5753/ui bun run --filter '@luna/ui-web' dev
# open the printed localhost URL in your browser; it connects to luna-dev.
```
(Token auto-fills from `.env.development`/your client `.env`; it must equal luna-dev's `UI_WS_TOKEN`.)

**3. See the terminal + log in.** Because the server advertises `capabilities.setup`, the UI shows the **embedded terminal** instead of chat. It's running `claude setup-token` — you'll see a **URL**. Open that URL in your browser, sign into claude.ai, and **paste the returned code back into the terminal**.

**4. Watch it flip to normal.** On a successful login the server seeds the account and restarts; within ~10s the gate re-boots it into **normal chat-mode** and the UI switches from the terminal to the chat panes. You can now chat.

**5. (Optional) re-test the lapse path.** Move the credential aside again + restart → the setup terminal reappears (incident-proof). Then restore for normal use:
```
incus exec luna-dev -- mv /root/.luna/claude/.credentials.json.bak /root/.luna/claude/.credentials.json   # if you didn't complete a real login
incus exec luna-dev -- systemctl restart luna-dev-chat-server.service
```

**Faster non-visual check (for the server tasks 1-3 before the UI exists):** drive the pty over the raw WS with the token from `/proc/<ExecMainPID>/environ` and a tiny bun WebSocket client (connect to `ws://127.0.0.1:4753/ui?token=…`, watch `pty-output` frames carry the `claude setup-token` URL, send a `pty-input` frame) — the same `/proc`-token probe technique used during the incident diagnosis.

## Self-review
- **Spec coverage:** §4.C terminal (Tasks 1–2 frames+bridge, Task 4 xterm), §4.C `setup-token` primitive (Task 3), §4.D restart-on-success (Task 3). Lapse-while-running explicitly deferred (gate covers lapse-on-restart; proactive flip = doctor/timer follow-on) — stated in Scope.
- **Placeholders:** server tasks (1–3) carry exact code. Task 4 Step 1 is an explicit *grounding* step (read the client transport) because the ui-web client wasn't read during planning — the component shape is given; the transport subscribe/send API is to be captured there, not guessed. This is the one honest unknown, isolated to a first step.
- **Type consistency:** frame names (`pty-output`/`pty-input`/`pty-resize`) identical across protocol, shadow, server switch, bridge, and component; `setupPty`/`setupHandle` consistent in server.ts; `spawnSetupPty` signature matches its test + the buildSetupServerLayer caller.
- **Security:** every server task preserves the `UI_WS_TOKEN` upgrade gate (the pty is only reachable post-auth).
