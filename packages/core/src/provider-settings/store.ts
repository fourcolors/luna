/**
 * ProviderSettingsStore — SQLite-backed store for operator model/provider
 * routing preferences. Lives on luna.db under the "provider_settings" component.
 *
 * Schema: a single key-value table
 *   provider_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)
 *
 * In practice only one row is used: key='config', value=JSON blob of
 * ProviderSettingsPayload. The KV table keeps the schema dead-simple;
 * future columns can be added via a v2 migration without touching v1 rows.
 *
 * Does NOT touch the `accounts` table (§5.1 byte-exact; frozen).
 */

import { applyMigration, ensureSchemaVersions, type BunDb } from "../db/schema-versions.js"
import type { ProviderSettingsPayload } from "./types.js"

export const COMPONENT = "provider_settings"

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS provider_settings (
    key   TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
  );
`

const CONFIG_KEY = "config"

export interface ProviderSettingsStore {
  /** Read the persisted settings, or null if none have been saved yet. */
  readonly read: () => ProviderSettingsPayload | null
  /** Persist settings. Overwrites any existing config. */
  readonly write: (payload: ProviderSettingsPayload) => void
}

/**
 * Open or create the provider_settings component on an existing luna.db handle.
 * Runs the v1 migration idempotently. Does NOT open the DB itself (the caller
 * owns the connection lifetime).
 */
export const openProviderSettingsStore = (
  db: BunDb,
  nowMs: number = Date.now(),
): ProviderSettingsStore => {
  ensureSchemaVersions(db)
  applyMigration(db, COMPONENT, 1, SCHEMA_V1, nowMs)

  const read = (): ProviderSettingsPayload | null => {
    const row = db
      .query("SELECT value FROM provider_settings WHERE key = ? LIMIT 1")
      .get(CONFIG_KEY) as { value: string } | undefined | null
    if (row == null) return null
    try {
      const parsed = JSON.parse(row.value) as unknown
      if (parsed === null || typeof parsed !== "object") return null
      // Defensive shape check — version field must be present.
      const o = parsed as Record<string, unknown>
      if (o["version"] !== 1) return null
      return parsed as ProviderSettingsPayload
    } catch {
      return null
    }
  }

  const write = (payload: ProviderSettingsPayload): void => {
    const json = JSON.stringify(payload)
    db.query(
      "INSERT INTO provider_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(CONFIG_KEY, json)
  }

  return { read, write }
}
