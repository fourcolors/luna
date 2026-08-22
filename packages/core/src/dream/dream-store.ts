/**
 * DreamStore — SQLite-backed audit ledger + watermark for the dream-engine
 * (Phase 1, alignment-loop-phase1).
 *
 * Storage model:
 *   - `dream_audit` is an append-only op-ledger. Each row carries a `status`
 *     of `applied` (auto-applied by applyOps), `proposed` (held for Phase 3
 *     survey), or `reverted` (undo via revert()). Only `memory_dedup` ops are
 *     auto-applied in Phase 1.
 *   - `dream_state` is a key/value watermark store; key `last_dream_at` holds
 *     the millisecond timestamp through which the last completed dream cycle ran.
 *
 * Layers:
 *   - `DreamStore.Memory` — Ref-backed, in-process layer. Zero SQLite deps;
 *     used in all unit/vitest tests.
 *   - `DreamStore.makeLayer(dbPath)` — Layer.effect over `bun:sqlite`. Requires
 *     `Clock` and `LunaSqliteBootstrap` in the Effect environment.
 *
 * Idempotency:
 *   The `dream_audit` table has a UNIQUE constraint on `(dream_id, target_id, op)`
 *   and all inserts use `INSERT OR IGNORE`. This guarantees crash-recovery
 *   idempotency: re-running the same dream window produces the same dreamId and
 *   the second insert is silently ignored. Both layers honour this contract.
 *
 * Finalizer discipline (§3.4 #4):
 *   The `db.close()` finalizer is registered FIRST inside the scoped Effect,
 *   before any prepared statements are created (LIFO teardown order).
 */

