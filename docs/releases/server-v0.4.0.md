# Server v0.4.0

First server release since `server-v0.3.0` (2026-07-25).
`UI_WS_PROTOCOL_VERSION` remains 2; no wire-version bump is required.

## Read this before updating from v0.3.0

**Do not upgrade a v0.3.0 systemd installation directly to this release.**
There are two compatibility boundaries: the unit names the removed
`apps/ui-web/scripts/chat-server.ts`, and the old updater builds the removed
`@luna/ui-web` package. Running the v0.3.0 installer with `--units-only` merely
recreates the old unit. Using a newer installer before its launcher exists also
makes a restart or rollback fail.

Use the compatibility hops below for a **bare-host, in-place systemd install
at v0.3.0**. These SHAs retain the artifacts needed by the preceding updater.
This sequence has been checked against the source; it still requires a staged
upgrade rehearsal before use on a production host. Older versions, launchd,
Incus, and releases-layout installations need a procedure adapted to their
existing supervisor and host/container paths; do not apply bare-host defaults
to them or downgrade a newer host to these bridge commits.

Before beginning, back up the database/state and installed units, ensure the
checkout has no local work, and arrange a maintenance window with no active
sessions. Pause existing guardian/autodeploy timers and branch auto-update for
all hops, recording their previous settings. Otherwise automation can advance
past a bridge before its unit is reconciled. Keep the same profile, repo path,
state path, and any custom service/port options throughout.

The examples use the standard stable bare-host paths. Run with the privileges
used for the original installation, and stop on any failed command or unhealthy
readiness result:

```bash
set -euo pipefail
UPGRADE_REPO=/root/luna
UPGRADE_STATE=/root/.luna
UPGRADE_PROFILE=stable

# 1. The old engine can build this tree; the old unit still boots it.
"$UPGRADE_REPO/scripts/luna-update-server" \
  --profile "$UPGRADE_PROFILE" --repo-dir "$UPGRADE_REPO" \
  --luna-home "$UPGRADE_STATE" \
  --ref c484d696b4b62998a75098fc3a423f1b2def42ad
test "$(git -C "$UPGRADE_REPO" rev-parse HEAD)" = "c484d696b4b62998a75098fc3a423f1b2def42ad"

# 2. Now the installed bridge has BOTH the old entrypoint and new launcher.
"$UPGRADE_REPO/scripts/luna-server-install" \
  --profile "$UPGRADE_PROFILE" --repo-dir "$UPGRADE_REPO" \
  --luna-home "$UPGRADE_STATE" --units-only --no-enable --no-start
systemctl cat luna-chat-server.service
# Confirm WorkingDirectory=/root/luna and
# ExecStart=<bun> run scripts/luna-chat-server-entry.ts before restarting.
```

The bridge installer preserves `.env` and dependencies, does not restart, and
backs up replaced units as `.prev`. After confirming the rendered paths:

```bash
systemctl restart luna-chat-server.service
curl --fail --silent --show-error http://127.0.0.1:4753/readyz
```

Require a healthy response reporting the bridge SHA before continuing. If
reconciliation fails, restore the saved unit and reload systemd while still at the bridge;
do not advance. Do not roll back to v0.3.0 with the new unit still installed,
because v0.3.0 lacks its launcher.

```bash
# In the same configured shell, after the bridge restart is healthy:
# 3. This tree still has the SPA the bridge engine builds, but its own
# updater no longer requires that SPA for subsequent upgrades.
"$UPGRADE_REPO/scripts/luna-update-server" \
  --profile "$UPGRADE_PROFILE" --repo-dir "$UPGRADE_REPO" \
  --luna-home "$UPGRADE_STATE" \
  --ref 775ee6614bb67692bbef9c40063e9af479e7e7db
test "$(git -C "$UPGRADE_REPO" rev-parse HEAD)" = "775ee6614bb67692bbef9c40063e9af479e7e7db"

# 4. Invoke the now-installed updater for the final hop.
"$UPGRADE_REPO/scripts/luna-update-server" \
  --profile "$UPGRADE_PROFILE" --repo-dir "$UPGRADE_REPO" \
  --luna-home "$UPGRADE_STATE" --ref server-v0.4.0
test "$(git -C "$UPGRADE_REPO" rev-parse HEAD)" = "$(git -C "$UPGRADE_REPO" rev-parse server-v0.4.0^{commit})"
```

Each updater hop must pass its readiness check. If it defers or fails, leave
subsequent steps pending and inspect the reported state. Restore the previous
automation settings only after verifying the final release and its supervision.
A failed update can fail during the obsolete SPA build before restarting, or
at service startup due to stale paths. Rollback is attempted, but is not a
guarantee of recovery or a fixed downtime duration.

## Also worth knowing

- **Rollback needs a reachable package registry.** The rollback path re-runs
  `bun install --frozen-lockfile`, and the lockfile has moved over six weeks. If
  the registry is unreachable during a failed update, the service can stay down
  and need manual recovery. Update when you can reach npm.
- **Legacy autodeploy timers self-adopt the guardian.** A host still running a
  legacy timer that lands on this release will run `luna-guardian adopt`, which
  installs the guardian into `/usr/local/lib` and retires the legacy timer. This
  is a change in how your server is supervised. Expect it, or install the
  guardian deliberately beforehand.

## Highlights

**Deployment and supervision.** Support for a per-profile releases layout
with immutable releases and an atomic flip. Existing in-place installations
stay in-place until an operator performs the separate
[layout migration](https://github.com/fourcolors/luna/blob/server-v0.4.0/docs/deploy-layout-migration.md). Path-independent
units with a TypeScript launcher and unit-render rollback. The guardian gains
tri-state probe classification with persisted K-of-N debounce, postconditions on
every mutation, silent converged ticks, and a hermetic test harness. Session
guard is now a restart primitive, with `--force` reserved for humans.

**Reliability.** Credit-exhaustion refusals now classify correctly, so a drained
account is benched and traffic fails over instead of looping on the same refusal
(#625). Restart-aware orphan accounting stops clean shutdowns from polluting the
doctor streak. Job outcome-health predicates and staleness alerting landed under
ADR 0001, alongside mechanical freshness stamps on injected context.

**Channels.** A fail-closed Discord adapter, ported to Effect 4 and wired into
boot (#605, #611).

**Agents.** An agent sidebar with `@` mentions and agent-grouped threads, plus
agent participation views. Account management from Moon. SDK bumped to 0.3.257.

**Contracts.** A `luna.db` schema-continuity contract with a CI assertion, and a
`defineToolPackage` factory for tool packages.

## Migrations

All schema changes in this window are additive and ledgered per component in
`schema_versions`. They apply automatically at boot, forward-only. No manual
migration step is required.

## Verifying the update

```bash
systemctl status luna-chat-server        # active, no chdir errors
luna doctor                              # clean
```

Your server version is reported by `control.version`, sourced from
`server.version.json`.
