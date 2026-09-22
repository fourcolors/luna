---
name: luna-verify
description: Use when verifying that a change to the Luna app actually works - before claiming a UI or chat feature is done, when the user asks to test the app, see it running, or prove a feature behaves correctly, and when deciding how much verification a change needs. Covers the Moon Tauri app, the chat window, the jsdom harness, the Vite dev server, real WKWebView, and running a local chat server. Not for pure library or server-side packages, which are plain unit tests.
user-invocable: true
argument-hint: "[what you changed]"
---

# Verifying a Luna change

Luna has four verification tiers. **Pick by what you changed, not by what is convenient.**
The failure this skill exists to prevent is shipping a UI change verified only by unit tests.

## Which tier do I need?

| What you changed | Minimum tier |
|---|---|
| A reducer, resolver, or pure function | **T0** |
| DOM structure, a new element, frame handling, turn lifecycle | **T1** |
| Anything with a visual result - CSS, layout, colour, size, spacing | **T2** |
| SVG `fill`/`stroke`/`stop-color`, CSS filters, `mix-blend-mode`, `backdrop-filter`, `color-mix()` in SVG | **T3** |
| Server frames, auth, reconnect, anything crossing the WebSocket | **T4** |

Higher tiers do not replace lower ones. T2 does not prove logic; T0 does not prove pixels.

---

## T0 - unit. Seconds.

```bash
bun run test
```

Run from the **repo root**. Add a path to narrow: `bun run test -- apps/ui-moon-tauri/test/moon-face-bar.test.ts`

> Never run bare `vitest` inside `apps/ui-moon-tauri`. That config has no `include`/`exclude`, so it
> collects `e2e/specs/*.spec.mjs` and fails with `ReferenceError: browser is not defined`. Those are
> WebdriverIO specs. Root `bun run test` scopes to `*.test.ts(x)` and is unaffected.

**Proves** pure logic. **Proves nothing** about the DOM or pixels.

## T1 - jsdom against the real page. Seconds.

`apps/ui-moon-tauri/test/helpers/chat-harness.ts` boots the **real `frontend-react/chat.html` body and
the real `bootChat()`** - the same function `main-chat.tsx` calls - in jsdom, then publishes the
internals on `window.__MoonInternals`.

Push real server frames through the real `WebSocketEngine`:

```ts
const M = () => (window as any).__MoonInternals
M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'hi' })
M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'a', name: 'Read', input: {} })
M().handleFrame({ type: 'tool-result', toolCallId: 'a', status: 'ok', output: 'x' })
M().handleFrame({ type: 'turn-complete', threadId: 't1' })
```

Copy the setup from `test/chat-window.test.ts`. For socket-level behaviour (drops, reconnect storms)
use `test/helpers/FakeWebSocket.ts` instead - `simulateOpen`, `injectServerMessage`, `simulateFlap`.

**Proves** that a given frame sequence produces the right DOM and state.
**Proves nothing** about how it looks, or that the server really sends that shape.

## T2 - real CSS in a real browser. A minute. **The default for anything visual.**

```bash
bun run --cwd apps/ui-moon-tauri dev:frontend      # Vite, port 5175
```

Then drive `http://localhost:5175/chat.html` with the **agent-browser** skill or the Claude_Browser
tools. This serves the real bundled module graph and the real stylesheets, so layout, cascade and
computed colour are genuine.

The page boots fine outside Tauri: boot-time invokes are capped (`BOOT_INVOKE_MS` in `tauriBoot.ts`),
so it degrades to "Disconnected" rather than hanging.

**The hub's first-run setup wizard is force-opened off-Tauri** by loading
`http://localhost:5175/index.html?wizard` - `MoonHubApp.tsx`'s mount effect checks
`new URLSearchParams(location.search).has("wizard")` when `__TAURI__` is absent, paints `body`
`#10142a`, and calls `controller.openWizard()`. `localStorage "luna.moon.setupComplete"` does NOT
gate this path - the param bypasses `isSetupComplete()`.

**The real page publishes its controllers as globals**, so you can drive a whole turn from the
console - this is the single most useful thing in this skill:

```js
// verified against the real bundle on 5175
WebSocketEngine.handleFrame({ type:'assistant-delta', threadId:'t', turnId:'v1', text:'Checking. ' })
WebSocketEngine.handleFrame({ type:'tool-call', threadId:'t', turnId:'v1', toolCallId:'a', name:'Grep', input:{} })
WebSocketEngine.handleFrame({ type:'tool-result', toolCallId:'a', status:'error', output:'2 failing' })
WebSocketEngine.handleFrame({ type:'turn-complete', threadId:'t' })
ChatLoop.flush()
```

Available: `WebSocketEngine`, `ChatState`, `ChatLoop`, `ChatEngine`, `MoonFace`, `MoonBar`,
`Attachments`, `ComposerConfig`, `SlashMenu`, `SmartBarEngine`, `ThreadDrawerEngine`, `LunaThreadDrag`.
`MoonFace.setBusy(true)` and friends drive the avatar directly.

