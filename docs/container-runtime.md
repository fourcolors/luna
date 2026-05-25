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
