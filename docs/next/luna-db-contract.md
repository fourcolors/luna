# luna.db schema-continuity contract

## Why this document exists

Stack 2 of `luna-next` (see `NEXT.md`) plans to extract the chat-server daemon out of `apps/ui-web/scripts/` and into `apps/server`.
That move is a daemon cutover: a new process starts reading and writing the same on-disk state the old daemon owned.
The 2026-07-31 greenfield redesign review flagged that no document named exactly which tables, columns, and indexes a daemon depends on, so a schema change could silently break continuity across a cutover with nobody noticing until data looked wrong in production.
This document is that list.
It is derived directly from the migration DDL in the source files it cites, not from memory or from `DESIGN.md`'s aspirational §5.1 baseline, which predates several of the tables described here and is not byte-accurate to what ships today.
Every table, column, and index named below is load-bearing: a future migration that drops or renames one of them fails `packages/core/test/luna-db-contract.test.ts`, which asserts this contract against the real migration chain.
See "Keeping this contract honest" at the bottom for exactly which CI lane runs that test and how strongly it gates today.

## The file topology (read this before anything else)

A "luna.db schema" is not one file.
The daemon opens three distinct kinds of SQLite database, and a cutover must copy all of them under the same discipline:

1. `~/.luna/luna.db` (or `$LUNA_DB_PATH`) - the Luna-runtime database.
   Sessions, threads, jobs, agent notes, alignment, the cost ledger, and the dream reflection store all live here, gated by the per-component `schema_versions` migration ledger.
