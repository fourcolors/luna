/**
 * SuggestedActionsStore — SQLite-backed two-layer store for Luna's proposed
 * actions. Mirrors AlignmentStore's shape exactly:
 *
 *   - `suggested_action_log` is an append-only audit ledger (one row per
 *     lifecycle event), idempotent on a deterministic id derived from
 *     (actionId, event, at) via INSERT OR IGNORE.
 *   - `suggested_action_state` holds ONE row per action — its current status,
 *     payload, and (once accepted) the durable execution link. This row is the
 *     AUTHORITATIVE source of truth for status; lifecycle transitions are
 *     guarded `UPDATE … WHERE status = <expected>` so a double-accept can only
 *     win once (the atomicity guard behind "accept can't double-execute").
 *
 * Layers mirror AlignmentStore: Memory (Ref) for tests, makeLayer(dbPath) over
 * bun:sqlite requiring Clock + LunaSqliteBootstrap.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import { SUGGESTED_ACTIONS_COMPONENT, SuggestedActionsError } from "./types.js"
import type {
  ExecutionRef,
  ListThreadQuery,
  ProposeInput,
  SuggestedActionLogRow,
  SuggestedActionPayload,
  SuggestedActionRow,
  SuggestedActionStatus,
} from "./types.js"

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

const STATUS_CHECK =
  "('proposed','accepted','in_progress','completed','failed','dismissed')"

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS suggested_action_log (
    id           TEXT NOT NULL PRIMARY KEY,
    action_id    TEXT NOT NULL,
    at           INTEGER NOT NULL,
    event        TEXT NOT NULL CHECK(event IN ${STATUS_CHECK}),
    thread_id    TEXT NOT NULL,
    source       TEXT NOT NULL CHECK(source IN ('agent','dream')),
    action_type  TEXT NOT NULL CHECK(action_type IN ('task','research','create_skill','create_workflow','run_workflow')),
    payload_json TEXT NOT NULL,
    UNIQUE(action_id, event, at)
  );
  CREATE INDEX IF NOT EXISTS idx_sa_log_action ON suggested_action_log(action_id);
  CREATE INDEX IF NOT EXISTS idx_sa_log_thread ON suggested_action_log(thread_id);

  CREATE TABLE IF NOT EXISTS suggested_action_state (
    action_id      TEXT NOT NULL PRIMARY KEY,
    thread_id      TEXT NOT NULL,
    source         TEXT NOT NULL,
    action_type    TEXT NOT NULL,
    title          TEXT NOT NULL,
    detail         TEXT,
    rationale      TEXT,
    payload_json   TEXT NOT NULL,
    status         TEXT NOT NULL CHECK(status IN ${STATUS_CHECK}),
    execution_kind TEXT,
    execution_id   TEXT,
    error          TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sa_state_thread_status ON suggested_action_state(thread_id, status);
`

// ── Deterministic ids ──────────────────────────────────────────────────────────

/** FNV-1a (32-bit) — same family belief-writer uses for content ids. */
const fnv1a = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** Content-derived action id so re-proposing the SAME (thread, type, title)
 *  dedups via the state-row PK (no nagging duplicates). Explicit `id` wins. */
const deriveActionId = (i: ProposeInput): string =>
  i.id ??
  `sa-${fnv1a(`${i.threadId}|${i.actionType}|${i.title.trim().toLowerCase()}`)}`

/** Audit-log row id — idempotency key on (actionId, event, at). */
const deriveLogId = (actionId: string, event: string, at: number): string =>
  `sal-${actionId}-${event}-${at}`

// ── API ─────────────────────────────────────────────────────────────────────

