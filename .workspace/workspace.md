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
- **Channel** — a runtime deployment. Two exist: `dev` (port 5753 on
  jax-box, branch `dev`) and `stable` (port 5754 on jax-box, branch
  `master`). "Promote" means dev → master + redeploy stable.
- **Container** — the incus container hosting a channel's chat-server
  on jax-box.
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
5. Merge to `dev`. Deploy to luna-dev container on jax-box:
   - `ssh root@jax-box "cd /root/luna/dev/repo && git pull --ff-only"`
   - `bun install` (only when lockfile changed)
   - `systemctl restart luna-dev-chat-server.service`
6. Smoke-test via `luna chat --dev`. Verify the new behavior end-to-end.
7. **Stop and wait for operator approval** before promoting to master.
   Operator sometimes wants to live with dev for a beat first.
8. Promote: fast-forward `master` → `dev`, push, pull on jax-box's
   stable repo, restart `luna-chat-server.service`. **Warning:**
   restarting stable kills any active operator session connected via
   the stable channel. Tell the operator before doing this.

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

Two channels run on jax-box. The dev channel runs inside an incus
container (`luna-dev`); the stable channel runs directly on the host.
Paths therefore depend on whose POV is asking.

**Host POV (where deploys land, where you run `git pull` for a channel):**

- Dev repo:     `/root/luna/dev/repo`     (cloned from `origin/dev`).
- Stable repo:  `/root/luna/stable/repo`  (cloned from `origin/master`).
- Dev `~/.luna`:    `/root/.luna-dev/` (bind-mounted into the container).
- Stable `~/.luna`: `/root/.luna/`     (the host's own; stable runs as root on the host).

**Dev container POV (where dev-Luna sees her filesystem):**

- Repo:       `/root/luna/`  (bind-mount of host `/root/luna/dev/repo`).
- `~/.luna/`: `/root/.luna/` (bind-mount of host `/root/.luna-dev/`).

So when dev-Luna says her repo is at `/root/luna`, she is correct — that
is the same physical files as the host's `/root/luna/dev/repo`. The
deploy commands target the host paths; introspection from inside the
container targets the container paths.

**Stable POV** is identical to host POV (no container indirection).

**Ports + services:**

- Dev:    port `5753`, `luna-dev-chat-server.service` (inside the
  `luna-dev` container — restart via `incus exec luna-dev -- systemctl
  restart luna-dev-chat-server.service`).
- Stable: port `5754`, `luna-chat-server.service` (on the host —
  restart via `systemctl restart luna-chat-server.service`).

**GitHub:** `fourcolors/luna`.
