/**
 * Per-component migration ladder helper (Phase 25e).
 *
 * DESIGN.md §5.2 specifies a `schema_versions(component, version, applied_at)`
 * table as the canonical migration ledger. Phases 5–24 shipped with each
 * component gating its own ladder on the global `PRAGMA user_version` instead;
 * because all 5 components share `~/.luna/luna.db`, whichever component ran
 * its migration first bumped the pragma to 1 and every subsequent component
 * silently skipped its CREATE TABLE — leaving its tables non-existent.
 *
 * This helper closes that drift. Each component now keys its ladder on its
 * own row in `schema_versions`, so migrations run independently per component
 * regardless of what any sibling has done.
 *
 * Note for future @effect/sql migration: the bun:sqlite + helper approach
 * was chosen over @effect/sql's migration runner because Phases 5–24 already
 * use direct bun:sqlite (see session-store-sqlite.ts header). When the repo
 * later moves to @effect/sql wholesale, this helper should be replaced by
 * the @effect/sql-bun migration runner — same `schema_versions` table.
 *
 * Apps and packages that cannot depend on `@luna/core` (notably
 * `apps/agent-cli/src/db.ts`) inline-duplicate this file. Keep the two
 * copies in sync; drift reintroduces the migration-collision bug.
 */

/** Minimal bun:sqlite shape — matches the BunDb typedefs already used by
 * the per-component sqlite stores. Kept narrow on purpose. */
export interface BunDb {
  run: (sql: string) => void
  query: (sql: string) => {
    get: (...p: unknown[]) => unknown
    all: (...p: unknown[]) => unknown[]
    run: (...p: unknown[]) => { changes: number }
  }
}

const SCHEMA_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_versions (
    component   TEXT NOT NULL,
    version     INTEGER NOT NULL,
    applied_at  INTEGER NOT NULL,
    PRIMARY KEY (component, version)
  );
`

/**
 * Idempotent. Safe to call from every component on every open. Creates the
 * `schema_versions` ledger if it does not yet exist; otherwise a no-op.
 */
export const ensureSchemaVersions = (db: BunDb): void => {
  db.run(SCHEMA_VERSIONS_DDL)
}

/**
 * Run `sql` exactly once for (component, version). Records success in
 * `schema_versions` in the same transaction so a partial migration cannot
 * leave the ledger lying.
 *
 * Concurrency: BEGIN IMMEDIATE acquires the SQLite write lock up front,
 * so two processes racing the same migration serialize cleanly — the loser
 * sees the row already present on its second check.
 *
 * Throws on SQL error after rolling back. Callers wrap in their own
 * domain error (ConfigError, IntegrityError) as appropriate.
 */
export const applyMigration = (
  db: BunDb,
  component: string,
  version: number,
  sql: string,
  nowMs: number,
): void => {
  const hasStmt = db.query(
    "SELECT 1 AS x FROM schema_versions WHERE component = ? AND version = ? LIMIT 1",
  )
  const has = hasStmt.get(component, version) as { x: number } | undefined | null
  if (has != null) return
  db.run("BEGIN IMMEDIATE")
  try {
    // Re-check INSIDE the write lock (codex PR2 review finding 2): the doc
    // above always promised a "second check", but until now it didn't
    // exist — two first-boot processes could both pass the unlocked check,
    // and the loser would run the DDL again and die on the ledger's
    // primary key. With the lock held, the loser now sees the winner's row
    // and no-ops.
    const raced = hasStmt.get(component, version) as { x: number } | undefined | null
    if (raced != null) {
      db.run("COMMIT")
      return
    }
    db.run(sql)
    db.query(
      "INSERT INTO schema_versions (component, version, applied_at) VALUES (?, ?, ?)",
    ).run(component, version, nowMs)
    db.run("COMMIT")
  } catch (e) {
    try {
      db.run("ROLLBACK")
    } catch {
      /* best-effort */
    }
    throw e
  }
}
