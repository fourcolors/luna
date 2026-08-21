# Doctor workflow

Runnable V2 `kind=workflow` pipeline that diagnoses, **backs up**, patches,
verifies, and finalizes heal attempts for chronically failing jobs.

This is **not** `luna doctor` (CLI preflight) or `scripts/luna-doctor` (registry check).

## Manual run

```sh
# From repo root (server machine or worktree with LUNA_DB_PATH set):
bun run apps/server/scripts/doctor-workflow-run.ts --patient job:<jobId>

# Optional:
bun run apps/server/scripts/doctor-workflow-run.ts \
  --patient job:sched-xxx \
  --attempt 1 \
  --summary "max turns exhausted"
```

Creates a **one-shot** workflow job due now. JobTicker must be running to claim it.

## Pipeline steps

| # | Step | Role |
|---|------|------|
| 0 | diagnose | Classify restart / unstuck / patch / escalate |
| 1 | backup | Snapshot patient to `~/.luna/doctor-backups/` |
| 2 | apply | Heuristic / plan.json patch (refuses without backupId) |
| 3 | verify | Patient still enabled + loadable |
| 4 | finalize | Success, or rollback from backup |

Shell-only (no LLM planner) until plan.json handoff is wired end-to-end.

State handoff lives under `~/.luna/doctor-runs/<run-id>/`.

## CLI (workflow shell steps)

```sh
bun run apps/server/scripts/luna-doctor-workflow.ts diagnose --state-dir <dir>
bun run apps/server/scripts/luna-doctor-workflow.ts backup --state-dir <dir> --attempt 1
bun run apps/server/scripts/luna-doctor-workflow.ts apply --state-dir <dir> --attempt 1
bun run apps/server/scripts/luna-doctor-workflow.ts verify --state-dir <dir>
bun run apps/server/scripts/luna-doctor-workflow.ts finalize --state-dir <dir>
```

## Auto-enqueue (Phase B1)

When a non-exempt job's `fail_streak` or `orphan_streak` hits the threshold
(default **5**), JobTicker:

1. Sets `heal_state=healing`, `enabled=0`, `heal_attempts += 1`
2. Enqueues the same doctor workflow one-shot as a manual run
3. On doctor failure: re-enqueue until `heal_attempts` reaches **3**, then
   `heal_state=escalated` (no 4th doctor)
4. On patient success: resets fail/orphan/heal counters

**Exempt from auto-doctor:** `dream`, `wake`, and any `source=doctor-workflow`
job (no doctor-for-doctor).

Thresholds / CLI path are overridable via `JobTickerLayer({ doctor: { ... } })`.

## Code

- Types / builder / heal API: `packages/core/src/doctor/`
- Run: `apps/server/scripts/doctor-workflow-run.ts`
- Step CLI: `apps/server/scripts/luna-doctor-workflow.ts`
