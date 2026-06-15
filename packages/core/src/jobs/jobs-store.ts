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
            enabled: true,
            nextRunAt: null,
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
          const map = yield* Ref.get(store)
          const existing = map.get(id)
          if (!existing) return false
          const next: PersistedJob = {
            ...existing,
            schedule: patch.schedule !== undefined ? patch.schedule : existing.schedule,
            enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
            nextRunAt:
              patch.nextRunAt !== undefined ? patch.nextRunAt : existing.nextRunAt,
            updatedAt: ts,
          }
          const m2 = new Map(map)
          m2.set(id, next)
          yield* Ref.set(store, m2)
          return true
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
          const map = yield* Ref.get(store)
          const existing = map.get(id)
          if (!existing) return false
          if (existing.lastRun !== args.previousLastRun) return false
          const next: PersistedJob = {
            ...existing,
            lastRun: args.claimAt,
            lastStatus: "running",
            nextRunAt: args.nextRunAt,
            updatedAt: ts,
          }
          const m2 = new Map(map)
          m2.set(id, next)
          yield* Ref.set(store, m2)
          return true
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

      return {
        record,
        listAll,
        getById,
        remove,
        touch,
        setV2Fields,
        listDue,
        claim,
        recordRunStart,
        recordRunEnd,
        updateRunStatus,
        listRuns,
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

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements — V1 columns
        const insertStmt = db.query(
          `INSERT INTO jobs
             (id, kind, spec, next_run, last_run, last_status, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        )
        // V2 SELECT includes the additive columns (schedule, enabled, next_run_at).
        const SELECT_COLS =
          "id, kind, spec, next_run, last_run, last_status, payload_json, " +
          "created_at, updated_at, schedule, enabled, next_run_at"
        const listAllStmt = db.query(
          `SELECT ${SELECT_COLS} FROM jobs ORDER BY created_at ASC`,
        )
        const byIdStmt = db.query(
          `SELECT ${SELECT_COLS} FROM jobs WHERE id = ?`,
        )
        const deleteStmt = db.query(`DELETE FROM jobs WHERE id = ?`)
        const touchStmt = db.query(
          `UPDATE jobs
              SET next_run = COALESCE(?, next_run),
                  last_run = COALESCE(?, last_run),
                  last_status = COALESCE(?, last_status),
                  updated_at = ?
            WHERE id = ?`,
        )
        const existsStmt = db.query(`SELECT 1 FROM jobs WHERE id = ? LIMIT 1`)

        // Prepared statements — V2 (jobs additive cols + job_runs ledger).
        const setV2FieldsStmt = db.query(
          // Use sentinel sub-selects so a partial patch only touches the
          // requested columns. `?` bound to NULL leaves the existing value.
          `UPDATE jobs
              SET schedule    = COALESCE(?, schedule),
                  enabled     = COALESCE(?, enabled),
                  next_run_at = COALESCE(?, next_run_at),
                  updated_at  = ?
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

        const rowToJob = (row: RawRow): PersistedJob => ({
          id: row.id,
          kind: row.kind as JobKind,
          spec: row.spec,
          payload: JSON.parse(row.payload_json) as PersistedJob["payload"],
          nextRun: row.next_run,
          lastRun: row.last_run,
          lastStatus: row.last_status,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          schedule: row.schedule,
          enabled: row.enabled !== 0,
          nextRunAt: row.next_run_at,
        })
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
            try {
              db.run("BEGIN IMMEDIATE")
              insertStmt.run(input.id, input.kind, input.spec, payloadJson, ts, ts)
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
              enabled: true,
              nextRunAt: null,
            } satisfies PersistedJob
          })

        const listAll: JobsStoreApi["listAll"] = () =>
          Effect.try({
            try: () => (listAllStmt.all() as RawRow[]).map(rowToJob),
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
                  patch.nextRun ?? null,
                  patch.lastRun ?? null,
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
                  patch.schedule ?? null,
                  patch.enabled === undefined ? null : patch.enabled ? 1 : 0,
                  patch.nextRunAt ?? null,
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
            try: () => (listDueStmt.all(now) as RawRow[]).map(rowToJob),
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

        return {
          record,
          listAll,
          getById,
          remove,
          touch,
          setV2Fields,
          listDue,
          claim,
          recordRunStart,
          recordRunEnd,
          updateRunStatus,
          listRuns,
        } satisfies JobsStoreApi
      }),
    )
  }
}
