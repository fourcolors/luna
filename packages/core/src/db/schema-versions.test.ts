/**
 * Unit tests for the per-component migration ladder helper (Phase 25e/2).
 *
 * In-memory `bun:sqlite` DBs only — no fs writes. Bun-gated since the helper
 * targets bun:sqlite directly (mirrors all other sqlite tests in the repo).
 */
import { describe, expect, it } from "vitest"
import {
  applyMigration,
  ensureSchemaVersions,
  type BunDb,
} from "./schema-versions.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

const openMem = async (): Promise<BunDb & { close: () => void }> => {
  const bunSqliteSpec = "bun:sqlite"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ bunSqliteSpec)
  return new mod.Database(":memory:") as BunDb & { close: () => void }
}

const tableExists = (db: BunDb, name: string): boolean => {
  const row = db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name) as { name: string } | null | undefined
  return row != null
}

const ledgerRows = (db: BunDb): ReadonlyArray<{
  component: string
  version: number
  applied_at: number
}> =>
  db
    .query("SELECT component, version, applied_at FROM schema_versions")
    .all() as ReadonlyArray<{
    component: string
    version: number
    applied_at: number
  }>

d("schema-versions helper", () => {
  it("applyMigration runs SQL on first call and records the row", async () => {
    const db = await openMem()
    try {
      ensureSchemaVersions(db)
      applyMigration(
        db,
        "accounts",
        1,
        "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY)",
        12345,
      )
      expect(tableExists(db, "accounts")).toBe(true)
      const rows = ledgerRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({
        component: "accounts",
        version: 1,
        applied_at: 12345,
      })
    } finally {
      db.close()
    }
  })

  it("applyMigration is idempotent — second call is a no-op", async () => {
    const db = await openMem()
    try {
      ensureSchemaVersions(db)
      applyMigration(
        db,
        "accounts",
        1,
        "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY)",
        100,
      )
      // Second call would fail outright if it actually re-executed the
      // INSERT (PK violation on (component, version)). Pass a SQL string
      // that would also fail if executed, to prove the early-return.
      applyMigration(
        db,
        "accounts",
        1,
        "THIS IS NOT VALID SQL — must not be run on the idempotent path",
        200,
      )
      const rows = ledgerRows(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.applied_at).toBe(100) // still the original ts
    } finally {
      db.close()
    }
  })

  it("applyMigration rolls back on SQL error and leaves no ledger row", async () => {
    const db = await openMem()
    try {
      ensureSchemaVersions(db)
      expect(() =>
        applyMigration(
          db,
          "broken",
          1,
          "CREATE TABLE oops (id TEXT); SELECT THIS_IS_NOT_VALID_SQL;",
          1,
        ),
      ).toThrow()
      // No ledger row recorded.
      const rows = ledgerRows(db)
      expect(rows).toHaveLength(0)
      // The CREATE TABLE inside the failed batch must have been rolled back.
      // (bun:sqlite's `run` accepts multi-statement SQL via exec; the second
      // statement throws and the BEGIN IMMEDIATE is rolled back.)
      expect(tableExists(db, "oops")).toBe(false)
    } finally {
      db.close()
    }
  })

  it("ensureSchemaVersions is idempotent across multiple calls", async () => {
    const db = await openMem()
    try {
      ensureSchemaVersions(db)
      ensureSchemaVersions(db)
      ensureSchemaVersions(db)
      // Sanity: ledger still empty, table still there.
      expect(tableExists(db, "schema_versions")).toBe(true)
      expect(ledgerRows(db)).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})
