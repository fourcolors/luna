/**
 * JobsStoreService — in-memory and SQLite-backed layers for the `jobs` table
 * (DESIGN.md §5.1).
 *
 * Mirrors the agent-notes.ts / workspaces.ts pattern exactly:
 *   - Memory layer for unit tests (Ref<Map<id, PersistedJob>>).
 *   - SQLite layer built on bun:sqlite + applyMigration ledger.
 *
 * Phase 1 (this file) only persists `cron`-kind triggers. Stream triggers
 * cannot be serialized; oneshot + file-watch are reserved for future phases.
 *
 * Schema parity with DESIGN.md §5.1: column names match the frozen baseline
 * verbatim (`id, kind, spec, next_run, last_run, last_status, payload_json`).
 * Two columns are additive: `created_at`, `updated_at` — used internally for
 * boot-order reload + telemetry. Adding additive columns is permitted by
 * DESIGN.md §10.3 (workspaces follows the same pattern).
 */
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import type {
  JobKind,
  JobRun,
  JobRunStatus,
  JobsStoreApi,
  PersistedJob,
} from "./jobs-store-types.js"
import { JobsStoreError } from "./jobs-store-types.js"

// ── Schema DDL ───────────────────────────────────────────────────────────────

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT NOT NULL PRIMARY KEY,
    kind         TEXT NOT NULL,
    spec         TEXT NOT NULL,
    next_run     INTEGER,
    last_run     INTEGER,
    last_status  TEXT,
    payload_json TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_kind_created
    ON jobs(kind, created_at);
