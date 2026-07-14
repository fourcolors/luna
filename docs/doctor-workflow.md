# Doctor workflow

Runnable V2 `kind=workflow` pipeline that diagnoses, **backs up**, patches,
verifies, and finalizes heal attempts for chronically failing jobs.

This is **not** `luna doctor` (CLI preflight) or `scripts/luna-doctor` (registry check).

## Manual run

```sh
# From repo root (server machine or worktree with LUNA_DB_PATH set):
bun run apps/ui-web/scripts/doctor-workflow-run.ts --patient job:<jobId>

# Optional:
bun run apps/ui-web/scripts/doctor-workflow-run.ts \
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
| 2 | plan | Optional LLM plan (JSON only; no DB writes) |
| 3 | apply | Backup-gated patch (refuses without backupId) |
| 4 | verify | Patient still enabled + loadable |
| 5 | finalize | Success, or rollback from backup |

State handoff lives under `~/.luna/doctor-runs/<run-id>/`.

## CLI (workflow shell steps)

```sh
bun run apps/ui-web/scripts/luna-doctor-workflow.ts diagnose --state-dir <dir>
bun run apps/ui-web/scripts/luna-doctor-workflow.ts backup --state-dir <dir> --attempt 1
bun run apps/ui-web/scripts/luna-doctor-workflow.ts apply --state-dir <dir> --attempt 1
bun run apps/ui-web/scripts/luna-doctor-workflow.ts verify --state-dir <dir>
bun run apps/ui-web/scripts/luna-doctor-workflow.ts finalize --state-dir <dir>
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

## Kill switch

`LUNA_SCHED_DOCTOR=0` freezes **auto-enqueue** only. Manual
`doctor-workflow-run` still works.

## Code

- Types / builder / heal API: `packages/core/src/doctor/`
- Run: `apps/ui-web/scripts/doctor-workflow-run.ts`
- Step CLI: `apps/ui-web/scripts/luna-doctor-workflow.ts`
