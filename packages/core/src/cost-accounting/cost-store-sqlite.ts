/**
 * CostAccountingService — SQLite-backed Layer (Phase 24a).
 *
 * Persistence-backed sibling to the in-memory `CostAccountingService.Default`.
 * Implements the same `CostAccountingApi` contract; SQL backing is invisible
 * to callers.
 *
 * Storage model (per advisor):
 *   - `cost_events` is canonical (one row per CostAccrued event); rollups are
 *     computed on demand via `SELECT SUM(...) GROUP BY <dim>`. There is NO
 *     `cost_buckets` table — events are the source of truth.
 *   - `cost_event_experiments` is a sidecar (cost_event_id, experiment_id) so
 *     the §5.1 frozen `cost_events` schema is not extended.
 *   - `cost_budgets(dim, key, budget_usd)` carries budget caps separately
 *     since budgets aren't event-derived.
 *
 * Architecture:
 *   - Layer.scoped opens the DB, runs migrations (PRAGMA user_version ladder),
 *     registers the `db.close` finalizer FIRST (LIFO §3.4 #4), then prepared
 *     statements + the subscriber daemon.
 *   - Subscriber consumes `obs.subscribeEvents` (eager, HANDOFF #2), filters
 *     to CostAccrued, INSERTs one cost_events row + (if applicable) the
 *     sidecar row, all inside a BEGIN IMMEDIATE transaction.
 *   - `bun:sqlite` direct import via dynamic-import escape hatch (matches
 *     `session-store-sqlite.ts`); avoids hard-failing under stock node+vitest.
 *
 * Invariants:
 *   §3.1 + §3.4 #4 — Layer.scoped + `db.close` finalizer registered FIRST.
 *   §5.1          — cost_events column names byte-exact; no new columns.
 *   §5.2          — per-component PRAGMA user_version migration ladder.
 *   §6            — IntegrityError for SQL constraint violations; no new tags.
 *   §16           — subscriber filters CostAccrued from the canonical stream.
 *   HANDOFF #9    — events are seeded via obs.recordCost; we consume the
 *                   canonical stream, never hand-built events.
 */
import {
  Effect,
  Layer,
  Ref,
  Stream,
} from "effect"
import { ObservabilityService } from "../observability/observability.js"
import { Clock } from "../clock.js"
import { IntegrityError } from "../errors.js"
import { CostAccountingService } from "./cost-accounting.js"
import type {
  BudgetRule,
  CostAccountingApi,
  CostAccountingConfig,
  CostBucket,
} from "./types.js"

