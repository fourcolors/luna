---
name: luna-panel-browser-mock
description: Use when verifying Luna's React settings panels (settings.voice, settings.updates, etc.) in a plain browser via the Vite dev server without a real Tauri backend. Covers stubbing window.__TAURI__ before panel.html's inline script captures it, driving win.listen/event.listen events through the real bundled code path, and the gotchas (parse-time ctx capture, global event bus, timed emit timelines). Complements luna-verify's T2 tier.
---

# Verifying Luna settings panels in a plain browser

React-owned panel types (`REACT_PANEL_TYPES` in `apps/ui-moon-tauri/frontend-react/panel.html`)
boot via `src/main-panel.tsx` → `panel-boot.tsx` → `mountReactPanel` using `window.__panelCtx`,
which panel.html's inline script builds **at parse time**. `ctx.win`, `ctx.label`, and
`ctx.hasTauri` are all captured then — a `window.__TAURI__` stub injected *after* load is too
late.

## The working recipe

1. `bun run --cwd apps/ui-moon-tauri dev:frontend` (Vite, port 5175, root `frontend-react/`).
2. Create a TEMPORARY `frontend-react/panel-mock.html`: copy `panel.html` and inject a
   `<script>` stub **as the first child of `<head>`** (before the vendor scripts and the inline
   script). Same relative paths (`/vendor`, `/src/main-panel.tsx`, `?type=` param) all work
   unchanged. Delete the file afterward — never commit it.
