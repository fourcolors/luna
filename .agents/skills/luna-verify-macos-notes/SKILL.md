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

- Settles are driven by a persistent LeftMouseUp watcher + a per-window
  `Moved` mark (`note_dock_moved`), NOT by any title-bar pointerdown — so ANY
  grab spot (even the native-zone strip ~4px below the top edge) settles on
  release. To verify a settle ran, use a temporary `eprintln!` in
  `settle_snap` / `take_moved_labels` ([SNAPDBG] tags) and grep the dev log.
- The watcher settles EVERY moved window on each mouse-up, and a settle that
  moves a frame re-marks it — so one drop can visibly re-dock OTHER windows
  (including flipping parent/child direction). Convergence, not a bug — but
  expect the "settled" set to sometimes contain windows you didn't drag.
- Launcher row clicks occasionally miss the row hit-area; pressing Enter on
  the filtered row reliably invokes open_widget.
  Caveat: Enter activates the highlighted index-0 row (often "Luna"), not
  your match — filter until the target is row 0, or click the row text.
- Collapse→orb: the moon-collapse button sits at the title bar's far right
  end and is often off-screen — `cmd+shift+K` (global toggle) is the reliable
  trigger. Orb click → expand_from_moon restores every dock window.
- Geometry ground truth: `~/.luna/layout.json` stores each panel's logical
  rect — use it to assert flushness exactly (child.y == parent.bottom).
- Coordinate scale on the Devin box: 1 tool px = 1.5625 logical pt, so
  SNAP_GAP (20pt) ≈ 12.8 tool px. Drops must clear ~13 tool px of gap.
- Resize grips are thin JS hit strips (`.resize-s` = 8px straddling the
  bottom edge; `.resize-se` corner bracket). Native `startResizeDragging`
  is unimplemented on macOS — the JS loop owns resizing; grabs on the edge
  strips fire `Resized` events which drive `reflush_snap_children`.
