/**
 * push-through-install — install (or update) the autonomous push-through V2
 * WORKFLOW job.
 *
 * This REPLACES the legacy `kind=prompt` push-through job, which could never run
 * headless: it was wired to `mcp__local_shell__*`, and `local_shell` proxies to
 * an ATTACHED terminal client (it needs a bound chat thread). The scheduler
 * fires jobs with no client attached, so the old job could not run any shell —
 * it spent cycles escalating "gh not logged in" because it was guessing, not
 * checking. See memory: self-improvement-loop / jax-box-deployment.
 *
 * The replacement is a `kind=workflow` job — a LINEAR, worktree-isolated,
 * dedup-gated pipeline. The irreversible actions (push, PR) live in
 * deterministic shell steps; only the code change is delegated to a bounded,
 * commit-only prompt step. Pipeline (halt_on_failure = true):
 *
 *   0. shell  — pick the top `todo` next_action from workspace.db; HALT (no-op)
 *               if none. Acquire an atomic worktree lock (AFTER the no-work
 *               check). Create a per-action branch `auto/na-<id>` in the
 *               dedicated worktree (off origin/dev), reset clean, and record the
 *               selected id in a sidecar file. NEVER touches the live repo's
 *               working tree or branch (the only write to the live repo is the
 *               idempotent `git worktree add` registration).
 *   1. prompt — the agent reads the LOCKED id from the sidecar and implements
 *               EXACTLY that next_action inside the worktree, then commits there.
 *               No push / no PR. Tight allowed_tools (Bash + memory + obs only —
 *               no scheduler, no local_shell), modest max_turns. Scoped `git add`
 *               (not `add -A`).
 *   2. shell  — DEDUP GATE + structural confinement backstops. All must hold or
 *               the run halts (and releases the lock): branch matches
 *               `auto/na-*`; HEAD is not the base; the live repo's tracked tree
 *               is clean (the agent didn't mutate /root/luna); `git cherry`
 *               reports new (`+`) commits vs origin/<base> (already-MERGED
 *               guard); the diff trips no secret-scan; `gh pr list` shows no
 *               OPEN PR for the head (unmerged same-action guard). The cherry +
 *               open-PR pair is the dependency-free port of `@luna/adapter-sdk`
 *               `guardShip` (PR #70).
 *   3. shell  — push (`--force-with-lease`, bare so `set -e` catches a failure —
 *               dash has no `pipefail`; also recovers a branch stranded by a
 *               prior push-ok/pr-fail run) + `gh pr create` against <base>; on
 *               success mark the next_action `status='doing'` and release the
 *               lock.
 *
 * PREREQUISITES (all true on luna-dev as of 2026-06-08):
 *   - V2 scheduler running (the only scheduler) so the ticker fires it.
 *   - `Environment=HOME=/root` on the unit so gh/git find creds in the worker's
 *     process env (proven via worker-path diagnostics).
 *   - A git worktree at LUNA_PUSH_THROUGH_WORKTREE. Step 0 self-heals it with an
 *     idempotent `git worktree add` if missing.
 *   - A GNU/coreutils host (the lock's staleness reclaim uses `stat -c %Y`).
 *     The deploy target (luna-dev, Linux) qualifies; the INSTALL host's OS is
 *     irrelevant (it only stores the step strings).
 *
 * KNOWN LIMITS / operator-accept-before-relying-heavily (see review 2026-06-08):
 *   - The workflow-worker's prompt step has a wall-clock timeout
 *     (DEFAULT_QUERY_TIMEOUT_MS = 10 min, overridable per-step via timeout_ms):
 *     on expiry the step is recorded status:"timeout" and the SDK subprocess is
 *     aborted, so a hung agent turn can no longer wedge the single-fiber V2
 *     ticker. The default sits well under LOCK_STALE_S (3600s) so a timed-out
 *     run's worktree lock still clears via the staleness reclaim — and the
 *     install asserts the pipeline's total step budget stays under it (see
 *     assertTimeoutBudget). The `prompt`-kind jobs (daily-brief, dream) share
 *     the SAME bound now, via the shared runBoundedQuery helper (daily-brief
 *     overridable per-payload via timeout_ms, dream via LUNA_DREAM_TIMEOUT_MS).
 *   - No per-action attempt cap: an action the agent can never complete (it
 *     keeps making no commit) is re-selected each cycle, burning a prompt-step
 *     turn. Recommended fast-follow: attempt counter → status='blocked'.
 *   - Agent confinement to the worktree is enforced by the step-2 backstops
 *     (live-tree-clean + branch assertion + secret-scan), not by sandboxing the
 *     agent's Bash. A direct `push` to master by the agent is bounded only by
 *     branch protection on master (loop gap #7).
 *
 * SAFETY: installs DISABLED by default. Arming an unattended pusher is an
 * operator decision (DNA ask-list #4) — pass --enable (or set enabled=1)
 * explicitly. With no open next_actions the pipeline is a clean no-op (step 0
 * halts), so even when enabled it does nothing until work is seeded.
 *
 * Usage:
 *   bun run apps/ui-web/scripts/push-through-install.ts            # install, disabled
 *   bun run apps/ui-web/scripts/push-through-install.ts --enable   # install + arm
 *   bun run apps/ui-web/scripts/push-through-install.ts --force    # replace existing
 *   bun run apps/ui-web/scripts/push-through-install.ts --uninstall
 *
 * Env honoured:
 *   LUNA_DB_PATH / LUNA_HOME          — same resolution as chat-server.ts
 *   LUNA_PUSH_THROUGH_ID              — job id. Default "push-through".
 *   LUNA_PUSH_THROUGH_CRON            — cron expr (server UTC). Default "*\/30 * * * *".
 *   LUNA_PUSH_THROUGH_WORKTREE        — isolated worktree. Default "/root/luna-auto".
 *   LUNA_PUSH_THROUGH_LIVE_REPO       — live repo (for `worktree add`). Default "/root/luna".
 *   LUNA_PUSH_THROUGH_WORKSPACE_DB    — workspace.db. Default "<live_repo>/.workspace/workspace.db".
 *   LUNA_PUSH_THROUGH_REPO            — gh repo slug. Default "fourcolors/luna".
 *   LUNA_PUSH_THROUGH_BASE            — PR base branch. Default "dev".
 *   LUNA_PUSH_THROUGH_MAX_TURNS       — prompt-step max_turns. Default 16.
 */
