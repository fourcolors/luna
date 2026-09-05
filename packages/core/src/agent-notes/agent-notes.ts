/**
 * AgentNotesService — in-memory and SQLite-backed layers.
 *
 * Two layers:
 *   AgentNotesService.Memory — in-memory Ref<Map<string, AgentNote>>.
 *     No SQLite. Used by all unit tests.
 *   AgentNotesService.makeLayer(dbPath) — SQLite-backed Layer.
 *     Mirrors telemetry-store-sqlite.ts patterns exactly.
 */
import { createHash } from "node:crypto"
import { Context, Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import type {
  AgentNote,
  AgentNotesApi,
  GatedNoteResult,
  NoteKind,
  UnparsedPayload,
} from "./types.js"
import { DEFAULT_HEARTBEAT_MS, NoteError } from "./types.js"

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

// ── Fingerprinting ────────────────────────────────────────────────────────────

/**
 * Produce a canonical JSON encoding of a value with keys sorted
 * deterministically. Nested objects are also sorted. Arrays are preserved
 * as-is (element order is meaningful).
 *
 * The reserved `_gate` key is excluded from the encoding so that a note
 * written by `recordIfChanged` (which injects `_gate.fp` into the payload)
 * can be fingerprinted consistently when used as the previous note baseline.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value)
  }
  const obj = value as Record<string, unknown>
  const sorted = Object.keys(obj)
    .filter((k) => k !== "_gate")
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k]
      return acc
    }, {})
  // Recursively encode each value canonically
  const entries = Object.keys(sorted)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(sorted[k])}`)
    .join(",")
  return `{${entries}}`
}

/**
 * Compute a content fingerprint from a note's summary and payload.
 * The `_gate` key is excluded from the payload encoding.
 *
 * Uses a simple deterministic string — no crypto dependency — that is
 * stable across identical inputs.
 */
const computeFingerprint = (summary: string, payload: unknown): string => {
  const payloadPart = canonicalJson(payload)
  // NUL separates the two parts so that a summary ending in the payload's
  // leading characters cannot collide with a shorter summary.
  const material = `summary:${summary}\x00payload:${payloadPart}`
  // Hash rather than storing the material verbatim: the fingerprint is
  // persisted into every gated note's payload, so an unhashed value would
  // duplicate the whole note's content on every row it guards.
  return createHash("sha256").update(material).digest("hex")
}

/**
 * Derive the fingerprint from an existing {@link AgentNote}.
 *
 * If the note's payload contains `_gate.fp`, that stored fingerprint is
 * returned directly (it was written by a previous `recordIfChanged` call).
 * Otherwise the fingerprint is recomputed from the note's summary and
 * payload, making the gate work against rows written before this feature.
 */
const derivePreviousFingerprint = (note: AgentNote): string => {
  if (
    note.payload !== null &&
    typeof note.payload === "object" &&
    !Array.isArray(note.payload)
  ) {
    const p = note.payload as Record<string, unknown>
    if (
      typeof p["_gate"] === "object" &&
      p["_gate"] !== null &&
      typeof (p["_gate"] as Record<string, unknown>)["fp"] === "string"
    ) {
      return (p["_gate"] as Record<string, unknown>)["fp"] as string
    }
  }
  return computeFingerprint(note.summary, note.payload)
}

/**
 * Merge `_gate: { fp }` into a caller-supplied payload.
 * If payload is null/undefined, creates `{ _gate: { fp } }`.
 * The caller's `_gate` key, if any, is replaced.
 */
const withGateMetadata = (payload: unknown, fp: string): Record<string, unknown> => {
  const base: Record<string, unknown> =
    payload !== null &&
    payload !== undefined &&
    typeof payload === "object" &&
    !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>) }
      : {}
  base["_gate"] = { fp }
  return base
}

// ── Service Tag ──────────────────────────────────────────────────────────────

export class AgentNotesService extends Context.Service<AgentNotesService, AgentNotesApi>()("luna/AgentNotesService") {
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

