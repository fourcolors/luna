/**
 * SQLite MemoryBackend — uses bun's native `bun:sqlite` driver.
 *
 * We wrap `bun:sqlite` directly rather than @effect/sql-sqlite-bun to avoid
 * committing the monorepo to the @effect/sql v3→v4 churn during Phase 5.
 * When effect/sql stabilizes on v4, this file is a ~50 line translation.
 *
 * Schema (DESIGN.md §5.1 extended — original `memory_keyed(k,v,ts,tags)` was
 * too flat; we add namespace/kind/id/schema_version so records round-trip
 * through the MemoryExport envelope without lossy encoding):
 *
 *   CREATE TABLE memory_keyed (
 *     id              TEXT PRIMARY KEY,
 *     namespace       TEXT NOT NULL,
 *     kind            TEXT NOT NULL,
 *     content_json    TEXT NOT NULL,
 *     schema_version  INTEGER NOT NULL,
 *     created_at      INTEGER NOT NULL,
 *     updated_at      INTEGER NOT NULL,
 *     tags_json       TEXT NOT NULL
 *   );
 *   CREATE INDEX idx_memory_ns ON memory_keyed(namespace);
 *   CREATE INDEX idx_memory_kind ON memory_keyed(kind);
 *   CREATE INDEX idx_memory_updated ON memory_keyed(updated_at);
 *
 * Tests that don't run under bun skip this backend (it's gated by the
 * runtime check). CI and `bun test` exercise it; `node` / stock vitest fall
 * through without error.
 */
import { Effect, Layer, Stream } from "effect"
import { MemoryBackendError } from "@luna/core"
import {
  MEMORY_ENVELOPE_VERSION,
  matchesQuery,
  type MemoryExport,
  type MemoryQuery,
  type MemoryRecord,
} from "../types.js"

export interface SqliteBackendApi {
  readonly backendName: "sqlite"
  readonly put: (rec: MemoryRecord) => Effect.Effect<void, MemoryBackendError>
  readonly get: (
    id: string,
  ) => Effect.Effect<MemoryRecord | null, MemoryBackendError>
  readonly query: (q: MemoryQuery) => Stream.Stream<MemoryRecord, MemoryBackendError>
  readonly delete: (id: string) => Effect.Effect<boolean, MemoryBackendError>
  readonly exportAll: () => Effect.Effect<MemoryExport, MemoryBackendError>
  readonly importAll: (
    env: MemoryExport,
  ) => Effect.Effect<number, MemoryBackendError>
  readonly close: () => Effect.Effect<void>
}

interface DbRow {
  id: string
  namespace: string
  kind: string
  content_json: string
  schema_version: number
  created_at: number
  updated_at: number
  tags_json: string
}

function rowToRecord(row: DbRow): MemoryRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    kind: row.kind,
    content: JSON.parse(row.content_json),
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags_json) as ReadonlyArray<string>,
  }
}

function asError(op: string, cause: unknown): MemoryBackendError {
  return new MemoryBackendError({ backend: "sqlite", op, cause })
}

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS memory_keyed (
    id              TEXT PRIMARY KEY,
    namespace       TEXT NOT NULL,
    kind            TEXT NOT NULL,
    content_json    TEXT NOT NULL,
    schema_version  INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    tags_json       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_ns ON memory_keyed(namespace);
  CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_keyed(kind);
  CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_keyed(updated_at);
`

export class SqliteBackend extends Effect.Tag("luna/SqliteBackend")<
  SqliteBackend,
  SqliteBackendApi
>() {
  /**
   * Build a sqlite-backed Layer. `dbPath` can be `":memory:"` for ephemeral
   * databases (ideal for tests).
   */
  static fromPath(
    dbPath: string,
  ): Layer.Layer<SqliteBackend, MemoryBackendError> {
    return Layer.scoped(
      SqliteBackend,
      Effect.gen(function* () {
        // Dynamic import so stock-vitest-under-node users don't hard-fail
        // at import time; they'll fail at Layer construction instead with
        // a clean MemoryBackendError.
        // Use a runtime-computed specifier to avoid TS type resolution
        // on `bun:sqlite` (types live in @types/bun; we don't install).
        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () =>
            (import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>),
          catch: (cause) => asError("import", cause),
        })
        const Database = (mod as { default?: unknown; Database?: unknown })
          .Database as new (p: string) => {
            run: (sql: string) => void
            query: (sql: string) => {
              get: (...p: unknown[]) => unknown
              all: (...p: unknown[]) => unknown[]
              run: (...p: unknown[]) => { changes: number }
            }
            close: () => void
          }

        if (!Database) {
          yield* Effect.fail(
            asError("import", new Error("bun:sqlite has no Database export")),
          )
        }

        const db = new Database(dbPath)
        db.run(MIGRATION)
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        const putStmt = db.query(
          `INSERT OR REPLACE INTO memory_keyed
             (id, namespace, kind, content_json, schema_version,
              created_at, updated_at, tags_json)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        const getStmt = db.query(`SELECT * FROM memory_keyed WHERE id = ?`)
        const delStmt = db.query(`DELETE FROM memory_keyed WHERE id = ?`)
        const selectAllStmt = db.query(
          `SELECT * FROM memory_keyed ORDER BY updated_at DESC`,
        )

        const put: SqliteBackendApi["put"] = (rec) =>
          Effect.try({
            try: () => {
              putStmt.run(
                rec.id,
                rec.namespace,
                rec.kind,
                JSON.stringify(rec.content),
                rec.schemaVersion,
                rec.createdAt,
                rec.updatedAt,
                JSON.stringify(rec.tags),
              )
            },
            catch: (cause) => asError("put", cause),
          })

        const get: SqliteBackendApi["get"] = (id) =>
          Effect.try({
            try: () => {
              const row = getStmt.get(id) as DbRow | null | undefined
              return row ? rowToRecord(row) : null
            },
            catch: (cause) => asError("get", cause),
          })

        const query: SqliteBackendApi["query"] = (q) => {
          // Simple table-scan + in-memory filter. Index support for
          // namespace/kind is there; tag filter is JSON so it scans.
          // Good enough for Phase 5 — optimize later.
          try {
            const rows = selectAllStmt.all() as DbRow[]
            const matches = rows
              .map(rowToRecord)
              .filter((r) => matchesQuery(r, q))
            const limited = q.limit ? matches.slice(0, q.limit) : matches
            return Stream.fromIterable(limited)
          } catch (cause) {
            return Stream.fail(asError("query", cause))
          }
        }

        const del: SqliteBackendApi["delete"] = (id) =>
          Effect.try({
            try: () => delStmt.run(id).changes > 0,
            catch: (cause) => asError("delete", cause),
          })

        const exportAll: SqliteBackendApi["exportAll"] = () =>
          Effect.try({
            try: () => {
              const rows = selectAllStmt.all() as DbRow[]
              return {
                backend: "sqlite" as const,
                envelopeVersion: MEMORY_ENVELOPE_VERSION,
                exportedAt: Date.now(),
                records: rows.map(rowToRecord),
              }
            },
            catch: (cause) => asError("exportAll", cause),
          })

        const importAll: SqliteBackendApi["importAll"] = (env) =>
          Effect.gen(function* () {
            let n = 0
            for (const rec of env.records) {
              yield* put(rec)
              n++
            }
            return n
          })

        return {
          backendName: "sqlite" as const,
          put,
          get,
          query,
          delete: del,
          exportAll,
          importAll,
          close: () => Effect.sync(() => db.close()),
        }
      }),
    )
  }
}