import { Cron, Effect, Layer, ManagedRuntime } from "effect"
import { Clock, JobsStoreService } from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import { resolveRuntimePaths } from "./runtime-paths.js"

const paths = resolveRuntimePaths()
console.log("[push-through-install] db paths:", { lunaDbPath: paths.lunaDbPath })

const args = new Set(process.argv.slice(2))
const FORCE = args.has("--force")
const UNINSTALL = args.has("--uninstall")
const ENABLE = args.has("--enable")

const JOB_ID = process.env.LUNA_PUSH_THROUGH_ID ?? "push-through"
const CRON_EXPR = process.env.LUNA_PUSH_THROUGH_CRON ?? "*/30 * * * *"
const WORKTREE = process.env.LUNA_PUSH_THROUGH_WORKTREE ?? "/root/luna-auto"
const LIVE_REPO = process.env.LUNA_PUSH_THROUGH_LIVE_REPO ?? "/root/luna"
const WORKSPACE_DB =
  process.env.LUNA_PUSH_THROUGH_WORKSPACE_DB ?? `${LIVE_REPO}/.workspace/workspace.db`
const REPO = process.env.LUNA_PUSH_THROUGH_REPO ?? "fourcolors/luna"
const BASE = process.env.LUNA_PUSH_THROUGH_BASE ?? "dev"
const MAX_TURNS = (() => {
  const raw = process.env.LUNA_PUSH_THROUGH_MAX_TURNS
  const n = raw ? Number(raw) : 16
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 16
})()
// Pin the prompt step's wall-clock deadline explicitly (it would otherwise fall
// to the worker's DEFAULT_QUERY_TIMEOUT_MS). 10 min clears a max_turns run; the
// install-time assertTimeoutBudget() guarantees it + the shell steps stay under
// LOCK_STALE_S so a timed-out run can't outlive its own worktree lock.
const PROMPT_TIMEOUT_MS = (() => {
  const raw = process.env.LUNA_PUSH_THROUGH_PROMPT_TIMEOUT_MS
  const n = raw ? Number(raw) : 600_000
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 600_000
})()

