```
    ██╗     ██╗   ██╗███╗   ██╗ █████╗
    ██║     ██║   ██║████╗  ██║██╔══██╗
    ██║     ██║   ██║██╔██╗ ██║███████║
    ██║     ██║   ██║██║╚██╗██║██╔══██║
    ███████╗╚██████╔╝██║ ╚████║██║  ██║
    ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝
    locally-hosted AI agent framework
```

A modular, locally-hosted AI agent framework built on Effect-TS, Bun, and SQLite.

## What it is

Luna is a composable agent SDK. It provides the infrastructure layer for running Claude-powered agents locally — account brokering, session management, memory, cost accounting, MCP tool servers, and a chat surface — all wired together as Effect-TS Layers.

## Authentication

Luna uses your **Claude.ai subscription** — not an Anthropic API key.

Under the hood, Luna runs on the [Claude Code Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk), which authenticates via the same OAuth token that Claude Code uses. If you're already logged in to Claude Code on your machine, Luna can use that session directly.

**How it works:**
- Luna's `AccountBroker` manages a pool of OAuth tokens
- Tokens are obtained via `claude setup-token` (the Claude Code CLI)
- Secrets are stored in 1Password or macOS Keychain — never as plaintext
- Per-query token injection happens transparently via the SDK's env overlay
- Multiple accounts are supported with automatic rotation and health tracking

**You need:**
- A [Claude.ai](https://claude.ai) subscription (Pro or higher)
- [Claude Code](https://claude.ai/code) installed and logged in (`claude login`)

The install script will check for an existing Claude Code session and walk you through setup if needed.

## Stack

- **Runtime:** [Bun](https://bun.sh)
- **Effect system:** [Effect-TS v3](https://effect.website)
- **Agent SDK:** [Anthropic Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk)
- **Database:** SQLite via `@effect/sql-sqlite-bun` · Vectorlite for HNSW vector search
- **Testing:** Vitest
- **UI:** Solid.js (web) · Tauri (desktop shell)

## Architecture

Luna is built from composable Effect Layers:

| Layer | Purpose |
|-------|---------|
| `AccountBroker` | Multi-account OAuth token rotation with health tracking |
| `SessionStore` | SQLite-backed chat session + message persistence |
| `ChatService` | Agent execution, streaming, MCP integration |
| `JobScheduler` | Bounded fiber pool for background jobs |
| `TriggerAgent` | Cron + stream-based job triggers |
| `MemoryTools` | MCP server for persistent vector + structured memory |
| `SchedulerTools` | MCP server for scheduling recurring agent tasks |
| `WorkflowRuntime` | Durable multi-step workflows via `@effect/workflow` |
| `ObservabilityService` | Structured events + OpenTelemetry tracing |
| `CostAccounting` | Per-session/team budget tracking |

## Packages

```
packages/
  core/           — foundation services (sessions, jobs, memory, observability)
  chat-service/   — agent execution + streaming
  adapter-sdk/    — Anthropic Agent SDK bridge
  memory/         — memory backends (SQLite, vector, file, in-memory)
  memory-tools/   — MCP server exposing memory to agents
  scheduler-tools/ — MCP server exposing scheduling to agents
  tools/          — built-in + custom tool builder
  ui-shared/      — shared UI primitives
  ui-ws/          — WebSocket server for UI
apps/
  ui-web/         — Solid.js web chat interface
  ui-tauri/       — Tauri desktop shell
  agent-cli/      — reference CLI composition
```

## Install (macOS)

One command to install Luna on any Mac — clones the repo, installs deps, sets up `~/.luna/`, checks your Claude Code session, registers a launchd daemon, and installs the `luna` CLI shortcut:

```bash
curl -fsSL https://raw.githubusercontent.com/example-org/luna/master/install.sh | bash
```

Or clone and run locally:

```bash
git clone https://github.com/example-org/luna.git ~/Projects/luna
bash ~/Projects/luna/install.sh
```

**Prerequisites:**
- macOS (Apple Silicon or Intel)
- A [Claude.ai](https://claude.ai) subscription (Pro or higher)
- [Claude Code](https://claude.ai/code) — the installer will check your login status
- Bun — the installer will install it if missing

After install:
```bash
luna          # opens the web UI at http://localhost:5174
```

## Development

```bash
bun install
bun run test        # run all tests
bun run typecheck   # type check all packages
```

### Dev servers

```bash
# Web UI (Vite, hot reload)
bun run --filter '@luna/ui-web' dev

# Chat backend (requires Claude Code login)
bun run --filter '@luna/ui-web' server:chat
```

### Adding accounts

```bash
# Register a Claude.ai account with Luna
bun run --filter '@luna/agent-cli' luna-account add \
  --id me --label "My Account" --kind anthropic \
  --secret-ref claude-code:login

# List registered accounts
bun run --filter '@luna/agent-cli' luna-account list
```

## Personalisation

Luna's identity (`DNA.md`) is loaded at boot into every chat thread's system prompt.

The loader checks `~/.luna/DNA.md` first — if it exists, that wins. The repo's `DNA.md` is the fallback. This lets you keep a personal identity file (with your name, handles, preferences) outside the repo:

```bash
edit ~/.luna/DNA.md   # your personal Luna identity — never committed
```

## Local state

User data lives in `~/.luna/`:

| Path | Purpose |
|------|---------|
| `~/.luna/workspace/` | Working documents, planning |
| `~/.luna/state/` | Live runtime state |
| `~/.luna/logs/` | Log files |
| `~/.luna/run/` | PIDs, sockets |

## Design

Read [`DESIGN.md`](./DESIGN.md) — the architecture contract. Frozen sections are marked; don't infer architecture from anywhere else.

## License

MIT