import { Context, Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import type {
  DreamAuditQuery,
  DreamAuditRow,
  DreamAuditRowInput,
} from "./types.js"
import { DreamError } from "./types.js"

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
  CREATE TABLE IF NOT EXISTS dream_audit (
    id           TEXT NOT NULL PRIMARY KEY,
    dream_id     TEXT NOT NULL,
    at           INTEGER NOT NULL,
    op           TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    before_json  TEXT,
    after_json   TEXT,
    rationale    TEXT NOT NULL,
    status       TEXT NOT NULL CHECK(status IN ('applied','proposed','reverted')),
    applied_at   INTEGER,
    reverted_at  INTEGER,
    UNIQUE(dream_id, target_id, op)
  );
  CREATE INDEX IF NOT EXISTS idx_dream_audit_dream ON dream_audit(dream_id);
  CREATE INDEX IF NOT EXISTS idx_dream_audit_target ON dream_audit(target_id);
  CREATE INDEX IF NOT EXISTS idx_dream_audit_status ON dream_audit(status);

  CREATE TABLE IF NOT EXISTS dream_state (
    k TEXT NOT NULL PRIMARY KEY,
    v TEXT NOT NULL
  );
`

const randomUuid = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `dream-${Math.floor(Math.random() * 1e9)}`

export interface DreamStoreApi {
  readonly record: (input: DreamAuditRowInput) => Effect.Effect<string, DreamError>
  readonly list: (
    q: DreamAuditQuery,
  ) => Effect.Effect<ReadonlyArray<DreamAuditRow>, DreamError>
  readonly get: (id: string) => Effect.Effect<DreamAuditRow | null, DreamError>
  readonly markReverted: (
    id: string,
    at: number,
  ) => Effect.Effect<boolean, DreamError>
  readonly getWatermark: Effect.Effect<number | null, DreamError>
  readonly setWatermark: (ms: number) => Effect.Effect<void, DreamError>
}

export class DreamStore extends Context.Service<DreamStore, DreamStoreApi>()("luna/DreamStore") {
  /** Ref-backed in-memory layer for tests. No SQLite. */
  static readonly Memory: Layer.Layer<DreamStore, never, Clock> = Layer.effect(
    DreamStore,
    Effect.gen(function* () {
      const rows = yield* Ref.make<ReadonlyArray<DreamAuditRow>>([])
      const watermark = yield* Ref.make<number | null>(null)

      const key = (r: { dreamId: string; targetId: string; op: string }) =>
        `${r.dreamId} ${r.targetId} ${r.op}`

      const record: DreamStoreApi["record"] = (input) =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(rows)
          const dup = existing.find((r) => key(r) === key(input))
          if (dup) return dup.id // INSERT OR IGNORE semantics
          const id = randomUuid()
          const row: DreamAuditRow = {
            id,
            dreamId: input.dreamId,
            at: input.at,
            op: input.op,
            targetId: input.targetId,
            before: input.before,
            after: input.after,
            rationale: input.rationale,
            status: input.status,
            appliedAt: input.appliedAt,
            revertedAt: null,
          }
          yield* Ref.update(rows, (rs) => [...rs, row])
          return id
        })

      const list: DreamStoreApi["list"] = (q) =>
        Ref.get(rows).pipe(
          Effect.map((rs) => {
            let out = rs
            if (q.dreamId !== undefined) out = out.filter((r) => r.dreamId === q.dreamId)
            if (q.status !== undefined) out = out.filter((r) => r.status === q.status)
            if (q.targetId !== undefined) out = out.filter((r) => r.targetId === q.targetId)
            if (q.limit !== undefined) out = out.slice(0, q.limit)
            return out
          }),
        )

      const get: DreamStoreApi["get"] = (id) =>
        Ref.get(rows).pipe(Effect.map((rs) => rs.find((r) => r.id === id) ?? null))

      const markReverted: DreamStoreApi["markReverted"] = (id, at) =>
        Effect.gen(function* () {
          const rs = yield* Ref.get(rows)
          if (!rs.some((r) => r.id === id)) return false
          yield* Ref.set(
            rows,
            rs.map((r) =>
              r.id === id ? { ...r, status: "reverted" as const, revertedAt: at } : r,
            ),
          )
          return true
        })

      const getWatermark: DreamStoreApi["getWatermark"] = Ref.get(watermark)
      const setWatermark: DreamStoreApi["setWatermark"] = (ms) =>
        Ref.set(watermark, ms)

      return {
        record,
        list,
        get,
        markReverted,
        getWatermark,
        setWatermark,
      } satisfies DreamStoreApi
    }),
  )

  /**
   * SQLite-backed Layer. `dbPath` may be `":memory:"` for ephemeral use.
   * Requires `Clock` and `LunaSqliteBootstrap` in the environment.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<DreamStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.effect(
      DreamStore,
      Effect.gen(function* () {
        // Pull bootstrap marker BEFORE opening any Database so the
        // process-wide setCustomSQLite swap has run.
        yield* LunaSqliteBootstrap

        const clock = yield* Clock

        // Dynamic import — insulates stock-node vitest from hard-failing
        // at module load.
        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "dream-store",
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
              module: "dream-store",
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
        applyMigration(db, "dream", 1, SCHEMA_V1, nowMs)

        // §3.4 #4 LIFO: register db.close finalizer FIRST.
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements.
        const insertStmt = db.query(`
          INSERT OR IGNORE INTO dream_audit
            (id, dream_id, at, op, target_id, before_json, after_json,
             rationale, status, applied_at, reverted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `)
        const selectById = db.query(`SELECT * FROM dream_audit WHERE id = ?`)
        const selectKey = db.query(
          `SELECT id FROM dream_audit WHERE dream_id = ? AND target_id = ? AND op = ?`,
        )
        const revertStmt = db.query(
          `UPDATE dream_audit SET status = 'reverted', reverted_at = ? WHERE id = ?`,
        )
        const getWmStmt = db.query(`SELECT v FROM dream_state WHERE k = 'last_dream_at'`)
        const setWmStmt = db.query(
          `INSERT INTO dream_state (k, v) VALUES ('last_dream_at', ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
        )

        const rowToAudit = (r: Record<string, unknown>): DreamAuditRow => ({
          id: r.id as string,
          dreamId: r.dream_id as string,
          at: r.at as number,
          op: r.op as DreamAuditRow["op"],
          targetId: r.target_id as string,
          before: r.before_json == null ? null : JSON.parse(r.before_json as string),
          after: r.after_json == null ? null : JSON.parse(r.after_json as string),
          rationale: r.rationale as string,
          status: r.status as DreamAuditRow["status"],
          appliedAt: (r.applied_at as number | null) ?? null,
          revertedAt: (r.reverted_at as number | null) ?? null,
        })

        const wrap = <A>(op: string, f: () => A) =>
          Effect.try({
            try: f,
            catch: (cause) =>
              new DreamError({ op, message: `sqlite ${op} failed: ${String(cause)}`, cause }),
          })

        const record: DreamStoreApi["record"] = (input) =>
          wrap("record", () => {
            insertStmt.run(
              randomUuid(),
              input.dreamId,
              input.at,
              input.op,
              input.targetId,
              input.before == null ? null : JSON.stringify(input.before),
              input.after == null ? null : JSON.stringify(input.after),
              input.rationale,
              input.status,
              input.appliedAt,
            )
            const row = selectKey.get(input.dreamId, input.targetId, input.op) as
              | { id: string }
              | undefined
            return row?.id ?? ""
          })

        const list: DreamStoreApi["list"] = (q) =>
          wrap("list", () => {
            const clauses: string[] = []
            const params: unknown[] = []
            if (q.dreamId !== undefined) { clauses.push("dream_id = ?"); params.push(q.dreamId) }
            if (q.status !== undefined) { clauses.push("status = ?"); params.push(q.status) }
            if (q.targetId !== undefined) { clauses.push("target_id = ?"); params.push(q.targetId) }
            const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
            const limit = q.limit !== undefined ? `LIMIT ${Number(q.limit)}` : ""
            const stmt = db.query(`SELECT * FROM dream_audit ${where} ORDER BY at ASC ${limit}`)
            return (stmt.all(...params) as Array<Record<string, unknown>>).map(rowToAudit)
          })

        const get: DreamStoreApi["get"] = (id) =>
          wrap("get", () => {
            const r = selectById.get(id) as Record<string, unknown> | undefined
            return r ? rowToAudit(r) : null
          })

        const markReverted: DreamStoreApi["markReverted"] = (id, at) =>
          wrap("markReverted", () => revertStmt.run(at, id).changes > 0)

        const getWatermark: DreamStoreApi["getWatermark"] = wrap("getWatermark", () => {
          const r = getWmStmt.get() as { v: string } | undefined
          return r ? Number(r.v) : null
        })

        const setWatermark: DreamStoreApi["setWatermark"] = (ms) =>
          wrap("setWatermark", () => { setWmStmt.run(String(ms)) }).pipe(Effect.asVoid)

        return { record, list, get, markReverted, getWatermark, setWatermark } satisfies DreamStoreApi
      }),
    )
  }
}