3. Stub shape that covers all consumers:
   - `__TAURI__.core.invoke(cmd, args)` — canned per-command promises; reject unhandled cmds
     (mimics off-Tauri so degradation paths still work).
   - `__TAURI__.window.getCurrentWindow()` → `{ label, listen(name, h) }` — capture `h` into a
     map; also Proxy-wrap so other methods (`startDragging`, etc.) return async no-ops
     (`LunaDock.wire` touches the win handle).
   - `__TAURI__.event.listen(name, h)` — the **global** event bus; UpdatesPanel subscribes to
     `update://*` here, NOT `ctx.win.listen` (voice-model-progress IS on ctx.win — check which
     bus the panel's doc comment names).
   - `window.__mockEmit(name, payload)` — fires captured handlers with `{payload}`.
4. Navigate to `http://localhost:5175/panel-mock.html?type=<panel.type>`.

## Driving state

Two options:
- **Timed emits (preferred for recordings):** inside the stub, schedule `setTimeout` emits when
  a trigger invoke fires (e.g. `voice_ensure_model` → tick `voice-model-progress` payloads over
  a few seconds; `update_state` → snapshot DTO then `update://progress`/`update://ready`).
  Self-running demo needing only a page load / one click — no console injection.
- **Manual emits:** call `__mockEmit` via devtools console or CDP. Note `browser_console` may
  refuse ("Chrome is not in the foreground") on Chrome instances the tool didn't launch, and
  Chrome's "Allow JavaScript from Apple Events" (View → Developer) may not persist — don't
  count on either.

## What to assert

- Exact `textContent` on the formatMb-derived nodes (`#voice-model-status`,
  `#update-bytes`, `#update-percent`) plus a true-size screenshot — a broken shared import
  leaves the panel at "Loading…" (title never flips), a wrong formatter fails exact strings.
- Payload key names differ per panel: voice uses `downloadedBytes`/`totalBytes`, update events
  use `downloaded`/`total` — read the reducer's `applyEvent`, don't guess.

## WS-backed panels (settings.models, settings.vault, …)

Panels that call `ctx.connectWs(registry, …)` don't use Tauri events — they speak
LunaWS JSON frames over a real `WebSocket`. Strongest mock: point the stubbed
`load_connection` invoke at a REAL local WS server so the full transport path
(`LunaWS.createClient` → socket → registry dispatch → outbound `client.send`)
runs unmodified.

- In the `panel-mock.html` stub, answer `invoke('load_connection')` with
  `{ wsUrl: 'ws://127.0.0.1:<port>/', wsToken: 'mock' }`; reject everything else.
  `MoonSession.resolveBootRoute` calls route commands that reject → it degrades
  to `null` → panel falls into the legacy `load_connection` path automatically —
  no route-command stubbing needed.
- Mock server: `Bun.serve({ websocket: … })` — send `hello`
  (`{capabilities:{modelRouting:true}}`) + `model-routing-list` on `open`; reply
  `model-routing-status {requestId, ok, message}` to `model-routing-save`; append
  every inbound frame to a log file for byte-level assertions. HTTP control
  endpoints on the same port (`/push?model=X` → send a fresh list;
  `/state` → dump received frames as JSON) make server-initiated frames
  scriptable mid-run AND displayable on camera — open `/state` in a second
  Chrome tab to show the captured outbound frame in the recording.
- Port gotcha: `lsof -nP -iTCP:<port> -sTCP:LISTEN` first — 9876 was already
  bound by `devin-rem` here; pick a verified-free port.
- Multiple server personas without rewriting the stub: have `load_connection`
  read the WS URL from a `?mockws=ws://127.0.0.1:<port>/` query param (falling
  back to a default). A second mock port can then send a different hello
  (e.g. `capabilities:{}` to exercise the vault panel's legacy op-token form)
  — same panel-mock.html, just a different URL in a second tab.
- Even better for persona-per-field matrixes: carry the persona in the WS
  PATH — `server.upgrade(req, { data: { variant } })` on e.g.
  `/routing/auto-jev` then `ws.data.variant` in `open()`. Deterministic per
  page load and dodges the `isDirty` guard entirely (no mid-run pushes needed
  to switch personas — just point the URL at another path and reload).
- After acking `model-routing-save`, ALSO push a fresh `model-routing-list`
  reflecting the save — the real server sends one after every successful
  save (wire doc), and the panel's post-save state (dirty cleared, pending
  notes, refreshed drafts) only settles correctly when it arrives.
- Missing `@fontsource/*` packages make Vite fail `src/fonts/moon-fonts.css`
  (postcss ENOENT). `bun install` fixes it; if node_modules predates the
  bundled-fonts commit, run it before verifying panels visually.
- An iOS Simulator may sit on this desktop and throw dialogs over the Chrome
  window mid-recording. Hide it: `osascript -e 'tell application "System
  Events" to set visible of process "Simulator" to false'`; dismiss its
  in-sim dialogs first if clicks are being swallowed.
- Fast Refresh remount loop: if ANYTHING else touches panel source files
  while Vite watches (a parallel agent's formatter, a file-sync daemon),
  every touch emits `hmr update` → remounts the panel → replays its whole
  boot/probe sequence (your invoke log fills with repeated boot calls) AND
  silently eats pointer-driven interactions mid-flight (drag pointerup on
  the unmounted element → onChangeEnd never fires). Check the Vite log for
  `hmr update` lines before blaming the panel; wait for a quiet window or
  prefer keyboard-driven commits — Astryx Slider fires onChangeEnd on every
  arrow keydown (line ~306 of Slider.js), so focus-thumb + ArrowRight
  commits deterministically without pointer capture.
- `browser_console` refuses ("Chrome is not in the foreground") on Chrome
  instances the tool didn't launch, and the macOS AX tree does NOT expose
  Chrome web content for query/assert. Render an on-screen overlay div
  (fixed pane appended on DOMContentLoaded, fed by the invoke stub) showing
  the ordered invoke log + relevant localStorage keys — it is DOM truth made
  pixel-visible for screenshots/recordings, no console needed.
- Window sizing: the computer tool's coordinate space is scaled (e.g.
  1024x768) vs macOS real points (e.g. 1600x1200 — get via `osascript -e
  'tell application "Finder" to get bounds of window of desktop'`). osascript
  `set size/position` works in real points: set Chrome to the FULL desktop
  bounds, not the tool-space numbers, or the window ends up ~64% size.

## chat.html works too (chat-mock.html)

The same stub technique works on `chat.html` (copy → `chat-mock.html`, stub
first in `<head>`). Its boot path: `loadConnectionAndConnect` invokes
`migrate_legacy_connection` + `load_connection` (answer the second with your
mock URL — 'mock' is a fine literal token, it just can't be `legacy` or an
`env:`/`file:`/`op://` ref, which PoolEngine refuses to dial) →
`MoonSession.resolveBootRoute` rejects via the stub → legacy fallback →
`LunaWsAdapter` (PoolEngine) dials. The ONLY frame the adapter waits on is
the server `hello` — send it on `open` and `acquire()` resolves →
`isConnected()` true → `syncThread()` sends `list-threads`/`subscribe`
(just log them). Every inbound frame then reaches `MoonFrames.dispatch` —
so server-initiated flows like `secret-request` (secure-box) or
`suggested-action-set` can be triggered with an HTTP `/push-*` endpoint on
the mock that broadcasts to open sockets mid-run. Verify outbound frames
(`secret-result`, `user-message`) in the `/state` log; ack `secret-result`
with `secret-status{requestId, ok:true}` to watch the panel's
"Saving…" → "Saved." → auto-hide path.
- Astryx `Selector` is a combobox: click the trigger → a popover listbox opens
  (options are plain click targets by their label text; checkmark = current
  value). The panel's `data-testid` lands on the field wrapper, not the trigger.
- Remember the reducer's `isDirty` guard: a pushed `model-routing-list` is
  IGNORED while unsaved draft edits exist — only applies after a successful
  save ack clears dirty. Sequence push-while-dirty (no-op) → save → push
  (applies) to prove both branches.
