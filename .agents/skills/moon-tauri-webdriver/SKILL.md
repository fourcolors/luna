---
name: moon-tauri-webdriver
description: Drive the Luna Moon Tauri app end-to-end on macOS via its embedded WebDriver (build with wdio-e2e, spawn with TAURI_WEBDRIVER_PORT, per-window handles, real OS-drag gestures via computer tool). Complements the luna-verify skill's T3 tier.
---

# Driving Luna Moon (Tauri/WKWebView) end-to-end

Use this when `luna-verify` T3 calls for a real WKWebView check and you also need
scripted control — invoking Tauri commands, reading window geometry, or arming
gesture monitors — that clicking alone can't give.

## Build (avoid the voice/cmake wall)

The default `voice` cargo feature needs cmake (whisper-rs-sys) which may be
absent. Build the app without it, adding the embedded WebDriver:

```bash
cd apps/ui-moon-tauri/src-tauri
cargo build --no-default-features --features "custom-protocol wdio-e2e"
# binary: target/debug/luna-moon-ui
```

`bun run --cwd apps/ui-moon-tauri dev` (tauri dev) uses default features and
hits the cmake wall — do not use it when cmake is missing.
Frontend dist must exist: `cd apps/ui-moon-tauri && bun run build:frontend`.

## Run + connect

```bash
TAURI_WEBDRIVER_PORT=4445 target/debug/luna-moon-ui &   # embedded W3C server
```

Then talk plain W3C WebDriver HTTP to `127.0.0.1:4445`:
- `POST /session` `{capabilities:{alwaysMatch:{browserName:'w3c'}}}`
- `GET  /session/{id}/window/handles` — returns **window labels** (e.g.
  `"main"`, `"panel-chat"`, `"widget-74d485b6ab80ac3a"`), one per WebviewWindow
- `POST /session/{id}/window` `{handle:"panel-chat"}` — switch JS context
- `POST /session/{id}/execute/sync` `{script:"return ...", args:[]}` — runs in
  the current webview; `window.__TAURI__.core.invoke(...)` works there

The app boots fine with no chat server and empty ~/.luna (first-run wizard
appears — click "Skip for now" to reach the orb). Card windows degrade to a
"Not connected" body but chrome/spawn geometry is unaffected.

## Spawning windows via invoke (all callable from any panel-chat context)

- `invoke('open_widget', {kind:'chat'})` → `panel-chat` (registry size 560x520)
- `invoke('open_widget', {kind:'chat', params:{thread:'t', redockTo:'panel-chat'}, x, y})`
  → `panel-chat-<djb2>` pinned floater (required for redock/pullout tests —
  `allow-redock-thread` capability only covers `panel-chat*` callers)
- `invoke('open_artifact_widget', {artifactId, title, x, y})` → `widget-<djb2>`
- Cmd+K in any window → `panel-launcher` (auto-closes on blur — expected)
- `invoke('close_widget', {label})` → closes any `panel-*`/`widget-*` label

## Read window geometry

```js
const w = window.__TAURI__.window.getCurrentWindow();
const [p,s,sf] = await Promise.all([w.outerPosition(), w.outerSize(), w.scaleFactor()]);
// logical rect = p.x/sf, p.y/sf, s.width/sf, s.height/sf
```

## Coordinate mapping (computer-tool screenshots vs Tauri coords)

The agent screenshot space (1024x768) is SCALED, not 1:1. Check the real
display (`osascript -e 'tell app "Finder" to get bounds of window of desktop'`
→ 1600x1200 here). `screenshot_px = tauri_logical * 0.64`. Tauri coords are in
real display points — a window at logical (520,172) renders at screenshot
(333,110). Zoom/screenshot wrong-region is the first failure mode — always map.

## Exercising the NSEvent-monitor gestures (install_mouse_monitors paths)

`begin_native_resize` / `begin_redock_drag` / `begin_native_pullout_drag` are
driven by NSEvent local+global monitors — they need REAL OS mouse events
(computer tool drags work; synthetic JS mouse events do not).

- **Resize**: `.resize-se` grip div exists on `.widget-shell` in every card
  page; get its rect via JS, then left_mouse_down + mouse_move + up. The
  pointerdown itself invokes begin_native_resize (macOS path in
  vendor/moon-resize.js). Fast synthetic move bursts partially coalesce —
  interleave ~200ms waits for 1:1 tracking.
- **Redock**: the floater's own page arms begin_redock_drag on title-bar
  pointerdown via LunaDock when pinned (`?thread=…&redockTo=…` params required).
  Just do a real title-bar drag over the owner's left strip — no invoke needed.
  A second programmatic arm produces a harmless but confusing double end event.
- **Pullout**: hold left button on empty desktop, invoke
  `begin_native_pullout_drag({floaterLabel, ownerLabel, threadId})` from a
  panel-chat* context — floater teleports so its grab point (default 36,18 pt
  from top-left) sits under the cursor, then tracks every move globally until
  mouse-up. Assert via outerPosition == cursor - grab.

## Observing gesture events

`window.__TAURI__.event.listen(name, cb)` in any webview is app-wide — one
listener context captures every emit regardless of target. Events are
delivered TWICE per emit (window+webview label match) — dedupe mentally, don't
report it as a bug. Gesture events: `redock-preview`/`redock-thread` → owner,
`redock-self-preview`/`redock-drag-ended` → floater (pullout adds
`pullout:true`), `luna-resize-ended` → the resized window.

## Traps

- `setFocus`/`set_position` may be capability-denied from JS — click the window
  to focus instead.
- First-run setup wizard renders inside the orb window — dismiss with
  "Skip for now" before asserting orb geometry (140x185).
- `panel-launcher` closes itself on focus loss — don't treat as a bug.
- Global shortcut registration fails without Accessibility permission —
  expected for unsigned debug binaries; Cmd+K still works (DOM handler).
- `write_panel_layout` persists open panels to ~/.luna/layout.json — boot
  restore replays them on next launch; delete it for a clean boot.

## Devin Secrets Needed

None — build, spawn and drive are all local.