2. `~/.luna/memory.db` (or `$LUNA_MEMORY_DB`) - the memory/embeddings database.
   This is a SEPARATE file from `luna.db`, wired independently in `apps/ui-web/scripts/runtime-paths.ts`.
   It holds `memory_keyed`, `memory_vectors`, the `memory_fts` full-text index, and - when the optional Vectorlite extension loads - the `memory_vectors_hnsw` virtual table plus its own on-disk sidecar file.
   Beliefs (`~/BELIEFS.md`-style operator beliefs, not Mr. Cobb's personal file) are rows inside `memory_vectors`/`memory_keyed`, not a separate `beliefs` table.
3. `<workspace>/.workspace/workspace.db` - one file per workspace, created by `installWakeSchema()` (`packages/core/src/wake/workspace-schema.ts`) with plain `CREATE TABLE IF NOT EXISTS` DDL, never the `schema_versions` migration ladder.
   It holds `goals`, `next_actions`, and `wake_log`.

Treating these three file kinds as one blob is the exact mistake this contract exists to prevent.
A cutover gate that only verifies `luna.db` and silently drops `memory.db` or a workspace's `workspace.db` has not verified continuity at all.

## Part A - tables in `luna.db`

### `schema_versions` (the migration ledger itself)

Source: `packages/core/src/db/schema-versions.ts`.

```
schema_versions (component TEXT, version INTEGER, applied_at INTEGER, PRIMARY KEY (component, version))
```

Every component below gates its own migrations on its own `component` row here, independently of every sibling component.
This is what fixed the Phase 25e migration-collision bug where one component's `PRAGMA user_version` bump caused every other component to skip its own `CREATE TABLE`.

### `sessions` + `messages` (chat transcript store)

Source: `packages/core/src/session/session-store-sqlite.ts`, wired at `paths.lunaDbPath` in `apps/ui-web/scripts/chat-server.ts`.

```
sessions (id, parent_id, title, tags, created_at, ended_at, model, options_json, status, meta_json)
messages (id, session_id, parent_id, kind, role, content_json, schema_version, ts, seq)
```

Indexes: `idx_sessions_created`, `idx_sessions_status`, `idx_sessions_status_created`, `idx_sessions_lastmsgat` (expression index on `json_extract(meta_json, '$.lastMessageAt')`), `idx_messages_session_seq`, `idx_messages_toplevel_user` (partial index, `kind = 'user' AND parent_id IS NULL`).
`meta_json` is an additive column beyond the frozen `DESIGN.md` §5.1 skeleton; it carries `lastMessageAt` and `lastMessagePreview` for the sidebar.

### `threads` (SDK-resume registry)

Source: `packages/core/src/threads/thread-registry.ts`, wired at `paths.lunaDbPath`.

```
threads (id, sdk_session_id, cwd, title, model, effort, created_at, last_active_at, status, archived_at)
```

Indexes: `idx_threads_last_active`, `idx_threads_status`.
`threads` and `sessions` are related but distinct: `threads` is the durable SDK resume-pointer plus archival state machine (`status` is `active` or `archived`, never deleted); `sessions`/`messages` is the fuller transcript record.
A cutover must preserve both - resuming a thread without its `sdk_session_id` row, or losing a session's `messages`, are both correctness failures, not cosmetic ones.

### `jobs` + `job_runs` (scheduler and crash-reconciliation)

Source: `packages/core/src/jobs/jobs-store.ts`, wired at `paths.lunaDbPath`.

```
jobs (id, kind, spec, next_run, last_run, last_status, payload_json, created_at, updated_at,
      schedule, enabled, next_run_at, retry_attempt, fail_streak, orphan_streak, heal_attempts, heal_state)
job_runs (id, job_id, started_at, finished_at, status, attempt, output_text, error, steps_json)
```

Indexes: `idx_jobs_kind_created`, `idx_jobs_due` (`jobs(enabled, next_run_at)`), `idx_job_runs_job`, `idx_job_runs_status`.

Crash-reconciliation invariants a cutover must not break (see `reconcileAfterCrash` in `packages/core/src/jobs/jobs-store-types.ts`):

- On boot, every open `job_runs` row (`finished_at IS NULL`) is closed as `cancelled`.
- A run whose pre-close status was `waiting` counts toward `waitingClosed`; every other pre-close status counts toward `orphansClosed`.
- Any job with `last_status = 'running'` and no open run (a "sticky" row) is repaired to `last_status = 'errored'`.
- Enabled recurring jobs that had a running orphan (or a sticky-running repair) get `next_run_at` pulled forward to `min(next_run_at ?? Infinity, finishedAt + jitter)`, where jitter is the deterministic `hash(jobId) % (rescheduleJitterMs + 1)`.
- Waiting-only orphans never pull `next_run_at` forward.
- Disabled jobs are never re-enabled by reconciliation.

A new daemon that skips `reconcileAfterCrash` on boot, or runs it against the wrong `jobs`/`job_runs` shape, will either double-fire jobs or leave sticky `running` rows stuck forever - this is precisely the failure class the job-reconciliation smoke test in the cutover gate below exists to catch.

### `agent_notes` (self-report stream)

Source: `packages/core/src/agent-notes/agent-notes.ts`, wired at `paths.lunaDbPath`.

```
agent_notes (id, session_id, parent_id, kind, summary, payload_json, ts)
```

Indexes: `idx_agent_notes_session_ts`, `idx_agent_notes_kind_ts`.

### `alignment_log` + `alignment_state` (belief-survey cadence state)

Source: `packages/core/src/alignment/alignment-store.ts`, wired at `paths.lunaDbPath`.

```
alignment_log (id, at, signal_kind, score_delta, ewma_after, ref, UNIQUE(ref, signal_kind, at))
alignment_state (id INTEGER CHECK(id = 1), ewma, updated_at)
```

Index: `idx_alignment_log_kind_at`.
`signal_kind` is constrained to `task_quality`, `belief_validation`, or `outreach_welcome`.
`alignment_state` is a single-row (`id = 1`) denormalized cache; it is fully derivable by replaying the EWMA-eligible rows of `alignment_log`, so it is a cache, not a second source of truth.
"Cadence" (the survey-interval controller in `packages/core/src/alignment/cadence.ts`) is pure math with no storage of its own - it consumes `alignment_state.ewma` and a `getLastSurveyAt` value that is DERIVED as `MAX(at)` over `task_quality` rows in `alignment_log`, not stored in its own column.
Belief content itself (the actual belief text, status, and validation history) is not in this table pair at all; it lives as `memory_vectors`/`memory_keyed` rows in `memory.db` under the belief namespace (`packages/core/src/beliefs/belief-writer.ts`).
A cutover that migrates `alignment_log`/`alignment_state` but not the belief rows in `memory.db` leaves the alignment loop scoring beliefs that no longer resolve.

### `cost_events` + `cost_event_experiments` + `cost_budgets` (cost ledger)

Source: `packages/core/src/cost-accounting/cost-store-sqlite.ts` (`CostAccountingService.fromPath`, alias for `makeCostAccountingSqlite`).
The `cost_events` columns are frozen per `DESIGN.md` §5.1; the other two tables are additive and scoped to this component.

```
cost_events (id, session_id, team_name, workflow_id, account_id, tokens_in, tokens_out, cache_read, cache_write, usd, ts)
cost_event_experiments (cost_event_id REFERENCES cost_events(id) ON DELETE CASCADE, experiment_id, PRIMARY KEY (cost_event_id, experiment_id))
cost_budgets (dim, key, budget_usd, PRIMARY KEY (dim, key))
```

Indexes: `idx_cost_session`, `idx_cost_team`, `idx_cost_workflow`, `idx_cost_exp`.

### `dream_audit` + `dream_state` - NOT `dream_log`

Source: `packages/core/src/dream/dream-store.ts`, wired at `paths.lunaDbPath`.

```
dream_audit (id, dream_id, at, op, target_id, before_json, after_json, rationale, status, applied_at, reverted_at,
             UNIQUE(dream_id, target_id, op), CHECK(status IN ('applied','proposed','reverted')))
dream_state (k TEXT PRIMARY KEY, v TEXT)
```

Indexes: `idx_dream_audit_dream`, `idx_dream_audit_target`, `idx_dream_audit_status`.
There is no `dream_log` table anywhere in the codebase; a prior slice's investigation confirmed this, and this contract restates it explicitly because the name is an easy, plausible-sounding guess that does not exist.
`dream_state` is a flat key/value store; the only key in current use is `last_dream_at`, the millisecond watermark through which the last completed dream cycle ran.
`dream_audit` is append-only and idempotent by construction: every insert is `INSERT OR IGNORE` keyed on the `UNIQUE(dream_id, target_id, op)` constraint, so replaying the same dream window twice (as a crash-recovery retry would) is safe.

## Part B - tables in `memory.db` (a different file - see the topology section above)

Source: `packages/memory/src/backends/sqlite-vector-maintenance.ts` (`ensureMemoryVectorSchema`) and `packages/memory/src/backends/sqlite-vector.ts`.

```
memory_keyed (id TEXT PRIMARY KEY, namespace, kind, content_json, schema_version, created_at, updated_at, tags_json, scope_json, provenance_json)
memory_vectors (id TEXT PRIMARY KEY REFERENCES memory_keyed(id) ON DELETE CASCADE, namespace, embedding, dimension, text, ts,
                embedding_provider, embedding_model, embedding_format, embedding_input_hash, embedded_at, enrichment)
memory_fts (text, enrichment)   -- FTS5 virtual table, content='memory_vectors', content_rowid='rowid'
```

Indexes: `idx_memory_ns`, `idx_memory_kind`, `idx_memory_updated` (on `memory_keyed`); `idx_vectors_ns` (on `memory_vectors`).
`memory_fts` is kept in sync by the `memory_vectors_ai` / `memory_vectors_ad` / `memory_vectors_au` triggers on `memory_vectors`.

The `embedding_provider`, `embedding_model`, `embedding_format`, `embedding_input_hash`, and `embedded_at` columns on `memory_vectors` ARE the embedder-migration audit state.
There is no separate audit table: `luna memory status` and `luna memory reembed` (see `getMemoryVectorStatus` / `reembedMemoryVectors` in `sqlite-vector-maintenance.ts`) compute staleness by comparing each row's stored metadata against the currently active embedder's provider/model/format/input-hash, entirely from these columns.
A cutover that changes the embedder without preserving these five columns loses the ability to detect which vectors need re-embedding, and will silently rank on stale or incompatible embeddings.

### `memory_vectors_hnsw` (optional virtual table) + its sidecar file

When the Vectorlite SQLite extension loads successfully, `sqlite-vector.ts` additionally creates a virtual table `memory_vectors_hnsw` (`USING vectorlite(embedding float32[dim], hnsw(max_elements=100000), '<sidecar-path>')`), kept in sync by three more triggers (`memory_vectors_hnsw_ai`/`_ad`/`_au`), and backed by a sidecar file at `<memoryDbPath>.hnsw.bin` (see `deriveHnswSidecarPath` in `packages/memory/src/backends/hnsw-sidecar.ts`).
This is a graceful-degradation path by design: when the extension is unavailable (non-bun runtime, missing prebuilt, wrong platform), the backend falls back to a naive in-process cosine ranker and never raises an error.
A cutover gate MUST still copy the `.hnsw.bin` sidecar file alongside `memory.db` if it exists, because discarding it forces a full HNSW graph rebuild from `memory_vectors` on next boot - correct, but a needless cost at scale.
This contract names `memory_vectors_hnsw` and its sidecar so a future migration does not accidentally break the trigger wiring, but the CI schema-assertion test does not build the extension-backed virtual table itself (see the test file's header for why).

## Part C - tables in each workspace's `workspace.db` (bootstrap DDL, not the migration ladder)

Source: `packages/core/src/wake/workspace-schema.ts` (`installWakeSchema`, `hasWakeSchema`), installed by `apps/ui-web/scripts/enable-wake.ts` and self-healed by `WakeLogStore` (`packages/core/src/wake/wake-log-store.ts`).

```
goals (slug TEXT PRIMARY KEY, title, description, status, priority, created_at, updated_at)
next_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_slug, action, status, priority, created_at, updated_at, completed_at, notes)
wake_log (id INTEGER PRIMARY KEY AUTOINCREMENT, woke_at, goal_slug, summary, outcome, artifacts)
```

This is the split the previous slice's investigation verified and this contract restates so it is never re-litigated from scratch: `wake_log` and `next_actions` do not live in `luna.db`, and they are not gated by `schema_versions`.
They live in a PER-WORKSPACE `workspace.db` file at `<workspace path>/.workspace/workspace.db`, created with plain `CREATE TABLE IF NOT EXISTS` DDL that is safe to re-run and does not alter an existing table whose shape differs.
`goals` and `next_actions` together are `WAKE_REQUIRED_TABLES`; a workspace missing either one is treated as "not wake-enabled" and the wake cycle skips rather than errors.
`wake_log` is excluded from that required-tables check because `WakeLogStore` self-heals it independently on every open.
A cutover gate that only inspects `luna.db` will never see this table set at all - it must additionally open every active workspace's `workspace.db` (the active list itself comes from the `workspaces` table in `luna.db`) and verify `goals`/`next_actions`/`wake_log` there.

## What is intentionally out of scope here

`luna.db` also carries an operator-registry surface not covered in detail by this contract because it is configuration state, not behavioral continuity state a daemon cutover can silently corrupt: `workspaces`, `accounts`, `connectors`, `mcp_servers`, `artifacts`, `vault_items`/`vault_sync_config`, `skill_preferences`, `suggested_actions`, `provider_settings`, `ui_feedback_status`, and the Telegram channel's session-map/dedup tables.
`~/.luna/analytics.db` (DuckDB, not SQLite) holds telemetry rollups only and is likewise out of scope: losing it degrades observability, not correctness.
None of these are exempt from "do not silently break a migration" as engineering practice - they are exempt from THIS document because the redesign panel's flagged omission was specifically the tables above: the ones whose loss or corruption changes what the daemon does, not just what it reports.
A future slice that widens this contract to cover the registry surface is welcome to extend this document; it should not need to re-derive Parts A through C.

## The cutover gate

No new daemon (the Stack 2 `apps/server` extraction, or anything after it) may cut real traffic over to a new persistence layer without passing all three of the following, in order, against a COPY of the live database files - never against the live files themselves:

1. **Boot against a copy.** Copy `luna.db`, `memory.db` (with its `.hnsw.bin` sidecar if present), and every active workspace's `workspace.db` to a scratch location, taken from the host whose daemon is currently serving traffic - the copy must reflect the on-disk state the new daemon will actually inherit at cutover, not an arbitrary or stale snapshot.
   Before booting the new daemon, normalize the copy under the OLD daemon's OWN migration chain only: run the currently-serving daemon's code against the copy (or confirm that daemon has already run its full chain) so the ledger reflects everything the old code ships.
   Never bring the ledger "current" with respect to migrations only the NEW daemon carries - pre-applying such a migration out of band is pre-applying the exact change this assertion exists to catch, and makes the gate unfailable.
   The two cases must not be conflated: a ledger that merely lags the old daemon's own shipped code (a stale copy) is the one legitimate normalize-and-re-run case; a migration present only in the new daemon's chain is the gate's FINDING, never a normalization target.
   Because `memory.db` and `workspace.db` carry no `schema_versions` ledger (memory's maintenance migrations are unledgered `ALTER TABLE`s in `sqlite-vector-maintenance.ts`; workspace bootstrap is `CREATE TABLE IF NOT EXISTS`), the ledger diff cannot see them: capture `PRAGMA table_info` for every table in both copies before and after boot and require identical output - any inventory delta is a step-1 failure exactly like a ledger delta.
   Boot the new daemon against the normalized copies only.
   If the new daemon's migration chain does anything other than a clean no-op `applyMigration` skip against a normalized copy, the gate fails before step 2 even runs - a non-no-op result here is precisely the surprise this contract exists to catch, not a case to explain away.
2. **Replay the retrieval bench.** Run `packages/memory`'s `bun run bench:memory` (the retrieval bench harness referenced by `NEXT.md`'s Decision 5) against a reachable Ollama instance serving `nomic-embed-text` (`LUNA_TEST_OLLAMA=1 LUNA_EMBEDDER=ollama LUNA_OLLAMA_EMBED_MODEL=nomic-embed-text`).
   Ollama is a hard prerequisite for this step, not an optional flag: when it is unreachable the harness exits 2 with "start the daemon or unset LUNA_EMBEDDER" advice, and following that advice by unsetting `LUNA_EMBEDDER` silently swaps in the stub embedder, whose recall is roughly half the real embedder's - a stub run must never be recorded or compared as this gate's baseline.
   Set `LUNA_BENCH_ENFORCE=1` with `LUNA_BENCH_RECALL_THRESHOLD` at the intended floor, and `LUNA_BENCH_JSON` to a scratch path, so the harness enforces the threshold and records a structured result itself (`packages/memory/bench/memory-suite.ts:109-112,723-741`) instead of relying on a human eyeballing console output.
   This cutover's recorded baseline, measured against the 200-record / 230-query `memory-suite-corpus.json`: hybrid OVERALL recall@1 0.734, recall@5 0.868, recall@10 0.933, MRR 0.794, nDCG@10 0.826; bm25 OVERALL recall@5 0.686 as the embedder-independent control.
   0.868 sits only 0.018 above the harness's own default `LUNA_BENCH_RECALL_THRESHOLD` floor of 0.85, so a real cutover should set the floor explicitly rather than let that default apply silently; this is the abandon band S08 and S26 compare against.
   The harness always seeds its own `:memory:` backend from a synthetic corpus and never reads the copied `memory.db`'s own rows, so this step verifies the embedding and ranking CODE against a fresh corpus, not CONTINUITY of data already sitting in the copied database - concretely, a new daemon that reinterpreted the stored vector encoding or a column's semantics would pass this bench while every EXISTING row decoded wrong.
   Closing that gap needs a follow-up read-back check that opens the copied `memory.db` with the new daemon's reader and asserts existing rows still decode to finite vectors of the recorded dimension, before this gate governs a real cutover.
3. **Pass a job-reconciliation smoke test.** Seed the copied `luna.db` with at least one `job_runs` row left `running` (simulating a crash mid-execution) and one `jobs` row with a sticky `last_status = 'running'` and no open run, matching the fixtures already exercised in `packages/core/src/jobs/jobs-store.test.ts`'s `reconcileAfterCrash` coverage.
   Boot the new daemon and confirm it reconciles both cases per the crash-reconciliation invariants listed in Part A: orphaned runs closed as `cancelled`, sticky jobs repaired to `errored`, `next_run_at` pulled forward only for the running/sticky case, never for waiting-only orphans, and never re-enabling a disabled job.

Only after all three gates pass may the surface cutover (traffic pointed at the new daemon, old daemon retired) happen.
Copy-never-the-live-database is the constant across all three steps: every gate runs against scratch copies, and a failed gate leaves the live `luna.db`, `memory.db`, and every `workspace.db` completely untouched.

## Keeping this contract honest

`packages/core/test/luna-db-contract.test.ts` asserts every table and column named in Part A, Part B (excluding the extension-gated `memory_vectors_hnsw` virtual table, see that test file's header), and Part C against the actual migration chain and bootstrap functions cited above.

Know exactly how strongly that test gates today, because a contract that overstates its own enforcement is worse than one that admits the gap.
The test opens real `bun:sqlite` databases, so it can only run under the bun runner: CI's blocking vitest gate collects the file but skips it by design, and the assertions actually execute in the `bun run test:bun` step.
That step is a HARD GATE in `.github/workflows/ci.yml` (see that file's gate-7 comment for the exact promotion counts, kept in one place so this document does not carry a second copy that can drift out of sync), so a contract break now fails the workflow instead of surfacing as a red-but-ignored result.

The first real run of the cutover gate above - against a copy of a genuinely-used local `luna.db`, not a synthetic fixture - tripped exactly the stale-copy case that step 1's old-code normalization rule now covers: three additive migrations (`jobs@4`, `sessions@3`, `cost@1`) not yet in the copy's `schema_versions` ledger applied on first boot.
The forensic resolution (PR #438): the copy's source file had not been written since 2026-07-27, predating those migrations shipping, so the ledger lagged the old daemon's own code - the legitimate normalize-and-re-run case, not new-daemon drift; all three are additive (`ALTER TABLE ADD COLUMN` / `CREATE ... IF NOT EXISTS`), and a second boot against the migrated copy was a clean 29 -> 29 no-op, proving idempotence.

When this contract and the test disagree with the code, the code is not automatically right: open an issue and reconcile all three, because the whole point of a schema-continuity contract is that its promises and its enforcement never drift apart.
