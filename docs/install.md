# Luna Install Guide

Luna uses one monorepo for the server, web app, shared packages, and terminal
client. A fresh clone can install the local client, install a Linux server
service, or create an Incus container runtime.

## Local Client

On a Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/fourcolors/luna/master/install.sh | bash
```

Or from a local clone:

```bash
bash install.sh
```

The installer:

- clones or updates `https://github.com/fourcolors/luna.git`
- runs `bun install --frozen-lockfile`
- creates `~/.luna/`
- installs `~/.local/bin/luna`
- writes stable/dev primary and fallback WebSocket URLs to `~/.luna/.env`

It does not install a server and does not read or write Claude OAuth tokens.

Use:

```bash
luna chat
luna chat --dev
```

If the server tokens are not already in `~/.luna/.env`, pass them explicitly:

```bash
bash install.sh \
  --stable-token '<stable-ui-ws-token>' \
  --dev-token '<dev-ui-ws-token>'
```

Tokens are written with `0600` permissions and are never printed by dry-runs.

By default, the client installer writes Tailscale-style primary URLs and
LAN-style fallback URLs (substitute your actual server hostname — the shipped
`install.sh` default is `luna-host` / `luna-host.local`; `luna-server` is the
neutral placeholder used in these docs):

```bash
LUNA_STABLE_WS_URL=ws://luna-server:4753/ui
LUNA_STABLE_FALLBACK_WS_URL=ws://luna-server.local:4753/ui
LUNA_DEV_WS_URL=ws://luna-server:5753/ui
LUNA_DEV_FALLBACK_WS_URL=ws://luna-server.local:5753/ui
```

Use explicit URLs for another host:

```bash
bash install.sh \
  --stable-url ws://luna-host:4753/ui \
  --stable-fallback-url ws://luna-host.local:4753/ui \
  --dev-url ws://luna-host:5753/ui \
  --dev-fallback-url ws://luna-host.local:5753/ui
```

If the client should also try SSH-based restart/repair, opt in explicitly:

```bash
bash install.sh \
  --enable-ssh-recovery \
  --ssh-user root \
  --ssh-host luna-server \
  --fallback-ssh-host luna-server.local
```

## Linux Server

Run this inside a Linux host or container that should serve Luna:

```bash
scripts/luna-server-install \
  --profile stable \
  --repo-dir /root/luna/stable/repo \
  --luna-home /root/.luna \
  --token '<ui-ws-token>'
```

For a dev container mounted at `/root/luna`:

```bash
scripts/luna-server-install \
  --profile dev \
  --repo-dir /root/luna \
  --luna-home /root/.luna \
  --token '<ui-ws-token>'
```

The script:

- installs required apt packages and Bun unless `--skip-deps` is set
- writes `CLAUDE_CONFIG_DIR`, `LUNA_REPO_ROOT`, and `LUNA_UI_WS_HOST`
- pins portable state paths under `--luna-home`: `LUNA_DB_PATH`,
  `LUNA_MEMORY_DB`, `LUNA_ANALYTICS_DB_PATH`, and `LUNA_EVENTS_JSONL_PATH`
- preserves an existing UI token unless `--rotate-token` is set
- writes a systemd service
- runs `systemctl daemon-reload`, `enable`, and `restart` by default

Dry-run first when changing a host:

```bash
scripts/luna-server-install --dry-run --profile dev --token '<ui-ws-token>'
```

## Incus Container

On a host with Incus initialized, create the dev container on the dev host
ports:

```bash
scripts/luna-container-create \
  --profile dev \
  --name luna-dev \
  --repo git@github.com:fourcolors/luna.git \
  --branch <feature-branch-or-tag> \
  --repo-path /root/luna/dev/repo \
  --state-path /root/.luna-dev \
  --host luna-server \
  --host-ws-port 5753 \
  --host-control-port 5754 \
  --token '<dev-ui-ws-token>'
```

The dev container uses:

```text
/root/luna/dev/repo         host repo checkout mounted to /root/luna
/root/.luna-dev             host runtime state mounted to /root/.luna
luna-server:5753 -> luna-dev:4753  WebSocket server
luna-server:5754 -> luna-dev:4754  control server
```

Inside the container, runtime state is addressed through container-local paths
in `.env`:

```text
LUNA_HOME=/root/.luna
LUNA_DB_PATH=/root/.luna/luna.db
LUNA_MEMORY_DB=/root/.luna/memory.db
LUNA_ANALYTICS_DB_PATH=/root/.luna/analytics.duckdb
LUNA_EVENTS_JSONL_PATH=/root/.luna/events.jsonl
```

To prepare stable for a container cutover, build it on temporary candidate
ports first:

```bash
scripts/luna-container-create \
  --profile stable \
  --name luna-stable \
  --repo git@github.com:fourcolors/luna.git \
  --branch master \
  --repo-path /root/luna/stable/repo \
  --state-path /root/.luna \
  --host luna-server \
  --host-ws-port 6753 \
  --host-control-port 6754 \
  --skip-clone
```

The stable candidate uses:

```text
/root/luna/stable/repo      host repo checkout mounted to /root/luna
/root/.luna                 host runtime state mounted to /root/.luna
luna-server:6753 -> luna-stable:4753  candidate WebSocket server
luna-server:6754 -> luna-stable:4754  candidate control server
```

After verification, use the stable cutover runbook in
[`docs/container-runtime.md`](./container-runtime.md) to move stable from
candidate ports to production ports and keep rollback available.

The script prepares host paths, writes container `.env`, creates an Ubuntu
24.04 cloud container, mounts the selected repo and state paths into the
container, proxies the selected host ports to container ports `4753` and
`4754`, starts the container, waits for cloud-init, checks the systemd
service, and installs the host-side guardian for the channel.

The independent guardian is **on by default**: it seeds `/etc/luna/servers.toml`
from `scripts/seeds/servers.toml` when absent and enables
`luna-guardian install <profile>`. The pinned host-side guardian checks deep
health, repairs/restarts safely, resumes interrupted transactions, and tracks
updates while idle. Pass `--no-auto-update` to skip it (enable later with
`scripts/luna-guardian adopt <profile>`). Prove a live rollout with
`luna-guardian accept <profile> --expected-sha <full-sha> --min-cycles 2`. See
[`docs/autodeploy.md`](./autodeploy.md) for cadence and opt-out.

If the Incus instance already exists, the script exits successfully without
changing repo files, state files, cloud-init, devices, or services. Use
`--replace` only when you intend to delete and recreate the container.

Use `--dry-run` to see the exact Incus commands without touching the host.

## Verification

Local script tests:

```bash
bun run test test/deploy-scripts.test.ts
bash -n install.sh scripts/luna-server-install scripts/luna-container-create
```

Runtime health checks:

```bash
curl -fsS http://luna-server:4753/healthz
curl -fsS http://luna-server:5753/healthz
```
