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
LAN-style fallback URLs:

```bash
LUNA_STABLE_WS_URL=ws://jax-box:4753/ui
LUNA_STABLE_FALLBACK_WS_URL=ws://jax-box.local:4753/ui
LUNA_DEV_WS_URL=ws://jax-box:5753/ui
LUNA_DEV_FALLBACK_WS_URL=ws://jax-box.local:5753/ui
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
  --ssh-host jax-box \
  --fallback-ssh-host jax-box.local
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
- preserves an existing UI token unless `--rotate-token` is set
- writes a systemd service
- runs `systemctl daemon-reload`, `enable`, and `restart` by default

Dry-run first when changing a host:

```bash
scripts/luna-server-install --dry-run --profile dev --token '<ui-ws-token>'
```

## Incus Container

On a host with Incus initialized:

```bash
scripts/luna-container-create \
  --profile dev \
  --name luna-dev \
  --repo git@github.com:fourcolors/luna.git \
  --branch dev \
  --repo-path /root/luna/dev/repo \
  --state-path /root/.luna-dev \
  --host jax-box \
  --host-ws-port 5753 \
  --host-control-port 5754 \
  --token '<dev-ui-ws-token>'
```

The script prepares host paths, writes container `.env`, creates an Ubuntu
24.04 cloud container, mounts:

- `/root/luna/dev/repo` on the host to `/root/luna` in the container
- `/root/.luna-dev` on the host to `/root/.luna` in the container

It then proxies host `5753` to container `4753`, proxies host `5754` to
container `4754`, starts the container, waits for cloud-init, and checks the
systemd service.

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
curl -fsS http://jax-box:4753/healthz
curl -fsS http://jax-box:5753/healthz
```
