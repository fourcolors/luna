/**
 * Direct `bun:sqlite` helper for the seed CLI.
 *
 * Mirrors `packages/core/src/account-broker/account-broker-sql.ts`:
 *   - same §5.1 columns (id, label, kind, secret_ref, health, cooldown_ms,
 *     usage_json) — byte-exact
 *   - same migration ladder via `PRAGMA user_version`
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

export const TARGET_USER_VERSION = 1

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
      try {
        db.run("ROLLBACK")
      } catch {
        /* best-effort */
      }
      throw e
    }
  }
  return db
}