export interface SuggestedActionsStoreApi {
  /** Stage a proposed action (log + state). Idempotent on the action id — if a
   *  row already exists (any status) it is returned unchanged (no resurrection,
   *  no duplicate). Returns the current row. */
  readonly propose: (
    input: ProposeInput,
  ) => Effect.Effect<SuggestedActionRow, SuggestedActionsError>
  readonly getById: (
    id: string,
  ) => Effect.Effect<SuggestedActionRow | null, SuggestedActionsError>
  /** Thread's actions, oldest-first; optionally filtered by status. */
  readonly listByThread: (
    threadId: string,
    q?: ListThreadQuery,
  ) => Effect.Effect<ReadonlyArray<SuggestedActionRow>, SuggestedActionsError>
  /** Every action currently `in_progress` (drives the completion observer). */
  readonly listInProgress: () => Effect.Effect<
    ReadonlyArray<SuggestedActionRow>,
    SuggestedActionsError
  >
  /** Atomic `proposed → accepted`. Returns the row only if THIS call won the
   *  transition (changes === 1); null if it was already non-proposed. */
  readonly markAccepted: (
    id: string,
  ) => Effect.Effect<SuggestedActionRow | null, SuggestedActionsError>
  /** Atomic `proposed → dismissed`. Returns the row, or null if not proposed. */
  readonly markDismissed: (
    id: string,
  ) => Effect.Effect<SuggestedActionRow | null, SuggestedActionsError>
  /** `accepted → in_progress`, recording the execution link. */
  readonly recordExecution: (
    id: string,
    exec: ExecutionRef,
  ) => Effect.Effect<SuggestedActionRow | null, SuggestedActionsError>
  /** `accepted|in_progress → completed|failed` (terminal). */
  readonly recordTerminal: (
    id: string,
    status: "completed" | "failed",
    error?: string | null,
  ) => Effect.Effect<SuggestedActionRow | null, SuggestedActionsError>
}

