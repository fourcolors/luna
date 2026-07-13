/**
 * SessionStore — SQLite-backed Layer (Phase 5 persistence).
 *
 * Mirrors the in-memory `SessionStore.Default` API (same Service tag, same
 * methods, same error semantics) but persists sessions + messages to a
 * `bun:sqlite` database at `dbPath`. Schema per DESIGN.md §5.1, with an
 * extension column `meta_json` on `sessions` for our `lastMessageAt` /
 * `lastMessagePreview` sidebar fields (sidecar to the frozen schema —
 * additive, won't break a future @effect/sql-sqlite-bun reader).
 *
 * Why we wrap `bun:sqlite` directly (not @effect/sql-sqlite-bun): same
 * rationale as `packages/memory/src/backends/sqlite.ts` — dodge the
 * effect/sql v3→v4 churn during Phase 5. ~50-line translation when v4 lands.
 *
 * Pragmas: WAL journaling + synchronous=NORMAL + foreign_keys=ON.
 * - WAL: writers don't block readers; concurrent appends across sessions
 *   serialize cleanly (advisor verdict, Phase 5 pre-flight)
 * - synchronous=NORMAL: durability tradeoff acceptable for chat threads
 *   (a crash may lose the last few ms of writes; no torn rows)
 * - foreign_keys=ON: messages.session_id REFERENCES sessions(id) is
 *   enforced — appending to a ghost session fails at the DB layer too
 *
 * Streaming write coalescing: NOT done here. SessionStore is the durable
 * boundary; ChatService (or whoever calls appendMessage) is responsible
 * for batching streaming deltas and persisting only on turn boundaries.
 * Per advisor: "the Ref is a write coalescer, not a cache."
 */
import { Effect, Layer, Stream } from "effect"
import type {
  SessionOptions,
  SessionQuery,
  SessionStatus,
  SessionSummary,
} from "./types.js"
import {
  MESSAGE_ENVELOPE_VERSION,
  type MessageKind,
  type StoredMessage,
} from "../messages.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { IntegrityError } from "../errors.js"
import { extractTextPreview } from "./projection.js"
import { SessionStore } from "./session-store.js"

// ── Schema ──────────────────────────────────────────────────────────────────
//
// `meta_json` is our additive column for sidebar bookkeeping
// (lastMessageAt, lastMessagePreview). DESIGN.md §5.1 sessions schema is
// the floor, not the ceiling — same pattern the memory backend follows
// when it extends `memory_keyed`.
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    parent_id     TEXT,
    title         TEXT,
    tags          TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    model         TEXT NOT NULL,
    options_json  TEXT NOT NULL,
    status        TEXT NOT NULL,
    meta_json     TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id),
    parent_id     TEXT,
    kind          TEXT NOT NULL,
    role          TEXT,
    content_json  TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    ts            INTEGER NOT NULL,
    seq           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session_seq
    ON messages(session_id, seq);
  CREATE INDEX IF NOT EXISTS idx_sessions_created
    ON sessions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_status
    ON sessions(status);
`

// Version 2: partial index backing the `hasUserMessage` correlated EXISTS in
// list(). Must ship as its own migration version, not appended to SCHEMA_V1:
// applyMigration early-returns once (sessions, 1) is recorded, so any DDL added
// to SCHEMA_V1 never reaches a pre-existing database. A new version advances an
// already-v1 DB to v2 and creates the index there too.
const SCHEMA_V2 = `
  CREATE INDEX IF NOT EXISTS idx_messages_toplevel_user
    ON messages(session_id) WHERE kind = 'user' AND parent_id IS NULL;
