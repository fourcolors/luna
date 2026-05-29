/**
 * AlignmentStore — SQLite-backed alignment-signal ledger + denormalized EWMA
 * cache (Phase 3, §5.2). Mirrors DreamStore's two-layer shape.
 *
 *   - `alignment_log` is an append-only signal ledger. Idempotent on a
 *     deterministic id derived from (ref, signal_kind, at) via INSERT OR IGNORE
 *     — so a crash between a belief write and its alignment append is crash-safe
 *     by re-run (spec-delta #5; true single-tx atomicity is a follow-on).
 *   - `alignment_state` is a single-row O(1) EWMA cache (§5.2). Derivable from
 *     the EWMA-eligible rows of alignment_log via rebuildState().
 *
 * Layers mirror DreamStore: Memory (Ref) for tests, makeLayer(dbPath) over
 * bun:sqlite requiring Clock + LunaSqliteBootstrap.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import { applyMigration, ensureSchemaVersions } from "../db/schema-versions.js"
import { LunaSqliteBootstrap } from "../db/sqlite-bootstrap.js"
import { ConfigError } from "../errors.js"
import { ALIGNMENT_COMPONENT, AlignmentError, EWMA_ELIGIBLE } from "./types.js"
import type { AlignmentLogQuery, AlignmentLogRow, AlignmentLogRowInput } from "./types.js"

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
  CREATE TABLE IF NOT EXISTS alignment_log (
    id          TEXT NOT NULL PRIMARY KEY,
    at          INTEGER NOT NULL,
    signal_kind TEXT NOT NULL CHECK(signal_kind IN ('task_quality','belief_validation','outreach_welcome')),
    score_delta REAL NOT NULL,
    ewma_after  REAL,
    ref         TEXT NOT NULL,
    UNIQUE(ref, signal_kind, at)
  );
  CREATE INDEX IF NOT EXISTS idx_alignment_log_kind_at ON alignment_log(signal_kind, at);

  CREATE TABLE IF NOT EXISTS alignment_state (
    id         INTEGER NOT NULL PRIMARY KEY CHECK(id = 1),
    ewma       REAL NOT NULL,
    updated_at INTEGER NOT NULL
  );
`

/** Deterministic id — idempotency key (spec-delta #5). */
const deriveLogId = (i: AlignmentLogRowInput): string =>
  `al-${i.ref}-${i.signalKind}-${i.at}`

export interface AlignmentStoreApi {
  readonly append: (input: AlignmentLogRowInput) => Effect.Effect<string, AlignmentError>
  readonly list: (q: AlignmentLogQuery) => Effect.Effect<ReadonlyArray<AlignmentLogRow>, AlignmentError>
  /** Current global EWMA; defaults to 0.0 (dormant floor, §2.4) when unset. */
  readonly getEwma: Effect.Effect<number, AlignmentError>
  readonly setEwma: (ewma: number) => Effect.Effect<void, AlignmentError>
  /** Recompute the EWMA cache from the EWMA-eligible log rows; returns it. */
  readonly rebuildState: () => Effect.Effect<number, AlignmentError>
}

export class AlignmentStore extends Effect.Tag("luna/AlignmentStore")<
  AlignmentStore,
  AlignmentStoreApi
