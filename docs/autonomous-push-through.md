# Autonomous Push-Through Workflow

The push-through workflow is a V2 scheduler job (`kind=workflow`) that turns one
queued workspace next_action per run into a pull request against `dev` — fully
unattended, but with the irreversible actions (push, PR) kept in deterministic
shell steps and only the code change delegated to a bounded agent.

It is installed by [`apps/ui-web/scripts/push-through-install.ts`](../apps/ui-web/scripts/push-through-install.ts)
and runs under the `JobTicker` (the only scheduler).

## Why a workflow (not a prompt) job

The earlier `kind=prompt` push-through was wired to `mcp__local_shell__*`, which
proxies to an **attached** terminal client. The scheduler fires jobs with no
client attached, so it could never run a shell headless. This workflow runs its
shell steps directly in the chat-server process instead, and the dedup gate is
enforced structurally rather than relying on the agent to remember it.

## Pipeline (linear, `halt_on_failure = true`)

### 0. Select + isolate
- Pick the highest-priority open action:
  `SELECT id FROM next_actions WHERE status='todo' ORDER BY priority DESC, created_at ASC LIMIT 1`.
  If none, the run halts (`NO_OPEN_ACTIONS`) — a cheap idle heartbeat that spends
  no model tokens.
- Acquire an atomic `mkdir` lock (with a staleness-reclaim window) so two
  overlapping runs can't stomp the shared worktree. Acquired *after* the no-work
  check, so idle ticks never contend on it.
- Check out a fresh per-action branch `auto/na-<id>` in a dedicated worktree
  (`/root/luna-auto`, off `origin/dev`), reset clean, and record the selected id
  in a sidecar file. The live repo the server boots from (`/root/luna`) has its
  working tree and branch left untouched (the only write is the idempotent
  `git worktree add` registration).

### 1. Implement (commit-only)
A bounded agent (`allowed_tools` = Bash + memory + observability only; modest
`max_turns`) reads the **locked id from the sidecar** and implements exactly that
one action inside the worktree, staging only the files it changed and committing
there. It does **not** push or open a PR.

### 2. Dedup gate + confinement backstops
Before anything irreversible, all of these must hold or the run halts (releasing
the lock):
- the branch matches `auto/na-*` and is not the base branch;
- the live repo's tracked tree is clean (the agent didn't mutate `/root/luna`);
- `git cherry origin/dev HEAD` reports new (`+`) commits — i.e. the work isn't
  already merged;
- the diff trips no secret-scan;
- `gh pr list --head <branch>` shows no open PR for this branch.

The `git cherry` + open-PR pair is the dependency-free port of
`@luna/adapter-sdk`'s `guardShip`: `git cherry` catches already-merged work, the
open-PR check catches an unmerged re-run of the same action.

### 3. Push + open PR
Push the branch (`--force-with-lease`, so a non-fast-forward left by a prior
crashed run can't wedge the action), open a PR against `dev`, mark the action
`status='doing'` so the next tick doesn't redo it, and release the lock.

## Prerequisites
- The V2 ticker running (it is the only scheduler) so it fires the job.
- `HOME` set on the systemd unit (e.g. `Environment=HOME=/root`) so `git`/`gh`
  find their credentials in the worker's process environment.
- A git worktree at `/root/luna-auto` (step 0 self-heals it if missing).
- A GNU/coreutils host (the lock's staleness reclaim uses `stat -c %Y`). The
  deploy target is Linux; the install host's OS is irrelevant.

## Install / arm
```sh
# install disabled (default)
bun run apps/ui-web/scripts/push-through-install.ts
# install and arm on the */30 schedule
bun run apps/ui-web/scripts/push-through-install.ts --enable
# replace an existing job (e.g. swap the legacy prompt job)
bun run apps/ui-web/scripts/push-through-install.ts --force
# remove
bun run apps/ui-web/scripts/push-through-install.ts --uninstall
```

By default it installs **disabled**; arming an unattended pusher is a deliberate
operator action. With no open next_actions the pipeline is a clean no-op, so even
when armed it does nothing until work is seeded (by the wake reasoner's Path-B
filing or by the operator).

## Known limits / fast-follows
- ~~The workflow-worker's prompt step has no wall-clock timeout and the V2
  ticker dispatches inline on a single fiber, so a hung agent turn can stall
  other V2 jobs.~~ Resolved: prompt steps carry a `timeout_ms` (default
  10 min), the ticker enforces a per-dispatch backstop deadline (workflow
  kind default 20 min + grace) that interrupts a hung dispatch, and due jobs
  dispatch with bounded concurrency (default 4) so one slow job no longer
  stalls the tick (see SYSTEM.md "Deadlines, retries & concurrency").
  Shell steps are also abort-wired to their dispatch (issue #277): an
  interrupted or timed-out step kills its whole process group, so a hung
  command - or a grandchild like `ssh` under `git push` - cannot outlive the
  run and race a retry (previously only this workflow's own lock guarded
  that).
- No per-action attempt cap: an action the agent can never complete is
  re-selected each cycle. Recommended fast-follow: an attempt counter that flips
  a stuck action to `status='blocked'`.
- Agent confinement to the worktree is enforced by the step-2 backstops, not by
  sandboxing the agent's shell; a direct push to `master` by the agent is bounded
  only by branch protection on `master`.
