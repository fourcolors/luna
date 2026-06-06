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
import type { JobKind, JobsStoreApi, PersistedJob } from "./jobs-store-types.js"
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

      return { record, listAll, getById, remove, touch } satisfies JobsStoreApi
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

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements
        const insertStmt = db.query(
          `INSERT INTO jobs
             (id, kind, spec, next_run, last_run, last_status, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        )
        const listAllStmt = db.query(
          `SELECT id, kind, spec, next_run, last_run, last_status, payload_json, created_at, updated_at
           FROM jobs
           ORDER BY created_at ASC`,
        )
        const byIdStmt = db.query(
          `SELECT id, kind, spec, next_run, last_run, last_status, payload_json, created_at, updated_at
           FROM jobs
           WHERE id = ?`,
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

        return { record, listAll, getById, remove, touch } satisfies JobsStoreApi
      }),
    )
  }
}
