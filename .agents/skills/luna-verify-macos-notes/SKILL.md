---
name: luna-verify-macos-notes
description: macOS + Chrome gotchas when running the luna-verify T2/T3 tiers (Vite cold-start blank page, no CDP for console tools, driving the native file picker, hitting tiny chip buttons). Pairs with the luna-verify skill.
---

# luna-verify macOS/Chrome notes

Additions to the luna-verify skill for driving the Vite-served chat page in Chrome on macOS with computer-use tools.

## Vite cold start looks like a broken page

`bun run --cwd apps/ui-moon-tauri dev:frontend` reports ready in ~10s, but the
**first** request for `chat.html` takes ~15s while Vite transforms the module
graph — Chrome sits on a blank white page. Curl `chat.html` once (or just wait
and Cmd+R) before concluding the page is broken.

## The computer/browser tools cannot reach Chrome's DevTools protocol

`open -a "Google Chrome" <url>` starts Chrome without
`--remote-debugging-port`, so `browser_console` ("Could not connect to Chrome
via CDP") and `read_dom` both fail. Options:

- Prefer the on-screen console: focus the page, `cmd+alt+j`, click the console
  input, type the expression, Enter — the output is also captured in the
  recording (good evidence). The globals (`Attachments`, `WebSocketEngine`,
  `ChatLoop`, …) are reachable there.
- Or relaunch Chrome with `--remote-debugging-port=9222` if CDP is needed.
- Expected noise: with no chat server running, the console fills with
  `WebSocket connection to 'ws://127.0.0.1:4753/ui' failed:
  net::ERR_CONNECTION_REFUSED` retries — unrelated to UI features that are
  client-side only (e.g. attachment staging).

## Driving the native macOS file picker from the attach menu

`#attach-plus-btn` → `#attach-menu-attachment` → `fileInput.click()` opens a
real NSOpenPanel. Inside it: `cmd+shift+g`, type the absolute file path,
`Return` (selects the file), then click **Open**. Prepare files under `/tmp`
first (a minimal `%PDF-1.4` header file classifies fine; a python3 zlib PNG is
enough for the image path).

## The attachment-chip remove button is ~10px

`.att-remove` (the ×) sits at the far right of each chip. Coordinate clicks a
few px off silently miss (chip stays). Hover first and use the `zoom` action on
the chip — the button turns red on `:hover`, which confirms the cursor is on
it before clicking.

## T4 local chat server on macOS — extra gotchas

The luna-verify skill's T4 recipe works on macOS with these corrections:

- **`bun apps/agent-cli/src/luna.ts account add` ignores `LUNA_HOME`** — its
  `defaultDbPath()` is always `~/.luna/luna.db`. The server reads
  `$LUNA_HOME/luna.db`, so a missing `--db-path` seeds the wrong DB and the
  server stays in setup-mode (`[credential-readiness] accounts read failed:
  SQLITE_CANTOPEN` + `setup-mode`). Always pass
  `--db-path $LUNA_HOME/luna.db`. Clean up the stray `~/.luna/luna.db` after.
- **`LUNA_CLAUDE_CODE_EXECUTABLE` must be pinned on macOS** — the auto-detector
  only scans for the linux-x64 package, so on darwin it logs "no fallback
  `claude` binary was found". The bundled binary lives at
  `node_modules/.bun/@anthropic-ai+claude-agent-sdk-darwin-arm64@*/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
  (verify with `--version`).
- **Browser UI auth without `luna pair`**: `pair` writes `moon-connection.json`
  via a Tauri invoke the browser can't run. In non-Tauri boot the hub reads
  `localStorage.luna_ws_token` (hubEngines.ts ~line 596) — set it in the
  on-screen console and reload; the UI then connects to
  `ws://127.0.0.1:4753/ui` and shows "Connected".
- **Duplicate restored tabs** can pollute the recording: a "Restore pages?"
  click may reopen a second Luna tab that retries auth without the token
  (server log fills with `auth failed — 401 sent`).
- **Cheap turn lane**: the model/effort cluster (`#model-cfg-btn`) may be
  hidden; send `{type:'new-thread', model:'claude-haiku-4-5'}` via
  `WebSocketEngine.send()` in the console instead — the thread chip confirms
  the lane. Note the send goes to the ACTIVE thread; creating a new thread
  does not necessarily move the view.
- **Server-side proof the model saw the attachment**: after a turn,
  `$LUNA_HOME/luna.db` `messages.content_json` persists the user payload with
  `{type:"document",source:{media_type:"application/pdf",data:"JVBERi…"}}` and
  the assistant row carries the real `model` id — greppable evidence without
  trusting the UI.

## Devin Secrets Needed

T4 model round-trips need `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`,
`sk-ant-oat01…`) bound via the exec `env` parameter
(`env:CLAUDE_CODE_OAUTH_TOKEN` secret-ref on the account) — never written to
disk. Without it the pipeline still proves everything up to the SDK call: the
server accepts the `application/pdf` frame, persists the `document` block, and
the turn fails only at the Anthropic API with
`401 OAuth access token is invalid` — a distinct, legible signal that is NOT
an attachment rejection.