// ── Pipeline steps ───────────────────────────────────────────────────────────
//
// Shell steps use only `$(...)`, `$VAR`, and `$(( ))` (never `${...}`) so they
// are safe inside TS template literals. State crosses steps via the filesystem:
// the selected action id in ID_FILE and the worktree's on-disk HEAD. Each step
// is one `/bin/sh -c` (dash on the target — no `pipefail`); `set -e` + explicit
// `exit 1` drive the halt_on_failure gate.
//
// ID_FILE/LOCK_DIR are namespaced by JOB_ID so two installed instances don't
// corrupt each other's sidecar/lock.
const ID_FILE = `/root/.luna-${JOB_ID}-current-id`

// Concurrency guard: an atomic mkdir lock spanning the run. The in-process V2
// ticker is a single fiber that dispatches inline, so it self-serializes
// SCHEDULED fires — this lock is defense-in-depth against operator-initiated
// one-off runs (observed 2026-06-08: a manual trigger racing the cron boundary
// stomped the shared worktree) and any future forked/multi-process dispatch.
// Acquired AFTER the no-work check so idle heartbeats never touch it; released
// by the gate's halt paths and by the final step. A crashed run leaves it for
// the staleness window to reclaim. LOCK_STALE_S MUST exceed the worst-case
// TOTAL run time (sum of every step's timeout). The prompt step is now bounded
// (PROMPT_TIMEOUT_MS); assertTimeoutBudget() enforces total < LOCK_STALE_S at
// install time so a timed-out run can never outlive its own lock's reclaim.
const LOCK_DIR = `/root/.luna-${JOB_ID}.lock.d`
const LOCK_STALE_S = 3600 // 60 min — comfortably longer than the step budget

// Step 0 — select work + prepare an isolated branch. Halts (no-op) if nothing
// is queued. Self-heals the worktree if it doesn't exist yet.
const STEP_SELECT = [
  "set -e",
  `git -C ${LIVE_REPO} worktree add ${WORKTREE} origin/${BASE} 2>/dev/null || true`,
  `ID=$(sqlite3 ${WORKSPACE_DB} "SELECT id FROM next_actions WHERE status='todo' ORDER BY priority DESC, created_at ASC LIMIT 1")`,
  `[ -n "$ID" ] || { echo NO_OPEN_ACTIONS; exit 1; }`,
  // atomic lock acquire (mkdir) with atomic staleness reclaim
  `if ! mkdir ${LOCK_DIR} 2>/dev/null; then AGE=$(( $(date +%s) - $(stat -c %Y ${LOCK_DIR} 2>/dev/null || echo 0) )); [ $AGE -ge ${LOCK_STALE_S} ] || { echo CONCURRENT_RUN_SKIP age=$AGE; exit 1; }; rmdir ${LOCK_DIR} 2>/dev/null || rm -rf ${LOCK_DIR}; mkdir ${LOCK_DIR} 2>/dev/null || { echo LOCK_RECLAIM_LOST; exit 1; }; echo RECLAIMED_STALE_LOCK age=$AGE; fi`,
  `echo "$ID" > ${ID_FILE}`,
  `BR=auto/na-$ID`,
  `git -C ${WORKTREE} fetch origin --quiet`,
  `git -C ${WORKTREE} checkout -B "$BR" origin/${BASE}`,
  `git -C ${WORKTREE} reset --hard origin/${BASE}`,
  `git -C ${WORKTREE} clean -fd`,
  `echo SELECTED id=$ID branch=$BR`,
].join("; ")

