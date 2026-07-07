# Auto-deploy (`luna-autodeploy`)

`scripts/luna-autodeploy` is the pull-based deploy **trigger** that closes the
"merged PR → running server" gap. GitHub can't reach jax-box (Tailscale) and CI
can't reach jax-box, so the box polls GitHub: a systemd timer checks the upstream
branch and, when it has **moved**, runs the existing `scripts/luna-update-server`
(fetch → `reset --hard` → conditional `bun install` → restart → `/healthz`+`/readyz`
readiness probe → **auto-rollback** on failure).

It's a thin, safe wrapper — all the deploy/rollback logic lives in
`luna-update-server`; `luna-autodeploy` only decides *whether* to deploy:

- **No-op when unchanged** — if the channel is already at `origin/<branch>` it
  exits 0 quietly, so a frequent timer only ever restarts the server when the
  branch actually moved.
- **Connect-aware** — by default it **defers** (exit 0, retry next tick) when the
  channel has active WebSocket sessions, so it never drops you mid-conversation.
  `--allow-active` / `--force` override — and are never baked into a timer unit.
- **Auditable** — every run logs to the unit journal:
  `journalctl -u luna-autodeploy-stable.service`.

## Auto-update is ON by default

Both channels ship with an auto-update timer (owner decision 2026-07; this
supersedes the earlier manual-only stable policy). A timer run only ever
restarts the server when the branch moved **and** the channel is idle — the
connect-aware deferral is the safety mechanism for the daily driver.

| Channel | Repo (host) | Branch | Target | Cadence |
|---|---|---|---|---|
| `dev` | `/root/luna/dev/repo` | `dev` (registry `deploy.trackBranch`) | incus container `luna-dev` (:4753) | every **3min** |
| `stable` | `/root/luna/stable/repo` | `master` | incus container `luna-stable` (:4753) | every **15min** |

Stable's 15min cadence trades update latency for calm: `master` moves far less
often than `dev`, and a quarter-hour worst-case lag is invisible for a daily
driver while cutting GitHub polling and restart pressure 5×.

Repos and branches come from the registry (`/etc/luna/servers.toml`, seeded
from `scripts/seeds/servers.toml`); `LUNA_DEV_BRANCH` / `LUNA_STABLE_BRANCH`
env overrides win when set (e.g. staging a feature branch or a `moon-v*` tag
on dev).

Provisioning installs the timer automatically: `scripts/luna-container-create`
seeds `/etc/luna/servers.toml` from `scripts/seeds/servers.toml` when absent
and runs `luna-autodeploy install-timer <profile>` at the end of a successful
create (skip with `--no-auto-update`).

The timer unit's `ExecStart` carries `--from-timer`, which marks the run as
machine-initiated. That flag does exactly two things: it makes the run respect
the `deploy.autoUpdate` knob, and nothing else — deferral, rollback, and exit
codes behave exactly like a manual run.

## Opting out

Two levers, in order of reach:

1. **Knob off (timer stays installed, runs no-op):** set
   `deploy.autoUpdate = false` in the channel's `[[server]]` stanza in
   `/etc/luna/servers.toml`. Every timer tick then exits 0 with
   `auto-update is OFF` in the journal. Absent key = `true` — auto-update is
   the default, the opt-out is explicit.
2. **Remove the timer entirely:** `luna-autodeploy uninstall-timer stable`.

Manual one-command deploys (`luna-autodeploy stable`) always work regardless of
the knob — typing the command is the consent the knob exists to gate.

The registry's `deploy.timer` key remains the hard rail: `install-timer`
refuses any profile whose stanza says `deploy.timer = false` (enforced in code,
checked by `luna-doctor`). The `LUNA_REGISTRY_DISABLE=1` hardcoded fallback
still disallows a stable timer — it encodes the legacy bare-host topology;
default-on auto-update is a registry-path policy.

## Usage

```sh
# deploy a channel now if its branch moved (no-op otherwise)
luna-autodeploy dev
luna-autodeploy stable                  # manual one-command deploy (always works)

# flags
luna-autodeploy dev --dry-run           # show what it would do
luna-autodeploy stable --allow-active   # deploy even if sessions are connected
luna-autodeploy dev --force             # bypass the no-op + connect-aware checks

# timers (interval defaults to the registry's deploy.timerInterval:
# dev 3min, stable 15min)
luna-autodeploy install-timer stable
luna-autodeploy install-timer dev --interval 3min
luna-autodeploy uninstall-timer stable
```

The timer's `ExecStart` points at the copy of the script that installed it;
the pinned-copy engine quarantine (F11) protects a mid-run deploy from
rewriting the engine underneath itself.

## Exit codes
`0` = up-to-date / deferred / knob-off no-op / deployed-clean · `1` = update
failed but rolled back · `2` = bad usage or CRITICAL (rollback also failed —
needs attention).

## Check status
```sh
systemctl list-timers 'luna-autodeploy-*.timer'
journalctl -u luna-autodeploy-stable.service -n 30
journalctl -u luna-autodeploy-dev.service -n 30
```
