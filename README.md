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

Install the Claude Code CLI and authenticate it on the machine that will run
the Luna server. The client installer does not read or write Claude OAuth
tokens.

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

## Install

Luna is a monorepo. A clone contains the terminal client, web UI, server
runtime, shared packages, and host/container setup scripts.

Install the terminal client on a Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/fourcolors/luna/master/install.sh | bash
```

Or clone and run locally:

```bash
git clone https://github.com/fourcolors/luna.git ~/Projects/luna
bash ~/Projects/luna/install.sh
```

The installer clones the monorepo, installs dependencies, creates `~/.luna/`,
and writes a `luna` wrapper that runs the terminal client:

After install:
```bash
luna chat        # stable runtime
luna chat --dev  # dev runtime
```

Server and container setup are separate, explicit operations:

- [Install guide](./docs/install.md)
- [Incus container runtime](./docs/container-runtime.md)
- [jax-box deployment](./docs/jax-box-deploy.md)

The clone includes scripts for Linux hosts:

```bash
scripts/luna-server-install --help
scripts/luna-container-create --help
```

## Runtime model

Luna is designed to run with one local client and two server runtimes:

| Runtime | Purpose | Client command | Default URL |
|---------|---------|----------------|-------------|
| Stable | The agent you actually use day to day | `luna chat` | `ws://jax-box:4753/ui` |
| Dev | A separate runtime for testing fixes and branches | `luna chat --dev` | `ws://jax-box:5753/ui` |

The terminal client reads profile settings from `~/.luna/.env`:

```bash
LUNA_STABLE_WS_URL=ws://jax-box:4753/ui
LUNA_STABLE_UI_WS_TOKEN=<stable-token>
LUNA_DEV_WS_URL=ws://jax-box:5753/ui
LUNA_DEV_UI_WS_TOKEN=<dev-token>
```

Tokens are local secrets and should not be committed.

## Container system

Luna uses Incus system containers for host-like Linux runtimes. This gives each
runtime its own systemd service, filesystem state, Claude Code config, and Bun
environment without turning the whole machine into an OpenStack deployment.

The recommended jax-box layout is:

```text
/root/luna/stable/repo      stable repo checkout
/root/luna/dev/repo         dev repo checkout
/root/.luna                 stable runtime state
/root/.luna-dev             dev runtime state
```

Inside a container, the mounted paths are always:

```text
/root/luna                  repo
/root/.luna                 runtime state
```

The dev container maps host ports to container ports:

```text
jax-box:5753 -> luna-dev:4753  WebSocket server
jax-box:5754 -> luna-dev:4754  control server
```

Create the dev container from a clone on jax-box:

```bash
scripts/luna-container-create \
  --profile dev \
  --name luna-dev \
  --repo git@github.com:fourcolors/luna.git \
  --branch master \
  --repo-path /root/luna/dev/repo \
  --state-path /root/.luna-dev \
  --host jax-box \
  --host-ws-port 5753 \
  --host-control-port 5754 \
  --token '<dev-ui-ws-token>'
```

If the container already exists, this command exits successfully without
changing the existing instance. Use `--replace` only when you intend to delete
and rebuild the container. The scripts do not upgrade the host kernel; Incus
containers share the T2 Mac host kernel.

## Development

```bash
bun install
bun run typecheck
bun run test
```

Focused checks for the deployment/client work:

```bash
bash -n install.sh scripts/luna-server-install scripts/luna-container-create scripts/lib/luna-deploy.sh
bun run test test/deploy-scripts.test.ts apps/ui-web/scripts/__tests__/rename-chat-server.test.ts
bun run --filter '@luna/agent-cli' test
```

Known local caveat: some DuckDB/telemetry tests currently fail under Vitest
when it cannot load `bun:sqlite`. Use the focused checks above for deployment
script changes until that test-runner issue is fixed.

### Dev servers

```bash
# Web UI (Vite, hot reload)
bun run --filter '@luna/ui-web' dev

# Chat backend (requires Claude Code login)
bun run --filter '@luna/ui-web' server:chat
```

### Stable/dev workflow

Develop on a branch, push it, and test it through the dev runtime:

```bash
git checkout -b <feature-branch>
bun run typecheck
bun run --filter '@luna/agent-cli' test
git push origin <feature-branch>
luna chat --dev
```

After the dev runtime is working, merge to `master` and promote stable on
jax-box:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
git fetch origin master
git checkout master
git pull --ff-only origin master
bun install --frozen-lockfile
systemctl restart luna-chat-server.service
curl -fsS http://127.0.0.1:4753/healthz
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
