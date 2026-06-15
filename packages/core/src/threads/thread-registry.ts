/**
 * ThreadRegistry — durable index of Luna threads in luna.db.
 *
 * Architecture mirrors jobs-store.ts exactly:
 *   - Effect.Tag service
 *   - Memory layer for unit tests (Ref<Map>)
 *   - SQLite layer via bun:sqlite dynamic import + applyMigration ledger
 *   - chat-service depends on the SERVICE TAG; no bun:sqlite in chat-service
 *
 * Phase 1 columns: id, sdk_session_id, cwd, title, model, effort,
 *   created_at, last_active_at.
 *
 * status/archived_at are DEFERRED to Phase 3 (additive ALTER — do NOT add now).
 *
 * The registry supersedes thread-session-map.json as the source of truth.
 * One-shot boot migration imports rows from the legacy JSON file; after that
 * all writes go to the DB and the JSON file is never written again.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"

// ── Schema DDL ───────────────────────────────────────────────────────────────

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS threads (
    id              TEXT PRIMARY KEY,
    sdk_session_id  TEXT,
    cwd             TEXT,
    title           TEXT,
    model           TEXT,
    effort          TEXT,
    created_at      INTEGER NOT NULL,
    last_active_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_threads_last_active
    ON threads(last_active_at DESC);
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

// ── Public types ─────────────────────────────────────────────────────────────

/** A thread row as returned by the registry. */
export interface ThreadRow {
  /** Luna thread id — thr_<base36>_<rand> */
  readonly id: string
  /** Claude SDK session UUID (NULL until first turn fires onSdkSessionId). */
  readonly sdkSessionId: string | null
  /** Working directory used when the SDK session was created. Load-bearing for resume. */
  readonly cwd: string | null
  /** Human label (set lazily; null until named). */
  readonly title: string | null
  /** Last-known model selection for this thread. */
  readonly model: string | null
  /** Last-known effort selection for this thread. */
  readonly effort: string | null
  /** Unix ms when the thread row was first inserted. */
  readonly createdAt: number
  /** Unix ms of the last turn (bumped on each turn start). */
  readonly lastActiveAt: number
}

/** Input for upsert() — all optional except id. */
export interface ThreadUpsertInput {
  readonly id: string
  readonly sdkSessionId?: string | null
  readonly cwd?: string | null
  readonly title?: string | null
  readonly model?: string | null
  readonly effort?: string | null
}

/** The registry API exposed via the Effect service tag. */
export interface ThreadRegistryApi {
  /**
   * Insert a new thread row, or update an existing one.
   * On insert: created_at and last_active_at are set to now.
   * On update (id already present): merges supplied non-undefined fields.
   */
  upsert: (input: ThreadUpsertInput) => Effect.Effect<ThreadRow, never>

  /** Retrieve a thread by id. Returns null if absent. */
  get: (id: string) => Effect.Effect<ThreadRow | null, never>

  /** Persist the SDK session id for a thread (fires on onSdkSessionId callback). */
  setSid: (id: string, sdkSessionId: string) => Effect.Effect<boolean, never>

  /** Persist model and/or effort for a thread. */
  setConfig: (
    id: string,
    config: { model?: string; effort?: string },
  ) => Effect.Effect<boolean, never>

  /** Bump last_active_at to now. Best-effort — off the hot path. */
  touch: (id: string) => Effect.Effect<boolean, never>

  /** List all threads, most-recently-active first. */
  list: () => Effect.Effect<ReadonlyArray<ThreadRow>, never>
}

// ── ThreadRegistryError ──────────────────────────────────────────────────────

export class ThreadRegistryError extends Error {
  readonly _tag = "ThreadRegistryError"
  readonly op: string
  constructor(
    op: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.op = op
    this.name = "ThreadRegistryError"
  }
}

// ── Service Tag ──────────────────────────────────────────────────────────────

