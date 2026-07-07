# Incus Container Runtime

Luna uses Incus system containers for separate stable and development runtime
environments. This is lighter than OpenStack and closer to the problem Luna is
solving: isolate full Linux userlands while still keeping the single host easy
to recover and inspect.

## Why Incus

Docker is best for packaging one process. Luna needs a fuller host-like
environment: systemd services, a normal filesystem, Claude Code state, Bun,
repo checkouts, and operational commands. Incus gives Luna a managed Linux
system per runtime while keeping the setup small enough for one physical box.

Agent Zero can keep using Docker where its own assumptions require Docker.
Luna does not need to force that model onto the rest of the host.

## Host Kernel Constraint

The Ubuntu host is an old Intel T2 Mac. Incus containers share the host kernel,
so container setup must not depend on a host kernel upgrade. These scripts do
not install or upgrade the kernel and do not force an Incus upgrade.

Use Ubuntu 24.04 cloud containers. On this host, Ubuntu 26.04 was observed to
get stuck during early boot/network setup, while 24.04 worked.

## Container Shape

Recommended stable/dev layout:

```text
/root/luna/stable/repo      host stable repo checkout tracking master
/root/luna/dev/repo         host dev repo checkout tracking dev
/root/.luna                 host stable state
/root/.luna-dev             host dev state

/root/luna                  container repo mount
/root/.luna                 container state mount
```

The dev container exposes:

```text
jax-box:5753 -> luna-dev:4753  WebSocket server
jax-box:5754 -> luna-dev:4754  control server
```

The stable runtime normally exposes:

```text
jax-box:4753 -> stable WebSocket server
jax-box:4754 -> stable control server
```

## Auto-Update Timer

`luna-container-create` installs a host-side auto-update timer for the channel
by default (owner decision 2026-07). It seeds `/etc/luna/servers.toml` from
`scripts/seeds/servers.toml` when absent and enables
`luna-autodeploy install-timer <profile>`, so the channel polls its branch from
the host and redeploys while idle (stable every 15min, dev every 3min). The
timer defers whenever WebSocket sessions are active, so it never restarts a
container mid-conversation.

Pass `--no-auto-update` to `luna-container-create` to skip installing the timer
(enable later with `scripts/luna-autodeploy install-timer <profile>`), or set
`deploy.autoUpdate = false` in the channel's registry stanza to keep the timer
installed but no-op. See [`docs/autodeploy.md`](./autodeploy.md) for cadence,
the registry knobs, and opt-out details.

## Stable Container Cutover

Build the stable container on candidate ports first so any existing host stable
service stays available until the maintenance window. The candidate build
installs an auto-update timer like any other create - pass `--no-auto-update`
if you want to hold the candidate on a fixed commit until you cut over.

```bash
# 1. Build candidate stable container on temporary host ports.
scripts/luna-container-create \
  --profile stable \
  --name luna-stable \
  --repo git@github.com:fourcolors/luna.git \
  --branch master \
  --repo-path /root/luna/stable/repo \
  --state-path /root/.luna \
  --host jax-box \
  --host-ws-port 6753 \
  --host-control-port 6754 \
  --skip-clone

# 2. Verify candidate without touching the host stable service.
curl -fsS http://127.0.0.1:6753/healthz
luna chat --url ws://jax-box.local:6753/ui

# 3. Cut over the stable ports during a short maintenance window.
systemctl --user status luna-chat-server.service --no-pager || true
systemctl status luna-chat-server.service --no-pager || true
if systemctl --user list-unit-files luna-chat-server.service --no-legend 2>/dev/null | grep -q '^luna-chat-server.service'; then
  printf 'user\n' > /root/.luna/stable-host-service-scope
  systemctl --user stop luna-chat-server.service
  systemctl --user disable luna-chat-server.service
elif systemctl list-unit-files luna-chat-server.service --no-legend 2>/dev/null | grep -q '^luna-chat-server.service'; then
  printf 'system\n' > /root/.luna/stable-host-service-scope
  systemctl stop luna-chat-server.service
  systemctl disable luna-chat-server.service
else
  echo "luna-chat-server.service not found as a user or system service" >&2
  exit 1
fi
incus config device remove luna-stable ws6753
incus config device remove luna-stable control6754
incus config device add luna-stable ws4753 proxy listen=tcp:0.0.0.0:4753 connect=tcp:127.0.0.1:4753 bind=host
incus config device add luna-stable control4754 proxy listen=tcp:0.0.0.0:4754 connect=tcp:127.0.0.1:4754 bind=host
incus restart luna-stable

# 4. Verify stable after cutover.
curl -fsS http://127.0.0.1:4753/healthz
curl -fsS http://jax-box.local:4753/healthz
```