export class SuggestedActionsStore extends Effect.Tag(
  "luna/SuggestedActionsStore",
)<SuggestedActionsStore, SuggestedActionsStoreApi>() {
  /** Ref-backed in-memory layer for tests. No SQLite. */
  static readonly Memory: Layer.Layer<SuggestedActionsStore, never, Clock> =
    Layer.effect(
      SuggestedActionsStore,
      Effect.gen(function* () {
        const clock = yield* Clock
        const states = yield* Ref.make<ReadonlyArray<SuggestedActionRow>>([])
        const log = yield* Ref.make<ReadonlyArray<SuggestedActionLogRow>>([])

        const appendLog = (r: SuggestedActionRow, event: SuggestedActionStatus, at: number) =>
          Ref.update(log, (ls) => {
            const id = deriveLogId(r.id, event, at)
            if (ls.some((l) => l.id === id)) return ls
            return [
              ...ls,
              {
                id,
                actionId: r.id,
                at,
                event,
                threadId: r.threadId,
                source: r.source,
                actionType: r.actionType,
              },
            ]
          })

        const propose: SuggestedActionsStoreApi["propose"] = (input) =>
          Effect.gen(function* () {
            const id = deriveActionId(input)
            const existing = (yield* Ref.get(states)).find((r) => r.id === id)
            if (existing) return existing
            const at = input.at ?? (yield* clock.nowMs())
            const row: SuggestedActionRow = {
              id,
              threadId: input.threadId,
              source: input.source,
              actionType: input.actionType,
              title: input.title,
              detail: input.detail ?? null,
              rationale: input.rationale ?? null,
              payload: input.payload,
              status: "proposed",
              executionKind: null,
              executionId: null,
              error: null,
              createdAt: at,
              updatedAt: at,
            }
            yield* Ref.update(states, (rs) => [...rs, row])
            yield* appendLog(row, "proposed", at)
            return row
          })

        const getById: SuggestedActionsStoreApi["getById"] = (id) =>
          Ref.get(states).pipe(Effect.map((rs) => rs.find((r) => r.id === id) ?? null))

        const listByThread: SuggestedActionsStoreApi["listByThread"] = (threadId, q) =>
          Ref.get(states).pipe(
            Effect.map((rs) => {
              let out = rs.filter((r) => r.threadId === threadId)
              if (q?.status && q.status.length > 0) {
                const set = new Set(q.status)
                out = out.filter((r) => set.has(r.status))
              }
              return [...out].sort((a, b) => a.createdAt - b.createdAt)
            }),
          )

        const listInProgress: SuggestedActionsStoreApi["listInProgress"] = () =>
          Ref.get(states).pipe(Effect.map((rs) => rs.filter((r) => r.status === "in_progress")))

        /** Guarded transition: apply `mut` only when the row is in `from`. */
        const transition = (
          id: string,
          from: ReadonlyArray<SuggestedActionStatus>,
          event: SuggestedActionStatus,
          mut: (r: SuggestedActionRow, at: number) => SuggestedActionRow,
        ): Effect.Effect<SuggestedActionRow | null, SuggestedActionsError> =>
          Effect.gen(function* () {
            const at = yield* clock.nowMs()
            const allowed = new Set(from)
            const cur = (yield* Ref.get(states)).find((r) => r.id === id)
            if (!cur || !allowed.has(cur.status)) return null
            const next = mut(cur, at)
            yield* Ref.update(states, (rs) => rs.map((r) => (r.id === id ? next : r)))
            yield* appendLog(next, event, at)
            return next
          })

        const markAccepted: SuggestedActionsStoreApi["markAccepted"] = (id) =>
          transition(id, ["proposed"], "accepted", (r, at) => ({
            ...r,
            status: "accepted",
            updatedAt: at,
          }))

        const markDismissed: SuggestedActionsStoreApi["markDismissed"] = (id) =>
          transition(id, ["proposed"], "dismissed", (r, at) => ({
            ...r,
            status: "dismissed",
            updatedAt: at,
          }))

        const recordExecution: SuggestedActionsStoreApi["recordExecution"] = (id, exec) =>
          transition(id, ["accepted"], "in_progress", (r, at) => ({
            ...r,
            status: "in_progress",
            executionKind: exec.kind,
            executionId: exec.id,
            updatedAt: at,
          }))

        const recordTerminal: SuggestedActionsStoreApi["recordTerminal"] = (id, status, error) =>
          transition(id, ["accepted", "in_progress"], status, (r, at) => ({
            ...r,
            status,
            error: error ?? null,
            updatedAt: at,
          }))

        return {
          propose,
          getById,
          listByThread,
          listInProgress,
          markAccepted,
          markDismissed,
          recordExecution,
          recordTerminal,
        } satisfies SuggestedActionsStoreApi
      }),
    )

  /**
   * SQLite-backed Layer. `dbPath` may be `":memory:"` for ephemeral use.
   * Requires `Clock` and `LunaSqliteBootstrap` in the environment.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<SuggestedActionsStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      SuggestedActionsStore,
      Effect.gen(function* () {
        // Pull the bootstrap marker BEFORE opening any Database so the
        // process-wide setCustomSQLite swap has run.
        yield* LunaSqliteBootstrap
        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "suggested-actions-store",
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
              module: "suggested-actions-store",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }

        const db = new Database(dbPath)
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")
        db.run("PRAGMA foreign_keys = ON")

        const nowMs0 = yield* clock.nowMs()
        ensureSchemaVersions(db)
        applyMigration(db, SUGGESTED_ACTIONS_COMPONENT, 1, SCHEMA_V1, nowMs0)

        // LIFO: register db.close finalizer first.
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements.
        const insertLogStmt = db.query(`
          INSERT OR IGNORE INTO suggested_action_log
            (id, action_id, at, event, thread_id, source, action_type, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const insertStateStmt = db.query(`
          INSERT OR IGNORE INTO suggested_action_state
            (action_id, thread_id, source, action_type, title, detail, rationale,
             payload_json, status, execution_kind, execution_id, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, NULL, ?, ?)
        `)
        const getStmt = db.query(`SELECT * FROM suggested_action_state WHERE action_id = ?`)

        const wrap = <A>(op: string, f: () => A) =>
          Effect.try({
            try: f,
            catch: (cause) =>
              new SuggestedActionsError({
                op,
                message: `sqlite ${op} failed: ${String(cause)}`,
                cause,
              }),
          })

        const rowToState = (r: Record<string, unknown>): SuggestedActionRow => ({
          id: r.action_id as string,
          threadId: r.thread_id as string,
          source: r.source as SuggestedActionRow["source"],
          actionType: r.action_type as SuggestedActionRow["actionType"],
          title: r.title as string,
          detail: (r.detail as string | null) ?? null,
          rationale: (r.rationale as string | null) ?? null,
          payload: JSON.parse(r.payload_json as string) as SuggestedActionPayload,
          status: r.status as SuggestedActionStatus,
          executionKind: (r.execution_kind as "job" | "workflow" | null) ?? null,
          executionId: (r.execution_id as string | null) ?? null,
          error: (r.error as string | null) ?? null,
          createdAt: r.created_at as number,
          updatedAt: r.updated_at as number,
        })

        const readById = (id: string): SuggestedActionRow | null => {
          const r = getStmt.get(id) as Record<string, unknown> | undefined
          return r ? rowToState(r) : null
        }

        const logEvent = (
          row: SuggestedActionRow,
          event: SuggestedActionStatus,
          at: number,
        ): void => {
          insertLogStmt.run(
            deriveLogId(row.id, event, at),
            row.id,
            at,
            event,
            row.threadId,
            row.source,
            row.actionType,
            JSON.stringify(row.payload),
          )
        }

        const propose: SuggestedActionsStoreApi["propose"] = (input) =>
          Effect.gen(function* () {
            const id = deriveActionId(input)
            const at = input.at ?? (yield* clock.nowMs())
            return yield* wrap("propose", () => {
              const existing = readById(id)
              if (existing) return existing
              const payloadJson = JSON.stringify(input.payload)
              insertStateStmt.run(
                id,
                input.threadId,
                input.source,
                input.actionType,
                input.title,
                input.detail ?? null,
                input.rationale ?? null,
                payloadJson,
                at,
                at,
              )
              const row = readById(id)
              if (!row) throw new Error("state row vanished after insert")
              logEvent(row, "proposed", at)
              return row
            })
          })

        const getById: SuggestedActionsStoreApi["getById"] = (id) =>
          wrap("getById", () => readById(id))

        const listByThread: SuggestedActionsStoreApi["listByThread"] = (threadId, q) =>
          wrap("listByThread", () => {
            const params: unknown[] = [threadId]
            let where = "thread_id = ?"
            if (q?.status && q.status.length > 0) {
              where += ` AND status IN (${q.status.map(() => "?").join(",")})`
              params.push(...q.status)
            }
            const stmt = db.query(
              `SELECT * FROM suggested_action_state WHERE ${where} ORDER BY created_at ASC`,
            )
            return (stmt.all(...params) as Array<Record<string, unknown>>).map(rowToState)
          })

        const listInProgress: SuggestedActionsStoreApi["listInProgress"] = () =>
          wrap("listInProgress", () =>
            (
              db
                .query(`SELECT * FROM suggested_action_state WHERE status = 'in_progress'`)
                .all() as Array<Record<string, unknown>>
            ).map(rowToState),
          )

        /** Guarded transition via `UPDATE … WHERE status IN (...)`; the row is
         *  returned only when changes === 1 (this call won the transition). */
        const transition = (
          op: string,
          id: string,
          from: ReadonlyArray<SuggestedActionStatus>,
          event: SuggestedActionStatus,
          setSql: string,
          extraParams: ReadonlyArray<unknown>,
        ): Effect.Effect<SuggestedActionRow | null, SuggestedActionsError> =>
          Effect.gen(function* () {
            const at = yield* clock.nowMs()
            return yield* wrap(op, () => {
              const placeholders = from.map(() => "?").join(",")
              const stmt = db.query(
                `UPDATE suggested_action_state SET ${setSql}, updated_at = ?
                 WHERE action_id = ? AND status IN (${placeholders})`,
              )
              const res = stmt.run(...extraParams, at, id, ...from)
              if (res.changes !== 1) return null
              const row = readById(id)
              if (row) logEvent(row, event, at)
              return row
            })
          })

        const markAccepted: SuggestedActionsStoreApi["markAccepted"] = (id) =>
          transition("markAccepted", id, ["proposed"], "accepted", "status = 'accepted'", [])

        const markDismissed: SuggestedActionsStoreApi["markDismissed"] = (id) =>
          transition("markDismissed", id, ["proposed"], "dismissed", "status = 'dismissed'", [])

        const recordExecution: SuggestedActionsStoreApi["recordExecution"] = (id, exec) =>
          transition(
            "recordExecution",
            id,
            ["accepted"],
            "in_progress",
            "status = 'in_progress', execution_kind = ?, execution_id = ?",
            [exec.kind, exec.id],
          )

        const recordTerminal: SuggestedActionsStoreApi["recordTerminal"] = (id, status, error) =>
          transition(
            "recordTerminal",
            id,
            ["accepted", "in_progress"],
            status,
            "status = ?, error = ?",
            [status, error ?? null],
          )

        return {
          propose,
          getById,
          listByThread,
          listInProgress,
          markAccepted,
          markDismissed,
          recordExecution,
          recordTerminal,
        } satisfies SuggestedActionsStoreApi
      }),
    )
  }
}
