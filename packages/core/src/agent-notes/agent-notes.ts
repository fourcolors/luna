/**
 * AgentNotesService — in-memory and SQLite-backed layers.
 *
 * Two layers:
 *   AgentNotesService.Memory — in-memory Ref<Map<string, AgentNote>>.
 *     No SQLite. Used by all unit tests.
 *   AgentNotesService.makeLayer(dbPath) — SQLite-backed Layer.
 *     Mirrors telemetry-store-sqlite.ts patterns exactly.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import type {
  AgentNote,
  AgentNotesApi,
  NoteKind,
  UnparsedPayload,
} from "./types.js"
import { NoteError } from "./types.js"

/**
 * Upper bound on the `raw` text carried by an {@link UnparsedPayload}.
 * Nothing constrains the size of `payload_json`, and the envelope is passed
 * straight through to tool output, so cap it rather than echoing an unbounded
 * blob. Observed malformed rows are ~2 KB, well under this.
 */
const UNPARSED_RAW_MAX = 4096

// ── Schema DDL ───────────────────────────────────────────────────────────────

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS agent_notes (
    id           TEXT NOT NULL PRIMARY KEY,
    session_id   TEXT NOT NULL,
    parent_id    TEXT,
    kind         TEXT NOT NULL,
    summary      TEXT NOT NULL,
    payload_json TEXT,
    ts           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_notes_session_ts
    ON agent_notes(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_agent_notes_kind_ts
    ON agent_notes(kind, ts);
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

export class AgentNotesService extends Effect.Tag("luna/AgentNotesService")<
  AgentNotesService,
  AgentNotesApi
>() {
  // ── Memory Layer ───────────────────────────────────────────────────────────

  /**
   * In-memory Ref<Map<string, AgentNote>> layer. No SQLite.
   * Used by all unit tests. Provides a fresh isolated store per run.
   */
  static Memory: Layer.Layer<AgentNotesService, never, Clock> = Layer.effect(
    AgentNotesService,
    Effect.gen(function* () {
      const clock = yield* Clock
      const store = yield* Ref.make<Map<string, AgentNote>>(new Map())

      const record: AgentNotesApi["record"] = (input) =>
        Effect.gen(function* () {
          const ts = yield* clock.nowMs()
          const id = input.id ?? crypto.randomUUID()
          const note: AgentNote = {
            id,
            sessionId: input.sessionId,
            parentId: input.parentId ?? null,
            kind: input.kind,
            summary: input.summary,
            payload: input.payload ?? null,
            ts,
          }
          yield* Ref.update(store, (map) => {
            const next = new Map(map)
            next.set(id, note)
            return next
          })
          return note
        })

      const getRecent: AgentNotesApi["getRecent"] = (sessionId, limit = 20) =>
        Ref.get(store).pipe(
          Effect.map((map) => {
            // Map preserves insertion order (ASC). Reverse first so that
            // when ts values are equal the stable sort keeps the later-inserted
            // note first (DESC insertion-order tiebreak).
            const notes = Array.from(map.values())
              .filter((n) => n.sessionId === sessionId)
              .reverse()
            notes.sort((a, b) => b.ts - a.ts)
            return notes.slice(0, limit) as ReadonlyArray<AgentNote>
          }),
        )

      const getRecentAcrossSessions: AgentNotesApi["getRecentAcrossSessions"] = (
        limit = 20,
      ) =>
        Ref.get(store).pipe(
          Effect.map((map) => {
            // Reverse before stable sort so equal-ts notes retain DESC insertion order.
            const notes = Array.from(map.values()).reverse()
            notes.sort((a, b) => b.ts - a.ts)
            return notes.slice(0, limit) as ReadonlyArray<AgentNote>
          }),
        )

      const getChain: AgentNotesApi["getChain"] = (sessionId) =>
        Ref.get(store).pipe(
          Effect.map((map) => {
            const notes = Array.from(map.values()).filter(
              (n) => n.sessionId === sessionId,
            )
            // Sort ts ASC; preserve insertion order for equal ts
            notes.sort((a, b) => a.ts - b.ts)
            return notes as ReadonlyArray<AgentNote>
          }),
        )

      const getByKind: AgentNotesApi["getByKind"] = (kind, limit = 50) =>
        Ref.get(store).pipe(
          Effect.map((map) => {
            // Reverse before stable sort so equal-ts notes retain DESC insertion order
            const notes = Array.from(map.values())
              .filter((n) => n.kind === kind)
              .reverse()
            notes.sort((a, b) => b.ts - a.ts)
            return notes.slice(0, limit) as ReadonlyArray<AgentNote>
          }),
        )

      const getById: AgentNotesApi["getById"] = (id) =>
        Ref.get(store).pipe(
          Effect.map((map) => map.get(id) ?? null),
        )

      const deleteForSession: AgentNotesApi["deleteForSession"] = (sessionId) =>
        Ref.modify(store, (map) => {
          const next = new Map(map)
          let count = 0
          for (const [id, note] of next) {
            if (note.sessionId === sessionId) {
              next.delete(id)
              count++
            }
          }
          return [count, next] as [number, Map<string, AgentNote>]
        })

      return {
        record,
        getRecent,
        getRecentAcrossSessions,
        getChain,
        getByKind,
        getById,
        deleteForSession,
      } satisfies AgentNotesApi
    }),
  )

  // ── SQLite Layer factory ───────────────────────────────────────────────────

  /**
   * Build a SQLite-backed AgentNotesService Layer. Mirrors telemetry-store-sqlite.ts.
   * `dbPath` accepts `":memory:"` for ephemeral tests.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<AgentNotesService, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      AgentNotesService,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap

        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () =>
            import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "agent-notes",
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
              module: "agent-notes",
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
        applyMigration(db, "agent-notes", 1, SCHEMA_V1, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements
        const insertStmt = db.query(
          `INSERT INTO agent_notes
             (id, session_id, parent_id, kind, summary, payload_json, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        const recentStmt = db.query(
          `SELECT id, session_id, parent_id, kind, summary, payload_json, ts
           FROM agent_notes
           WHERE session_id = ?
           ORDER BY ts DESC
           LIMIT ?`,
        )
        const chainStmt = db.query(
          `SELECT id, session_id, parent_id, kind, summary, payload_json, ts
           FROM agent_notes
           WHERE session_id = ?
           ORDER BY ts ASC`,
        )
        const byKindStmt = db.query(
          `SELECT id, session_id, parent_id, kind, summary, payload_json, ts
           FROM agent_notes
           WHERE kind = ?
           ORDER BY ts DESC
           LIMIT ?`,
        )
        const recentAllStmt = db.query(
          `SELECT id, session_id, parent_id, kind, summary, payload_json, ts
           FROM agent_notes
           ORDER BY ts DESC
           LIMIT ?`,
        )
        const byIdStmt = db.query(
          `SELECT id, session_id, parent_id, kind, summary, payload_json, ts
           FROM agent_notes
           WHERE id = ?`,
        )
        const deleteStmt = db.query(
          `DELETE FROM agent_notes WHERE session_id = ?`,
        )

        type RawRow = {
          id: string
          session_id: string
          parent_id: string | null
          kind: string
          summary: string
          payload_json: string | null
          ts: number
        }

        /**
         * Decode `payload_json`, degrading a malformed value instead of
         * throwing. `rowToNote` runs inside `.map` for every list read, so a
         * bare `JSON.parse` here made ONE poisoned row fail the ENTIRE query —
         * every healthy note in the page was lost with it, which took
         * `obs_notes_recent()` offline completely.
         *
         * Unlike jobs-store's `rowToJob` (which skips the row, because an
         * undispatchable job is worse than a missing one), notes are an audit
         * trail: the summary/kind/ts stay valuable, so the row is KEPT and only
         * `payload` degrades. See `UnparsedPayload` for why an envelope beats
         * `null` or the raw string. Read-side only — never written back.
         */
        const parsePayload = (raw: string | null, id: string): unknown => {
          if (raw == null) return null
          try {
            return JSON.parse(raw)
          } catch (cause) {
            // Never silent: log the id so the poisoned row stays locatable
            // (idiom mirrors jobs-store.ts).
            console.warn(
              `[agent-notes] note "${id}": unparseable payload_json: ${String(cause)} — surfacing as __unparsed envelope`,
            )
            const envelope: UnparsedPayload =
              raw.length > UNPARSED_RAW_MAX
                ? {
                    __unparsed: true,
                    raw: raw.slice(0, UNPARSED_RAW_MAX),
                    error: String(cause),
                    truncated: true,
                  }
                : { __unparsed: true, raw, error: String(cause) }
            return envelope
          }
        }

        const rowToNote = (row: RawRow): AgentNote => ({
          id: row.id,
          sessionId: row.session_id,
          parentId: row.parent_id,
          kind: row.kind,
          summary: row.summary,
          payload: parsePayload(row.payload_json, row.id),
          ts: row.ts,
        })

        const record: AgentNotesApi["record"] = (input) =>
          Effect.gen(function* () {
            const ts = yield* clock.nowMs()
            const id = input.id ?? crypto.randomUUID()
            // `JSON.stringify` can THROW (circular reference, BigInt) or return
            // `undefined` (function/symbol payload). Both used to escape the
            // declared `NoteError` failure channel — the throw as an unhandled
            // defect, the `undefined` as a bad statement binding — because this
            // ran before BEGIN IMMEDIATE and outside the try/catch below.
            let payloadJson: string | null = null
            if (input.payload !== undefined) {
              try {
                const encoded = JSON.stringify(input.payload)
                if (encoded === undefined) {
                  return yield* Effect.fail(
                    new NoteError({
                      op: "record",
                      message: `payload is not JSON-serializable (${typeof input.payload})`,
                    }),
                  )
                }
                payloadJson = encoded
              } catch (cause) {
                return yield* Effect.fail(
                  new NoteError({
                    op: "record",
                    message: `failed to serialize payload: ${String(cause)}`,
                    cause,
                  }),
                )
              }
            }
            db.run("BEGIN IMMEDIATE")
            try {
              insertStmt.run(
                id,
                input.sessionId,
                input.parentId ?? null,
                input.kind,
                input.summary,
                payloadJson,
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
                new NoteError({
                  op: "record",
                  message: String(e),
                  cause: e,
                }),
              )
            }
            return {
              id,
              sessionId: input.sessionId,
              parentId: input.parentId ?? null,
              kind: input.kind,
              summary: input.summary,
              payload: input.payload ?? null,
              ts,
            } satisfies AgentNote
          })

        const getRecent: AgentNotesApi["getRecent"] = (sessionId, limit = 20) =>
          Effect.try({
            try: () =>
              (recentStmt.all(sessionId, limit) as RawRow[]).map(rowToNote),
            catch: (cause) =>
              new NoteError({ op: "query", message: String(cause), cause }),
          })

        const getRecentAcrossSessions: AgentNotesApi["getRecentAcrossSessions"] = (
          limit = 20,
        ) =>
          Effect.try({
            try: () =>
              (recentAllStmt.all(limit) as RawRow[]).map(rowToNote),
            catch: (cause) =>
              new NoteError({ op: "query", message: String(cause), cause }),
          })

        const getChain: AgentNotesApi["getChain"] = (sessionId) =>
          Effect.try({
            try: () =>
              (chainStmt.all(sessionId) as RawRow[]).map(rowToNote),
            catch: (cause) =>
              new NoteError({ op: "query", message: String(cause), cause }),
          })

        const getByKind: AgentNotesApi["getByKind"] = (kind, limit = 50) =>
          Effect.try({
            try: () =>
              (byKindStmt.all(kind, limit) as RawRow[]).map(rowToNote),
            catch: (cause) =>
              new NoteError({ op: "query", message: String(cause), cause }),
          })

        const getById: AgentNotesApi["getById"] = (id) =>
          Effect.try({
            try: () => {
              const row = byIdStmt.get(id) as RawRow | undefined | null
              return row != null ? rowToNote(row) : null
            },
            catch: (cause) =>
              new NoteError({ op: "query", message: String(cause), cause }),
          })

        const deleteForSession: AgentNotesApi["deleteForSession"] = (
          sessionId,
        ) =>
          Effect.try({
            try: () => {
              db.run("BEGIN IMMEDIATE")
              try {
                const result = deleteStmt.run(sessionId)
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
              new NoteError({ op: "delete", message: String(cause), cause }),
          })

        return {
          record,
          getRecent,
          getRecentAcrossSessions,
          getChain,
          getByKind,
          getById,
          deleteForSession,
        } satisfies AgentNotesApi
      }),
    )
  }
}
