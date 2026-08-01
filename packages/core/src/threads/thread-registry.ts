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
 * Phase 3 (additive ALTER via migration v2):
 *   status TEXT NOT NULL DEFAULT 'active'  (values: active | archived)
 *   archived_at INTEGER                    (NULL when active; unix ms when archived)
 *
 * CARDINAL INVARIANT (Chairman's explicit decision):
 *   archive() NEVER deletes the thread row or the SDK jsonl.
 *   Archive is a reversible status flip; archived threads remain SDK-resumable.
 *   There is NO purge/delete path in any phase.
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

/**
 * Phase 3 migration — additive ALTER TABLE only. Never recreates the table.
 * SQLite ALTER TABLE ADD COLUMN is safe under our applyMigration ledger:
 * this block runs exactly once per database file.
 *
 * DEFAULT 'active' means all pre-existing rows get treated as active
 * after migration — correct by definition.
 */
const SCHEMA_V2 = `
  ALTER TABLE threads ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE threads ADD COLUMN archived_at INTEGER;
  CREATE INDEX IF NOT EXISTS idx_threads_status
    ON threads(status, last_active_at DESC);
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

/** Thread lifecycle status. Only two states — no purge/delete state exists. */
export type ThreadStatus = "active" | "archived"

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
  /**
   * Unix ms of the last activity (set on upsert/insert and updated via touch();
   * per-turn bumping is wired by chat-service calling touch() at turn start).
   */
  readonly lastActiveAt: number
  /**
   * Phase 3: lifecycle status. Defaults to 'active'.
   * Archived threads are hidden from the default list but NEVER deleted.
   * The row and its SDK jsonl remain present and resumable indefinitely.
   */
  readonly status: ThreadStatus
  /**
   * Phase 3: unix ms when this thread was archived, or null when active.
   * Cleared (set to null) when unarchived.
   */
  readonly archivedAt: number | null
}

/** Input for upsert() — all optional except id. */
export interface ThreadUpsertInput {
  readonly id: string
  /**
   * The SDK session id (resume pointer).
   *
   * Deliberately `string | undefined` and NOT `string | null`: upsert treats a
   * supplied value as "write this" and an omitted key as "leave alone", and
   * because `null !== undefined`, an explicit null used to mean "clear it".
   * chat-service reuses createThread to RESUME a thread, so passing null there
   * wiped the very pointer being resumed from and left the thread with a full
   * transcript and an empty model context. Omitting the key is correct for both
   * insert (column defaults to NULL) and update (existing value preserved).
   *
   * If clearing a sid is ever genuinely needed, add an explicit `clearSid`
   * method rather than widening this back to accept null.
   */
  readonly sdkSessionId?: string
  readonly cwd?: string | null
  readonly title?: string | null
  readonly model?: string | null
  readonly effort?: string | null
  /**
   * Override the timestamp used for created_at / last_active_at on INSERT
   * (ignored on UPDATE — last_active_at is always bumped to now on updates).
   * Useful for boot-time import so migrated threads get the migration timestamp
   * instead of the current clock.
   */
  readonly nowMs?: number
}

/** The registry API exposed via the Effect service tag. */
export interface ThreadRegistryApi {
  /**
   * Insert a new thread row, or update an existing one.
   * On insert: created_at and last_active_at are set to now; status = 'active'.
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

  /**
   * Set the title of an EXISTING thread only when it has none yet.
   * The deliberate clock-neutral exception to upsert's "last_active_at is
   * always bumped on updates" rule: read-driven title backfill (listThreads
   * derive-on-read) must never reset the auto-archive idle clock.
   * No-ops when the row is missing (never inserts) or already titled.
   * Returns true only when a title was actually written.
   */
  setTitleIfNull: (id: string, title: string) => Effect.Effect<boolean, never>

  /** Bump last_active_at to now. Best-effort — off the hot path. */
  touch: (id: string) => Effect.Effect<boolean, never>

  /** List all threads (all statuses), most-recently-active first. */
  list: () => Effect.Effect<ReadonlyArray<ThreadRow>, never>

  // ── Phase 3: Archival state machine ────────────────────────────────────────

  /**
   * Archive a thread: flip active->archived and record archived_at.
   * NEVER deletes the row or the SDK jsonl — archive is reversible.
   * Returns true if the thread existed (already-archived = idempotent true).
   */
  archive: (id: string) => Effect.Effect<boolean, never>

  /**
   * Unarchive a thread: flip archived->active and clear archived_at.
   * Returns true if the thread existed (already-active = idempotent true).
   */
  unarchive: (id: string) => Effect.Effect<boolean, never>

  /**
   * List threads filtered by status, most-recently-active first.
   * status='active' is the default sidebar view; 'archived' is the archive panel.
   */
  listByStatus: (status: ThreadStatus) => Effect.Effect<ReadonlyArray<ThreadRow>, never>

  /**
   * Return ACTIVE threads whose last_active_at is strictly less than cutoffMs.
   * Used by the auto-archive policy to find stale threads.
   * cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000  (14-day idle)
   */
  listStale: (cutoffMs: number) => Effect.Effect<ReadonlyArray<ThreadRow>, never>
}

/**
 * Normalize a title for storage: a blank / whitespace-only title becomes null.
 * Applied at every registry write so the `title` column is never the empty
 * string — the read side treats "" as "no title", so storing "" would make a
 * row derive-on-read forever while never accepting a backfill (the two title
 * emptiness notions must agree).
 */
const normalizeTitle = (title: string | null | undefined): string | null =>
  title != null && title.trim().length > 0 ? title : null

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

// ── Auto-archive policy ──────────────────────────────────────────────────────

/** 14 days in milliseconds — the idle cutoff for auto-archive. */
export const AUTO_ARCHIVE_IDLE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Run the auto-archive policy against the registry:
 *   archive ACTIVE threads with last_active_at < (nowMs - AUTO_ARCHIVE_IDLE_MS)
 *   AND that are not currently live (no in-flight turn).
 *
 * NEVER deletes any row or SDK jsonl. Only flips status -> 'archived'.
 *
 * @param registry  - the ThreadRegistryApi to query and mutate
 * @param nowMs     - current timestamp (ms); caller passes Date.now() in production
 * @param isLive    - optional liveness predicate: return true for threads that
 *                    have an in-flight turn or are otherwise considered active in
 *                    the chat-service. When the predicate returns true the thread
 *                    is SKIPPED even if it passes the 14-day idle cutoff.
 *
 *                    Decision: wiring true in-process liveness from the registry
 *                    layer is impractical (ChatService is a separate Effect.Tag);
 *                    the caller passes the predicate as a closure over the live
 *                    thread set instead of coupling the registry to ChatService.
 *                    When absent (e.g. in scheduled jobs that run without a live
 *                    ChatService), the `last_active_at` timestamp alone serves as
 *                    the proxy — 14-day idle is conservative enough that a truly
 *                    live thread is never stale.
 *
 * Returns the ids of threads that were archived by this run.
 * Can be called from a scheduled job or the wake cycle.
 */
export const runAutoArchive = (
  registry: ThreadRegistryApi,
  nowMs: number,
  isLive?: (threadId: string) => boolean,
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    const cutoff = nowMs - AUTO_ARCHIVE_IDLE_MS
    const stale = yield* registry.listStale(cutoff)
    const archived: string[] = []
    for (const thread of stale) {
      // Guard: skip threads that are currently live / have an in-flight turn.
      // The predicate is the caller's view of liveness; absent means "not wired"
      // (treated as not-live, i.e. safe to archive).
      if (isLive?.(thread.id)) continue
      const ok = yield* registry.archive(thread.id).pipe(
        Effect.catchAllCause(() => Effect.succeed(false)),
      )
      if (ok) archived.push(thread.id)
    }
    return archived
  })

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
          const clockTs = yield* nowMs()
          const ts = input.nowMs ?? clockTs
          const existing = (yield* Ref.get(store)).get(input.id)
          if (existing) {
            const updated: ThreadRow = {
              ...existing,
              ...(input.sdkSessionId !== undefined
                ? { sdkSessionId: input.sdkSessionId }
                : {}),
              ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
              ...(input.title !== undefined ? { title: normalizeTitle(input.title) } : {}),
              ...(input.model !== undefined ? { model: input.model } : {}),
              ...(input.effort !== undefined ? { effort: input.effort } : {}),
              lastActiveAt: clockTs,
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
            title: normalizeTitle(input.title),
            model: input.model ?? null,
            effort: input.effort ?? null,
            createdAt: ts,
            lastActiveAt: ts,
            status: "active",
            archivedAt: null,
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

      const setTitleIfNull: ThreadRegistryApi["setTitleIfNull"] = (id, title) =>
        Ref.modify(store, (m) => {
          const existing = m.get(id)
          const next = normalizeTitle(title)
          // Writable only when the row exists, is currently untitled (null OR a
          // legacy blank), and we actually have a non-blank title to set.
          if (!existing || normalizeTitle(existing.title) !== null || next === null) {
            return [false, m] as [boolean, typeof m]
          }
          const n = new Map(m)
          n.set(id, { ...existing, title: next })
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

      const archive: ThreadRegistryApi["archive"] = (id) =>
        Effect.gen(function* () {
          const ts = yield* nowMs()
          return yield* Ref.modify(store, (m) => {
            const existing = m.get(id)
            if (!existing) return [false, m] as [boolean, typeof m]
            // Already archived => idempotent (row exists => true)
            if (existing.status === "archived") return [true, m] as [boolean, typeof m]
            const n = new Map(m)
            n.set(id, { ...existing, status: "archived", archivedAt: ts })
            return [true, n] as [boolean, typeof m]
          })
        })

      const unarchive: ThreadRegistryApi["unarchive"] = (id) =>
        Ref.modify(store, (m) => {
          const existing = m.get(id)
          if (!existing) return [false, m] as [boolean, typeof m]
          // Already active => idempotent (row exists => true)
          if (existing.status === "active") return [true, m] as [boolean, typeof m]
          const n = new Map(m)
          n.set(id, { ...existing, status: "active", archivedAt: null })
          return [true, n] as [boolean, typeof m]
        })

      const listByStatus: ThreadRegistryApi["listByStatus"] = (status) =>
        Ref.get(store).pipe(
          Effect.map((m) =>
            Array.from(m.values())
              .filter((r) => r.status === status)
              .sort((a, b) => b.lastActiveAt - a.lastActiveAt),
          ),
        )

      const listStale: ThreadRegistryApi["listStale"] = (cutoffMs) =>
        Ref.get(store).pipe(
          Effect.map((m) =>
            Array.from(m.values())
              .filter((r) => r.status === "active" && r.lastActiveAt < cutoffMs)
              .sort((a, b) => a.lastActiveAt - b.lastActiveAt),
          ),
        )

      return {
        upsert,
        get,
        setSid,
        setConfig,
        setTitleIfNull,
        touch,
        list,
        archive,
        unarchive,
        listByStatus,
        listStale,
      } satisfies ThreadRegistryApi
    }),
  )

  // ── SQLite Layer factory ───────────────────────────────────────────────────

  /**
   * Build a SQLite-backed ThreadRegistryService Layer.
   * dbPath accepts ":memory:" for ephemeral tests.
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
        // Phase 3: additive ALTER TABLE — runs once via migration ledger.
        applyMigration(db, "threads", 2, SCHEMA_V2, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // ── Prepared statements ─────────────────────────────────────────────

        const SELECT_COLS =
          "id, sdk_session_id, cwd, title, model, effort, created_at, last_active_at, " +
          "COALESCE(status, 'active') AS status, archived_at"

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
        const setTitleIfNullStmt = db.query(
          // Cover legacy blank rows too — the read side treats '' as untitled,
          // so a '' row must remain writable (normalizeTitle now prevents new
          // '' writes, but pre-existing rows may hold it).
          `UPDATE threads SET title = ? WHERE id = ? AND (title IS NULL OR title = '')`,
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
        // Phase 3 statements
        const archiveStmt = db.query(
          `UPDATE threads SET status = 'archived', archived_at = ?
            WHERE id = ? AND status != 'archived'`,
        )
        const unarchiveStmt = db.query(
          `UPDATE threads SET status = 'active', archived_at = NULL
            WHERE id = ? AND status = 'archived'`,
        )
        const listByStatusStmt = db.query(
          `SELECT ${SELECT_COLS} FROM threads
            WHERE COALESCE(status, 'active') = ?
            ORDER BY last_active_at DESC`,
        )
        const listStaleStmt = db.query(
          `SELECT ${SELECT_COLS} FROM threads
            WHERE COALESCE(status, 'active') = 'active' AND last_active_at < ?
            ORDER BY last_active_at ASC`,
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
          status: string | null
          archived_at: number | null
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
          status: (row.status === "archived" ? "archived" : "active") as ThreadStatus,
          archivedAt: row.archived_at ?? null,
        })

        const upsert: ThreadRegistryApi["upsert"] = (input) =>
          Effect.gen(function* () {
            const clockTs = yield* clock.nowMs()
            const insertTs = input.nowMs ?? clockTs
            const existing = existsStmt.get(input.id)
            if (existing) {
              updateStmt.run(
                input.sdkSessionId !== undefined ? 1 : 0,
                input.sdkSessionId ?? null,
                input.cwd !== undefined ? 1 : 0,
                input.cwd ?? null,
                input.title !== undefined ? 1 : 0,
                normalizeTitle(input.title),
                input.model !== undefined ? 1 : 0,
                input.model ?? null,
                input.effort !== undefined ? 1 : 0,
                input.effort ?? null,
                clockTs,
                input.id,
              )
            } else {
              insertStmt.run(
                input.id,
                input.sdkSessionId ?? null,
                input.cwd ?? null,
                normalizeTitle(input.title),
                input.model ?? null,
                input.effort ?? null,
                insertTs,
                insertTs,
              )
            }
            const row = getStmt.get(input.id) as RawRow | undefined
            if (!row) {
              return {
                id: input.id,
                sdkSessionId: input.sdkSessionId ?? null,
                cwd: input.cwd ?? null,
                title: normalizeTitle(input.title),
                model: input.model ?? null,
                effort: input.effort ?? null,
                createdAt: insertTs,
                lastActiveAt: insertTs,
                status: "active" as ThreadStatus,
                archivedAt: null,
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

        const setTitleIfNull: ThreadRegistryApi["setTitleIfNull"] = (id, title) =>
          Effect.sync(() => {
            const next = normalizeTitle(title)
            if (next === null) return false // never persist a blank title
            return setTitleIfNullStmt.run(next, id).changes > 0
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

        const archive: ThreadRegistryApi["archive"] = (id) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            const result = archiveStmt.run(ts, id)
            if (result.changes > 0) return true
            // No change: already archived or doesn't exist
            const exists = existsStmt.get(id)
            return exists != null
          })

        const unarchive: ThreadRegistryApi["unarchive"] = (id) =>
          Effect.sync(() => {
            const result = unarchiveStmt.run(id)
            if (result.changes > 0) return true
            // No change: already active or doesn't exist
            const exists = existsStmt.get(id)
            return exists != null
          })

        const listByStatus: ThreadRegistryApi["listByStatus"] = (status) =>
          Effect.sync(() =>
            (listByStatusStmt.all(status) as RawRow[]).map(rowToThread),
          )

        const listStale: ThreadRegistryApi["listStale"] = (cutoffMs) =>
          Effect.sync(() =>
            (listStaleStmt.all(cutoffMs) as RawRow[]).map(rowToThread),
          )

        return {
          upsert,
          get,
          setSid,
          setConfig,
          setTitleIfNull,
          touch,
          list,
          archive,
          unarchive,
          listByStatus,
          listStale,
        } satisfies ThreadRegistryApi
      }),
    )
  }
}