`

/**
 * Phase 12b (scheduler-rebuild) — DESIGN.md §5.3.
 *
 * Additive columns on `jobs`:
 *   schedule    — cron expression (new code reads this; legacy rows have NULL
 *                  and readers fall back to the v1 `spec` column).
 *   enabled     — 0|1; the ticker skips rows with enabled=0.
 *   next_run_at — when the ticker should next fire this row.
 *
 * New table `job_runs` is a per-fire audit ledger. One row per cron tick
 * (or oneshot dispatch). Closes when the worker reports terminal status.
 *
 * The `idx_jobs_due` index supports the ticker's per-minute `listDue` query;
 * `idx_job_runs_job` supports `listRuns(jobId)`.
 */
const SCHEMA_V2 = `
  ALTER TABLE jobs ADD COLUMN schedule    TEXT;
  ALTER TABLE jobs ADD COLUMN enabled     INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE jobs ADD COLUMN next_run_at INTEGER;
  CREATE INDEX IF NOT EXISTS idx_jobs_due
    ON jobs(enabled, next_run_at);

  CREATE TABLE IF NOT EXISTS job_runs (
    id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT    NOT NULL,
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    status       TEXT    NOT NULL,
    attempt      INTEGER NOT NULL DEFAULT 1,
    output_text  TEXT,
    error        TEXT,
    steps_json   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_job_runs_job
    ON job_runs(job_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_job_runs_status
    ON job_runs(status, started_at DESC);
`

/**
 * job-ticker-oban-deadlines — Oban-style retry counter.
 *
 * `retry_attempt` tracks how many times the CURRENT failure streak has been
 * retried for a recurring job; the JobTicker bumps it on a failed dispatch
 * and resets it to 0 on the next success (see JobTickerOptions.retryBackoff).
 * A plain literal DEFAULT is legal on SQLite's `ADD COLUMN`, so every
 * existing row backfills to 0 without a data migration pass.
 */
const SCHEMA_V3 = `
  ALTER TABLE jobs ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 0;
`

// ── bun:sqlite minimal shape ─────────────────────────────────────────────────

interface BunDb {
  run: (sql: string) => void
  query: (sql: string) => BunStmt
  close: () => void
}
interface BunStmt {
  get: (...p: unknown[]) => unknown
  all: (...p: unknown[]) => unknown[]
  run: (...p: unknown[]) => { changes: number }
}

// ── Service Tag ──────────────────────────────────────────────────────────────

export class JobsStoreService extends Effect.Tag("luna/JobsStoreService")<
  JobsStoreService,
  JobsStoreApi
>() {
  // ── Memory Layer ───────────────────────────────────────────────────────────

  /** Fresh isolated Ref<Map> per build. No SQLite. */
  static Memory: Layer.Layer<JobsStoreService, never, Clock> = Layer.effect(
    JobsStoreService,
    Effect.gen(function* () {
      const clock = yield* Clock
      const store = yield* Ref.make<Map<string, PersistedJob>>(new Map())

      const record: JobsStoreApi["record"] = (input) =>
        Effect.gen(function* () {
          const ts = yield* clock.nowMs()
          const job: PersistedJob = {
            id: input.id,
            kind: input.kind,
            spec: input.spec,
            payload: input.payload,
            nextRun: null,
            lastRun: null,
            lastStatus: null,
            createdAt: ts,
            updatedAt: ts,
            schedule: null,
            enabled: input.enabled ?? true,
            nextRunAt: input.nextRunAt ?? null,
            retryAttempt: 0,
          }
          const existed = yield* Ref.get(store).pipe(
            Effect.map((m) => m.has(input.id)),
          )
          if (existed) {
            return yield* Effect.fail(
              new JobsStoreError({
                op: "record",
                message: `job id ${input.id} already exists`,
              }),
            )
          }
          yield* Ref.update(store, (map) => {
            const next = new Map(map)
            next.set(input.id, job)
            return next
          })
          return job
        })

      const listAll: JobsStoreApi["listAll"] = () =>
        Ref.get(store).pipe(
          Effect.map((map) => {
            const all = Array.from(map.values())
            all.sort((a, b) => a.createdAt - b.createdAt)
            return all as ReadonlyArray<PersistedJob>
          }),
        )

      const getById: JobsStoreApi["getById"] = (id) =>
        Ref.get(store).pipe(Effect.map((map) => map.get(id) ?? null))

      const remove: JobsStoreApi["remove"] = (id) =>
        Ref.modify(store, (map) => {
          if (!map.has(id)) return [false, map] as [boolean, typeof map]
          const next = new Map(map)
          next.delete(id)
          return [true, next] as [boolean, typeof map]
        })

      const touch: JobsStoreApi["touch"] = (id, patch) =>
        Effect.gen(function* () {
          const ts = yield* clock.nowMs()
          return yield* Ref.modify(store, (map) => {
            const existing = map.get(id)
            if (!existing) return [false, map] as [boolean, typeof map]
            const next = new Map(map)
            next.set(id, {
              ...existing,
              nextRun: patch.nextRun !== undefined ? patch.nextRun : existing.nextRun,
              lastRun: patch.lastRun !== undefined ? patch.lastRun : existing.lastRun,
              lastStatus:
                patch.lastStatus !== undefined ? patch.lastStatus : existing.lastStatus,
              updatedAt: ts,
            })
            return [true, next] as [boolean, typeof map]
          })
        })

      // ── V2 method impls (Memory layer) ─────────────────────────────────

      const runs: Map<number, JobRun> = new Map()
      let nextRunId = 1

      const setV2Fields: JobsStoreApi["setV2Fields"] = (id, patch) =>
        Effect.gen(function* () {
          const ts = yield* clock.nowMs()
          return yield* Ref.modify(store, (map) => {
            const existing = map.get(id)
            if (!existing) return [false, map] as [boolean, typeof map]
            const next: PersistedJob = {
              ...existing,
              schedule:
                patch.schedule !== undefined ? patch.schedule : existing.schedule,
              enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
              nextRunAt:
                patch.nextRunAt !== undefined ? patch.nextRunAt : existing.nextRunAt,
              retryAttempt:
                patch.retryAttempt !== undefined
                  ? patch.retryAttempt
                  : existing.retryAttempt,
              updatedAt: ts,
            }
            const m2 = new Map(map)
            m2.set(id, next)
            return [true, m2] as [boolean, typeof map]
          })
        })

      const listDue: JobsStoreApi["listDue"] = (now) =>
        Effect.gen(function* () {
          const map = yield* Ref.get(store)
          return Array.from(map.values())
            .filter(
              (j) =>
                j.enabled === true &&
                (j.nextRunAt === null || j.nextRunAt <= now),
            )
            .sort(
              (a, b) =>
                (a.nextRunAt ?? a.createdAt) - (b.nextRunAt ?? b.createdAt),
            )
        })

      const claim: JobsStoreApi["claim"] = (id, args) =>
        Effect.gen(function* () {
          const ts = yield* clock.nowMs()
          return yield* Ref.modify(store, (map) => {
            const existing = map.get(id)
            if (!existing) return [false, map] as [boolean, typeof map]
            if (existing.lastRun !== args.previousLastRun) {
              return [false, map] as [boolean, typeof map]
            }
            const next: PersistedJob = {
              ...existing,
              lastRun: args.claimAt,
              lastStatus: "running",
              nextRunAt: args.nextRunAt,
              updatedAt: ts,
            }
            const m2 = new Map(map)
            m2.set(id, next)
            return [true, m2] as [boolean, typeof map]
          })
        })

      const recordRunStart: JobsStoreApi["recordRunStart"] = (input) =>
        Effect.sync(() => {
          const id = nextRunId++
          const run: JobRun = {
            id,
            jobId: input.jobId,
            startedAt: input.startedAt,
            finishedAt: null,
            status: "running" as JobRunStatus,
            attempt: input.attempt ?? 1,
            outputText: null,
            error: null,
            stepsJson: null,
          }
          runs.set(id, run)
          return run
        })

      // job-ticker-producer-executor-276 (codex amendment 3) - atomic
      // claim + run-start. `jobs` lives in `store` (a Ref<Map>) but `runs`
      // is a plain (non-Ref) Map - two separate containers, one of which
      // cannot itself be the atomicity boundary. The critic-mandated
      // guarantee is NOT "one Ref.modify region" (impossible here) but
      // "NO yield point between the CAS and the run insert": the entire
      // read-check-write-insert sequence runs inside Ref.modify's plain
      // synchronous updater callback (not `yield*`-driven), so a fiber
      // interrupt cannot land between the claim landing and the run row
      // existing - the exact gap `claim()` + a separate `recordRunStart()`
      // would reopen. A Map.set cannot throw, so there is no "insert failed,
      // roll back the claim" case to model on this layer (that's a SQLite
      // Layer concern - see makeLayer's claimAndStartRun and its BEGIN
      // IMMEDIATE / ROLLBACK).
      const claimAndStartRun: JobsStoreApi["claimAndStartRun"] = (id, args) =>
        Effect.gen(function* () {
          const ts = yield* clock.nowMs()
          let startedRun: JobRun | null = null
          const won = yield* Ref.modify(store, (map) => {
            const existing = map.get(id)
            if (!existing) return [false, map] as [boolean, typeof map]
            if (existing.lastRun !== args.previousLastRun) {
              return [false, map] as [boolean, typeof map]
            }
            const next: PersistedJob = {
              ...existing,
              lastRun: args.claimAt,
              lastStatus: "running",
              nextRunAt: args.nextRunAt,
              updatedAt: ts,
            }
            const m2 = new Map(map)
            m2.set(id, next)
            // Synchronous, no `yield*` between here and the CAS above - the
            // atomicity guarantee this method exists for.
            const runId = nextRunId++
            const run: JobRun = {
              id: runId,
              jobId: id,
              startedAt: args.startedAt,
              finishedAt: null,
              status: "running" as JobRunStatus,
              attempt: args.attempt,
              outputText: null,
              error: null,
              stepsJson: null,
            }
            runs.set(runId, run)
            startedRun = run
            return [true, m2] as [boolean, typeof map]
          })
          if (!won || !startedRun) return null
          return { run: startedRun }
        })

      const recordRunEnd: JobsStoreApi["recordRunEnd"] = (runId, end) =>
        Effect.sync(() => {
          const existing = runs.get(runId)
          if (!existing) return false
          runs.set(runId, {
            ...existing,
            finishedAt: end.finishedAt,
            status: end.status,
            outputText: end.outputText ?? null,
            error: end.error ?? null,
            stepsJson: end.stepsJson ?? null,
          })
          return true
        })

      const updateRunStatus: JobsStoreApi["updateRunStatus"] = (
        runId,
        status,
      ) =>
        Effect.sync(() => {
          const existing = runs.get(runId)
          // Live rows only: a closed run (finishedAt set) must not be
          // resurrected by a late flip-back — mirror the SQLite layer's
          // `AND finished_at IS NULL` guard.
          if (!existing || existing.finishedAt !== null) return false
          runs.set(runId, { ...existing, status })
          return true
        })

      const listRuns: JobsStoreApi["listRuns"] = (jobId, limit = 25) =>
        Effect.sync(() =>
          Array.from(runs.values())
            .filter((r) => r.jobId === jobId)
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, limit),
        )

      const pruneRuns: JobsStoreApi["pruneRuns"] = (cutoffMs) =>
        Effect.sync(() => {
          let deleted = 0
          for (const [id, run] of runs) {
            if (run.finishedAt !== null && run.finishedAt < cutoffMs) {
              runs.delete(id)
              deleted++
            }
          }
          return deleted
        })

      const closeOrphanedRuns: JobsStoreApi["closeOrphanedRuns"] = (args) =>
        Effect.sync(() => {
          let closed = 0
          for (const [id, run] of runs) {
            if (run.finishedAt === null) {
              runs.set(id, {
                ...run,
                status: "cancelled",
                finishedAt: args.finishedAt,
                error: run.error ?? args.error ?? "orphaned (process restart)",
              })
              closed++
            }
          }
          return closed
        })

      return {
        record,
        listAll,
        getById,
        remove,
        touch,
        setV2Fields,
        listDue,
        claim,
        claimAndStartRun,
        recordRunStart,
        recordRunEnd,
        updateRunStatus,
        listRuns,
        pruneRuns,
        closeOrphanedRuns,
      } satisfies JobsStoreApi
    }),
  )

  // ── SQLite Layer factory ───────────────────────────────────────────────────

  /**
   * Build a SQLite-backed JobsStoreService Layer. Mirrors agent-notes.
   * `dbPath` accepts `":memory:"` for ephemeral tests.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<JobsStoreService, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      JobsStoreService,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap

        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "jobs-store",
              key: "bun:sqlite",
              message: `failed to import bun:sqlite: ${String(cause)}`,
            }),
        })
        const Database = (mod as { Database?: unknown }).Database as
          | (new (p: string) => BunDb)
          | undefined
        if (!Database) {
          return yield* Effect.fail(
            new ConfigError({
              module: "jobs-store",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }
        const db = new Database(dbPath)

        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")
        db.run("PRAGMA foreign_keys = ON")

        const nowMs = yield* clock.nowMs()
        ensureSchemaVersions(db)
        applyMigration(db, "jobs", 1, SCHEMA_V1, nowMs)
        applyMigration(db, "jobs", 2, SCHEMA_V2, nowMs)
        applyMigration(db, "jobs", 3, SCHEMA_V3, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements — V1 columns
        const insertStmt = db.query(
          // enabled + next_run_at are bound explicitly so a caller can create a
          // row already armed (atomic) rather than record()+setV2Fields().
          `INSERT INTO jobs
             (id, kind, spec, next_run, last_run, last_status, payload_json, created_at, updated_at, enabled, next_run_at)
           VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
        )
        // V2 SELECT includes the additive columns (schedule, enabled, next_run_at);
        // V3 adds retry_attempt (job-ticker-oban-deadlines).
        const SELECT_COLS =
          "id, kind, spec, next_run, last_run, last_status, payload_json, " +
          "created_at, updated_at, schedule, enabled, next_run_at, retry_attempt"
        const listAllStmt = db.query(
          `SELECT ${SELECT_COLS} FROM jobs ORDER BY created_at ASC`,
        )
        const byIdStmt = db.query(
          `SELECT ${SELECT_COLS} FROM jobs WHERE id = ?`,
        )
        const deleteStmt = db.query(`DELETE FROM jobs WHERE id = ?`)
        // CASE-WHEN sentinel (not COALESCE): a leading 0|1 "present?" flag per
        // column lets an explicit NULL CLEAR the field while an omitted key
        // leaves it untouched — matching the Memory layer's `!== undefined`
        // semantics. COALESCE(?, col) cannot tell "set NULL" from "omit".
        const touchStmt = db.query(
          `UPDATE jobs
              SET next_run    = CASE WHEN ? = 1 THEN ? ELSE next_run END,
                  last_run    = CASE WHEN ? = 1 THEN ? ELSE last_run END,
                  last_status = CASE WHEN ? = 1 THEN ? ELSE last_status END,
                  updated_at  = ?
            WHERE id = ?`,
        )
        const existsStmt = db.query(`SELECT 1 FROM jobs WHERE id = ? LIMIT 1`)

        // Prepared statements — V2 (jobs additive cols + job_runs ledger).
        // CASE-WHEN sentinel: each column carries a leading 0|1 "present?" flag
        // so an explicit NULL CLEARS it (e.g. resetting next_run_at) while an
        // omitted key leaves it untouched. COALESCE(?, col) treated NULL as
        // "omit", so the SQLite layer could never clear a field and silently
        // diverged from the Memory layer (which honours null-clears).
        const setV2FieldsStmt = db.query(
          `UPDATE jobs
              SET schedule      = CASE WHEN ? = 1 THEN ? ELSE schedule END,
                  enabled       = CASE WHEN ? = 1 THEN ? ELSE enabled END,
                  next_run_at   = CASE WHEN ? = 1 THEN ? ELSE next_run_at END,
                  retry_attempt = CASE WHEN ? = 1 THEN ? ELSE retry_attempt END,
                  updated_at    = ?
            WHERE id = ?`,
        )
        const listDueStmt = db.query(
          `SELECT ${SELECT_COLS} FROM jobs
            WHERE enabled = 1
              AND (next_run_at IS NULL OR next_run_at <= ?)
            ORDER BY COALESCE(next_run_at, created_at) ASC`,
        )
        // Atomic claim: only succeeds when the row's last_run is still the
        // value the caller saw at read time (or both are NULL). Returns the
        // raw .changes count which the API maps to a boolean.
        const claimEqStmt = db.query(
          `UPDATE jobs
              SET last_run    = ?,
                  last_status = 'running',
                  next_run_at = ?,
                  updated_at  = ?
            WHERE id = ? AND last_run IS ?`,
        )
        const runStartStmt = db.query(
          `INSERT INTO job_runs (job_id, started_at, finished_at, status, attempt)
           VALUES (?, ?, NULL, 'running', ?)
           RETURNING id`,
        )
        const runEndStmt = db.query(
          `UPDATE job_runs
              SET finished_at = ?,
                  status      = ?,
                  output_text = ?,
                  error       = ?,
                  steps_json  = ?
            WHERE id = ?`,
        )
        // Live-status flip (running↔waiting). `finished_at IS NULL` guards
        // against a late flip-back resurrecting a row recordRunEnd already
        // closed (e.g. the SDK turn timed out while the run was waiting).
        const runStatusStmt = db.query(
          `UPDATE job_runs
              SET status = ?
            WHERE id = ? AND finished_at IS NULL`,
        )
        const listRunsStmt = db.query(
          `SELECT id, job_id, started_at, finished_at, status, attempt,
                  output_text, error, steps_json
             FROM job_runs
            WHERE job_id = ?
            ORDER BY started_at DESC
            LIMIT ?`,
        )
        // Retention sweep: only CLOSED rows (finished_at NOT NULL) are
        // eligible — an in-flight run is never deleted out from under a worker.
        const pruneRunsStmt = db.query(
          `DELETE FROM job_runs
            WHERE finished_at IS NOT NULL AND finished_at < ?`,
        )
        // Crash recovery: close every in-flight row (finished_at NULL). Keeps
        // any pre-existing error (COALESCE) so a partial worker error survives.
        const closeOrphanStmt = db.query(
          `UPDATE job_runs
              SET status      = 'cancelled',
                  finished_at = ?,
                  error       = COALESCE(error, ?)
            WHERE finished_at IS NULL`,
        )

        type RawRow = {
          id: string
          kind: string
          spec: string
          next_run: number | null
          last_run: number | null
          last_status: string | null
          payload_json: string
          created_at: number
          updated_at: number
          schedule: string | null
          enabled: number
          next_run_at: number | null
          retry_attempt: number
        }
        type RawRunRow = {
          id: number
          job_id: string
          started_at: number
          finished_at: number | null
          status: string
          attempt: number
          output_text: string | null
          error: string | null
          steps_json: string | null
        }

        // Returns null (never throws) when payload_json is unparseable. This
        // is shared by listAll (the workflow gallery) AND listDue (the
        // JobTicker's due read). A single malformed payload must NOT sink the
        // whole read: throwing here would blank the gallery and — worse —
        // stall dispatch of EVERY scheduled job through listDue. Skip the bad
        // row instead, logging its id so it is locatable (see issue #232).
        const rowToJob = (row: RawRow): PersistedJob | null => {
          let payload: PersistedJob["payload"]
          try {
            payload = JSON.parse(row.payload_json) as PersistedJob["payload"]
          } catch (cause) {
            console.warn(
              `[jobs-store] skipping job "${row.id}": unparseable payload_json: ${String(cause)}`,
            )
            return null
          }
          return {
            id: row.id,
            kind: row.kind as JobKind,
            spec: row.spec,
            payload,
            nextRun: row.next_run,
            lastRun: row.last_run,
            lastStatus: row.last_status,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            schedule: row.schedule,
            enabled: row.enabled !== 0,
            nextRunAt: row.next_run_at,
            retryAttempt: row.retry_attempt,
          }
        }
        const rowToRun = (row: RawRunRow): JobRun => ({
          id: row.id,
          jobId: row.job_id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          status: row.status as JobRunStatus,
          attempt: row.attempt,
          outputText: row.output_text,
          error: row.error,
          stepsJson: row.steps_json,
        })

        const record: JobsStoreApi["record"] = (input) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            const existing = existsStmt.get(input.id)
            if (existing) {
              return yield* Effect.fail(
                new JobsStoreError({
                  op: "record",
                  message: `job id ${input.id} already exists`,
                }),
              )
            }
            const payloadJson = JSON.stringify(input.payload)
            const enabledVal = (input.enabled ?? true) ? 1 : 0
            const nextRunAtVal = input.nextRunAt ?? null
            try {
              db.run("BEGIN IMMEDIATE")
              insertStmt.run(
                input.id,
                input.kind,
                input.spec,
                payloadJson,
                ts,
                ts,
                enabledVal,
                nextRunAtVal,
              )
              db.run("COMMIT")
            } catch (e) {
              try {
                db.run("ROLLBACK")
              } catch {
                /* best-effort */
              }
              return yield* Effect.fail(
                new JobsStoreError({
                  op: "record",
                  message: String(e),
                  cause: e,
                }),
              )
            }
            return {
              id: input.id,
              kind: input.kind,
              spec: input.spec,
              payload: input.payload,
              nextRun: null,
              lastRun: null,
              lastStatus: null,
              createdAt: ts,
              updatedAt: ts,
              schedule: null,
              enabled: input.enabled ?? true,
              nextRunAt: input.nextRunAt ?? null,
              retryAttempt: 0,
            } satisfies PersistedJob
          })

        const listAll: JobsStoreApi["listAll"] = () =>
          Effect.try({
            try: () =>
              (listAllStmt.all() as RawRow[])
                .map(rowToJob)
                .filter((j): j is PersistedJob => j !== null),
            catch: (cause) =>
              new JobsStoreError({ op: "list", message: String(cause), cause }),
          })

        const getById: JobsStoreApi["getById"] = (id) =>
          Effect.try({
            try: () => {
              const row = byIdStmt.get(id) as RawRow | undefined
              return row ? rowToJob(row) : null
            },
            catch: (cause) =>
              new JobsStoreError({ op: "list", message: String(cause), cause }),
          })

        const remove: JobsStoreApi["remove"] = (id) =>
          Effect.try({
            try: () => {
              const result = deleteStmt.run(id)
              return result.changes > 0
            },
            catch: (cause) =>
              new JobsStoreError({ op: "delete", message: String(cause), cause }),
          })

        const touch: JobsStoreApi["touch"] = (id, patch) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            return yield* Effect.try({
              try: () => {
                const result = touchStmt.run(
                  patch.nextRun !== undefined ? 1 : 0,
                  patch.nextRun ?? null,
                  patch.lastRun !== undefined ? 1 : 0,
                  patch.lastRun ?? null,
                  patch.lastStatus !== undefined ? 1 : 0,
                  patch.lastStatus ?? null,
                  ts,
                  id,
                )
                return result.changes > 0
              },
              catch: (cause) =>
                new JobsStoreError({ op: "update", message: String(cause), cause }),
            })
          })

        // ── V2 method impls (SQLite layer) ──────────────────────────────────

        const setV2Fields: JobsStoreApi["setV2Fields"] = (id, patch) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            return yield* Effect.try({
              try: () => {
                const result = setV2FieldsStmt.run(
                  patch.schedule !== undefined ? 1 : 0,
                  patch.schedule ?? null,
                  patch.enabled !== undefined ? 1 : 0,
                  patch.enabled ? 1 : 0,
                  patch.nextRunAt !== undefined ? 1 : 0,
                  patch.nextRunAt ?? null,
                  patch.retryAttempt !== undefined ? 1 : 0,
                  patch.retryAttempt ?? null,
                  ts,
                  id,
                )
                return result.changes > 0
              },
              catch: (cause) =>
                new JobsStoreError({ op: "update", message: String(cause), cause }),
            })
          })

        const listDue: JobsStoreApi["listDue"] = (now) =>
          Effect.try({
            try: () =>
              (listDueStmt.all(now) as RawRow[])
                .map(rowToJob)
                .filter((j): j is PersistedJob => j !== null),
            catch: (cause) =>
              new JobsStoreError({ op: "list", message: String(cause), cause }),
          })

        const claim: JobsStoreApi["claim"] = (id, args) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            return yield* Effect.try({
              try: () => {
                db.run("BEGIN IMMEDIATE")
                try {
                  const result = claimEqStmt.run(
                    args.claimAt,
                    args.nextRunAt ?? null,
                    ts,
                    id,
                    args.previousLastRun,
                  )
                  db.run("COMMIT")
                  return result.changes > 0
                } catch (e) {
                  try { db.run("ROLLBACK") } catch { /* best-effort */ }
                  throw e
                }
              },
              catch: (cause) =>
                new JobsStoreError({ op: "claim", message: String(cause), cause }),
            })
          })

        const recordRunStart: JobsStoreApi["recordRunStart"] = (input) =>
          Effect.try({
            try: () => {
              const attempt = input.attempt ?? 1
              const row = runStartStmt.get(
                input.jobId,
                input.startedAt,
                attempt,
              ) as { id: number } | undefined
              if (!row) throw new Error("RETURNING id produced no row")
              return {
                id: row.id,
                jobId: input.jobId,
                startedAt: input.startedAt,
                finishedAt: null,
                status: "running" as JobRunStatus,
                attempt,
                outputText: null,
                error: null,
                stepsJson: null,
              } satisfies JobRun
            },
            catch: (cause) =>
              new JobsStoreError({ op: "run_start", message: String(cause), cause }),
          })

        // job-ticker-producer-executor-276 (codex amendment 4) - one
        // BEGIN IMMEDIATE wrapping the SAME claim CAS `claim()` uses plus the
        // `job_runs` insert `recordRunStart()` uses. Mirrors the `claim()`
        // transaction shape immediately above: on a thrown error (e.g. the
        // INSERT fails for any reason) the whole transaction - INCLUDING the
        // claim UPDATE that already landed on this connection - rolls back,
        // so there is no observable state where `jobs.last_run` advanced but
        // no `job_runs` row exists for it. A claim-CAS loss (changes===0) is
        // NOT an error: commit the (no-op) transaction and return null, same
        // as `claim()` returning false.
        const claimAndStartRun: JobsStoreApi["claimAndStartRun"] = (id, args) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            return yield* Effect.try({
              try: () => {
                db.run("BEGIN IMMEDIATE")
                try {
                  const claimResult = claimEqStmt.run(
                    args.claimAt,
                    args.nextRunAt ?? null,
                    ts,
                    id,
                    args.previousLastRun,
                  )
                  if (claimResult.changes === 0) {
                    db.run("COMMIT")
                    return null
                  }
                  const row = runStartStmt.get(
                    id,
                    args.startedAt,
                    args.attempt,
                  ) as { id: number } | undefined
                  if (!row) throw new Error("RETURNING id produced no row")
                  db.run("COMMIT")
                  return {
                    run: {
                      id: row.id,
                      jobId: id,
                      startedAt: args.startedAt,
                      finishedAt: null,
                      status: "running" as JobRunStatus,
                      attempt: args.attempt,
                      outputText: null,
                      error: null,
                      stepsJson: null,
                    } satisfies JobRun,
                  }
                } catch (e) {
                  try { db.run("ROLLBACK") } catch { /* best-effort */ }
                  throw e
                }
              },
              catch: (cause) =>
                new JobsStoreError({ op: "claim", message: String(cause), cause }),
            })
          })

        const recordRunEnd: JobsStoreApi["recordRunEnd"] = (runId, end) =>
          Effect.try({
            try: () => {
              const result = runEndStmt.run(
                end.finishedAt,
                end.status,
                end.outputText ?? null,
                end.error ?? null,
                end.stepsJson ?? null,
                runId,
              )
              return result.changes > 0
            },
            catch: (cause) =>
              new JobsStoreError({ op: "run_end", message: String(cause), cause }),
          })

        const updateRunStatus: JobsStoreApi["updateRunStatus"] = (
          runId,
          status,
        ) =>
          Effect.try({
            try: () => runStatusStmt.run(status, runId).changes > 0,
            catch: (cause) =>
              new JobsStoreError({
                op: "run_status",
                message: String(cause),
                cause,
              }),
          })

        const listRuns: JobsStoreApi["listRuns"] = (jobId, limit = 25) =>
          Effect.try({
            try: () => (listRunsStmt.all(jobId, limit) as RawRunRow[]).map(rowToRun),
            catch: (cause) =>
              new JobsStoreError({ op: "list", message: String(cause), cause }),
          })

        const pruneRuns: JobsStoreApi["pruneRuns"] = (cutoffMs) =>
          Effect.try({
            try: () => pruneRunsStmt.run(cutoffMs).changes,
            catch: (cause) =>
              new JobsStoreError({ op: "delete", message: String(cause), cause }),
          })

        const closeOrphanedRuns: JobsStoreApi["closeOrphanedRuns"] = (args) =>
          Effect.try({
            try: () =>
              closeOrphanStmt.run(
                args.finishedAt,
                args.error ?? "orphaned (process restart)",
              ).changes,
            catch: (cause) =>
              new JobsStoreError({ op: "run_end", message: String(cause), cause }),
          })

        return {
          record,
          listAll,
          getById,
          remove,
          touch,
          setV2Fields,
          listDue,
          claim,
          claimAndStartRun,
          recordRunStart,
          recordRunEnd,
          updateRunStatus,
          listRuns,
          pruneRuns,
          closeOrphanedRuns,
        } satisfies JobsStoreApi
      }),
    )
  }
}
