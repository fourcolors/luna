/**
 * Direct `bun:sqlite` helper for the seed CLI.
 *
 * Mirrors `packages/core/src/account-broker/account-broker-sql.ts`:
 *   - same §5.1 columns (id, label, kind, secret_ref, health, cooldown_ms,
 *     usage_json) — byte-exact
 *   - same per-component `schema_versions` migration ladder (Phase 25e)
 *   - same WAL/synchronous/foreign_keys pragmas
 *
 * The CLI does NOT depend on the broker package — it talks to the same
 * file on disk, with the same schema. This keeps the CLI a tiny binary
 * that can run without spinning up Effect.
 *
 * Why dynamic-import: tsc with stock `@types/node` doesn't know about
 * `bun:sqlite`. We resolve at call time (we are bun-only at runtime, so
 * the import always succeeds in production). Mirrors the
 * cost-store-sqlite / account-broker-sql approach.
 */
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"

// ── Inline-duplicated schema_versions helper (Phase 25e) ───────────────────
// Keep in sync with packages/core/src/db/schema-versions.ts.
// The CLI deliberately does not depend on @luna/core (see header) — drift
// reintroduces the migration-collision bug fixed in Phase 25e.

const SCHEMA_VERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_versions (
    component   TEXT NOT NULL,
    version     INTEGER NOT NULL,
    applied_at  INTEGER NOT NULL,
    PRIMARY KEY (component, version)
  );
`

const ensureSchemaVersions = (db: SqliteDb): void => {
  db.run(SCHEMA_VERSIONS_DDL)
}

const applyMigration = (
  db: SqliteDb,
  component: string,
  version: number,
  sql: string,
  nowMs: number,
): void => {
  const has = db
    .query(
      "SELECT 1 AS x FROM schema_versions WHERE component = ? AND version = ? LIMIT 1",
    )
    .get(component, version) as { x: number } | undefined | null
  if (has != null) return
  db.run("BEGIN IMMEDIATE")
  try {
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

// ── Schema (§5.1, byte-exact columns) ──────────────────────────────────────
export const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    secret_ref    TEXT NOT NULL,
    health        TEXT NOT NULL,
    cooldown_ms   INTEGER,
    usage_json    TEXT NOT NULL
  );
`

export const defaultDbPath = (): string => {
  const override = process.env["LUNA_DB_PATH"]
  if (override !== undefined && override.length > 0) return override
  return path.join(os.homedir(), ".luna", "luna.db")
}

export interface AccountRow {
  id: string
  label: string
  kind: string
  secret_ref: string
  health: string
  cooldown_ms: number | null
  usage_json: string
}

export interface SqliteDb {
  run: (sql: string) => void
  query: (sql: string) => {
    get: (...p: unknown[]) => unknown
    all: (...p: unknown[]) => unknown[]
    run: (...p: unknown[]) => { changes: number }
  }
  close: () => void
}

const loadDatabase = (): new (p: string) => SqliteDb => {
  // Synchronous require via createRequire — bun resolves `bun:sqlite`
  // natively (we are bun-only at runtime). createRequire works under
  // both bun and node; under node the resolve will fail with a clear
  // ENOENT-style error which we surface to the caller.
  try {
    const req = createRequire(import.meta.url)
    const mod = req("bun:sqlite") as { Database?: new (p: string) => SqliteDb }
    if (mod.Database) return mod.Database
  } catch (e) {
    throw new Error(
      `bun:sqlite is unavailable. luna-account must be run under \`bun\`. ` +
        `Cause: ${String(e)}`,
    )
  }
  throw new Error(
    "bun:sqlite resolved but exposes no `Database` constructor.",
  )
}

export const openDb = (dbPath: string): SqliteDb => {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }
  const Database = loadDatabase()
  const db = new Database(dbPath)
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA foreign_keys = ON")
  // §5.2 migration ladder: per-component `schema_versions` ledger (Phase 25e).
  // Component name "accounts" is shared with
  // packages/core/src/account-broker/account-broker-sql.ts — both write the
  // same accounts table on the same DB, so they MUST agree on version keying.
  ensureSchemaVersions(db)
  applyMigration(db, "accounts", 1, SCHEMA_V1, Date.now())
  return db
}