// Step 2 — dedup gate + structural confinement backstops. `rel` frees the lock
// on every halt so a no-work/abort outcome doesn't wedge the worktree.
const STEP_GATE = [
  "set -e",
  `rel(){ rmdir ${LOCK_DIR} 2>/dev/null || rm -rf ${LOCK_DIR}; }`,
  `cd ${WORKTREE}`,
  "git fetch origin --quiet",
  "BR=$(git rev-parse --abbrev-ref HEAD)",
  // branch must be one we created; never the base; never detached (BR=HEAD)
  `case "$BR" in auto/na-*) ;; *) echo BAD_BRANCH_ABORT br=$BR; rel; exit 1;; esac`,
  `[ "$BR" != ${BASE} ] || { echo ON_BASE_ABORT; rel; exit 1; }`,
  // the agent must not have mutated the live repo's tracked tree
  `DIRTY=$(git -C ${LIVE_REPO} status --porcelain --untracked-files=no)`,
  `[ -z "$DIRTY" ] || { echo LIVE_TREE_DIRTY_ABORT; rel; exit 1; }`,
  // new commits vs base (distinguish a cherry failure from genuinely-zero)
  `CHOUT=$(git cherry origin/${BASE} HEAD) || { echo CHERRY_FAILED; rel; exit 1; }`,
  `NEW=$(printf '%s\\n' "$CHOUT" | grep -c '^+' || true)`,
  `[ "$NEW" -gt 0 ] || { echo NO_NEW_COMMITS_HALT new=$NEW; rel; exit 1; }`,
  // secret-scan the diff before anything leaves the host
  `if git diff origin/${BASE}...HEAD | grep -Eq '(sk-ant-[A-Za-z0-9_-]{8})|(gh[posru]_[A-Za-z0-9]{20})|(github_pat_[A-Za-z0-9_]{20})|(AKIA[0-9A-Z]{16})|(BEGIN [A-Z ]*PRIVATE KEY)'; then echo SECRET_SUSPECTED_ABORT; rel; exit 1; fi`,
  // no open PR already exists for this head
  `OPEN=$(gh pr list --repo ${REPO} --head "$BR" --state open --json number --jq length)`,
  `[ "$OPEN" = 0 ] || { echo OPEN_PR_EXISTS_HALT open=$OPEN; rel; exit 1; }`,
  "echo GATE_PASS new=$NEW open=$OPEN br=$BR",
].join("; ")

// Step 3 — push + open PR, then mark the action in-flight and release the lock.
const STEP_SHIP = [
  "set -e",
  `cd ${WORKTREE}`,
  "BR=$(git rev-parse --abbrev-ref HEAD)",
  `case "$BR" in auto/na-*) ;; *) echo BAD_BRANCH_ABORT br=$BR; exit 1;; esac`,
  // bare (no pipe) so set -e catches a push failure; --force-with-lease recovers
  // a branch stranded by a prior push-ok/pr-create-fail run (the gate already
  // proved no open PR exists for it, so nothing is orphaned).
  `git push --force-with-lease -u origin "$BR"`,
  // title = commit subject verbatim (the agent already prefixes "autonomy:"; do
  // not double it — cf. PR #74's "autonomy: autonomy:" title). A gh failure here
  // fails the assignment under set -e → halt before MARKED_DOING.
  `URL=$(gh pr create --repo ${REPO} --base ${BASE} --head "$BR" --title "$(git log -1 --pretty=%s)" --body "Opened autonomously by the push-through workflow job. Implements one workspace next_action in an isolated worktree; deterministic dedup gate (git cherry + open-PR + secret-scan + live-tree-clean) passed before push. Review before merge." 2>&1)`,
  "echo PR=$URL",
  `ID=$(cat ${ID_FILE} 2>/dev/null || true)`,
  `[ -z "$ID" ] || sqlite3 ${WORKSPACE_DB} "UPDATE next_actions SET status='doing', updated_at=$(date +%s)000 WHERE id=$ID"`,
  "echo MARKED_DOING id=$ID",
  `rmdir ${LOCK_DIR} 2>/dev/null || rm -rf ${LOCK_DIR}`,
  "echo RELEASED_LOCK",
].join("; ")