## Launching the real Tauri app (not just the Vite frontend)

`bun run --cwd apps/ui-moon-tauri dev` does a static `build:frontend` then launches
`target/debug/luna-moon-ui` properly activated. Do NOT run the bare binary
directly after building — the windows can come up non-composited / shelved by
Stage Manager (contents never paint, Stage-Manager-style stray thumbnails).
Always launch through the tauri dev wrapper; relaunch after any Rust edit
(there is no hot reload).

The app degrades gracefully with no chat server ("Connection Error" banner) —
window-open paths (`expand_from_moon`, `open_widget`, panels) work unpaired.

## Opening windows via the app's own UI

- Moon orb click → `expand_from_moon` → `panel-chat` (the "Luna" card).
- `cmd+K` inside a window → launcher panel; click a row (Enter selects the
  highlighted index-0 row, not your filter) → `open_widget {kind}`; the
  launcher auto-closes.
- Drag surfaces: `.title-bar` (all dock windows) and `.chat-header`. The
  chat's `.chat-header` area can select text — grab the `.title-bar` strip
  (the top ~26px, where the window name sits) for reliable drags.

## Real-drag gotchas for the snap system

- Settles are snapshot-driven (db0f72e2): dock frames snapshot on
  LeftMouseDown; on LeftMouseUp every window whose x/y changed gets
  `snap_to_flush_edge` + ONE `apply_attachment_plan` (planner builds a BFS
  spanning tree per flush-adjacency component, chat = hub root). The diff
  compares x/y ONLY — a pure resize doesn't count as "changed"; children
  track resizes via the Resized-arm `reflush_snap_children` instead.
- Built-in `[snap]` eprintln lines in dev-server stdout replace manual
  instrumentation. Caveats: attach successes are SILENT (only
  `attach {label} -> {pl}: window gone` logs on failure), and `detach
  {label}` is logged as a no-op whenever the plan wants a parent for a
  window that isn't attached yet — a "detach" line before an attach is
  normal, not a reversal.
- `apply_attachment_plan` needs the main thread (MainThreadMarker) — any
  call site that runs off-main logs "apply_attachment_plan off main thread
  — skipped" and silently no-ops. Async command contexts (open_widget etc.)
  are off-main; the Up-monitor settle and boot reattach run on-main.
- Miniaturizing a parent shelves its whole child stack into one Dock tile;
  deminiaturizing restores all, attachments intact. cmd+H hides everything
  incl. the orb; unhide restores the stack.
- Boot settle (`reattach_flushed_windows` settles every dock window on
  launch): a window restored inside the snap zone goes flush and attaches;
  parked windows stay put and stay detached.
- Launcher row clicks occasionally miss the row hit-area; pressing Enter on
  the filtered row reliably invokes open_widget.
  Caveat: Enter activates the highlighted index-0 row (often "Luna"), not
  your match — filter until the target is row 0, or click the row text.
- Collapse→orb: the moon-collapse button sits at the title bar's far right
  end and is often off-screen — `cmd+shift+K` (global toggle) is the reliable
  trigger. Orb click → expand_from_moon restores every dock window.
- Saved positions now round-trip at settle time: e389ec75 applies all snap
  frames synchronously via `setFrameTopLeftPoint` (`set_frame_top_left_ns`),
  so the post-build re-assert lands before `reattach_flushed_windows` reads
  frames (observed: window written y=756 settles at exactly (811,756), not
  the old tao-constrained 671), and the settle's corrective move lands
  before child attach (no transient seam). tao's `set_position` alone is
  still deferred — any new position path must use the AppKit helper.