`

// ── Row shapes (mirror SQL columns 1:1) ────────────────────────────────────
interface SessionDbRow {
  id: string
  parent_id: string | null
  title: string | null
  tags: string
  created_at: number
  ended_at: number | null
  model: string
  options_json: string
  status: SessionStatus
  meta_json: string
}

interface MessageDbRow {
  id: string
  session_id: string
  parent_id: string | null
  kind: MessageKind
  role: string | null
  content_json: string
  schema_version: number
  ts: number
  seq: number
}

interface SessionMeta {
  readonly lastMessageAt: number | null
  readonly lastMessagePreview: string | null
}

const parseMeta = (s: string): SessionMeta => {
  try {
    const o = JSON.parse(s) as Partial<SessionMeta>
    return {
      lastMessageAt: o.lastMessageAt ?? null,
      lastMessagePreview: o.lastMessagePreview ?? null,
    }
  } catch {
    return { lastMessageAt: null, lastMessagePreview: null }
  }
}

/**
 * Derive the session's persisted effort preference from its options JSON.
 * The switcher stores real effort levels at `sdkOptions.effort` and the
 * ultracode mode as `sdkOptions.settings.ultracode` (see chat-service
 * setThreadConfig) — surface both so SessionSummary reflects mid-thread
 * switches. Best-effort: malformed JSON yields undefined, never a throw.
 */
const effortFromOptionsJson = (optionsJson: string): string | undefined => {
  try {
    const o = JSON.parse(optionsJson) as Partial<SessionOptions>
    const sdk = (o.sdkOptions ?? {}) as Record<string, unknown>
    const settings = sdk["settings"] as Record<string, unknown> | undefined
    if (settings !== undefined && settings["ultracode"] === true) {
      return "ultracode"
    }
    const e = sdk["effort"]
    return typeof e === "string" && e !== "" ? e : undefined
  } catch {
    return undefined
  }
}

const rowToSummary = (r: SessionDbRow): SessionSummary => {
  const meta = parseMeta(r.meta_json)
  const effort = effortFromOptionsJson(r.options_json)
  return {
    id: r.id,
    parentId: r.parent_id,
    title: r.title,
    tags: JSON.parse(r.tags) as ReadonlyArray<string>,
    createdAt: r.created_at,
    endedAt: r.ended_at,
    model: r.model,
    ...(effort !== undefined ? { effort } : {}),
    status: r.status,
    lastMessageAt: meta.lastMessageAt,
    lastMessagePreview: meta.lastMessagePreview,
  }
}

const rowToMessage = (r: MessageDbRow): StoredMessage => ({
  id: r.id,
  sessionId: r.session_id,
  seq: r.seq,
  ts: r.ts,
  parentId: r.parent_id,
  kind: r.kind,
  schemaVersion: MESSAGE_ENVELOPE_VERSION,
  payload: JSON.parse(r.content_json),
})

const integrity = (resource: string, message: string) =>
  new IntegrityError({ module: "session-store", resource, message })

/**
 * Serialize a SessionOptions blob for the `options_json` column, dropping any
 * value JSON cannot represent (cyclic references, functions, BigInt, etc.)
 * instead of throwing.
 *
 * The durable session row only needs the *serializable* configuration
 * (model, effort, settings, …). Live handles such as in-process MCP server
 * objects belong only to the in-memory `sdkOptions` handed to the SDK adapter
 * — they are re-wired fresh on every (re)build and are never read back from
 * this row. The primary fix strips them upstream (chat-service.createThread);
 * this is the belt to the upstream suspenders: a stray non-serializable field
 * degrades to a lossy-but-valid row rather than bricking thread creation.
 *
 * Falls back to `getCircularReplacer` (which substitutes `"[Circular]"` /
 * `"[Unserializable]"`) only when a first plain `JSON.stringify` throws, so the
 * common path keeps full fidelity and zero overhead.
 */
const safeStringifyOptions = (opts: SessionOptions): string => {
  try {
    return JSON.stringify(opts)
  } catch {
    return JSON.stringify(opts, getCircularReplacer())
  }
}

const getCircularReplacer = (): ((key: string, value: unknown) => unknown) => {
  const seen = new WeakSet<object>()
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString()
    if (typeof value === "function") return undefined
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]"
      seen.add(value)
    }
    return value
  }
}

// Minimal `bun:sqlite` shape we need. Typed locally so this file doesn't
// depend on @types/bun (matches the memory backend convention).
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

/**
 * Build a sqlite-backed SessionStore Layer. `dbPath` accepts `":memory:"`
 * for ephemeral tests. The Layer is `Layer.scoped` so the DB handle is
 * closed when the surrounding scope finalizes.
 */
export const makeSessionStoreSqlite = (
  dbPath: string,
): Layer.Layer<SessionStore, never, LunaSqliteBootstrap> =>
  Layer.scoped(
    SessionStore,
    Effect.gen(function* () {
      // Phase 27a: pull the bootstrap Tag BEFORE opening any Database so
      // the process-wide `setCustomSQLite()` swap has run. Side effect
      // only — we don't branch on the result.
      yield* LunaSqliteBootstrap

      // Dynamic import — keeps stock-vitest-under-node from hard-failing at
      // import time. Bun resolves `bun:sqlite` natively.
      const bunSqliteSpec = "bun:sqlite"
      const mod = yield* Effect.tryPromise({
        try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
        catch: (cause) =>
          new Error(`failed to import bun:sqlite: ${String(cause)}`),
      }).pipe(Effect.orDie)
      const Database = (mod as { Database?: unknown }).Database as
        | (new (p: string) => BunDb)
        | undefined
      if (!Database) {
        return yield* Effect.dieMessage("bun:sqlite has no Database export")
      }
      const db = new Database(dbPath)

      // Pragmas — set BEFORE any user data writes. WAL is persisted at
      // file level so reopen-with-WAL is idempotent.
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA synchronous = NORMAL")
      db.run("PRAGMA foreign_keys = ON")

      // §5.2 migration ladder: per-component `schema_versions` ledger
      // (Phase 25e). Replaces the pre-25e `PRAGMA user_version` gate.
      // SessionStore has no Clock dep; Date.now() is fine for the ledger
      // applied_at column (it's an audit timestamp, not a domain time).
      ensureSchemaVersions(db)
      applyMigration(db, "sessions", 1, SCHEMA_V1, Date.now())
      applyMigration(db, "sessions", 2, SCHEMA_V2, Date.now())

      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      // Prepared statements — reused across calls, big perf win.
      const sessionInsert = db.query(
        `INSERT INTO sessions
           (id, parent_id, title, tags, created_at, ended_at, model,
            options_json, status, meta_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      const sessionGet = db.query(`SELECT * FROM sessions WHERE id = ?`)
      const sessionExists = db.query(
        `SELECT 1 AS x FROM sessions WHERE id = ? LIMIT 1`,
      )
      const sessionSetStatus = db.query(
        `UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`,
      )
      const sessionSetOptions = db.query(
        `UPDATE sessions SET options_json = ? WHERE id = ?`,
      )
      const sessionSetModel = db.query(
        `UPDATE sessions SET model = ? WHERE id = ?`,
      )
      const sessionGetOptions = db.query(
        `SELECT options_json FROM sessions WHERE id = ?`,
      )
      const sessionSetMeta = db.query(
        `UPDATE sessions SET meta_json = ? WHERE id = ?`,
      )
      const sessionGetMeta = db.query(
        `SELECT meta_json FROM sessions WHERE id = ?`,
      )
      const messageInsert = db.query(
        `INSERT INTO messages
           (id, session_id, parent_id, kind, role, content_json,
            schema_version, ts, seq)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      const messageNextSeq = db.query(
        `SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq
           FROM messages WHERE session_id = ?`,
      )
      const messagesAll = db.query(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC`,
      )
      // Bounded lookup for the thread's first top-level user message — used by
      // sidebar title derivation. LIMIT 1 so it never materializes the whole
      // message log (the reason readMessages was too costly for derive-on-read).
      const firstUserMessage = db.query(
        `SELECT * FROM messages WHERE session_id = ? AND kind = 'user' ` +
          `AND parent_id IS NULL ORDER BY seq ASC LIMIT 1`,
      )
      const sessionsList = db.query(`SELECT * FROM sessions`)
      // Same as `sessionsList` but restricted to threads that have a top-level
      // user message - mirrors the `firstUserMessage` predicate. Used by
      // list()'s `hasUserMessage` filter to drop empty/probe threads BEFORE the
      // limit is applied. The correlated EXISTS is served by the partial index
      // `idx_messages_toplevel_user`, so it is a per-session index seek that
      // stops at the first match rather than a full scan of `messages`.
      const sessionsListWithUser = db.query(
        `SELECT * FROM sessions s WHERE EXISTS (` +
          `SELECT 1 FROM messages m WHERE m.session_id = s.id ` +
          `AND m.kind = 'user' AND m.parent_id IS NULL)`,
      )

      const create = (input: {
        readonly id: string
        readonly options: SessionOptions
        readonly createdAt: number
      }): Effect.Effect<SessionSummary, IntegrityError> =>
        Effect.suspend(() => {
          const exists = sessionExists.get(input.id) as
            | { x: number }
            | undefined
          if (exists) {
            return Effect.fail(
              integrity(
                "session_id_unique",
                `session ${input.id} already exists`,
              ),
            )
          }
          const opts = input.options
          try {
            sessionInsert.run(
              input.id,
              opts.parentSessionId ?? null,
              opts.title ?? null,
              JSON.stringify(opts.tags ?? []),
              input.createdAt,
              null,
              opts.model,
              // Defense-in-depth: the options blob is caller-supplied and may
              // carry a non-serializable handle (e.g. live MCP server objects
              // with cyclic refs). A raw JSON.stringify throw here used to
              // brick thread creation. `safeStringifyOptions` drops cyclic /
              // unserializable values so a future stray field degrades to a
              // lossy-but-valid row instead of failing the INSERT. Callers that
              // need a field round-tripped must keep it serializable.
              safeStringifyOptions(opts),
              "active",
              JSON.stringify({
                lastMessageAt: null,
                lastMessagePreview: null,
              }),
            )
          } catch (cause) {
            return Effect.fail(
              integrity(
                "session_insert",
                `insert failed: ${String(cause)}`,
              ),
            )
          }
          const summary: SessionSummary = {
            id: input.id,
            parentId: opts.parentSessionId ?? null,
            title: opts.title ?? null,
            tags: opts.tags ?? [],
            createdAt: input.createdAt,
            endedAt: null,
            model: opts.model,
            status: "active",
            lastMessageAt: null,
            lastMessagePreview: null,
          }
          return Effect.succeed(summary)
        })

      const get = (
        id: string,
      ): Effect.Effect<SessionSummary | null, never> =>
        Effect.sync(() => {
          const row = sessionGet.get(id) as SessionDbRow | undefined
          return row ? rowToSummary(row) : null
        })

      const getOptions = (
        id: string,
      ): Effect.Effect<SessionOptions | null, never> =>
        Effect.sync(() => {
          const row = sessionGet.get(id) as SessionDbRow | undefined
          if (!row) return null
          try {
            return JSON.parse(row.options_json) as SessionOptions
          } catch {
            return null
          }
        })

      const setStatus = (
        id: string,
        status: SessionStatus,
        endedAt: number | null = null,
      ): Effect.Effect<void, IntegrityError> =>
        Effect.suspend(() => {
          const exists = sessionExists.get(id) as { x: number } | undefined
          if (!exists) {
            return Effect.fail(
              integrity("session_exists", `session ${id} not found`),
            )
          }
          sessionSetStatus.run(status, endedAt, id)
          return Effect.void
        })

      /**
       * Patch the stored options blob for an existing session.
       * Silently no-ops on unknown session ids (best-effort — the caller
       * may race a session close). Mirrors the in-memory setOptions semantics.
       */
      const setOptions = (
        id: string,
        patch: Partial<SessionOptions>,
      ): Effect.Effect<void, never> =>
        Effect.sync(() => {
          const row = sessionGetOptions.get(id) as
            | { options_json: string }
            | undefined
          if (!row) return
          let existing: SessionOptions
          try {
            existing = JSON.parse(row.options_json) as SessionOptions
          } catch {
            return // corrupted — skip silently
          }
          const merged = { ...existing, ...patch }
          try {
            sessionSetOptions.run(JSON.stringify(merged), id)
          } catch {
            // best-effort: a failed options patch is not a hard error
          }
          // Keep the denormalized `model` column in sync: SessionSummary
          // (thread-list / thread-created / smart bar) reads the column, so
          // leaving it at the creation-time value makes every client display
          // a stale model forever after a mid-thread switch.
          if (typeof patch.model === "string" && patch.model.trim() !== "") {
            try {
              sessionSetModel.run(patch.model, id)
            } catch {
              // best-effort, same contract as the options patch above
            }
          }
        })

      const appendMessage = (input: {
        readonly sessionId: string
        readonly messageId: string
        readonly ts: number
        readonly parentId: string | null
        readonly kind: MessageKind
        readonly payload: unknown
      }): Effect.Effect<StoredMessage, IntegrityError> =>
        Effect.suspend(() => {
          // All SQLite access — reads AND writes — lives inside one try/catch
          // so that SQLITE_BUSY / SQLITE_IOERR on any statement surfaces as a
          // typed IntegrityError (Effect.fail) rather than a raw throw that
          // propagates as a defect through Effect.suspend.  A defect would
          // escape adapter.ts's `Effect.catchAll` (which catches only typed
          // failures) and could kill the live streaming fiber.
          try {
            const exists = sessionExists.get(input.sessionId) as
              | { x: number }
              | undefined
            if (!exists) {
              return Effect.fail(
                integrity(
                  "message_session_exists",
                  `session ${input.sessionId} not found`,
                ),
              )
            }

            const role =
              input.kind === "user" || input.kind === "assistant"
                ? input.kind
                : null

            // BEGIN IMMEDIATE acquires a write lock BEFORE we read seq so
            // that two fibers appending to the same session cannot both read
            // the same MAX(seq) and then race the INSERT (duplicate seq).
            // seq-allocation + INSERT + meta update are all atomic inside this
            // one transaction.
            db.run("BEGIN IMMEDIATE")
            let stored: StoredMessage
            try {
              // Read seq INSIDE the write transaction so the read + INSERT
              // are atomic. No other writer can slip between these two
              // statements because BEGIN IMMEDIATE holds the write lock.
              const seqRow = messageNextSeq.get(input.sessionId) as {
                next_seq: number
              }
              const seq = seqRow.next_seq

              stored = {
                id: input.messageId,
                sessionId: input.sessionId,
                seq,
                ts: input.ts,
                parentId: input.parentId,
                kind: input.kind,
                schemaVersion: MESSAGE_ENVELOPE_VERSION,
                payload: input.payload,
              }

              // Update sidebar metadata. Mirrors in-memory store semantics
              // exactly: any kind bumps lastMessageAt; only user/assistant
              // refresh the preview.
              const metaRow = sessionGetMeta.get(input.sessionId) as
                | { meta_json: string }
                | undefined
              const meta = metaRow
                ? parseMeta(metaRow.meta_json)
                : {
                    lastMessageAt: null,
                    lastMessagePreview: null,
                  }
              // Parented (subagent-internal) messages never refresh the preview:
              // the SDK forwards a subagent's seed prompt as a parented user
              // message, and without this gate every Task spawn would overwrite
              // the sidebar with internal prompt text. lastMessageAt still bumps.
              const nextPreview =
                input.parentId == null &&
                (input.kind === "user" || input.kind === "assistant")
                  ? extractTextPreview(input.payload) ?? meta.lastMessagePreview
                  : meta.lastMessagePreview
              const nextMeta: SessionMeta = {
                lastMessageAt: input.ts,
                lastMessagePreview: nextPreview,
              }

              messageInsert.run(
                input.messageId,
                input.sessionId,
                input.parentId,
                input.kind,
                role,
                JSON.stringify(input.payload),
                MESSAGE_ENVELOPE_VERSION,
                input.ts,
                seq,
              )
              sessionSetMeta.run(JSON.stringify(nextMeta), input.sessionId)
              db.run("COMMIT")
            } catch (cause) {
              try {
                db.run("ROLLBACK")
              } catch {
                /* ignore — best-effort cleanup */
              }
              return Effect.fail(
                integrity("message_insert", `insert failed: ${String(cause)}`),
              )
            }

            return Effect.succeed(stored)
          } catch (cause) {
            // Catches read errors (SQLITE_BUSY, SQLITE_IOERR, etc.) from the
            // SELECTs above, converting them to typed failures so onMirrorError
            // can handle them without the error escaping as a defect.
            return Effect.fail(
              integrity(
                "message_read",
                `read failed during append: ${String(cause)}`,
              ),
            )
          }
        })

      const readMessages = (
        sessionId: string,
      ): Stream.Stream<StoredMessage, IntegrityError> =>
        Stream.unwrap(
          Effect.sync(() => {
            const exists = sessionExists.get(sessionId) as
              | { x: number }
              | undefined
            if (!exists) {
              return Stream.fail(
                integrity("session_exists", `session ${sessionId} not found`),
              )
            }
            const rows = messagesAll.all(sessionId) as MessageDbRow[]
            return Stream.fromIterable(rows.map(rowToMessage))
          }),
        )

      // First top-level user message, or null (also null for an unknown
      // session — callers treat "no first message" the same as "not found").
      const readFirstUserMessage = (
        sessionId: string,
      ): Effect.Effect<StoredMessage | null, never> =>
        Effect.sync(() => {
          const row = firstUserMessage.get(sessionId) as MessageDbRow | undefined
          return row ? rowToMessage(row) : null
        })

      const list = (
        q: SessionQuery = {},
      ): Stream.Stream<SessionSummary, never> =>
        Stream.unwrap(
          Effect.sync(() => {
            const rows = (
              q.hasUserMessage ? sessionsListWithUser : sessionsList
            ).all() as SessionDbRow[]
            const summaries = rows.map(rowToSummary)
            let filtered = summaries
            if (q.status)
              filtered = filtered.filter((r) => r.status === q.status)
            if (q.parentId)
              filtered = filtered.filter((r) => r.parentId === q.parentId)
            if (q.tag)
              filtered = filtered.filter((r) => r.tags.includes(q.tag!))
            if (q.orderBy === "lastMessageAt") {
              filtered.sort(
                (a, b) =>
                  (b.lastMessageAt ?? b.createdAt) -
                  (a.lastMessageAt ?? a.createdAt),
              )
            } else {
              filtered.sort((a, b) => b.createdAt - a.createdAt)
            }
            if (q.limit !== undefined) filtered = filtered.slice(0, q.limit)
            return Stream.fromIterable(filtered)
          }),
        )

      return SessionStore.of({
        _tag: "luna/SessionStore",
        create,
        get,
        getOptions,
        setOptions,
        setStatus,
        appendMessage,
        readMessages,
        readFirstUserMessage,
        list,
      })
    }),
  )

/**
 * Convenience: alias on the SessionStore class for symmetry with
 * `SessionStore.Default`. Use as `SessionStore.fromPath("~/.luna/luna.db")`
 * — matches the SqliteBackend pattern in `@luna/memory`.
 *
 * Pass `":memory:"` for ephemeral test DBs.
 */
// Attach as a static via interface augmentation. Done outside the class
// definition because SessionStore is generated by Effect.Service<>().
;(SessionStore as unknown as {
  fromPath: (
    dbPath: string,
  ) => Layer.Layer<SessionStore, never, LunaSqliteBootstrap>
}).fromPath = makeSessionStoreSqlite

declare module "./session-store.js" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace SessionStore {
    /** SQLite-backed Layer (Phase 5 persistence). */
    function fromPath(
      dbPath: string,
    ): Layer.Layer<SessionStore, never, LunaSqliteBootstrap>
  }
}
