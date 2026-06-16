/**
 * Unit tests for provider-settings SQLite store.
 *
 * Uses an in-memory Database (bun:sqlite) via dynamic import to mirror
 * the pattern in account-broker-sql.ts and session-store-sqlite.ts.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { openProviderSettingsStore, COMPONENT } from "./store.js"
import type { ProviderSettingsPayload } from "./types.js"
import type { BunDb } from "../db/schema-versions.js"

// ── bun:sqlite dynamic import helper ─────────────────────────────────────────

async function openMemoryDb(): Promise<BunDb> {
  try {
    const mod = await import("bun:sqlite" as string)
    const Database = (mod as { Database?: new (p: string) => BunDb }).Database
    if (!Database) throw new Error("no Database export")
    const db = new Database(":memory:")
    db.run("PRAGMA journal_mode = WAL")
    db.run("PRAGMA foreign_keys = ON")
    return db
  } catch {
    // In environments without bun:sqlite (vitest via node) — skip DB tests.
    return null as unknown as BunDb
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const samplePayload = (): ProviderSettingsPayload => ({
  version: 1,
  providers: [{ kind: "anthropic", enabled: true, monthlyCapUsd: 50 }],
  roleBindings: [
    {
      role: "advisor",
      preferenceList: [{ provider: "anthropic", model: "claude-opus-4-8" }],
    },
    {
      role: "daily-driver",
      preferenceList: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
    },
  ],
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("openProviderSettingsStore", () => {
  it("read() returns null when no config has been saved", async () => {
    const db = await openMemoryDb()
    if (db === null) return // skip in non-bun environments
    const store = openProviderSettingsStore(db, Date.now())
    expect(store.read()).toBeNull()
  })

  it("write() then read() round-trips the payload", async () => {
    const db = await openMemoryDb()
    if (db === null) return
    const store = openProviderSettingsStore(db, Date.now())
    const payload = samplePayload()
    store.write(payload)
    const result = store.read()
    expect(result).not.toBeNull()
    expect(result?.version).toBe(1)
    expect(result?.providers).toHaveLength(1)
    expect(result?.providers[0]?.kind).toBe("anthropic")
    expect(result?.providers[0]?.monthlyCapUsd).toBe(50)
    expect(result?.roleBindings).toHaveLength(2)
  })

  it("write() is idempotent — second write overwrites first", async () => {
    const db = await openMemoryDb()
    if (db === null) return
    const store = openProviderSettingsStore(db, Date.now())

    store.write(samplePayload())

    const updated: ProviderSettingsPayload = {
      version: 1,
      providers: [],
      roleBindings: [
        {
          role: "dream",
          preferenceList: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
        },
      ],
    }
    store.write(updated)

    const result = store.read()
    expect(result?.roleBindings).toHaveLength(1)
    expect(result?.roleBindings[0]?.role).toBe("dream")
    expect(result?.providers).toHaveLength(0)
  })

  it("migration is idempotent — opening twice does not fail", async () => {
    const db = await openMemoryDb()
    if (db === null) return
    // Open twice on the same db handle — should not throw.
    const store1 = openProviderSettingsStore(db, Date.now())
    const store2 = openProviderSettingsStore(db, Date.now())
    store1.write(samplePayload())
    expect(store2.read()).not.toBeNull()
  })

  it("schema_versions row is recorded after migration", async () => {
    const db = await openMemoryDb()
    if (db === null) return
    openProviderSettingsStore(db, Date.now())
    const row = db
      .query("SELECT version FROM schema_versions WHERE component = ? LIMIT 1")
      .get(COMPONENT) as { version: number } | undefined
    expect(row?.version).toBe(1)
  })

  it("read() returns null for a corrupted JSON blob", async () => {
    const db = await openMemoryDb()
    if (db === null) return
    const store = openProviderSettingsStore(db, Date.now())
    // Manually insert corrupted JSON.
    db.query(
      "INSERT INTO provider_settings (key, value) VALUES ('config', 'not-json')",
    ).run()
    expect(store.read()).toBeNull()
  })

  it("read() returns null for a wrong-version JSON blob", async () => {
    const db = await openMemoryDb()
    if (db === null) return
    const store = openProviderSettingsStore(db, Date.now())
    db.query(
      "INSERT INTO provider_settings (key, value) VALUES ('config', ?)",
    ).run(JSON.stringify({ version: 99, providers: [], roleBindings: [] }))
    expect(store.read()).toBeNull()
  })
})
