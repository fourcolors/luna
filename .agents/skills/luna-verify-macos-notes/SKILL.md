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

## Devin Secrets Needed

None. The Vite page boots outside Tauri and degrades to "Disconnected"
(`BOOT_INVOKE_MS` cap) — attachment staging, composer UI, and all client-side
bridges work without a server or credentials.
