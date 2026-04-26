# @experiment-agent/ui-web

ChatGPT-style chat UI over the ui-ws v2 protocol. Same Vite bundle runs
in the browser and inside the Tauri shell at `apps/ui-tauri`.

## Run

```bash
# Terminal 1 — real-SDK chat backend (ws://127.0.0.1:4753)
bun run --filter @experiment-agent/ui-web dev:server:chat

# Terminal 2 — pick one:
bun run --filter @experiment-agent/ui-web dev          # browser → http://localhost:5173
bun run --filter @experiment-agent/ui-tauri dev        # native window
```

The first time you connect, paste any non-empty token (the dev server
runs with a generated token printed at startup). Click **+ New** to
create a thread; type with **⌘ / Ctrl + Enter** to send.

## Features

- **Sidebar**: most-recently-active thread first; refreshes after every
  `thread-created` / `user-accepted` / `assistant-done`.
- **Chat panel**: streaming text during assistant turns; finalized
  messages render as GFM markdown with Shiki-highlighted code fences
  (lazy-loaded chunk; allowlist: ts, tsx, js, jsx, json, md, bash,
  python, rust, go).
- **Artifact panel**: appears as a third column when the active thread
  has artifacts. Source payloads come from a server-side extractor:
  - Code fences ≥ 10 lines OR ≥ 400 chars
  - `Write` / `Edit` / `MultiEdit` / `NotebookEdit` tool uses

## Known limitations

- **Thread durability**: the dev rig uses an in-memory `SessionStore`.
  Threads vanish on server restart. Durable storage lands with
  `SessionStore.Sqlite` (Phase 5).
- **Tauri prod bundle**: `bunx tauri build` works on macOS (icon set is
  generated). Code-signing / DMG / notarization is out of scope for the
  spike.
- **Token UX**: token is read from `localStorage` (`ui-ws.config`) or
  the `VITE_UI_WS_TOKEN` env var. There's no in-app login flow.

## Wire protocol

See `packages/ui-ws/README.md` for the full v2 frame catalog (server↔
client, dedupe rules, capability negotiation).
