# Auto-deploy (`luna-autodeploy`)

`scripts/luna-autodeploy` is the pull-based deploy **trigger** that closes the
"merged PR → running server" gap. GitHub can't reach jax-box (Tailscale) and CI
can't reach jax-box, so the box polls GitHub: a systemd timer checks the upstream
branch and, when it has **moved**, runs the existing `scripts/luna-update-server`
(fetch → `reset --hard` → conditional `bun install` → restart → `/healthz`+`/readyz`
readiness probe → **auto-rollback** on failure).

It's a thin, safe wrapper — all deploy/rollback logic lives in
`luna-update-server`; `luna-autodeploy` decides whether to deploy and lets an
eligible legacy host hand control to the guardian:

- **No-op when unchanged** — if the channel is already at `origin/<branch>` it
  exits 0 quietly, so a frequent timer only ever restarts the server when the
  branch actually moved.
- **Connect-aware** — by default it **defers** (exit 0, retry next tick) when the
  channel has active WebSocket sessions, so it never drops you mid-conversation.
  `--allow-active` / `--force` override — and are never baked into a timer unit.
- **Auditable** — every run logs to the unit journal:
  `journalctl -u luna-autodeploy-stable.service`.

## Guardian is the default host control plane

New installs run `luna-guardian-<profile>.timer` (one-minute checks). The
guardian is pinned under `/usr/local/lib/luna-guardian`, outside the mutable
channel checkout. It verifies the unit, `/healthz`, `/readyz`, and the exact
build SHA; captures redacted incident bundles; resumes interrupted update
transactions; reconciles unit drift while idle; and invokes the same rollback
engine described below. After a new Luna SHA passes deep health, the guardian
installs that checkout's engine into a new immutable directory and atomically
advances its own pin. systemd's in-process watchdog remains responsible for
sub-minute hang detection.

`luna-guardian adopt <profile>` verifies that no update transaction is pending
and that the running normal-mode build exactly matches checkout HEAD before it
pins the engine and hands off systemd ownership. It enables and proves the
guardian first, then disables and removes the older updater-only timer. A legacy
timer automatically calls this interface on its next safe tick; adoption still
runs when `deploy.autoUpdate=false` because health/repair is independent of
branch movement. A host whose checkout predates the guardian and already has
`deploy.autoUpdate=false` needs one manual checkout update before that migration
code exists locally; after that, the next legacy tick adopts without moving the
configured branch.

Existing hosts can migrate immediately without interrupting Luna:

```sh
scripts/luna-guardian adopt stable
scripts/luna-guardian adopt dev
```

Adoption exits `10` when a pending transaction or runtime/checkout mismatch
makes the mutable checkout unsafe. The legacy timer remains in place and retries.
Hard handoff failures are nonzero and can never print an adopted result.

## Auto-update is ON by default

Both channels ship with an auto-update timer (owner decision 2026-07; this
supersedes the earlier manual-only stable policy). A timer run only ever
restarts the server when the branch moved **and** the channel is idle — the
connect-aware deferral is the safety mechanism for the daily driver.

| Channel | Repo (host) | Branch | Target | Cadence |
|---|---|---|---|---|
| `dev` | `/root/luna/dev/repo` | `dev` (registry `deploy.trackBranch`) | incus container `luna-dev` (:4753) | guardian every **1min** |
| `stable` | `/root/luna/stable/repo` | `master` | incus container `luna-stable` (:4753) | guardian every **1min** |

The one-minute cadence is a health cadence, not a restart cadence: unchanged
branches are no-ops and connected sessions defer updates. The legacy
updater-only timer retains its registry-configured 3min/15min defaults when an
operator explicitly installs it instead of the guardian.

Repos and branches come from the registry (`/etc/luna/servers.toml`, seeded
from `scripts/seeds/servers.toml`); `LUNA_DEV_BRANCH` / `LUNA_STABLE_BRANCH`
env overrides win when set (e.g. staging a feature branch or a `moon-v*` tag
on dev).

Provisioning installs the guardian automatically: `scripts/luna-container-create`
seeds `/etc/luna/servers.toml` from `scripts/seeds/servers.toml` when absent
and runs `luna-guardian install <profile>` at the end of a successful
create (skip with `--no-auto-update`).

The guardian timer starts its pinned `check` interface; that interface invokes
the pinned updater with `--from-timer`. The flag makes branch movement respect
`deploy.autoUpdate` and grants no restart override — connect-aware deferral and
rollback behave exactly like a manual run.

## Opting out

Two levers, in order of reach:

1. **Branch movement off (guardian health stays on):** set
   `deploy.autoUpdate = false` in the channel's `[[server]]` stanza in
   `/etc/luna/servers.toml`. Every timer tick still checks and repairs health;
   its updater exits 0 with `auto-update is OFF` instead of moving the branch.
   Absent key = `true` — auto-update is the default, the opt-out is explicit.
2. **Remove the guardian entirely:** `luna-guardian uninstall stable`.

Manual one-command deploys (`luna-autodeploy stable`) always work regardless of
the knob — typing the command is the consent the knob exists to gate.

