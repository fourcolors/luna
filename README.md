# 🌙 Luna

A modular, locally-hosted AI agent framework built on Effect-TS, Bun, and SQLite.

## What it is

Luna is a composable agent SDK. It provides the infrastructure layer for running Claude-powered agents locally — account brokering, session management, memory, cost accounting, MCP tool servers, and a chat surface — all wired together as Effect-TS Layers.

## Stack

- **Runtime:** [Bun](https://bun.sh)
- **Effect system:** [Effect-TS v3](https://effect.website)
- **Database:** SQLite via `@effect/sql-sqlite-bun` · Vectorlite for HNSW vector search
- **Testing:** Vitest
- **UI:** Solid.js (web) · Tauri (desktop shell)

## Architecture

Luna is built from composable Effect Layers:

| Layer | Purpose |
|-------|---------|
| `AccountBroker` | Multi-account Anthropic API rotation with health tracking |
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
  adapter-sdk/    — Anthropic SDK bridge
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

## Getting Started

```bash
bun install
bun run test        # run all tests
bun run typecheck   # type check all packages
```

### Dev servers

```bash
# Web UI (Vite)
bun run --filter '@luna/ui-web' dev

# Chat backend (requires Anthropic API key)
bun run --filter '@luna/ui-web' dev:server:chat
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
