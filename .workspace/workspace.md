# Luna — development workspace

This is the workspace for Luna's own development: improving the agent
framework itself. When Luna is working *on* Luna, this is where she
operates.

The repo at this path *is* the codebase. The `workspace.db` here is
scoped to development activity — open issues, ongoing decisions, design
notes — not to anything in Luna's runtime state (that's `~/.luna/`).

## Vocabulary

- **PR / pull request** — a GitHub pull request against `dev` or
  `master`. Targets `dev` for normal work; only promote to `master`
  after dev smoke-tests clean.
- **Issue** — a GitHub issue in `fourcolors/luna`. Numbered, e.g. `#17`.
- **Phase** — a coarse milestone band (Phase 25e, Phase 27a, etc.). Used
  inline in code comments and commit messages to anchor when something
  shipped. New work doesn't need a phase number unless it's continuing
  an existing band.
- **Channel** — a runtime deployment. Two exist: `dev` (branch `dev`)
  and `stable` (branch `master`), each served by its own chat-server on
  the deploy host. "Promote" means dev → master + redeploy stable.
- **Container** — the OS container that can host a channel's chat-server.
  The dev channel runs inside one; stable runs host-direct.
- **DNA / SYSTEM** — `DNA.md` (identity) and `SYSTEM.md` (mechanics),
  both loaded into every thread's system prompt. Source of truth for
  who Luna is and how her runtime is organized.
- **Subagent** — a `.md` file under `~/.luna/agents/` (global) or
  `.workspace/agents/` (scoped) that Luna can consult.

## Entities

The workspace's brain (`workspace.db`) tracks development entities.
v1 schema is intentionally empty — add tables as concrete needs appear,
don't pre-design.

**The `workspace.db` file does not exist on disk until something opens
it.** That is the correct state for v1, not a missing-file bug. The
first time code (or `sqlite3` from the shell) opens it, bun:sqlite
creates the file and the first migration adds the first table.

Expected first entrants when they're actually useful:

- **decisions** — non-obvious design calls worth re-finding by topic.
  Likely shape: `id`, `topic`, `decision`, `rationale`, `created_at`,
  `pr_url?`.
- **followups** — work that's been noticed but isn't tracked in GitHub
  Issues yet. Promote to an issue when it's ready to be filed.
- **deploy_log** — one row per dev/stable deploy: `channel`, `commit`,
  `at`, `outcome` (clean / rollback / footgun).

Issues themselves live in GitHub, not here. Don't duplicate that table.

## Processes

### Standard ship loop

1. Branch off `origin/dev` with a descriptive name (`feat/...`, `fix/...`).
2. Decompose the change into small lockable pieces. Each piece ends with
   a passing test or a clear verifiable outcome.
3. Typecheck (`bun run typecheck`) and the affected vitest suites green.
4. Push, open a PR against `dev`. CI runs typecheck + tests.
5. Merge to `dev`, then deploy the dev channel: pull the new commit on
   the deploy host's dev checkout, run `bun install` only when
   `bun.lock` changed (inside the container if `node_modules` is
   container-local), then `scripts/restart-channel.sh dev` — a guarded
   restart that refuses if a WebSocket session is connected to the dev
   channel, so Luna doesn't silently delete the chat thread she is
   running in. Pass `--yes` to accept the kill when you intentionally
   want to restart through your own active session (issue #24). The
   script tails the journal and curls `/healthz`; the service shows
   `active` even when a boot exception is crash-looping, so the journal
   output is the real signal. (Exact host, paths, container, and
   service names are operator-specific and live in the local deploy
   runbook — intentionally kept out of this public, prompt-injected doc.)
6. Smoke-test via `luna chat --dev`. Verify the new behavior end-to-end.
7. **Stop and wait for operator approval** before promoting to master.
   Operator sometimes wants to live with dev for a beat first.
8. Promote: fast-forward `master` → `dev`, push, pull the new commit on
   the host's stable checkout, then `scripts/restart-channel.sh stable`
   (with `--yes` if and only if the operator has consented to ending
   their stable chat session first). Stable runs host-direct, no
   container prefix.

### First-time workspace registration on a new channel

A fresh `luna.db` has the `workspaces` table (the chat-server's
migration creates it at boot) but no rows. Until a row is registered,
the workspaces system-prompt inject (`workspaces-loader`) returns
`null` and Luna's context window has no inlined `workspace.md`.

To register the `luna` workspace on a freshly-deployed channel, run the
bootstrap script against that channel's `~/.luna/luna.db`, pointing
`--path` at that channel's repo checkout:

```bash
bun run scripts/bootstrap-workspace.ts --slug luna --path <channel-repo-path>
```

For the containerized dev channel, exec into the container first so the
path resolves to its bind-mounted repo. The script is idempotent:
re-running updates the row in place (preserving `created_at`, refreshing
`updated_at` and `summary` from the current `workspace.md`'s first
paragraph). Restart the chat-server afterwards to pick the row up in the
next thread's system prompt.

### Filing follow-ups

When work surfaces a side-quest that isn't worth doing in the current
PR, file a GitHub issue immediately with reproduction steps and a
recommended option. Don't trust working memory to retain it.

### Observability discipline

Every substantive thread:
- `obs_note kind=goal_declared` immediately after operator states intent.
- `obs_note kind=decision` when picking between non-obvious options.
- `obs_note kind=progress` at each verifiable milestone (committed,
  deployed, tested).
- `obs_note kind=reflection` at session end.

Without these, the next thread can't reconstruct what got done.

## Pointers

Concrete deploy coordinates — hostnames, filesystem paths, container
names, ports, and service-unit names — are operator-specific and are
**intentionally kept out of this doc**, since it's tracked in a public
repo and injected verbatim into Luna's system prompt. They live in the
operator's local deploy runbook.

What's safe to know here is the *shape*:

- **Two channels** run on the deploy host: `dev` (branch `dev`) and
  `stable` (branch `master`). Each exposes a WebSocket chat-server.
- **Dev is containerized.** Its repo is bind-mounted from the host into
  an OS container, so the *same* files have two paths: a host POV (where
  deploys land and `git pull` runs) and a container POV (where dev-Luna
  introspects her own filesystem). When dev-Luna reports a repo path
  that differs from the host's, that's the bind-mount indirection, not
  a bug.
- **Stable is host-direct** — one POV, no container indirection.
- **Restarts go through `scripts/restart-channel.sh <dev|stable>`**, the
  guarded path that won't kill an active chat session unless `--yes`.

**GitHub:** `fourcolors/luna`.
