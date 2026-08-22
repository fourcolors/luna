/**
 * SessionHistoryService — SQLite-backed session transcript store (Phase 28).
 *
 * Replaces the DuckDB stub. Uses `bun:sqlite` exactly like
 * `telemetry-store-sqlite.ts` — same bootstrap ordering, same migration
 * ladder, same finalizer discipline.
 *
 * Storage model:
 *   - `session_history(uuid PK, type, entrypoint, session_id, …)` is
 *     canonical. Every record/query/getSession/deleteOlderThan call goes
 *     directly to prepared statements — no in-memory Ref mirror.
 *   - `idx_session_history_session_ts` covers (session_id, timestamp DESC)
 *     for efficient per-session queries.
 *   - `idx_session_history_tool_name` covers filtered toolName lookups.
 *
 * Architecture:
 *   - `makeLayer(dbPath)` — Layer.effect. Pulls `LunaSqliteBootstrap`
 *     first (process-wide setCustomSQLite), opens DB, runs migrations via
 *     `ensureSchemaVersions + applyMigration`, registers `db.close`
 *     finalizer (LIFO §3.4 #4). Then prepares statements.
 *   - `Memory` — Ref-backed ephemeral layer for tests. Zero SQLite deps.
 *
 * Invariants:
 *   §1         — no raw Promises at module boundaries; all API methods
 *                return Effect.Effect.
 *   §3.4 #4   — Layer.effect + finalizer registered FIRST.
 *   §5.2       — per-component schema_versions ledger (Phase 25e), idempotent.
 *   §6         — ConfigError raised at boot if bun:sqlite unavailable.
 */