**Scripted-turn ordering decides whether assistant text is a visible bubble.** Text that
arrives *before* the last tool-call is folded into the run timeline and is invisible once it
collapses into the "Worked for N steps" pill; text *after* the last tool-call is a trailing
`TextItem` - the visible `.msg.assistant` bubble. To assert on-screen text, send the delta/done
AFTER the tool frames, and omit `threadId` (a frame whose `threadId` ≠ `State.activeThreadId` is
silently dropped by thread isolation). If a render doesn't match expectations, inspect
`ChatState.turns` (`segs`/`_cumText`/`_settled`) - the text may be in the model but hidden inside
a collapsed timeline.

> `window.__MoonInternals` exists on the **hub page (`index.html`)** - `MoonHubApp.tsx` publishes it
> in its mount effect (search for `window.__MoonInternals = {` in `src/hub/MoonHubApp.tsx`):
> `handleFrame(frame)`, `dispatch(action)`, `getState()`, `SetupWizard.{open, close, goTo,
> choosePath, isComplete}`, `WebSocketEngine.{connect, disconnect, send}`, `TauriService`, `State`.
> It does **not** exist on `chat.html` - there the jsdom harness (T1) is the only publisher.
> Useful for asserting reducer state from CDP when a transient flag (e.g. `wizard.localDirInvalid`,
> a 1.8s pulse) resets before a screenshot lands: arm an in-page `setInterval` poller into
> `window.__<flag>` first, then click.

Stage state through those bridges, never by hand-writing markup. Setting the attribute a controller
owns (`face.dataset.state = 'busy'`) is fine for isolating a single CSS rule.

**Thread drawer / row drag** - when a change touches `threadDrawer.ts` or `threadDrag.ts`, the
drawer is exercisable at T2 with no server:

```js
// Seed rows through the REAL frame handler - the same path the server's
// 'thread-list' frame takes.
WebSocketEngine.handleFrame({type:'thread-list', threads:[
  {id:'t-a', title:'Alpha', lastMessagePreview:'one', lastMessageAt:Date.now()-60000},
  {id:'t-b', title:'Beta',  lastMessagePreview:'two', lastMessageAt:Date.now()}
]})
```

- Toggle is `#toggle-threads`; rows are `.thread-row` in `#thread-drawer-list`, sorted
  `lastMessageAt` desc.
- A real held-button drag on a row proves `LunaThreadDrag.createSession` + `pointerMove` ran: a
  `.thread-drag-ghost` card follows the cursor and the row takes `.dragging`. Judge by mid-drag
  state - after an in-strip release the ghost can stay in the DOM (its removal paths only run
  when a Tauri window spawn succeeds), so a lingering ghost is not a failure.
- A plain click goes pointerdown -> 'click' outcome -> `onRowClick` -> active selection.

**Driving a React panel's send path off-Tauri.** On `panel.html?type=<t>` the connect waterfall only
dials when `ctx.invoke('load_connection')` resolves, so in a plain browser the panel's `LunaWsClient`
never connects, `client.socket()` stays null, and every send path early-returns "Not connected". To
exercise a real `send()` (e.g. to inspect a request frame): wrap `window.__panelCtx.connectWs` so the
fresh client dials a throwaway `Bun.serve` WS endpoint, then remount the same panel via the module
graph - the mount's effect calls your wrapped `connectWs`:

```js
const m = await import('/src/panel-boot.tsx')
const ctx = { ...window.__panelCtx, connectWs: (reg, opts) => {
  const c = window.LunaWS.createClient({ registry: reg, ...(opts || {}) })
  c.connect('ws://127.0.0.1:9911'); return c
} }
m.dispatchPanelMount('settings.vault', ctx)   // remounts into #content-area
```

Have the fake server push `{"type":"hello","capabilities":{...}}` on open - capability-gated sections
(e.g. `vault-section` needs `capabilities.vault`) unhide only after that frame. The hello push is only
strictly required for fail-closed gates like `settings.vault`: some panels (e.g. `settings.accounts`,
whose `supported` flag defaults non-false) render the full form *until* a hello denies the capability.
Frame traffic is then assertable server-side in the fake server's stdout.

**No managed browser? Use CDP.** If the computer-use `browser` target is unavailable, launch
`open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-devin`, then
`GET http://localhost:9222/json`, pick the page target by URL, and `Runtime.evaluate` over its
`webSocketDebuggerUrl` (`returnByValue:true, awaitPromise:true`) - dynamic `import()` works in the dev
page, which is how the recipe above runs.

Take a screenshot **and** measure. `getComputedStyle()` and `getBoundingClientRect()` turn "looks
right" into a number you can put in a PR - `getComputedStyle(el).fill` is how you catch a token that
silently resolved to black. Precedent with the exact shape to copy: `.scratch/s16-shots/README.md`.

> **Judge at true size.** A hairline that reads at 3x can be invisible at 34px. Render the component
> at its shipped size before believing it, and remember an agent screenshot is downscaled.