The registry's `deploy.timer` key remains the hard rail: both guardian install
and legacy `install-timer` refuse profiles whose stanza says
`deploy.timer = false`; an already-running guardian removes its own units on the
next check (enforced in code, checked by `luna-doctor`). The
`LUNA_REGISTRY_DISABLE=1` hardcoded fallback still disallows a stable timer —
it encodes the legacy bare-host topology; default-on auto-update is a
registry-path policy.

## Usage

```sh
# deploy a channel now if its branch moved (no-op otherwise)
luna-autodeploy dev
luna-autodeploy stable                  # manual one-command deploy (always works)

# flags
luna-autodeploy dev --dry-run           # show what it would do
luna-autodeploy stable --allow-active   # deploy even if sessions are connected
luna-autodeploy dev --force             # bypass the no-op + connect-aware checks

# guardian (default control plane; one-minute deep-health cadence)
luna-guardian adopt stable
# human release attestation — the SAME status-file evidence the guardian's own
# engine-pin promotion gate consumes (see "Engine-pin promotion" below)
luna-guardian accept stable --expected-sha <full-sha> --min-cycles 2
luna-guardian diagnose stable           # capture a redacted incident bundle now
luna-guardian uninstall stable

# legacy updater-only timers (interval defaults to deploy.timerInterval:
# dev 3min, stable 15min). Do not run alongside the guardian.
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
systemctl list-timers 'luna-guardian-*.timer'
journalctl -u luna-guardian-stable.service -n 30
journalctl -u luna-guardian-dev.service -n 30
cat /var/lib/luna-guardian/status-stable
```

The status file is written atomically after every guardian run and records the
checkout SHA, pinned engine SHA, outcome, completion time, consecutive fully
healthy count, and the consecutive runtime-proof count
(`consecutive_runtime_healthy` — healthy runtime at the CHECKOUT sha, counted
even while the engine pin lags behind a fresh deploy). Deferred unit
reconciliation never increments the fully-healthy count. This is also the
heartbeat surface for an off-host dead-man monitor; a host cannot report its
own total failure or a disabled timer.

### Engine-pin promotion (accept-grade, automatic)

`accept` is the human attestation; the guardian's OWN engine pin now
self-promotes only on accept-grade stored evidence. A new checkout sha must
first accumulate `LUNA_GUARDIAN_PROMOTE_MIN_CYCLES` (default 2, accept parity;
`0` disables the gate entirely; otherwise clamped to 2..10 with invalid values
falling back to 2) consecutive runtime-proven ticks in the status file — read
through the same verifier `accept` uses — before `refresh_guardian_if_needed`
advances the pin. Until then the tick logs one `promotion pending` line when
the candidate first appears (not per tick) and keeps running on the current
pin; deploys themselves are never delayed, only the supervisor's
self-upgrade. Repairs are unaffected: the repair ladder runs before the
post-repair refresh, so missing promotion evidence can never block a repair.
Manual `luna-guardian install <profile>` and `adopt` bypass the gate — typing
the command is the attestation. One AUTOMATED path shares the `adopt` bypass:
if the guardian timer unit file goes missing while the legacy `luna-autodeploy`
timer is still active, its migration step re-runs `luna-guardian adopt`, which
re-pins the engine to the current checkout after a single runtime proof (no
stored-evidence requirement) and resets the timer cadence to adopt's 1min
default. This is a deliberate disaster-recovery trade-off — re-establishing a
functioning control plane beats gating its bootstrap — but it means a host
restored from a pre-guardian backup can advance the pin without accept-grade
evidence on the next legacy tick.

Known bounded limitation: a guardian timer cadence longer than
`LUNA_GUARDIAN_HEALTH_WINDOW_SEC` (default 900s) reads every stored heartbeat
as stale and quietly starves auto-promotion; the escapes are a manual
`install` or `LUNA_GUARDIAN_PROMOTE_MIN_CYCLES=0`.

When deep health fails, the guardian captures a redacted incident bundle (git,
unit, `/readyz`, capacity, and journal snapshots with tokens/secrets stripped)
and logs its path. Bundles land under `/var/lib/luna-guardian/incidents/<profile>/`.
Capture one on demand with `luna-guardian diagnose <profile>`, which prints the
written bundle path:

```sh
scripts/luna-guardian diagnose stable
ls -t /var/lib/luna-guardian/incidents/stable/ | head
```

From another Tailscale machine, run the portable probe under cron or an alerting
runner (nonzero means page):

```sh
scripts/luna-guardian-remote-check root@jax-box stable \
  --expected-sha <full-sha> --max-age 180
```

It independently reads the Guardian service state and heartbeat over SSH, then
probes `/readyz`, requiring a fresh healthy attestation, at least two cycles,
and matching runtime/engine SHA. A service in systemd's `activating` state is a
bounded in-progress check, not a dead-man failure; `TimeoutStartSec=12min`
prevents that exception from hiding a hung Guardian. The pre-first-run window is
also suppressed: a freshly installed timer that is active but has never fired
reports a pending first cycle instead of paging on the absent heartbeat. Failed
or missing units, a timer that has already fired without writing a heartbeat,
and stale inactive heartbeats all still page immediately.

Flags: `--expected-sha <full-sha>` pins the accepted SHA, `--max-age <seconds>`
sets the heartbeat freshness bound (default 180, minimum 60), and `--ready-url
<url>` overrides the probed readiness endpoint (default
`http://<host>:4753/readyz`).