export class ThreadRegistryService extends Effect.Tag(
  "luna/ThreadRegistryService",
)<ThreadRegistryService, ThreadRegistryApi>() {
  // ── Memory Layer ───────────────────────────────────────────────────────────

  /** Fresh isolated Ref<Map> per build. No SQLite. Used in unit tests. */
  static Memory: Layer.Layer<ThreadRegistryService, never, Clock> = Layer.effect(
    ThreadRegistryService,
    Effect.gen(function* () {
      const clock = yield* Clock
      const store = yield* Ref.make<Map<string, ThreadRow>>(new Map())

      const nowMs = (): Effect.Effect<number> => clock.nowMs()

      const upsert: ThreadRegistryApi["upsert"] = (input) =>
        Effect.gen(function* () {
          const ts = yield* nowMs()
          const existing = (yield* Ref.get(store)).get(input.id)
          if (existing) {
            const updated: ThreadRow = {
              ...existing,
              ...(input.sdkSessionId !== undefined
                ? { sdkSessionId: input.sdkSessionId }
                : {}),
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.effort !== undefined ? { effort: input.effort } : {}),
              lastActiveAt: ts,
            }
            yield* Ref.update(store, (m) => {
              const n = new Map(m)
              n.set(input.id, updated)
              return n
            })
            return updated
          }
          const row: ThreadRow = {
            id: input.id,
            sdkSessionId: input.sdkSessionId ?? null,
            cwd: input.cwd ?? null,
            title: input.title ?? null,
            model: input.model ?? null,
            effort: input.effort ?? null,
            createdAt: ts,
            lastActiveAt: ts,
          }
          yield* Ref.update(store, (m) => {
            const n = new Map(m)
            n.set(input.id, row)
            return n
          })
          return row
        })

      const get: ThreadRegistryApi["get"] = (id) =>
        Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null))

      const setSid: ThreadRegistryApi["setSid"] = (id, sdkSessionId) =>
        Ref.modify(store, (m) => {
          const existing = m.get(id)
          if (!existing) return [false, m] as [boolean, typeof m]
          const n = new Map(m)
          n.set(id, { ...existing, sdkSessionId })
          return [true, n] as [boolean, typeof m]
        })

      const setConfig: ThreadRegistryApi["setConfig"] = (id, config) =>
        Ref.modify(store, (m) => {
          const existing = m.get(id)
          if (!existing) return [false, m] as [boolean, typeof m]
          const n = new Map(m)
          n.set(id, {
            ...existing,
            ...(config.model !== undefined ? { model: config.model } : {}),
            ...(config.effort !== undefined ? { effort: config.effort } : {}),
          })
          return [true, n] as [boolean, typeof m]
        })

      const touch: ThreadRegistryApi["touch"] = (id) =>
        Effect.gen(function* () {
          const ts = yield* nowMs()
          return yield* Ref.modify(store, (m) => {
            const existing = m.get(id)
            if (!existing) return [false, m] as [boolean, typeof m]
            const n = new Map(m)
            n.set(id, { ...existing, lastActiveAt: ts })
            return [true, n] as [boolean, typeof m]
          })
        })

      const list: ThreadRegistryApi["list"] = () =>
        Ref.get(store).pipe(
          Effect.map((m) =>
            Array.from(m.values()).sort(
              (a, b) => b.lastActiveAt - a.lastActiveAt,
            ),
          ),
        )

      return { upsert, get, setSid, setConfig, touch, list } satisfies ThreadRegistryApi
    }),
  )

  // ── SQLite Layer factory ───────────────────────────────────────────────────

  /**
   * Build a SQLite-backed ThreadRegistryService Layer.
   * `dbPath` accepts `":memory:"` for ephemeral tests.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<ThreadRegistryService, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      ThreadRegistryService,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap

        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "thread-registry",
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
              module: "thread-registry",
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
        applyMigration(db, "threads", 1, SCHEMA_V1, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // ── Prepared statements ─────────────────────────────────────────────

        const SELECT_COLS =
          "id, sdk_session_id, cwd, title, model, effort, created_at, last_active_at"

        const insertStmt = db.query(
          `INSERT INTO threads
             (id, sdk_session_id, cwd, title, model, effort, created_at, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        const updateStmt = db.query(
          `UPDATE threads
              SET sdk_session_id = CASE WHEN ? = 1 THEN ? ELSE sdk_session_id END,
                  cwd            = CASE WHEN ? = 1 THEN ? ELSE cwd END,
                  title          = CASE WHEN ? = 1 THEN ? ELSE title END,
                  model          = CASE WHEN ? = 1 THEN ? ELSE model END,
                  effort         = CASE WHEN ? = 1 THEN ? ELSE effort END,
                  last_active_at = ?
            WHERE id = ?`,
        )
        const setSidStmt = db.query(
          `UPDATE threads SET sdk_session_id = ? WHERE id = ?`,
        )
        const setModelStmt = db.query(
          `UPDATE threads
              SET model  = CASE WHEN ? = 1 THEN ? ELSE model END,
                  effort = CASE WHEN ? = 1 THEN ? ELSE effort END
            WHERE id = ?`,
        )
        const touchStmt = db.query(
          `UPDATE threads SET last_active_at = ? WHERE id = ?`,
        )
        const getStmt = db.query(
          `SELECT ${SELECT_COLS} FROM threads WHERE id = ? LIMIT 1`,
        )
        const listStmt = db.query(
          `SELECT ${SELECT_COLS} FROM threads ORDER BY last_active_at DESC`,
        )
        const existsStmt = db.query(
          `SELECT 1 FROM threads WHERE id = ? LIMIT 1`,
        )

        type RawRow = {
          id: string
          sdk_session_id: string | null
          cwd: string | null
          title: string | null
          model: string | null
          effort: string | null
          created_at: number
          last_active_at: number
        }

        const rowToThread = (row: RawRow): ThreadRow => ({
          id: row.id,
          sdkSessionId: row.sdk_session_id,
          cwd: row.cwd,
          title: row.title,
          model: row.model,
          effort: row.effort,
          createdAt: row.created_at,
          lastActiveAt: row.last_active_at,
        })

        const upsert: ThreadRegistryApi["upsert"] = (input) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            const existing = existsStmt.get(input.id)
            if (existing) {
              updateStmt.run(
                input.sdkSessionId !== undefined ? 1 : 0,
                input.sdkSessionId ?? null,
                input.cwd !== undefined ? 1 : 0,
                input.cwd ?? null,
                input.title !== undefined ? 1 : 0,
                input.title ?? null,
                input.model !== undefined ? 1 : 0,
                input.model ?? null,
                input.effort !== undefined ? 1 : 0,
                input.effort ?? null,
                ts,
                input.id,
              )
            } else {
              insertStmt.run(
                input.id,
                input.sdkSessionId ?? null,
                input.cwd ?? null,
                input.title ?? null,
                input.model ?? null,
                input.effort ?? null,
                ts,
                ts,
              )
            }
            const row = getStmt.get(input.id) as RawRow | undefined
            if (!row) {
              // Should never happen — we just wrote it.
              return {
                id: input.id,
                sdkSessionId: input.sdkSessionId ?? null,
                cwd: input.cwd ?? null,
                title: input.title ?? null,
                model: input.model ?? null,
                effort: input.effort ?? null,
                createdAt: ts,
                lastActiveAt: ts,
              } satisfies ThreadRow
            }
            return rowToThread(row)
          })

        const get: ThreadRegistryApi["get"] = (id) =>
          Effect.sync(() => {
            const row = getStmt.get(id) as RawRow | undefined
            return row ? rowToThread(row) : null
          })

        const setSid: ThreadRegistryApi["setSid"] = (id, sdkSessionId) =>
          Effect.sync(() => setSidStmt.run(sdkSessionId, id).changes > 0)

        const setConfig: ThreadRegistryApi["setConfig"] = (id, config) =>
          Effect.sync(() => {
            const result = setModelStmt.run(
              config.model !== undefined ? 1 : 0,
              config.model ?? null,
              config.effort !== undefined ? 1 : 0,
              config.effort ?? null,
              id,
            )
            return result.changes > 0
          })

        const touch: ThreadRegistryApi["touch"] = (id) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            return yield* Effect.sync(
              () => touchStmt.run(ts, id).changes > 0,
            )
          })

        const list: ThreadRegistryApi["list"] = () =>
          Effect.sync(() =>
            (listStmt.all() as RawRow[]).map(rowToThread),
          )

        return { upsert, get, setSid, setConfig, touch, list } satisfies ThreadRegistryApi
      }),
    )
  }
}