**Panel windows** are exercisable the same way: `http://localhost:5175/panel.html?type=<panel-type>`
(plus per-type params like `?thread=` for actions, `?jobId=` for flow). React-owned types boot via
`src/panel-boot.tsx`'s `dispatchPanelMount` -> `mountReactPanel` (`src/panels/panel-mount.ts`), which
sets `#bar-title`, `document.title`, renders into `#content-area`, and publishes
`window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }` - the designed
smoke-check surface. Vanilla types go through panel.html's own `bootModule()` which sets the same
four fields PLUS `resolvedRouteLabel` and a `viewMode` accessor (React path's object is a strict
subset - pre-existing, not a bug). An unknown type lands on "Unknown panel" + a notice with
`hasModule: false`, which is a cheap regression check that the React/vanilla dispatch split works.

> Chrome 136+ only honors `--remote-debugging-port` with a **non-default `--user-data-dir`**
> (`--user-data-dir=/tmp/chrome-cdp`). If `browser_console`/`read_dom` refuse ("Chrome is not in the
> foreground" on macOS, or no listener on 9222), drive CDP yourself: fetch
> `http://127.0.0.1:9222/json`, open the page target's `webSocketDebuggerUrl`, `Page.navigate` +
> `Runtime.evaluate` with `returnByValue`.

## T3 - real WKWebView. Ten minutes plus a Rust build.

Tauri on macOS **is** WKWebView, and it is stricter than Chromium. Required for the traps listed
below, because Chromium will happily render things that ship black.

```bash
bun run --cwd apps/ui-moon-tauri dev
```

`tauri.conf.json` sets `beforeDevCommand: bun run build:frontend` and `devUrl: null`, so this does a
**static Vite build into `frontend-react/dist` and loads that**. There is no hot reload: Cmd+R after a
frontend edit, relaunch after a Rust edit.

To capture the window headlessly, see `~/.claude/projects/.../memory/real-tauri-wkwebview-glance-recipe.md`.
Two things from it that cost real time: `screencapture` silently writes nothing to a **leading-dot
filename**, and a genuine permission denial looks different (all-black frame).

## T4 - live server. Half an hour.

Only when the change crosses the WebSocket.

```bash
# 1. isolated home - NEVER point a test server at ~/.luna
LUNA_HOME=/tmp/luna-verify \
LUNA_DISABLE_VECTORLITE=1 \
LUNA_WAKE_ENABLED=0 \
LUNA_UI_WS_HOST=127.0.0.1 \
UI_WS_TOKEN="$(openssl rand -hex 32)" \
  bun run scripts/luna-chat-server-entry.ts

# 2. seed an account or the server stays in setup-mode
LUNA_HOME=/tmp/luna-verify bun apps/agent-cli/src/luna.ts account add \
  --id default --label Default --kind anthropic --secret-ref claude-code:login

# 3. point the CLI and Moon at it (writes both files, then self-checks)
bun apps/agent-cli/src/luna.ts pair --url ws://127.0.0.1:4753/ui --token <token>
```

`UI_WS_TOKEN` is read at **import time** and must be at least 16 chars, or the server throws before
it starts. The isolated `LUNA_HOME` is load-bearing: reusing the real `~/.luna` has produced a
false-positive pass before (`test/live-reconnect.test.ts`).

See `docs/HOW_TO_TEST_AND_VERIFY.md` and `TESTING.md`, which are authoritative and kept current.

---

## Traps

**`var()` in an SVG presentation attribute renders black in WKWebView.** `stop-color="var(--accent)"`
and `fill="var(--x)"` are substituted only in CSS *declarations*. Set them via a class, and keep a
hardcoded hex in the attribute as a fallback. `chat.html` carries comments about this.

**A CSS custom property scoped to a container does the same thing.** If `--status-error` is defined on
`.timeline` and something renders outside it, `fill: var(--status-error)` is invalid at
computed-value time and falls back to **black, silently**. Define semantic colour tokens on `:root`.

**A self-rescheduling `requestAnimationFrame` loop recurses synchronously under fake timers** and
blows the stack across every test that boots the page. Use `setInterval` for always-on UI loops.

**Rebuilding DOM nodes every frame pegs the compositor** hard enough that Chrome stops painting -
which looks exactly like a broken screenshot tool. Build nodes once, rewrite attributes. Gate
offscreen work with `IntersectionObserver`.

**`frontend/` is not the app.** The Tauri app loads `frontend-react/`; `frontend/` survives only as
the symlink target for `public/vendor` and `public/panels`. `frontend-react/dist/` is a build output
and is stale unless you just ran `build:frontend`.

**`apps/ui-web` no longer exists.** Any doc or memory telling you to run `--filter '@luna/ui-web'` is
dead. Also: `bun run --filter <pkg> <script>` prints `No packages matched the filter` when the
**script** is missing, not the package.

**Do not use `test:e2e` as verification.** It needs `cargo build --features wdio-e2e`, has never run
in CI, and its two specs assert less than the jsdom tier does.

## Before saying it works

- [ ] The tier the change actually required, not the cheapest one that passed.
- [ ] Compared against the **baseline** - stash your change and re-run, so you can say which failures
      are pre-existing rather than implying they are all yours.
- [ ] A screenshot for anything visual, taken at true size.
- [ ] Said plainly what you did **not** verify.