// Step 1 — the bounded, commit-only prompt step. Pinned to the id step 0 locked
// (via ID_FILE) so the agent provably implements the action the branch is named
// for.
const SYSTEM_PROMPT = [
  "You are Luna's autonomous worker executing ONE bounded task.",
  `A clean git worktree is already checked out at ${WORKTREE} on a fresh feature branch off origin/${BASE}.`,
  "RULES:",
  `(1) Work ONLY inside ${WORKTREE}; always use absolute paths there and \`git -C ${WORKTREE}\` for every git command.`,
  `(2) NEVER run git inside ${LIVE_REPO}, never change its branch, never push, never open a PR (a later automated step does that).`,
  "(3) Make ONLY the change the task describes - nothing else. Stage only the files you changed with explicit paths; do NOT use `git add -A`.",
  "(4) Commit in the worktree.",
  "(5) If the task is already done or genuinely unclear, make no commit and say so.",
].join(" ")

const USER_PROMPT = [
  "Find the exact action you must implement by reading the id locked for this run:",
  `ID=$(cat ${ID_FILE}); sqlite3 ${WORKSPACE_DB} "SELECT action FROM next_actions WHERE id=$ID"`,
  `Implement exactly that action as a minimal change inside the worktree ${WORKTREE}.`,
  `Stage only the files you changed (explicit paths, e.g. git -C ${WORKTREE} add path/to/file), then commit:`,
  `git -C ${WORKTREE} -c user.name=Luna -c user.email=luna@local commit -m "autonomy: <concise summary>"`,
  `Finally print the new commit SHA: git -C ${WORKTREE} rev-parse --short HEAD`,
].join(" ")

const ALLOWED_TOOLS = [
  "Bash",
  "mcp__memory__memory_search",
  "mcp__observability__obs_note",
  "mcp__observability__obs_notes_recent",
] as const

const buildPayload = () => ({
  label: "push-through",
  source: "push-through-install",
  halt_on_failure: true,
  steps: [
    { kind: "shell" as const, cmd: STEP_SELECT, timeout_ms: 120_000 },
    {
      kind: "prompt" as const,
      user_prompt: USER_PROMPT,
      system_prompt: SYSTEM_PROMPT,
      model: "claude-sonnet-5",
      max_turns: MAX_TURNS,
      timeout_ms: PROMPT_TIMEOUT_MS,
      allowed_tools: [...ALLOWED_TOOLS],
    },
    { kind: "shell" as const, cmd: STEP_GATE, timeout_ms: 120_000 },
    { kind: "shell" as const, cmd: STEP_SHIP, timeout_ms: 180_000 },
  ],
})

/**
 * Code-enforce the worktree-lock invariant: a halted (timed-out / failed) run
 * stops BEFORE the gate/ship steps that release the lock, so the lock falls to
 * the LOCK_STALE_S reclaim. If the pipeline's worst-case total run could exceed
 * LOCK_STALE_S, a concurrent operator one-off could reclaim a STILL-ACTIVE
 * lock and stomp the shared worktree (the exact 2026-06-08 race the lock
 * exists to prevent). Every step is bounded (shells via timeout_ms, the prompt
 * via PROMPT_TIMEOUT_MS), so we can assert the sum stays safely under the
 * staleness window at install time rather than trusting a comment.
 */
const assertTimeoutBudget = (): void => {
  const totalMs = buildPayload().steps.reduce(
    (sum, s) => sum + (s.timeout_ms ?? PROMPT_TIMEOUT_MS),
    0,
  )
  const budgetMs = LOCK_STALE_S * 1000
  // Require a margin (not just <): the staleness clock starts at lock-acquire
  // (step 0), so the lock must comfortably outlast the whole run.
  if (totalMs >= budgetMs) {
    throw new Error(
      `[push-through-install] timeout budget ${totalMs}ms (sum of step timeouts) ` +
        `must stay under LOCK_STALE_S=${budgetMs}ms — a timed-out run would outlive ` +
        `its own worktree lock and risk a concurrent-stomp. Lower PROMPT_TIMEOUT_MS ` +
        `(env LUNA_PUSH_THROUGH_PROMPT_TIMEOUT_MS) or raise LOCK_STALE_S.`,
    )
  }
}