Rollback restores the previous host stable service and removes the stable
container's production port proxies. If the durable scope file is missing,
inspect `systemctl --user status luna-chat-server.service` and
`systemctl status luna-chat-server.service`, then write `user` or `system` to
`/root/.luna/stable-host-service-scope` before rolling back.

```bash
incus config device remove luna-stable ws4753
incus config device remove luna-stable control4754
incus stop luna-stable
# Bring the host stable service back as stop -> settle -> start, NOT a fast
# `systemctl restart`: a fast restart can start the new chat-server before the
# outgoing one releases its DuckDB/SQLite WAL/SHM handles, crashing the boot with
# SQLITE_CANTOPEN. The 6s settle covers that lagging handle release.
case "$(cat /root/.luna/stable-host-service-scope 2>/dev/null || true)" in
  user)
    systemctl --user enable luna-chat-server.service
    systemctl --user stop luna-chat-server.service
    sleep 6
    systemctl --user start luna-chat-server.service
    ;;
  system)
    systemctl enable luna-chat-server.service
    systemctl stop luna-chat-server.service
    sleep 6
    systemctl start luna-chat-server.service
    ;;
  *)
    echo "Set /root/.luna/stable-host-service-scope to user or system before rollback" >&2
    exit 1
    ;;
esac
curl -fsS http://127.0.0.1:4753/healthz
```

## Dangerous Local Shell

Stable or dev containers can be created with `--enable-dangerous-local-shell` to write
`/root/.luna/allow-dangerous-local-shell` and
`LUNA_<PROFILE>_DANGEROUS_AUTO_APPROVE_LOCAL_SHELL=1` into the mounted
profile state. When the chat server starts with that marker, `LUNA_RUNTIME_SCOPE=incus-container`,
and a cwd under `/root/luna`, it attaches a per-thread container-local shell
binding automatically. Luna can then run shell commands in her own Incus
sandbox even when the operator is connected from a remote CLI or browser.

An attached Luna CLI can still expose the machine running that CLI with
`--local-shell`; explicit CLI bindings may replace the default server sandbox
binding for that thread.

The `/root/luna` cwd check is a guardrail against accidental request cwd
changes, not a filesystem sandbox. Commands still run as the chat server user
inside the Incus container and can use absolute paths available inside that
container.
Do not mount the host Incus socket or host SSH keys into `luna-stable` unless
you intentionally want to grant host-level control.

## Incus Settings

The container script uses:

```bash
incus init images:ubuntu/24.04/cloud luna-dev \
  --config security.nesting=true \
  --config boot.autostart=true \
  --config boot.autorestart=true
```

`security.nesting=true` is required for the current Bun/Vitest/server behavior
inside unprivileged Incus containers on jax-box. The containers stay
unprivileged; host bind mounts use `shift=true`.

Cloud-init is set before first start so the container can run
`scripts/luna-server-install` on first boot. Cloud-init runs once, so recreate
the container with `--replace` if the first-boot setup needs to be replayed.

## Safety Rules

- Do not auto-upgrade the T2 host kernel.
- Do not overwrite existing UI tokens unless using an explicit rotate flag.
- Do not destroy or reinstall an existing Incus instance unless `--replace` is
  passed. The create script treats an existing instance as an unchanged success.
- The auto-update timer is on by default; use `--no-auto-update` (or
  `deploy.autoUpdate = false`) when a channel must stay on a pinned commit.
- Prefer `0.0.0.0` for proxy listeners if the host must survive Tailscale being
  down at boot. The WebSocket server still requires a bearer token.
- Keep stable and dev state directories separate.

## Sources

- Incus initialization: https://linuxcontainers.org/incus/docs/main/howto/initialize/
- Instance creation: https://linuxcontainers.org/incus/docs/main/howto/instances_create/
- Cloud-init: https://linuxcontainers.org/incus/docs/main/cloud-init/
- Disk devices: https://linuxcontainers.org/incus/docs/main/reference/devices_disk/
- Proxy devices: https://linuxcontainers.org/incus/docs/main/reference/devices_proxy/
- Instance options: https://linuxcontainers.org/incus/docs/main/reference/instance_options/