      const recordIfChanged: AgentNotesApi["recordIfChanged"] = (input, opts) =>
        Effect.gen(function* () {
          const heartbeatMs = opts?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

          // Reject negative heartbeat values
          if (heartbeatMs < 0) {
            return yield* Effect.fail(
              new NoteError({
                op: "record",
                message: `heartbeatMs must be >= 0, got ${heartbeatMs}`,
              }),
            )
          }

          // Compute the candidate fingerprint
          const fp =
            opts?.fingerprint ??
            computeFingerprint(input.summary, input.payload)

          // Look up the most recent existing note of this kind
          const recent = yield* getByKind(input.kind, 1)
          const prev = recent[0] ?? null

          if (prev !== null) {
            const prevFp = derivePreviousFingerprint(prev)
            const now = yield* clock.nowMs()
            const age = now - prev.ts

            // Suppress when fingerprint matches AND heartbeat has NOT elapsed
            if (prevFp === fp && (heartbeatMs === 0 ? false : age < heartbeatMs)) {
              const result: GatedNoteResult = {
                suppressed: true,
                lastTs: prev.ts,
                lastId: prev.id,
              }
              return result
            }
          }

          // Record — inject _gate metadata into payload
          const mergedPayload = withGateMetadata(input.payload, fp)
          const note = yield* record({ ...input, payload: mergedPayload })
          const result: GatedNoteResult = { suppressed: false, note }
          return result
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
        recordIfChanged,
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
    return Layer.effect(
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

        /**
         * Serialize payload to JSON string, returning NoteError for
         * non-serializable values. Extracted to a helper so both `record` and
         * `recordIfChanged` share the same guard.
         */
        const serializePayload = (
          payload: unknown,
        ): Effect.Effect<string | null, NoteError> =>
          Effect.gen(function* () {
            if (payload === undefined) return null
            try {
              const encoded = JSON.stringify(payload)
              if (encoded === undefined) {
                return yield* Effect.fail(
                  new NoteError({
                    op: "record",
                    message: `payload is not JSON-serializable (${typeof payload})`,
                  }),
                )
              }
              return encoded
            } catch (cause) {
              return yield* Effect.fail(
                new NoteError({
                  op: "record",
                  message: `failed to serialize payload: ${String(cause)}`,
                  cause,
                }),
              )
            }
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
            const payloadJson = yield* serializePayload(input.payload)
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

        const recordIfChanged: AgentNotesApi["recordIfChanged"] = (input, opts) =>
          Effect.gen(function* () {
            const heartbeatMs = opts?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

            // Reject negative heartbeat values
            if (heartbeatMs < 0) {
              return yield* Effect.fail(
                new NoteError({
                  op: "record",
                  message: `heartbeatMs must be >= 0, got ${heartbeatMs}`,
                }),
              )
            }

            // Validate payload serializability BEFORE any DB read.
            // This preserves the NoteError discipline: a non-serializable
            // payload must fail with NoteError, not throw a defect, regardless
            // of whether a previous note exists.
            //
            // We serialize the candidate payload (without _gate) first, just
            // to catch the error early. The actual merged payload is serialized
            // again inside `record` after we merge in `_gate`.
            if (input.payload !== undefined) {
              yield* serializePayload(input.payload)
            }

            // Compute the candidate fingerprint
            const fp =
              opts?.fingerprint ??
              computeFingerprint(input.summary, input.payload)

            // Look up the most recent existing note of this kind
            const recent = yield* getByKind(input.kind, 1)
            const prev = recent[0] ?? null

            if (prev !== null) {
              const prevFp = derivePreviousFingerprint(prev)
              const now = yield* clock.nowMs()
              const age = now - prev.ts

              // Suppress when fingerprint matches AND heartbeat has NOT elapsed
              // heartbeatMs === 0 means always record (no suppression)
              if (prevFp === fp && heartbeatMs > 0 && age < heartbeatMs) {
                const result: GatedNoteResult = {
                  suppressed: true,
                  lastTs: prev.ts,
                  lastId: prev.id,
                }
                return result
              }
            }

            // Record — inject _gate metadata into payload
            const mergedPayload = withGateMetadata(input.payload, fp)
            const note = yield* record({ ...input, payload: mergedPayload })
            const result: GatedNoteResult = { suppressed: false, note }
            return result
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
          recordIfChanged,
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