>() {
  /** Ref-backed in-memory layer for tests. No SQLite. */
  static readonly Memory: Layer.Layer<AlignmentStore, never, Clock> = Layer.effect(
    AlignmentStore,
    Effect.gen(function* () {
      const rows = yield* Ref.make<ReadonlyArray<AlignmentLogRow>>([])
      const ewma = yield* Ref.make<number | null>(null)

      const append: AlignmentStoreApi["append"] = (input) =>
        Effect.gen(function* () {
          const id = deriveLogId(input)
          const existing = yield* Ref.get(rows)
          if (existing.some((r) => r.id === id)) return id // INSERT OR IGNORE
          const r: AlignmentLogRow = { id, ...input }
          yield* Ref.update(rows, (rs) => [...rs, r])
          return id
        })

      const list: AlignmentStoreApi["list"] = (q) =>
        Ref.get(rows).pipe(
          Effect.map((rs) => {
            let out = rs
            if (q.signalKind !== undefined) out = out.filter((r) => r.signalKind === q.signalKind)
            if (q.since !== undefined) out = out.filter((r) => r.at >= q.since!)
            out = [...out].sort((a, b) => a.at - b.at)
            if (q.limit !== undefined) out = out.slice(0, q.limit)
            return out
          }),
        )

      const getEwma: AlignmentStoreApi["getEwma"] = Ref.get(ewma).pipe(
        Effect.map((e) => e ?? 0),
      )
      const setEwma: AlignmentStoreApi["setEwma"] = (e) => Ref.set(ewma, e)

      const rebuildState: AlignmentStoreApi["rebuildState"] = () =>
        Effect.gen(function* () {
          const rs = yield* Ref.get(rows)
          const eligible = rs
            .filter((r) => EWMA_ELIGIBLE.has(r.signalKind) && r.ewmaAfter !== null)
            .sort((a, b) => a.at - b.at)
          const last = eligible.at(-1)?.ewmaAfter ?? 0
          yield* Ref.set(ewma, last)
          return last
        })

      return { append, list, getEwma, setEwma, rebuildState } satisfies AlignmentStoreApi
    }),
  )

  /**
   * SQLite-backed Layer. `dbPath` may be `":memory:"` for ephemeral use.
   * Requires `Clock` and `LunaSqliteBootstrap` in the environment.
   */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<AlignmentStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      AlignmentStore,
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
              module: "alignment-store",
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
              module: "alignment-store",
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
        applyMigration(db, ALIGNMENT_COMPONENT, 1, SCHEMA_V1, nowMs)

        // §3.4 #4 LIFO: register db.close finalizer FIRST.
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements.
        const insertStmt = db.query(`
          INSERT OR IGNORE INTO alignment_log
            (id, at, signal_kind, score_delta, ewma_after, ref)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        const getEwmaStmt = db.query(`SELECT ewma FROM alignment_state WHERE id = 1`)
        const setEwmaStmt = db.query(`
          INSERT INTO alignment_state (id, ewma, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET ewma = excluded.ewma, updated_at = excluded.updated_at
        `)

        const rowToLog = (r: Record<string, unknown>): AlignmentLogRow => ({
          id: r.id as string,
          at: r.at as number,
          signalKind: r.signal_kind as AlignmentLogRow["signalKind"],
          scoreDelta: r.score_delta as number,
          ewmaAfter: (r.ewma_after as number | null) ?? null,
          ref: r.ref as string,
        })

        const wrap = <A>(op: string, f: () => A) =>
          Effect.try({
            try: f,
            catch: (cause) =>
              new AlignmentError({ op, message: `sqlite ${op} failed: ${String(cause)}`, cause }),
          })

        const append: AlignmentStoreApi["append"] = (input) =>
          wrap("append", () => {
            const id = deriveLogId(input)
            insertStmt.run(id, input.at, input.signalKind, input.scoreDelta, input.ewmaAfter, input.ref)
            return id
          })

        const list: AlignmentStoreApi["list"] = (q) =>
          wrap("list", () => {
            const clauses: string[] = []
            const params: unknown[] = []
            if (q.signalKind !== undefined) { clauses.push("signal_kind = ?"); params.push(q.signalKind) }
            if (q.since !== undefined) { clauses.push("at >= ?"); params.push(q.since) }
            const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
            const limit = q.limit !== undefined ? `LIMIT ${Number(q.limit)}` : ""
            const stmt = db.query(`SELECT * FROM alignment_log ${where} ORDER BY at ASC ${limit}`)
            return (stmt.all(...params) as Array<Record<string, unknown>>).map(rowToLog)
          })

        const getEwma: AlignmentStoreApi["getEwma"] = wrap("getEwma", () => {
          const r = getEwmaStmt.get() as { ewma: number } | undefined
          return r ? r.ewma : 0
        })

        const setEwma: AlignmentStoreApi["setEwma"] = (e) =>
          wrap("setEwma", () => { setEwmaStmt.run(e, Date.now()) }).pipe(Effect.asVoid)

        const rebuildState: AlignmentStoreApi["rebuildState"] = () =>
          Effect.gen(function* () {
            const eligible = yield* list({})
            const last = eligible
              .filter((r) => EWMA_ELIGIBLE.has(r.signalKind) && r.ewmaAfter !== null)
              .at(-1)?.ewmaAfter ?? 0
            const now = yield* clock.nowMs()
            yield* wrap("rebuildState", () => { setEwmaStmt.run(last, now) })
            return last
          })

        return { append, list, getEwma, setEwma, rebuildState } satisfies AlignmentStoreApi
      }),
    )
  }
}
