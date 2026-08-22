/**
 * WorkspaceRegistryService — in-memory and SQLite-backed layers.
 *
 * Mirrors `agent-notes.ts` exactly in shape:
 *   - In-memory `Ref<Map<slug, Workspace>>` for tests.
 *   - SQLite layer built on bun:sqlite + `applyMigration` ledger.
 *
 * SYSTEM.md §Workspaces specifies the canonical schema; this module is
 * the runtime that creates the table and exposes a typed API for register
 * / get / list / touch / updateSummary / setStatus / delete.
 *
 * The registry is metadata-only. A workspace's own state lives in its
 * scoped `<path>/.workspace/workspace.db` — that file is opened lazily
 * by code that actually operates inside the workspace, not by the
 * registry.
 */
import { Context, Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import type {
  ListFilter,
  RegisterInput,
  Workspace,
  WorkspaceRegistryApi,
  WorkspaceStatus,
} from "./types.js"
import { WorkspaceError } from "./types.js"

// ── Schema DDL ───────────────────────────────────────────────────────────────

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS workspaces (
    slug        TEXT PRIMARY KEY,
    path        TEXT NOT NULL,
    summary     TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workspaces_status_updated
    ON workspaces(status, updated_at);
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

export class WorkspaceRegistryService extends Context.Service<WorkspaceRegistryService, WorkspaceRegistryApi>()("luna/WorkspaceRegistryService") {
  // ── Memory Layer ───────────────────────────────────────────────────────────

  /**
   * In-memory `Ref<Map<slug, Workspace>>` layer. No SQLite. Used by all
   * unit tests. Provides a fresh isolated registry per run.
   */
  static Memory: Layer.Layer<WorkspaceRegistryService, never, Clock> =
    Layer.effect(
      WorkspaceRegistryService,
      Effect.gen(function* () {
        const clock = yield* Clock
        const store = yield* Ref.make<Map<string, Workspace>>(new Map())

        const register: WorkspaceRegistryApi["register"] = (input) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            const existing = (yield* Ref.get(store)).get(input.slug) ?? null
            const next: Workspace = {
              slug: input.slug,
              path: input.path,
              summary: input.summary ?? null,
              status: input.status ?? existing?.status ?? "active",
              createdAt: existing?.createdAt ?? ts,
              updatedAt: ts,
            }
            yield* Ref.update(store, (map) => {
              const copy = new Map(map)
              copy.set(input.slug, next)
              return copy
            })
            return next
          })

        const get: WorkspaceRegistryApi["get"] = (slug) =>
          Ref.get(store).pipe(Effect.map((map) => map.get(slug) ?? null))

        const list: WorkspaceRegistryApi["list"] = (filter) =>
          Ref.get(store).pipe(
            Effect.map((map) => {
              const rows = Array.from(map.values())
              const filtered =
                filter?.status != null
                  ? rows.filter((w) => w.status === filter.status)
                  : rows
              // Newest-updated first; stable insertion-order tiebreak by reversing first.
              const reversed = filtered.slice().reverse()
              reversed.sort((a, b) => b.updatedAt - a.updatedAt)
              return reversed as ReadonlyArray<Workspace>
            }),
          )

        const mutateOne = (
          slug: string,
          op: WorkspaceError["op"],
          patch: (w: Workspace, ts: number) => Workspace,
        ): Effect.Effect<Workspace | null, WorkspaceError> =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            const current = (yield* Ref.get(store)).get(slug) ?? null
            if (current == null) return null
            const next = patch(current, ts)
            yield* Ref.update(store, (map) => {
              const copy = new Map(map)
              copy.set(slug, next)
              return copy
            })
            return next
          })

        const touch: WorkspaceRegistryApi["touch"] = (slug) =>
          mutateOne(slug, "touch", (w, ts) => ({ ...w, updatedAt: ts }))

        const updateSummary: WorkspaceRegistryApi["updateSummary"] = (
          slug,
          summary,
        ) =>
          mutateOne(slug, "update-summary", (w, ts) => ({
            ...w,
            summary,
            updatedAt: ts,
          }))

        const setStatus: WorkspaceRegistryApi["setStatus"] = (slug, status) =>
          mutateOne(slug, "set-status", (w, ts) => ({
            ...w,
            status,
            updatedAt: ts,
          }))

        const deleteOne: WorkspaceRegistryApi["delete"] = (slug) =>
          Ref.modify(store, (map) => {
            if (!map.has(slug)) return [0, map] as [number, Map<string, Workspace>]
            const copy = new Map(map)
            copy.delete(slug)
            return [1, copy] as [number, Map<string, Workspace>]
          })

        return {
          register,
          get,
          list,
          touch,
          updateSummary,
          setStatus,
          delete: deleteOne,
        } satisfies WorkspaceRegistryApi
      }),
    )

  // ── SQLite Layer factory ───────────────────────────────────────────────────

  /**
   * Build a SQLite-backed WorkspaceRegistryService layer. `dbPath` accepts
   * `":memory:"` for ephemeral tests. Migration is keyed on component
   * `"workspaces"` in `schema_versions` so it runs exactly once per DB.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<
    WorkspaceRegistryService,
    ConfigError,
    Clock | LunaSqliteBootstrap
  > {
    return Layer.effect(
      WorkspaceRegistryService,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap

        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () =>
            import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "workspaces",
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
              module: "workspaces",
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
        applyMigration(db, "workspaces", 1, SCHEMA_V1, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements
        const getStmt = db.query(
          `SELECT slug, path, summary, status, created_at, updated_at
           FROM workspaces WHERE slug = ?`,
        )
        const listAllStmt = db.query(
          `SELECT slug, path, summary, status, created_at, updated_at
           FROM workspaces ORDER BY updated_at DESC`,
        )
        const listByStatusStmt = db.query(
          `SELECT slug, path, summary, status, created_at, updated_at
           FROM workspaces WHERE status = ? ORDER BY updated_at DESC`,
        )
        // Upsert: preserve created_at on conflict, refresh everything else.
        const upsertStmt = db.query(
          `INSERT INTO workspaces (slug, path, summary, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET
             path = excluded.path,
             summary = excluded.summary,
             status = excluded.status,
             updated_at = excluded.updated_at`,
        )
        const touchStmt = db.query(
          `UPDATE workspaces SET updated_at = ? WHERE slug = ?`,
        )
        const updateSummaryStmt = db.query(
          `UPDATE workspaces SET summary = ?, updated_at = ? WHERE slug = ?`,
        )
        const setStatusStmt = db.query(
          `UPDATE workspaces SET status = ?, updated_at = ? WHERE slug = ?`,
        )
        const deleteStmt = db.query(`DELETE FROM workspaces WHERE slug = ?`)

        type RawRow = {
          slug: string
          path: string
          summary: string | null
          status: string
          created_at: number
          updated_at: number
        }

        const rowToWorkspace = (row: RawRow): Workspace => ({
          slug: row.slug,
          path: row.path,
          summary: row.summary,
          status: row.status as WorkspaceStatus,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })

        const fetchOne = (slug: string): Workspace | null => {
          const row = getStmt.get(slug) as RawRow | undefined | null
          return row != null ? rowToWorkspace(row) : null
        }

        const register: WorkspaceRegistryApi["register"] = (input) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            const existing = fetchOne(input.slug)
            const status = input.status ?? existing?.status ?? "active"
            const createdAt = existing?.createdAt ?? ts
            db.run("BEGIN IMMEDIATE")
            try {
              upsertStmt.run(
                input.slug,
                input.path,
                input.summary ?? null,
                status,
                createdAt,
                ts,
              )
              db.run("COMMIT")
            } catch (e) {
              try {
                db.run("ROLLBACK")
              } catch {
                /* best-effort */
              }
              return yield* Effect.fail(
                new WorkspaceError({
                  op: "register",
                  message: String(e),
                  cause: e,
                }),
              )
            }
            return {
              slug: input.slug,
              path: input.path,
              summary: input.summary ?? null,
              status,
              createdAt,
              updatedAt: ts,
            } satisfies Workspace
          })

        const get: WorkspaceRegistryApi["get"] = (slug) =>
          Effect.try({
            try: () => fetchOne(slug),
            catch: (cause) =>
              new WorkspaceError({ op: "get", message: String(cause), cause }),
          })

        const list: WorkspaceRegistryApi["list"] = (filter) =>
          Effect.try({
            try: () => {
              const rows =
                filter?.status != null
                  ? (listByStatusStmt.all(filter.status) as RawRow[])
                  : (listAllStmt.all() as RawRow[])
              return rows.map(rowToWorkspace) as ReadonlyArray<Workspace>
            },
            catch: (cause) =>
              new WorkspaceError({ op: "list", message: String(cause), cause }),
          })

        const runWriteAndFetch = (
          op: WorkspaceError["op"],
          slug: string,
          write: (ts: number) => void,
        ): Effect.Effect<Workspace | null, WorkspaceError> =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            const before = fetchOne(slug)
            if (before == null) return null
            return yield* Effect.try({
              try: () => {
                db.run("BEGIN IMMEDIATE")
                try {
                  write(ts)
                  db.run("COMMIT")
                } catch (e) {
                  try {
                    db.run("ROLLBACK")
                  } catch {
                    /* best-effort */
                  }
                  throw e
                }
                return fetchOne(slug)
              },
              catch: (cause) =>
                new WorkspaceError({ op, message: String(cause), cause }),
            })
          })

        const touch: WorkspaceRegistryApi["touch"] = (slug) =>
          runWriteAndFetch("touch", slug, (ts) => {
            touchStmt.run(ts, slug)
          })

        const updateSummary: WorkspaceRegistryApi["updateSummary"] = (
          slug,
          summary,
        ) =>
          runWriteAndFetch("update-summary", slug, (ts) => {
            updateSummaryStmt.run(summary, ts, slug)
          })

        const setStatus: WorkspaceRegistryApi["setStatus"] = (slug, status) =>
          runWriteAndFetch("set-status", slug, (ts) => {
            setStatusStmt.run(status, ts, slug)
          })

        const deleteOne: WorkspaceRegistryApi["delete"] = (slug) =>
          Effect.try({
            try: () => {
              db.run("BEGIN IMMEDIATE")
              try {
                const result = deleteStmt.run(slug)
                db.run("COMMIT")
                return result.changes
              } catch (e) {
                try {
                  db.run("ROLLBACK")
                } catch {
                  /* best-effort */
                }
                throw e
              }
            },
            catch: (cause) =>
              new WorkspaceError({
                op: "delete",
                message: String(cause),
                cause,
              }),
          })

        return {
          register,
          get,
          list,
          touch,
          updateSummary,
          setStatus,
          delete: deleteOne,
        } satisfies WorkspaceRegistryApi
      }),
    )
  }
}