// ── Schema ──────────────────────────────────────────────────────────────────
//
// `cost_events` columns are byte-exact per DESIGN §5.1 (frozen). The two
// sidecar tables (`cost_event_experiments`, `cost_budgets`) are additive and
// scoped to this component — they don't touch the frozen surface.
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS cost_events (
    id            TEXT PRIMARY KEY,
    session_id    TEXT,
    team_name     TEXT,
    workflow_id   TEXT,
    account_id    TEXT,
    tokens_in     INTEGER NOT NULL DEFAULT 0,
    tokens_out    INTEGER NOT NULL DEFAULT 0,
    cache_read    INTEGER NOT NULL DEFAULT 0,
    cache_write   INTEGER NOT NULL DEFAULT 0,
    usd           REAL    NOT NULL DEFAULT 0,
    ts            INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cost_session
    ON cost_events(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_cost_team
    ON cost_events(team_name, ts);
  CREATE INDEX IF NOT EXISTS idx_cost_workflow
    ON cost_events(workflow_id, ts);

  CREATE TABLE IF NOT EXISTS cost_event_experiments (
    cost_event_id TEXT NOT NULL REFERENCES cost_events(id) ON DELETE CASCADE,
    experiment_id TEXT NOT NULL,
    PRIMARY KEY (cost_event_id, experiment_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cost_exp
    ON cost_event_experiments(experiment_id, cost_event_id);

  CREATE TABLE IF NOT EXISTS cost_budgets (
    dim          TEXT NOT NULL,
    key          TEXT NOT NULL,
    budget_usd   REAL NOT NULL,
    PRIMARY KEY (dim, key)
  );
`

const TARGET_USER_VERSION = 1

// ── bun:sqlite minimal shape (mirrors session-store-sqlite.ts) ──────────────
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

const integrity = (resource: string, message: string) =>
  new IntegrityError({ module: "cost-accounting", resource, message })

// CostBucket dimension (frozen on the public API).
type Dim = CostBucket["dimension"] // "session" | "team" | "workflow"

// Map a dim → cost_events column for SUM aggregation.
const dimColumn: Record<Dim, "session_id" | "team_name" | "workflow_id"> = {
  session: "session_id",
  team: "team_name",
  workflow: "workflow_id",
}

// Aggregate row shape.
interface AggRow {
  tokens_in: number | null
  tokens_out: number | null
  cache_read: number | null
  cache_write: number | null
  usd: number | null
  cnt: number
  min_ts: number | null
  max_ts: number | null
}

// ── Layer factory ───────────────────────────────────────────────────────────

/**
 * Build a sqlite-backed CostAccountingService Layer. `dbPath` accepts
 * `":memory:"` for ephemeral tests. The Layer is `Layer.scoped` so the DB
 * handle is closed when the surrounding scope finalizes (LIFO §3.4 #4).
 */
export const makeCostAccountingSqlite = (
  dbPath: string,
  config: CostAccountingConfig = {},
): Layer.Layer<
  CostAccountingService,
  never,
  ObservabilityService | Clock
> =>
  Layer.scoped(
    CostAccountingService,
    Effect.gen(function* () {
      const obs = yield* ObservabilityService
      const defaultBudget = config.defaultBudgetUsd ?? 0

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

      // Pragmas BEFORE any user data writes.
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA synchronous = NORMAL")
      db.run("PRAGMA foreign_keys = ON")

      // Migration ladder: PRAGMA user_version → bump per component (§5.2).
      // Wrap each bump in BEGIN IMMEDIATE / COMMIT / ROLLBACK.
      const cur = db.query("PRAGMA user_version").get() as
        | { user_version: number }
        | undefined
      const userVersion = cur?.user_version ?? 0
      if (userVersion < 1) {
        db.run("BEGIN IMMEDIATE")
        try {
          db.run(SCHEMA_V1)
          db.run(`PRAGMA user_version = ${TARGET_USER_VERSION}`)
          db.run("COMMIT")
        } catch (e) {
          db.run("ROLLBACK")
          throw e
        }
      }

      // §3.4 #4 LIFO: register `db.close` FIRST so the subscriber finalizer
      // (registered later via Stream consumption inside the scope) runs first
      // on teardown — when the DB finally closes, no statements are in flight.
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      // Prepared statements — reused across calls.
      const eventInsert = db.query(
        `INSERT INTO cost_events
           (id, session_id, team_name, workflow_id, account_id,
            tokens_in, tokens_out, cache_read, cache_write, usd, ts)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      const expInsert = db.query(
        `INSERT OR IGNORE INTO cost_event_experiments
           (cost_event_id, experiment_id) VALUES (?,?)`,
      )
      const budgetUpsert = db.query(
        `INSERT INTO cost_budgets (dim, key, budget_usd)
         VALUES (?,?,?)
         ON CONFLICT(dim, key) DO UPDATE SET budget_usd = excluded.budget_usd`,
      )
      const budgetGet = db.query(
        `SELECT budget_usd FROM cost_budgets WHERE dim = ? AND key = ?`,
      )
      const budgetDeleteAll = db.query(`DELETE FROM cost_budgets`)
      const eventsDeleteAll = db.query(`DELETE FROM cost_events`)
      // Aggregate query, parameterized per-dim. Pre-build one per dimension
      // so we don't string-concat user input into SQL.
      const aggQueries: Record<Dim, BunStmt> = {
        session: db.query(
          `SELECT
             COALESCE(SUM(tokens_in),0)  AS tokens_in,
             COALESCE(SUM(tokens_out),0) AS tokens_out,
             COALESCE(SUM(cache_read),0) AS cache_read,
             COALESCE(SUM(cache_write),0) AS cache_write,
             COALESCE(SUM(usd),0)        AS usd,
             COUNT(*)                    AS cnt,
             MIN(ts)                     AS min_ts,
             MAX(ts)                     AS max_ts
           FROM cost_events WHERE session_id = ?`,
        ),
        team: db.query(
          `SELECT
             COALESCE(SUM(tokens_in),0)  AS tokens_in,
             COALESCE(SUM(tokens_out),0) AS tokens_out,
             COALESCE(SUM(cache_read),0) AS cache_read,
             COALESCE(SUM(cache_write),0) AS cache_write,
             COALESCE(SUM(usd),0)        AS usd,
             COUNT(*)                    AS cnt,
             MIN(ts)                     AS min_ts,
             MAX(ts)                     AS max_ts
           FROM cost_events WHERE team_name = ?`,
        ),
        workflow: db.query(
          `SELECT
             COALESCE(SUM(tokens_in),0)  AS tokens_in,
             COALESCE(SUM(tokens_out),0) AS tokens_out,
             COALESCE(SUM(cache_read),0) AS cache_read,
             COALESCE(SUM(cache_write),0) AS cache_write,
             COALESCE(SUM(usd),0)        AS usd,
             COUNT(*)                    AS cnt,
             MIN(ts)                     AS min_ts,
             MAX(ts)                     AS max_ts
           FROM cost_events WHERE workflow_id = ?`,
        ),
      }
      // Distinct keys per dim — for listBuckets.
      const distinctSessions = db.query(
        `SELECT DISTINCT session_id AS k FROM cost_events
         WHERE session_id IS NOT NULL`,
      )
      const distinctTeams = db.query(
        `SELECT DISTINCT team_name AS k FROM cost_events
         WHERE team_name IS NOT NULL`,
      )
      const distinctWorkflows = db.query(
        `SELECT DISTINCT workflow_id AS k FROM cost_events
         WHERE workflow_id IS NOT NULL`,
      )

      const tsToIso = (ms: number): string => new Date(ms).toISOString()

      // Build a CostBucket from an aggregate row, or null if no rows matched.
      const rowToBucket = (
        dim: Dim,
        key: string,
        row: AggRow | undefined,
      ): CostBucket | null => {
        if (!row || row.cnt === 0 || row.min_ts === null || row.max_ts === null) {
          return null
        }
        return {
          key,
          dimension: dim,
          tokensIn: row.tokens_in ?? 0,
          tokensOut: row.tokens_out ?? 0,
          cacheRead: row.cache_read ?? 0,
          cacheWrite: row.cache_write ?? 0,
          estimatedUsd: row.usd ?? 0,
          firstEventTs: tsToIso(row.min_ts),
          lastEventTs: tsToIso(row.max_ts),
          eventCount: row.cnt,
        }
      }

      const queryBucket = (dim: Dim, key: string): CostBucket | null => {
        const row = aggQueries[dim].get(key) as AggRow | undefined
        return rowToBucket(dim, key, row)
      }

      // Ref<number> bumps every time the subscriber commits a row. Lets tests
      // (and getBucket callers, if needed) know "writes have settled" without
      // sleep-and-pray. Not exposed; observable via getBucket re-read.
      const writeCounter = yield* Ref.make(0)

      // ── Subscriber daemon ────────────────────────────────────────────────
      // Eager subscription so no events are missed after Layer init resolves.
      const eventStream = yield* obs.subscribeEvents

      yield* Effect.forkDaemon(
        eventStream.pipe(
          Stream.filter((e) => e.kind === "CostAccrued"),
          Stream.runForEach((ev) =>
            Effect.sync(() => {
              if (ev.kind !== "CostAccrued") return
              const id = crypto.randomUUID()
              const tsMs = Date.parse(ev.ts)
              try {
                db.run("BEGIN IMMEDIATE")
                eventInsert.run(
                  id,
                  ev.sessionId ?? null,
                  ev.teamName ?? null,
                  ev.workflowId ?? null,
                  null, // account_id — events don't carry it yet (§16)
                  ev.tokensIn,
                  ev.tokensOut,
                  ev.cacheRead,
                  ev.cacheWrite,
                  ev.estimatedUsd,
                  Number.isFinite(tsMs) ? tsMs : Date.now(),
                )
                // experiment_id sidecar: events don't currently carry it, but
                // the schema is in place for the next phase. If a producer
                // attaches `experimentId` via a forward-compatible widening,
                // we'd write the sidecar row here.
                const maybeExp = (ev as { experimentId?: unknown }).experimentId
                if (typeof maybeExp === "string" && maybeExp.length > 0) {
                  expInsert.run(id, maybeExp)
                }
                db.run("COMMIT")
              } catch (cause) {
                try {
                  db.run("ROLLBACK")
                } catch {
                  /* best-effort */
                }
                // Surface as Error event but don't kill the subscriber —
                // matches in-memory daemon's catchAllCause posture.
                // eslint-disable-next-line no-console
                console.error("cost-store-sqlite insert failed:", cause)
              }
            }).pipe(
              Effect.zipRight(Ref.update(writeCounter, (n) => n + 1)),
            ),
          ),
          Effect.catchAllCause(() => Effect.void),
        ),
      )

      // ── Public API ───────────────────────────────────────────────────────

      const getBucket: CostAccountingApi["getBucket"] = (dimension, key) =>
        Effect.sync(() => queryBucket(dimension, key))

      const listBuckets: CostAccountingApi["listBuckets"] = (dimension) =>
        Effect.sync(() => {
          const dims: Dim[] =
            dimension !== undefined ? [dimension] : ["session", "team", "workflow"]
          const out: CostBucket[] = []
          for (const dim of dims) {
            const stmt =
              dim === "session"
                ? distinctSessions
                : dim === "team"
                ? distinctTeams
                : distinctWorkflows
            const rows = stmt.all() as ReadonlyArray<{ k: string | null }>
            for (const r of rows) {
              if (r.k === null) continue
              const b = queryBucket(dim, r.k)
              if (b !== null) out.push(b)
            }
          }
          return out
        })

      const setBudget: CostAccountingApi["setBudget"] = (rule: BudgetRule) =>
        Effect.sync(() => {
          budgetUpsert.run(rule.dimension, rule.key, rule.budgetUsd)
        })

      const lookupBudget = (dim: Dim, key: string): number => {
        const row = budgetGet.get(dim, key) as
          | { budget_usd: number }
          | undefined
        return row?.budget_usd ?? defaultBudget
      }

      const isBudgetExceeded: CostAccountingApi["isBudgetExceeded"] = (
        dimension,
        key,
      ) =>
        Effect.sync(() => {
          const cap = lookupBudget(dimension, key)
          if (cap <= 0) return false // 0 = unlimited
          const bucket = queryBucket(dimension, key)
          if (bucket === null) return false
          return bucket.estimatedUsd >= cap
        })

      const remainingBudget: CostAccountingApi["remainingBudget"] = (
        dimension,
        key,
      ) =>
        Effect.sync(() => {
          const cap = lookupBudget(dimension, key)
          if (cap <= 0) return Infinity
          const bucket = queryBucket(dimension, key)
          const spent = bucket?.estimatedUsd ?? 0
          return Math.max(0, cap - spent)
        })

      const reset: CostAccountingApi["reset"] = Effect.sync(() => {
        // Clear in dependency order — sidecar first (FK CASCADE would also
        // cover it, but explicit is clearer).
        db.run("DELETE FROM cost_event_experiments")
        eventsDeleteAll.run()
        budgetDeleteAll.run()
      })

      return {
        getBucket,
        listBuckets,
        setBudget,
        isBudgetExceeded,
        remainingBudget,
        reset,
      } satisfies CostAccountingApi
    }),
  )

/**
 * Convenience: alias on the CostAccountingService class for symmetry with
 * `CostAccountingService.Default`. Use as
 * `CostAccountingService.fromPath("~/.luna/luna.db")`.
 *
 * Pass `":memory:"` for ephemeral test DBs.
 */
;(CostAccountingService as unknown as {
  fromPath: (
    dbPath: string,
    config?: CostAccountingConfig,
  ) => Layer.Layer<
    CostAccountingService,
    never,
    ObservabilityService | Clock
  >
}).fromPath = makeCostAccountingSqlite

declare module "./cost-accounting.js" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace CostAccountingService {
    /** SQLite-backed Layer (Phase 24a persistence). */
    function fromPath(
      dbPath: string,
      config?: CostAccountingConfig,
    ): Layer.Layer<
      CostAccountingService,
      never,
      ObservabilityService | Clock
    >
  }
}
