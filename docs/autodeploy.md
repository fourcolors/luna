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
  `--allow-active` / `--force` override.
- **Auditable** — every run logs to the unit journal:
  `journalctl -u luna-autodeploy-dev.service`.

## Channels (jax-box topology)

| Channel | Repo (host) | Branch | Target | Mode |
|---|---|---|---|---|
| `dev` | `/root/luna/dev/repo` | `$LUNA_DEV_BRANCH` (no default) | incus container `luna-dev` (:4753) | **auto** (timer) |
| `stable` | `/root/luna/stable/repo` | `master` | bare-host system unit (:4753) | **one-command** (manual) |

The `dev` profile has no default branch — the `dev` git branch is gone. Set
`LUNA_DEV_BRANCH` to a real ref (a feature branch or a `moon-v*` tag) to stage
it, or disable the dev timer (`luna-autodeploy uninstall-timer dev`) when nothing
is staged. **Stable is deliberately one-command** — the daily driver must never
restart unexpectedly.

## Usage

```sh
# deploy a channel now if its branch moved (no-op otherwise)
luna-autodeploy dev
luna-autodeploy stable                  # the operator's one-command stable deploy

# flags
luna-autodeploy dev --dry-run           # show what it would do
luna-autodeploy stable --allow-active   # deploy even if sessions are connected
luna-autodeploy dev --force             # bypass the no-op + connect-aware checks

# dev timer (every 3 min by default)
luna-autodeploy install-timer dev --interval 3min
luna-autodeploy uninstall-timer dev
```

The timer's `ExecStart` points at the **stable** repo's copy of the script
(`/root/luna/stable/repo/scripts/luna-autodeploy`) so a dev deploy can't rewrite
the tool that's mid-run.

## Exit codes
`0` = up-to-date / deferred / deployed-clean · `1` = update failed but rolled back
· `2` = bad usage or CRITICAL (rollback also failed — needs attention).

## Check status
```sh
systemctl list-timers luna-autodeploy-dev.timer
journalctl -u luna-autodeploy-dev.service -n 30
```
