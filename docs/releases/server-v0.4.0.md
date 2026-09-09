# Server v0.4.0

First server release since `server-v0.3.0` (2026-07-25). It covers 383 commits,
258 of which touch server code. No wire-protocol change: `UI_WS_PROTOCOL_VERSION`
is 2 in both releases, so existing Moon clients keep working.

## ⚠️ Read this before you update

**Hosts installed at or before `server-v0.3.0` must re-render their systemd unit
first, or the update will fail and roll back.**

The supervisor unit changed shape during this window. It used to name an
app-specific subdirectory that no longer exists in the repo:

| | v0.3.0 | v0.4.0 |
|---|---|---|
| `WorkingDirectory` | `<repo>/apps/ui-web` | `<repo>` |
| `ExecStart` | `bun run scripts/chat-server.ts` | `bun run scripts/luna-chat-server-entry.ts` |

A systemd unit is host-persistent state. It is not shipped in the repo, so
nothing in the v0.3.0 update engine re-renders it, and the update engine that
runs your 0.3.0 → 0.4.0 hop is the *old* engine already on your disk. That is why
this step can only travel as prose.

Run this **before** `luna update`:

```bash
scripts/luna-server-install --units-only --profile stable
```

`--units-only` re-renders the supervisor and pager units only. It never touches
your `.env`, never reinstalls dependencies, never migrates state, and does not
restart the service. It writes a `.prev` backup of the unit it replaces.

**If you skip it:** `luna update` fetches, resets the checkout, and restarts.
systemd then cannot `chdir` into the missing `apps/ui-web` (status=200),
readiness times out after 60s, and the engine auto-rolls-back. The failure is
safe — you end up back on v0.3.0 — but it costs roughly 90 seconds of downtime
and repeats on every attempt until the unit is fixed.

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

**Deployment and supervision.** A per-profile releases layout with immutable
releases and an atomic flip, replacing automated `reset --hard`. Path-independent
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
