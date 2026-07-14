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
- The [Claude Code](https://claude.ai/code) CLI installed and authenticated via `claude setup-token`

Install the `claude` CLI and run `claude setup-token` on the machine that will
run the Luna server — this is the OAuth login the `AccountBroker` brokers. The
client installer does not read or write Claude OAuth tokens.

## Stack

- **Runtime:** [Bun](https://bun.sh)
- **Effect system:** [Effect-TS v3](https://effect.website)
- **Agent SDK:** [Anthropic Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk)
- **Database:** SQLite via `@effect/sql-sqlite-bun` · Vectorlite for HNSW vector search
- **Testing:** Vitest
- **UI:** Solid.js (web) · Luna Moon floating widget (Tauri) · the `luna` terminal client

## Architecture

Luna is built from composable Effect Layers:

| Layer | Purpose |
|-------|---------|
| `AccountBroker` | Multi-account OAuth token rotation with health tracking |
| `SessionStore` | SQLite-backed chat session + message persistence |
| `ChatService` | Agent execution, streaming, MCP integration |
| `JobTicker` | Single supervised scheduler — drains the `jobs` table and dispatches due rows (prompt/workflow/dream/wake) to the `WorkerRegistry` |
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
  capabilities/   - versioned capability layer (slash commands, skills) a backend advertises to UIs
apps/
  agent-cli/      — the `luna` terminal client (chat, doctor, pair, account, memory)
  ui-web/         — Solid.js web chat interface (Vite dev server on :5174)
  ui-moon-tauri/  — Luna Moon: a small transparent floating-widget desktop app (Tauri)
```

### The apps, at a glance

| App | What it is |
|-----|------------|
| `agent-cli` | The `luna` CLI you install on your Mac. `luna chat` opens a terminal chat; `luna doctor` runs a connection preflight; `luna pair` points the CLI + Moon widget at a server in one command. |
| `ui-web` | The Solid.js web chat UI, served by Vite on `http://localhost:5174`. This is also where first-run Claude subscription login happens. |
| `ui-moon-tauri` | "Luna Moon" — a small (140×140), transparent, always-on-top floating crescent widget. Click it for a chat panel; toggle with `Cmd/Ctrl+Shift+K`. |

The LLM behind every surface is **cloud Claude via your Claude.ai subscription**
(see [Authentication](#authentication)); the server reaches it through the
`claude` CLI, so the server machine must be logged in with `claude setup-token`.
Local Ollama is used only for memory embeddings, not for chat.

## Quick Start

Luna is a monorepo. A clone contains the terminal client, web UI, the desktop
widget, the server runtime, shared packages, and host/container setup scripts.

**Step 0 — clone the repo.** Everything below assumes you have a local clone:

```bash
git clone https://github.com/fourcolors/luna.git ~/Projects/luna
cd ~/Projects/luna
```

You also need [Bun](https://bun.sh) (the installers will install it for you if
it is missing) and, on the machine that runs the server, the `claude` CLI
logged in with `claude setup-token` (see [Authentication](#authentication)).

### Easiest: the Luna Moon setup wizard

No clone needed. Download **Luna Moon** (the floating-widget desktop app) from
[GitHub Releases](https://github.com/fourcolors/luna/releases) and open it. On
first run a guided setup wizard appears with three paths:

- **This Mac** — installs and starts the Luna server right there (and detects
  an existing install, offering *Update & restart* instead),
- **My own server** — writes a tailored one-line installer to paste into your
  terminal for a Linux box you own,
- **Already running** — points the moon at an existing Luna server.

Every path ends with a live connection test (the wizard listens for the
server's `hello` before saving anything). Re-run it any time from
**Settings → Connection → Setup wizard**.

The server still needs its one-time Claude login (`claude setup-token`, see
[Authentication](#authentication)) — if it's missing, the wizard's final step
tells you exactly what to do.

### macOS: double-click installer

The easiest path on macOS is the interactive installer at the repo root.
Double-click **`install-mac.command`** in Finder (or run `./install-mac.command`
from Terminal in the clone) and pick a profile:

| Option | What it does | Extra requirements |
|--------|--------------|--------------------|
| **[1] Complete Desktop Install** | Installs the `luna` CLI, starts the chat server (supervised by launchd) and the Vite web UI on your Mac, and opens `http://localhost:5174`. | `claude setup-token` login on first run |
| **[2] Remote Server Client** | Installs the `luna` CLI only and points it at a remote Luna server (prompts for the WebSocket URL + token). | a running remote server |
| **[3] Separated Client / Server** | Installs the `luna` CLI wrapper only and prints manual server-deploy instructions. | — |
| **[4] Luna Moon — floating widget** | Starts the supervised local server (launchd) and launches the **Luna Moon** native floating widget; the token is auto-configured. | the **Rust toolchain** ([rustup](https://rustup.rs) + `cargo install tauri-cli`) **and** the `claude` CLI |

Option 4 compiles the Tauri app on first launch via `cargo tauri dev`, so the
Rust toolchain (`cargo`) and the `cargo-tauri` CLI must be installed first; the
installer aborts with instructions if either is missing. The widget can only
chat once the server has a logged-in Claude account, so on a fresh box it opens
the web UI for a one-time `claude setup-token` login before starting the moon.

### Any platform: terminal client only

To install just the `luna` terminal client, run `install.sh` from the clone (or
pipe it from GitHub):

```bash
bash ~/Projects/luna/install.sh
# or:
curl -fsSL https://raw.githubusercontent.com/fourcolors/luna/master/install.sh | bash
```

The installer clones/updates the monorepo, installs dependencies, creates
`~/.luna/`, and writes a `luna` wrapper onto your PATH (`~/.local/bin/luna`).
Run `bash install.sh --help` to see all flags (custom clone path, server URLs,
tokens, dry-run).

After install:
```bash
luna chat        # stable runtime
luna chat --dev  # dev runtime
luna doctor      # connection preflight: server reachable? token good? chat ready?
luna pair        # point the CLI + Moon widget at a server in one command
```

If you are connecting to a remote server, `luna pair --url ws://<host>:4753/ui
--token <ui-ws-token>` writes both `~/.luna/.env` and the Moon connection file,
then runs `luna doctor` to confirm the link is green. See
[How to test & verify](./docs/HOW_TO_TEST_AND_VERIFY.md) for the full
verification playbook (doctor failure modes, pairing, boot smokes).

### Server and container setup

Server and container setup are separate, explicit operations:

- [Install guide](./docs/install.md)
- [Incus container runtime](./docs/container-runtime.md)
- [jax-box deployment](./docs/jax-box-deploy.md)

The clone includes scripts for Linux hosts:

```bash
scripts/luna-server-install --help
scripts/luna-container-create --help
```

> **Networking / security model — Tailscale is the transport.** The WebSocket
> layer is plaintext `ws://` with the bearer token in the URL, so it has no
> transport confidentiality on its own and is meant to run **behind a
> [Tailscale](https://tailscale.com) tailnet**. The install scripts reflect this:
> when a tailnet is present they auto-bind the host's Tailscale IP (so a remote
> Mac reaches the server with no extra flags), otherwise they bind loopback and
> warn. Exposing the server on a public interface (`0.0.0.0`) is a deliberate,
> warned opt-in (`--i-understand-public`) and is unsafe without a private network
> in front of it. `luna doctor` warns if you point a client at a non-tailnet,
> non-loopback host.

## Runtime model

Luna is designed to run with one local client and two server runtimes:

| Runtime | Purpose | Client command | Primary URL | Fallback URL |
|---------|---------|----------------|-------------|--------------|
| Stable | The agent you actually use day to day | `luna chat` | `ws://jax-box:4753/ui` | `ws://jax-box.local:4753/ui` |
| Dev | A separate runtime for testing fixes and branches | `luna chat --dev` | `ws://jax-box:5753/ui` | `ws://jax-box.local:5753/ui` |

Stable tracks the `master` branch. There is no long-lived `dev` branch — Luna is
trunk-based: all work lands on `master` via PRs. The dev runtime is an optional
staging server you point at any feature branch or release tag to try a change
before it reaches stable. See [Branching & releases](#branching--releases).

The terminal client reads profile settings from `~/.luna/.env`:

```bash
LUNA_STABLE_WS_URL=ws://jax-box:4753/ui
LUNA_STABLE_FALLBACK_WS_URL=ws://jax-box.local:4753/ui
LUNA_STABLE_UI_WS_TOKEN=<stable-token>
LUNA_DEV_WS_URL=ws://jax-box:5753/ui
LUNA_DEV_FALLBACK_WS_URL=ws://jax-box.local:5753/ui
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

Create the dev container from a clone on jax-box. Point `--branch` at whatever
ref you want to stage — a feature branch or a `moon-v*` release tag (it no longer
tracks a `dev` branch):

```bash
scripts/luna-container-create \
  --profile dev \
  --name luna-dev \
  --repo git@github.com:fourcolors/luna.git \
  --branch <feature-branch-or-tag> \
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

Stable and dev container operations, including the stable container cutover and
rollback runbook, are documented in [Incus container runtime](./docs/container-runtime.md).

## Development

```bash
bun install
bun run typecheck
bun run test
```

Focused checks for the deployment/client work:

```bash
bash -n install.sh scripts/luna-server-install scripts/luna-container-create scripts/luna-guardian scripts/luna-guardian-remote-check scripts/lib/luna-deploy.sh
bun run test test/deploy-scripts.test.ts apps/ui-web/scripts/__tests__/rename-chat-server.test.ts
bun run --filter '@luna/agent-cli' test
```

Known local caveat: some DuckDB/telemetry tests currently fail under Vitest
when it cannot load `bun:sqlite`. Use the focused checks above for deployment
script changes until that test-runner issue is fixed.

For the full verification playbook — `luna doctor` failure modes, `luna pair`,
the `luna-update-server` rollback flow, the green test baseline, and the
ManagedRuntime boot smokes — see
[How to test & verify](./docs/HOW_TO_TEST_AND_VERIFY.md).

### Dev servers

```bash
# Web UI (Vite, hot reload)
bun run --filter '@luna/ui-web' dev

# Chat backend (requires the `claude` CLI logged in via `claude setup-token`)
bun run --filter '@luna/ui-web' server:chat
```

### Branching & releases

Luna is **trunk-based**: `master` is the only long-lived branch — there is no
`dev` branch. Do work on a short-lived feature branch, open a PR against
`master`, and squash-merge it.

```bash
git checkout master
git pull --ff-only origin master
git checkout -b <feature-branch>
bun run typecheck
bun run --filter '@luna/agent-cli' test
git push -u origin <feature-branch>
gh pr create --base master --fill   # review, then squash-merge
```

Optionally stage the change first on the dev runtime by pointing it at your
feature branch or a tag (see [Container system](#container-system)) before it
reaches stable.

**Releases are cut from tags, not branches.** Moon desktop builds are published
by pushing a `moon-v*` tag, which triggers `.github/workflows/release-moon.yml`
(build → sign → GitHub Release with updater artifacts):

```bash
# bumps the version triple, commits, creates tag moon-v<x.y.z>, and pushes it
bun run scripts/bump-moon.ts <x.y.z> --tag --push
```

See [RELEASES.md](RELEASES.md) for the full release conventions (the "Latest"
invariant and the `chat-v*` / other tag-only releases).

Stable **auto-updates by default** - the host-side guardian verifies health and
redeploys it while idle (see [autodeploy](docs/autodeploy.md)). To force a
deploy now, or when auto-update is opted out, drive the same connect-aware
rollback path and prove live completion - do not run raw `git pull` +
`bun install` + restart, which bypasses transaction journaling, rollback,
exact-SHA readiness, and the acceptance gate:

```bash
ssh root@jax-box
cd /root/luna/stable/repo
git fetch origin master
EXPECTED_SHA="$(git rev-parse origin/master)"
scripts/luna-autodeploy stable
scripts/luna-guardian adopt stable
/usr/local/lib/luna-guardian/current-stable/luna-guardian accept stable \
  --expected-sha "$EXPECTED_SHA" --min-cycles 2
```

If active sessions defer the update, leave the promotion pending and retry when
idle. See [jax-box deploy](docs/jax-box-deploy.md) for the full runbook.

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
