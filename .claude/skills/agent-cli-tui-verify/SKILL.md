---
name: agent-cli-tui-verify
description: How to run and verify the agent-cli OpenTUI chat TUI (`luna chat`) end-to-end — which directory to launch from, what server state it needs, how to prove key-handling paths via LUNA_TUI_DEBUG, and how to offline-test mcp-cli commands. Complements luna-verify (which covers the Moon app / web UI).
---

# Verifying the agent-cli TUI (`luna chat`)

`luna chat` mounts an OpenTUI/Solid terminal UI. These are the sharp edges that cost real time.

## Launch from the package dir — bunfig.toml is per-package

`@opentui/solid`'s preload (Bun JSX transform + solid-js client-build swap) is registered by
**`apps/agent-cli/bunfig.toml`**, NOT by code in `luna.ts` — the comment in `tui/mount.ts` claiming
"registered at the top of luna.ts" is misleading. Launch from the package root:

```bash
cd apps/agent-cli && bun src/luna.ts chat --url ws://127.0.0.1:4753/ui --token <token>
```

Running `bun apps/agent-cli/src/luna.ts ...` from the repo root skips the preload and dies with
`Cannot find module 'react/jsx-dev-runtime' from '.../tui/App.tsx'` before the TUI mounts.

## The TUI only mounts on a real TTY

`chat.ts` gates on `process.stdout.isTTY === true` — piping or a non-PTY exec silently falls back to
the readline UI. Use a real terminal emulator (Terminal.app, iTerm) or a PTY session for TUI tests.

## Getting the chat server out of setup-mode without real credentials

`luna chat` calls `connectWithRecovery` **before** mounting the TUI, so the server must be up:

```bash
LUNA_HOME=/tmp/luna-verify LUNA_DISABLE_VECTORLITE=1 LUNA_WAKE_ENABLED=0 \
  LUNA_UI_WS_HOST=127.0.0.1 UI_WS_TOKEN=<32+ hex chars> \
  bun run scripts/luna-chat-server-entry.ts    # from repo root
```

Setup-mode trap: `luna account add` writes to **`~/.luna/luna.db` (homedir), ignoring `LUNA_HOME`**.
The server probes `LUNA_HOME/luna.db` (or `LUNA_DB_PATH`). Seed the right file:

```bash
bun apps/agent-cli/src/luna.ts account add --id default --label Default \
  --kind anthropic --secret-ref env:LUNA_SMOKE_KEY --db-path /tmp/luna-verify/luna.db
```

Use a **non-`claude-code:login` secret-ref** — `probeCredentialReadiness` treats any non-login
account as ready (`non-login-account-present`) with no auth probe, while `claude-code:login` runs
`claude auth status --json` and lands in setup-mode when no `claude` binary exists.
A stray `~/.luna/luna.db` from a `account add` without `--db-path` does nothing for the server —
delete it to keep the machine clean.

## Proving key-handling paths: LUNA_TUI_DEBUG

`LUNA_TUI_DEBUG=<file>` makes mount.ts append a debug line for every meaningful event — the cheapest
way to prove a key path fired without inferring from pixels:

- `key: ctrl-c quit` — global Ctrl-C matched and the quit path ran (`beginQuit` → `client.close()` → `renderer.destroy()`)
- `key: f2 toggle selection mode` — F2 → `applySelectionMode`
- `RootApp setup, renderer keyInput=present` — global keypress handler registered
- `survey dismiss (no-op — resurfaces next connection)` — survey modal dismissed via Esc

A quit that worked shows the alt-screen clearing back to the shell prompt and `exit=0` from
`echo "exit=$?"`. F2's visible proof is a `selection mode: on` system line plus a `SELECT` marker
in the status bar.

Note: a pending survey modal may cover the timeline on first connect — Esc dismisses it.

## Offline-testing mcp-cli (no server needed)

`apps/server/scripts/mcp-cli.ts` talks only to a sqlite DB — `LUNA_DB=/tmp/x.db` isolates it.
`add` requires an `https:` URL (`http:`/`ws:` → `McpUrlInvalid`). Then `allow-all <slug> [--off]`,
`trust`, `allow <slug> <tool>`, `enable`/`disable` all exercise purely local state.

## Devin Secrets Needed

None — the smoke path above uses a dummy `env:` secret-ref and a locally generated `UI_WS_TOKEN`.