import { Context, Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import type {
  SessionHistoryApi,
  SessionRecord,
  SessionRecordInput,
  SessionHistoryQuery,
} from "./types.js"
import { SessionHistoryError } from "./types.js"

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

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS session_history (
    uuid          TEXT NOT NULL PRIMARY KEY,
    type          TEXT NOT NULL CHECK(type IN ('user', 'assistant', 'system')),
    entrypoint    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    parent_uuid   TEXT,
    timestamp     TEXT NOT NULL,
    request_id    TEXT,
    tool_use_id   TEXT,
    text_content  TEXT NOT NULL,
    tool_name     TEXT,
    skill_name    TEXT,
    created_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_session_history_session_ts
    ON session_history(session_id, timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_session_history_tool_name
    ON session_history(tool_name)
    WHERE tool_name IS NOT NULL;
`

// ── Row → SessionRecord mapper ────────────────────────────────────────────────

interface RawRow {
  uuid: string
  type: string
  entrypoint: string
  session_id: string
  parent_uuid: string | null
  timestamp: string
  request_id: string | null
  tool_use_id: string | null
  text_content: string
  tool_name: string | null
  skill_name: string | null
  created_at: string
}

const rowToRecord = (r: RawRow): SessionRecord => {
  const rec: SessionRecord = {
    uuid: r.uuid,
    type: r.type as SessionRecord["type"],
    entrypoint: r.entrypoint,
    sessionId: r.session_id,
    timestamp: r.timestamp,
    textContent: r.text_content,
    created_at: r.created_at,
  }
  // exactOptionalPropertyTypes: only set optional fields when present
  if (r.parent_uuid != null) (rec as { parentUuid?: string }).parentUuid = r.parent_uuid
  if (r.request_id != null) (rec as { requestId?: string }).requestId = r.request_id
  if (r.tool_use_id != null) (rec as { toolUseId?: string }).toolUseId = r.tool_use_id
  if (r.tool_name != null) (rec as { toolName?: string }).toolName = r.tool_name
  if (r.skill_name != null) (rec as { skillName?: string }).skillName = r.skill_name
  return rec
}

// ── Crypto: uuid v4 ───────────────────────────────────────────────────────────

const randomUuid = (): string => crypto.randomUUID()

// ── Service class ─────────────────────────────────────────────────────────────

export class SessionHistoryService extends Context.Service<SessionHistoryService, SessionHistoryApi>()("SessionHistoryService") {
  /**
   * SQLite-backed Layer. `dbPath` may be `":memory:"` for ephemeral use.
   * Requires `Clock` and `LunaSqliteBootstrap` in the environment.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<SessionHistoryService, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.effect(
      SessionHistoryService,
      Effect.gen(function* () {
        // Pull bootstrap marker BEFORE opening any Database so the
        // process-wide setCustomSQLite swap has run (Phase 27a).
        yield* LunaSqliteBootstrap

        const clock = yield* Clock

        // Dynamic import — insulates stock-node vitest from hard-failing
        // at module load (mirrors telemetry-store-sqlite.ts).
        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "session-history",
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
              module: "session-history",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }

        const db = new Database(dbPath)

        // Pragmas before any writes.
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")
        db.run("PRAGMA foreign_keys = ON")

        // §5.2 migration ladder.
        const nowMs = yield* clock.nowMs()
        ensureSchemaVersions(db)
        applyMigration(db, "session-history", 1, SCHEMA_V1, nowMs)

        // §3.4 #4 LIFO: register db.close finalizer first.
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements.
        const insertStmt = db.query(`
          INSERT INTO session_history
            (uuid, type, entrypoint, session_id, parent_uuid, timestamp,
             request_id, tool_use_id, text_content, tool_name, skill_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        const selectBySession = db.query(`
          SELECT * FROM session_history
          WHERE session_id = ?
          ORDER BY timestamp ASC
        `)

        const deleteOldStmt = db.query(`
          DELETE FROM session_history
          WHERE CAST(strftime('%s', timestamp) * 1000 AS INTEGER) < ?
        `)

        // ── API implementation ────────────────────────────────────────────

        const record: SessionHistoryApi["record"] = (entry: SessionRecordInput) =>
          Effect.gen(function* () {
            const uuid = randomUuid()
            const createdAt = yield* clock.nowIso()
            return yield* Effect.try({
              try: () => {
                insertStmt.run(
                  uuid,
                  entry.type,
                  entry.entrypoint,
                  entry.sessionId,
                  entry.parentUuid ?? null,
                  entry.timestamp,
                  entry.requestId ?? null,
                  entry.toolUseId ?? null,
                  entry.textContent,
                  entry.toolName ?? null,
                  entry.skillName ?? null,
                  createdAt,
                )
                return uuid
              },
              catch: (cause) =>
                new SessionHistoryError({
                  op: "record",
                  message: `insert failed: ${String(cause)}`,
                  cause,
                }),
            })
          })

        const query: SessionHistoryApi["query"] = (q: SessionHistoryQuery) =>
          Effect.try({
            try: () => {
              // Build a dynamic WHERE clause from the query filters.
              const conditions: string[] = []
              const params: unknown[] = []

              if (q.sessionId !== undefined) {
                conditions.push("session_id = ?")
                params.push(q.sessionId)
              }
              if (q.type !== undefined) {
                conditions.push("type = ?")
                params.push(q.type)
              }
              if (q.toolName !== undefined) {
                conditions.push("tool_name = ?")
                params.push(q.toolName)
              }
              if (q.skillName !== undefined) {
                conditions.push("skill_name = ?")
                params.push(q.skillName)
              }

              const where =
                conditions.length > 0
                  ? `WHERE ${conditions.join(" AND ")}`
                  : ""
              const limitClause =
                q.limit !== undefined ? `LIMIT ${q.limit}` : ""

              const sql = `
                SELECT * FROM session_history
                ${where}
                ORDER BY timestamp ASC
                ${limitClause}
              `
              const rows = db.query(sql).all(...params) as RawRow[]
              return rows.map(rowToRecord)
            },
            catch: (cause) =>
              new SessionHistoryError({
                op: "query",
                message: `query failed: ${String(cause)}`,
                cause,
              }),
          })

        const getSession: SessionHistoryApi["getSession"] = (sessionId: string) =>
          Effect.try({
            try: () => {
              const rows = selectBySession.all(sessionId) as RawRow[]
              return rows.map(rowToRecord)
            },
            catch: (cause) =>
              new SessionHistoryError({
                op: "query",
                message: `getSession failed: ${String(cause)}`,
                cause,
              }),
          })

        const deleteOlderThan: SessionHistoryApi["deleteOlderThan"] = (ts: number) =>
          Effect.try({
            try: () => {
              const result = deleteOldStmt.run(ts)
              return result.changes
            },
            catch: (cause) =>
              new SessionHistoryError({
                op: "delete",
                message: `deleteOlderThan failed: ${String(cause)}`,
                cause,
              }),
          })

        return { record, query, getSession, deleteOlderThan } satisfies SessionHistoryApi
      }),
    )
  }

  /**
   * Ref-backed in-memory Layer for tests. No SQLite required.
   * All operations are pure Effect.Effect — no bun:sqlite dependency.
   */
  static readonly Memory: Layer.Layer<SessionHistoryService, never, Clock> =
    Layer.effect(
      SessionHistoryService,
      Effect.gen(function* () {
        const clock = yield* Clock
        const store = yield* Ref.make<ReadonlyArray<SessionRecord>>([])

        const record: SessionHistoryApi["record"] = (entry: SessionRecordInput) =>
          Effect.gen(function* () {
            const uuid = randomUuid()
            const created_at = yield* clock.nowIso()
            const rec: SessionRecord = {
              uuid,
              type: entry.type,
              entrypoint: entry.entrypoint,
              sessionId: entry.sessionId,
              timestamp: entry.timestamp,
              textContent: entry.textContent,
              created_at,
            }
            // exactOptionalPropertyTypes: only set optional fields when present
            if (entry.parentUuid !== undefined)
              (rec as { parentUuid?: string }).parentUuid = entry.parentUuid
            if (entry.requestId !== undefined)
              (rec as { requestId?: string }).requestId = entry.requestId
            if (entry.toolUseId !== undefined)
              (rec as { toolUseId?: string }).toolUseId = entry.toolUseId
            if (entry.toolName !== undefined)
              (rec as { toolName?: string }).toolName = entry.toolName
            if (entry.skillName !== undefined)
              (rec as { skillName?: string }).skillName = entry.skillName
            yield* Ref.update(store, (rows) => [...rows, rec])
            return uuid
          })

        const query: SessionHistoryApi["query"] = (q: SessionHistoryQuery) =>
          Effect.gen(function* () {
            const rows = yield* Ref.get(store)
            let result = rows as ReadonlyArray<SessionRecord>
            if (q.sessionId !== undefined)
              result = result.filter((r) => r.sessionId === q.sessionId)
            if (q.type !== undefined)
              result = result.filter((r) => r.type === q.type)
            if (q.toolName !== undefined)
              result = result.filter((r) => r.toolName === q.toolName)
            if (q.skillName !== undefined)
              result = result.filter((r) => r.skillName === q.skillName)
            if (q.limit !== undefined)
              result = result.slice(0, q.limit)
            return result
          })

        const getSession: SessionHistoryApi["getSession"] = (sessionId: string) =>
          Effect.gen(function* () {
            const rows = yield* Ref.get(store)
            return rows
              .filter((r) => r.sessionId === sessionId)
              .slice()
              .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          })

        const deleteOlderThan: SessionHistoryApi["deleteOlderThan"] = (ts: number) =>
          Effect.gen(function* () {
            const rows = yield* Ref.get(store)
            const keep = rows.filter(
              (r) => new Date(r.timestamp).getTime() >= ts,
            )
            const deleted = rows.length - keep.length
            yield* Ref.set(store, keep)
            return deleted
          })

        return { record, query, getSession, deleteOlderThan } satisfies SessionHistoryApi
      }),
    )
}

// ── Schema export (for external consumers that want to inspect DDL) ───────────

export const SESSION_HISTORY_SCHEMA_V1 = SCHEMA_V1
