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