- Attach direction and parent choice: `settle_snap` and the open-path
  `attach_to_flush_neighbor` pick the flush parent by LONGEST shared edge
  (`flush_parent`), not by which neighbor you think is "the" anchor. A
  widget flush on TWO edges (e.g. chat's right edge AND under a parked
  widget's bottom) attaches to whichever overlap is longer — verify the
  actual parent via instrumentation or a tow test on EACH candidate before
  concluding "not attached" (a "doesn't tow with chat" observation may just
  mean it's another window's child). When the settled window is the chat,
  direction reverses: the neighbor docks under the chat (chat is the hub).
- Geometry ground truth: `~/.luna/layout.json` stores each panel's logical
  rect — use it to assert flushness exactly (child.y == parent.bottom).
- Coordinate scale on the Devin box: 1 tool px = 1.5625 logical pt, so
  SNAP_GAP (20pt) ≈ 12.8 tool px. Drops must clear ~13 tool px of gap.
- Resize grips are thin JS hit strips (`.resize-s` = 8px straddling the
  bottom edge; `.resize-se` corner bracket). Native `startResizeDragging`
  is unimplemented on macOS — the JS loop owns resizing; grabs on the edge
  strips fire `Resized` events which drive `reflush_snap_children`.

## Pixel-measuring native chrome (traffic lights) in T3

`screencapture -x` writes at the real backing resolution — on this box the
display is 1600x1200 at **1x** (PNG == logical pt), so a `pt` spec is a `px`
expectation. Window rects come from Accessibility, which works out of the box:

```bash
osascript -e 'tell application "System Events" to tell process "luna-moon-ui" \
  to get {name, position, size} of every window'
# window title ("Luna", "Settings"), x, y, w, h — one flat CSV row per window.
# Caveat: `item 1 of position of window i` fails on the posn class —
# `set p to position of window i` into a var first, then `item 1 of p`.
```

The macOS traffic-light cluster: focused = red #FF5F57/yellow/green disks;
**unfocused = near-black disks (~rgb(7,15,29)) DARKER than the card bg
(~rgb(42,50,65)) — not mid-gray.** Scan for either in the strip
x∈[win_x+4, win_x+90], y∈[win_y+2, win_y+44]: the leftmost disk's top edge
sits ~12pt below the window top when the 36pt-container chrome layout holds,
~4-8pt when it collapses. Only the key window shows colored buttons — measure
right after interacting with that window, or detect the dark inactive disks.

## Other desktop windows can cover the orb

Simulator (iPhone Mirroring), notifications, etc. may sit over the orb or a
card window. Move them aside instead of fighting z-order — Accessibility is
already granted to the host terminal:

```bash
osascript -e 'tell application "System Events" to tell process "Simulator" \
  to set position of every window to {1130, 100}'
```

## Cheap second dock window + attach/detach verification

Cmd+K in any card opens the launcher; a row click spawns a `panel-*` window —
and snap-on-open may **already attach it flush** to the neighbor (check the dev
server stdout: `[snap] attach panel-settings -> panel-chat`). That exercises
`set_snap_parent_ns` without crafting a drop. Tow-verify attach by dragging the
PARENT (an attached child follows exactly); detach by dragging the child beyond
SNAP_GAP (~13 tool px) — the log prints `[snap] detach <label>`.

## `.resize-se` grab point is the exact corner

The corner bracket GLYPH sits ~15px inside the card, but the 8px-straddling hit
strip is AT the window edge — grabbing on the glyph (inside the card) selects
text instead of resizing. Get the corner from the System Events rect
(x+w, y+h → tool coords ×0.64) and grab within ~2-3 tool px of it.

## Foreign windows falsify pixel measurements — clear the field first

A "wrong margin" reading may be an OCCLUDER, not a bug. On this box the
chronic offenders: the **iPhone Mirroring "iCloud Signed Out" card** (a
separate `iPhone Mirroring` process window ~317x696 that reappears over the
top-left of whatever you're measuring) and any app an accidental dock click
launches (Chrome's first-run dialogs). Symptom in the PNG: lights-zone pixels
are light gray/white (~233+) instead of card bg ~(42,50,65), or extra
"disks" from dialog text. Enumerate owners before measuring:
`osascript -e 'tell application "System Events" to get name of every process whose visible is true'`,
then `set position of window X to {20, 120}` on the foreign process or
`tell application "X" to quit`. Also note: card-panel miniaturize is a NO-OP
(yellow button and Cmd+M do nothing) — re-show isn't a reachable reset path
for these windows, so don't burn time trying to test it.
