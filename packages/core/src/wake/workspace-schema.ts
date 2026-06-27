// packages/core/src/wake/workspace-schema.ts
//
// Canonical DDL for the wake-related tables in a workspace.db. This is the
// SINGLE source of truth shared by:
//   - WakeLogStore's wake_log self-heal,
//   - the `enable-wake` installer (apps/ui-web/scripts/enable-wake.ts),
//   - the wake unit tests.
//
// History: before this module these tables existed ONLY in test files — no
// production code path created `goals`/`next_actions` in a real workspace.db,
// so every wake cycle errored with `no such table: goals` (see the wake-schema
// issue). Centralising the DDL here closes that gap and kills schema drift.

/** `goals` — workspace objectives the wake reasoner orients around. */
export const GOALS_DDL = `CREATE TABLE IF NOT EXISTS goals (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  priority    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`

/**
 * `next_actions` — concrete TODOs the wake reasoner reads and proposes into.
 *
 * `goal_slug` is intentionally NULLABLE: `planNextActions` emits `null` for any
 * proposal not attached to a known goal, and `appendNextActions` inserts that
 * value directly. A `NOT NULL` column (as the old test-only schema had) would
 * make every unattached proposal fail a constraint and get silently swallowed —
 * Path-B filing would be dead on arrival. No FK to `goals` (matches the
 * long-standing wake_log self-heal shape and avoids ordering/FK-on hazards);
 * `planNextActions` already nulls any unknown slug for hygiene.
 */
export const NEXT_ACTIONS_DDL = `CREATE TABLE IF NOT EXISTS next_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_slug    TEXT,
  action       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'todo',
  priority     INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER,
  notes        TEXT
)`

/** `wake_log` — append-only ledger of wake cycles (also self-healed by WakeLogStore). */
export const WAKE_LOG_DDL = `CREATE TABLE IF NOT EXISTS wake_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  woke_at   INTEGER NOT NULL,
  goal_slug TEXT,
  summary   TEXT NOT NULL,
  outcome   TEXT NOT NULL,
  artifacts TEXT
)`

/**
 * The tables wake needs to do real work. `wake_log` is excluded because the
 * WakeLogStore self-heals it; a workspace missing `goals`/`next_actions` is
 * "not wake-enabled" and the cycle skips rather than errors.
 */
export const WAKE_REQUIRED_TABLES = ["goals", "next_actions"] as const

// Minimal structural db shapes (the project avoids @types/bun — see DESIGN §6.2).
interface QueryDb {
  query: (sql: string) => { all: (...p: ReadonlyArray<unknown>) => unknown[] }
}
interface RunDb {
  run: (sql: string) => unknown
}

/**
 * True iff the workspace.db has the tables wake needs (`goals` + `next_actions`).
 * Cheap `sqlite_master` lookup — preferred over catching a "no such table"
 * string, which is fragile across SQLite drivers.
 */
export const hasWakeSchema = (db: QueryDb): boolean => {
  const rows = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('goals','next_actions')",
    )
    .all() as ReadonlyArray<{ name: string }>
  const present = new Set(rows.map((r) => r.name))
  return WAKE_REQUIRED_TABLES.every((t) => present.has(t))
}

/**
 * Idempotently install the wake schema (`goals`, `next_actions`, `wake_log`)
 * into a workspace.db. All `CREATE TABLE IF NOT EXISTS` — safe to re-run and a
 * no-op when the tables already exist. Does NOT alter an existing table whose
 * shape differs; callers that care should check shape first.
 */
export const installWakeSchema = (db: RunDb): void => {
  db.run(GOALS_DDL)
  db.run(NEXT_ACTIONS_DDL)
  db.run(WAKE_LOG_DDL)
}