/**
 * Compute next fire time in UTC. Passing the explicit "UTC" tz to Cron.parse
 * pins matching to UTC regardless of the install host's process.env.TZ — and
 * exactly matches what the JobTicker's computeNextRunAt does at runtime, so the
 * install-time and runtime next_run_at can never diverge. Mirrors
 * daily-brief-install.ts.
 */
const computeNextRunAtUtc = (now: number): number | null => {
  const parsed = Cron.parse(CRON_EXPR, "UTC")
  if (parsed._tag === "Left") return null
  return Cron.next(parsed.right, new Date(now)).getTime()
}

const jobsStoreL = JobsStoreService.makeLayer(paths.lunaDbPath).pipe(
  Layer.provide(Clock.Default),
  Layer.provide(LunaSqliteBootstrapLive),
)

const program = Effect.gen(function* () {
  const store = yield* JobsStoreService
  const existing = yield* store.getById(JOB_ID)

  if (UNINSTALL) {
    if (!existing) {
      console.log(`[push-through-install] no row '${JOB_ID}' — nothing to uninstall`)
      return
    }
    const removed = yield* store.remove(JOB_ID)
    console.log(`[push-through-install] uninstalled '${JOB_ID}' (removed=${removed})`)
    return
  }

  // Fail the install if the step budget could outlive the worktree lock.
  assertTimeoutBudget()

  if (existing && !FORCE) {
    console.log(`[push-through-install] '${JOB_ID}' already installed:`, {
      kind: existing.kind,
      schedule: existing.schedule,
      enabled: existing.enabled,
    })
    console.log("[push-through-install] re-run with --force to replace (e.g. to swap the legacy prompt job)")
    return
  }

  if (existing && FORCE) {
    yield* store.remove(JOB_ID)
    console.log(`[push-through-install] removed existing '${JOB_ID}' (forced)`) // replaces legacy prompt job
  }

  const now = Date.now()
  const nextRunAt = computeNextRunAtUtc(now)
  if (nextRunAt === null) {
    throw new Error(`[push-through-install] failed to parse cron "${CRON_EXPR}"`)
  }

  // Arm the row ATOMICALLY (enabled + next_run_at in the INSERT). Otherwise a
  // bare record() defaults enabled=true / next_run_at=NULL = immediately due,
  // and with the V2 ticker now default-on and sharing luna.db, a tick landing
  // before a follow-up disable could claim+dispatch the autonomous push/PR
  // workflow the operator installed DISABLED (ENABLE=false).
  yield* store.record({
    id: JOB_ID,
    kind: "workflow",
    spec: CRON_EXPR,
    payload: buildPayload(),
    enabled: ENABLE,
    nextRunAt,
  })
  // `schedule` is metadata only (the ticker uses schedule ?? spec, and spec
  // already carries CRON_EXPR) — safe to set after arming, no due-window.
  yield* store.setV2Fields(JOB_ID, { schedule: CRON_EXPR })

  const row = yield* store.getById(JOB_ID)
  console.log(`[push-through-install] installed '${JOB_ID}':`, {
    kind: row?.kind,
    schedule: CRON_EXPR,
    enabled: row?.enabled,
    maxTurns: MAX_TURNS,
    worktree: WORKTREE,
    base: BASE,
    repo: REPO,
    steps: buildPayload().steps.length,
  })
  console.log(
    ENABLE
      ? `[push-through-install] ARMED — first fire at ${new Date(nextRunAt).toISOString()} (no-op until next_actions are seeded)`
      : "[push-through-install] installed DISABLED — arm with --enable or set enabled=1 when ready",
  )
})

const rt = ManagedRuntime.make(jobsStoreL)
rt.runPromiseExit(program)
  .then(async (exit) => {
    await rt.dispose()
    if (exit._tag === "Failure") {
      console.error("[push-through-install] FAILED:", exit.cause)
      process.exit(1)
    }
    console.log("[push-through-install] done.")
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("[push-through-install] FATAL:", err)
    process.exit(1)
  })
