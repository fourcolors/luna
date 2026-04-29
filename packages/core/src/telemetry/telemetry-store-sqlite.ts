/**
 * TelemetryService — SQLite-backed Layer (Phase 24b).
 *
 * Persistence-backed sibling to the in-memory `TelemetryService.makeLayer`.
 * Implements the same `TelemetryApi` contract; SQL is the single source of
 * truth — there is NO in-memory `Ref<Map>` mirror (advisor mandate A).
 *
 * Storage model:
 *   - `telemetry_counters(name, tags_key, tags_json, value, last_updated_ts)`
 *     is canonical. Every `inc/get/snapshot` call goes directly to SQL via
 *     prepared statements. UPSERT semantics:
 *       INSERT ... ON CONFLICT(name, tags_key) DO UPDATE
 *         SET value = value + excluded.value, ...
 *   - `telemetry_history(id, name, tags_key, tags_json, delta, ts)` is an
 *     OPT-IN row-per-inc audit log, OFF by default. HANDOFF Pattern #6:
 *     "events canonical, rollups computed; no derived bucket tables —
 *     history table opt-in default OFF". Honors §16 implicitly: Telemetry
 *     emits NO observability events, so there's no daemon subscriber.
 *   - `value` is `INTEGER NOT NULL` (advisor mandate B): every current
 *     caller passes integer `n`; SQLite affinity coerces if a producer ever
 *     drifts. `n` is integer-by-convention.
 *
 * Architecture:
 *   - Layer.scoped opens the DB, runs migrations (per-component
 *     `schema_versions` ledger, §5.2 / Phase 25e), registers `db.close`
 *     finalizer (LIFO §3.4 #4 — only
 *     finalizer needed: no daemon, see §16). Then prepared statements.
 *   - Dynamic `bun:sqlite` import keeps stock-vitest-under-node from
 *     hard-failing at module-load. Mirrors cost-store-sqlite + session-
 *     store-sqlite patterns.
 *
 * Invariants:
 *   §3.4 #4    — Layer.scoped + `db.close` finalizer registered FIRST
 *                (only finalizer; Telemetry has no daemon — §16).
 *   §5.2       — per-component `schema_versions` ledger (Phase 25e), idempotent.
 *   §6         — ConfigError raised at boot if `bun:sqlite` is unavailable.
 *   §16        — Telemetry emits no events; no obs.subscribeEvents daemon.
 *   HANDOFF #6 — opt-in history table, default OFF; storage-agnostic
 *                snapshot() reads from the canonical counters table.
 *   HANDOFF 938-948 — UPSERT on (name, tags_key); restored counter map IS
 *                the SQL table (no in-memory Ref mirror); optional history
 *                table per-counter via name allowlist.
 */
import { Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import { TelemetryService, counterKey } from "./telemetry.js"
import type {
  CounterSnapshot,
  MetricTags,
  TelemetryApi,
} from "./types.js"

// ── Options ─────────────────────────────────────────────────────────────────

/**
 * Per-counter history config. Default OFF (HANDOFF Pattern #6: rollups
 * computed, history opt-in only). When `enabled: true`, every `inc()` call
 * also appends a row to `telemetry_history` — gated by `nameAllowlist`
 * if provided (allowlist absent = all counters logged).
 */
export interface TelemetrySqliteOptions {
  readonly history?: {
    readonly enabled: boolean
    readonly nameAllowlist?: ReadonlyArray<string>
  }
}

// ── Schema ──────────────────────────────────────────────────────────────────
//
// Both tables are created unconditionally so the `history.enabled` flag can
// flip at runtime without a schema migration. Rows are only inserted into
// `telemetry_history` when (history.enabled && (allowlist absent || name ∈ allowlist)).
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS telemetry_counters (
    name             TEXT NOT NULL,
    tags_key         TEXT NOT NULL,
    tags_json        TEXT NOT NULL,
    value            INTEGER NOT NULL,
    last_updated_ts  TEXT NOT NULL,
    PRIMARY KEY (name, tags_key)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS telemetry_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    tags_key  TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    delta     INTEGER NOT NULL,
    ts        TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_telemetry_history_name_ts
    ON telemetry_history(name, ts);
`

// ── bun:sqlite minimal shape (mirrors cost-store-sqlite.ts) ─────────────────
interface BunDb {
  run: (sql: string) => void
  exec?: (sql: string) => void
  query: (sql: string) => BunStmt
  close: () => void
  transaction: <A>(fn: (...a: unknown[]) => A) => (...a: unknown[]) => A
}
interface BunStmt {
  get: (...p: unknown[]) => unknown
  all: (...p: unknown[]) => unknown[]
  run: (...p: unknown[]) => { changes: number }
}

// ── Layer factory ───────────────────────────────────────────────────────────

/**
 * Build a sqlite-backed TelemetryService Layer. `dbPath` accepts
 * `":memory:"` for ephemeral tests. The Layer is `Layer.scoped` so the DB
 * handle is closed when the surrounding scope finalizes (LIFO §3.4 #4).
 *
 * Layer error channel = `ConfigError` (boot-time only): raised when
 * `bun:sqlite` cannot be imported (e.g., running under stock node). Once
 * the layer builds, runtime ops do not surface ConfigError — schema is
 * stable and SQL is local.
 */
export const makeTelemetrySqlite = (
  dbPath: string,
  options: TelemetrySqliteOptions = {},
): Layer.Layer<TelemetryService, ConfigError, Clock | LunaSqliteBootstrap> =>
  Layer.scoped(
    TelemetryService,
    Effect.gen(function* () {
      // Phase 27a: pull the bootstrap Tag BEFORE opening any Database so
      // the process-wide `setCustomSQLite()` swap has run. Side effect
      // only — we don't branch on the result.
      yield* LunaSqliteBootstrap

      const clock = yield* Clock

      // Resolve history config once at boot — runtime stays branch-light.
      const historyEnabled = options.history?.enabled === true
      const allowlist = options.history?.nameAllowlist
      const allowlistSet =
        allowlist !== undefined ? new Set(allowlist) : undefined
      const historyAllows = (name: string): boolean =>
        historyEnabled &&
        (allowlistSet === undefined || allowlistSet.has(name))

      // Dynamic import of `bun:sqlite` — escape hatch so stock-node test
      // collection doesn't blow up on module load. Mirrors cost-store.
      const bunSqliteSpec = "bun:sqlite"
      const mod = yield* Effect.tryPromise({
        try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
        catch: (cause) =>
          new ConfigError({
            module: "telemetry",
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
            module: "telemetry",
            key: "bun:sqlite",
            message: "bun:sqlite module has no `Database` export",
          }),
        )
      }
      const db = new Database(dbPath)

      // Pragmas BEFORE any user data writes.
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA synchronous = NORMAL")
      db.run("PRAGMA foreign_keys = ON")

      // §5.2 migration ladder: per-component `schema_versions` ledger
      // (Phase 25e). Replaces the pre-25e `PRAGMA user_version` gate that
      // collided across components sharing `~/.luna/luna.db`.
      const nowMs = yield* clock.nowMs()
      ensureSchemaVersions(db)
      applyMigration(db, "telemetry", 1, SCHEMA_V1, nowMs)

      // §3.4 #4 LIFO: register `db.close` finalizer. Telemetry has no
      // daemon (§16: no events to subscribe to), so this is the ONLY
      // finalizer — strictly simpler than 24a.
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      // Prepared statements — reused across calls.
      const upsertStmt = db.query(
        `INSERT INTO telemetry_counters
           (name, tags_key, tags_json, value, last_updated_ts)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name, tags_key) DO UPDATE SET
           value = value + excluded.value,
           last_updated_ts = excluded.last_updated_ts`,
      )
      const getStmt = db.query(
        `SELECT value FROM telemetry_counters
         WHERE name = ? AND tags_key = ?`,
      )
      const snapshotStmt = db.query(
        `SELECT name, tags_json, value, last_updated_ts
         FROM telemetry_counters`,
      )
      const historyInsert = db.query(
        `INSERT INTO telemetry_history
           (name, tags_key, tags_json, delta, ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      const deleteCounters = db.query(`DELETE FROM telemetry_counters`)
      const deleteHistory = db.query(`DELETE FROM telemetry_history`)

      // ── Public API — every op goes straight to SQL (advisor mandate A). ──

      const inc: TelemetryApi["inc"] = (name, tags = {}, n = 1) =>
        Effect.gen(function* () {
          const ts = yield* clock.nowIso()
          const key = counterKey(name, tags)
          const tagsJson = JSON.stringify(tags)
          // Both UPSERT + (optional) history row run in a single
          // transaction so an inc() either fully lands or fully aborts.
          db.run("BEGIN IMMEDIATE")
          try {
            upsertStmt.run(name, key, tagsJson, n, ts)
            if (historyAllows(name)) {
              historyInsert.run(name, key, tagsJson, n, ts)
            }
            db.run("COMMIT")
          } catch (e) {
            try {
              db.run("ROLLBACK")
            } catch {
              /* best-effort */
            }
            throw e
          }
        })

      const get: TelemetryApi["get"] = (name, tags = {}) =>
        Effect.sync(() => {
          const key = counterKey(name, tags)
          const row = getStmt.get(name, key) as
            | { value: number }
            | undefined
          return row?.value ?? 0
        })

      const snapshot: TelemetryApi["snapshot"] = Effect.sync(() => {
        const rows = snapshotStmt.all() as ReadonlyArray<{
          name: string
          tags_json: string
          value: number
          last_updated_ts: string
        }>
        const out: CounterSnapshot[] = []
        for (const r of rows) {
          let tags: MetricTags = {}
          try {
            tags = JSON.parse(r.tags_json) as MetricTags
          } catch {
            tags = {}
          }
          out.push({
            name: r.name,
            tags,
            value: r.value,
            lastUpdatedTs: r.last_updated_ts,
          })
        }
        return out
      })

      const reset: TelemetryApi["reset"] = Effect.sync(() => {
        // Clear both tables atomically — counters first, history second.
        db.run("BEGIN IMMEDIATE")
        try {
          deleteCounters.run()
          deleteHistory.run()
          db.run("COMMIT")
        } catch (e) {
          try {
            db.run("ROLLBACK")
          } catch {
            /* best-effort */
          }
          throw e
        }
      })

      return {
        inc,
        get,
        snapshot,
        reset,
      } satisfies TelemetryApi
    }),
  )

/**
 * Convenience: alias on the TelemetryService class for symmetry with the
 * in-memory `TelemetryService.makeLayer`. Use as
 * `TelemetryService.fromPath("~/.luna/luna.db")`. Pass `":memory:"` for
 * ephemeral test DBs.
 */
;(TelemetryService as unknown as {
  fromPath: (
    dbPath: string,
    options?: TelemetrySqliteOptions,
  ) => Layer.Layer<TelemetryService, ConfigError, Clock | LunaSqliteBootstrap>
}).fromPath = makeTelemetrySqlite

declare module "./telemetry.js" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace TelemetryService {
    /** SQLite-backed Layer (Phase 24b persistence). */
    function fromPath(
      dbPath: string,
      options?: TelemetrySqliteOptions,
    ): Layer.Layer<TelemetryService, ConfigError, Clock | LunaSqliteBootstrap>
  }
}
