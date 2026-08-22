/**
 * VaultStore — durable vault item registry.
 *
 * One table in luna.db via the per-component migration ledger, mirroring
 * the connectors-store secret-ref discipline: `ref` is a POINTER
 * (`env:…` / `luna-op://…`), never a credential value.
 *
 * A second single-row table `vault_sync_config` holds the 1Password sync
 * settings (slice V3); it is read-only from the agent side until that
 * slice is built.
 *
 * Memory variant for unit tests; SQLite for production — same idioms as
 * ConnectorInstanceStore / skill-prefs-store.
 */
import { Context, Effect, Layer, Ref } from "effect"
import {
  Clock,
  ConfigError,
  LunaSqliteBootstrap,
  applyMigration,
  ensureSchemaVersions,
} from "@luna/core"
import type { VaultItem, VaultSyncConfig } from "./types.js"

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Items table.
 * `name_lower` is computed in TypeScript (`.toLowerCase()`) before every
 * write so the unique constraint uses Unicode folding, not SQLite's
 * ASCII-only lower().  The Memory layer uses the same JS fold, so both
 * backends behave identically on non-ASCII names.
 */
const ITEMS_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS vault_items (
    id          TEXT NOT NULL PRIMARY KEY,
    name        TEXT NOT NULL,
    name_lower  TEXT NOT NULL,
    kind        TEXT NOT NULL,
    ref         TEXT NOT NULL,
    source      TEXT NOT NULL,
    description TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    op_item_id  TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_items_name_lower
    ON vault_items(name_lower);
`

/** Sync-config table (single-row; V3 slice; read-only from agent side for now). */
const SYNC_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS vault_sync_config (
    id            INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    enabled       INTEGER NOT NULL,
    op_label      TEXT    NOT NULL,
    op_vault      TEXT    NOT NULL,
    poll_seconds  INTEGER NOT NULL,
    last_synced_at INTEGER,
    last_error    TEXT
  );
`

// ---------------------------------------------------------------------------
// Low-level bun:sqlite shims (typed-enough for this file)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Service API
// ---------------------------------------------------------------------------

export interface VaultStoreApi {
  /** Returns all registry items, oldest-first. */
  readonly list: () => Effect.Effect<ReadonlyArray<VaultItem>>
  /**
   * Insert or update by name (case-insensitive match). On update the id and
   * createdAt from the existing row are preserved; all other fields are
   * replaced by the incoming item.
   */
  readonly upsertByName: (item: VaultItem) => Effect.Effect<void>
  readonly getById: (id: string) => Effect.Effect<VaultItem | null>
  /** Returns true when a row was deleted, false when the id was not found. */
  readonly remove: (id: string) => Effect.Effect<boolean>
  /** Returns the sync config row, or null when it has never been written. */
  readonly getSyncConfig: () => Effect.Effect<VaultSyncConfig | null>
  readonly setSyncConfig: (cfg: VaultSyncConfig) => Effect.Effect<void>
}

export class VaultStore extends Context.Service<VaultStore, VaultStoreApi>()("luna/VaultStore") {
  /** In-memory variant — unit tests. */
  static readonly Memory: Layer.Layer<VaultStore> = Layer.effect(
    VaultStore,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, VaultItem>>(new Map())
      const syncRef = yield* Ref.make<VaultSyncConfig | null>(null)

      return {
        list: () =>
          Ref.get(store).pipe(
            Effect.map((m) =>
              Array.from(m.values()).sort((a, b) => a.createdAt - b.createdAt),
            ),
          ),

        upsertByName: (item) =>
          Ref.update(store, (m) => {
            // Find existing by case-insensitive name match.
            const nameLower = item.name.toLowerCase()
            let existingKey: string | undefined
            for (const [k, v] of m) {
              if (v.name.toLowerCase() === nameLower) {
                existingKey = k
                break
              }
            }
            const next = new Map(m)
            if (existingKey !== undefined) {
              const existing = m.get(existingKey)!
              next.delete(existingKey)
              next.set(existing.id, {
                ...item,
                id: existing.id,
                createdAt: existing.createdAt,
              })
            } else {
              next.set(item.id, item)
            }
            return next
          }),

        getById: (id) =>
          Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),

        remove: (id) =>
          Ref.modify(store, (m): readonly [boolean, Map<string, VaultItem>] => {
            if (!m.has(id)) return [false, m] as const
            const next = new Map(m)
            next.delete(id)
            return [true, next] as const
          }),

        getSyncConfig: () => Ref.get(syncRef),

        setSyncConfig: (cfg) => Ref.set(syncRef, cfg),
      } satisfies VaultStoreApi
    }),
  )

  /** SQLite-backed layer over luna.db (":memory:" works for tests under bun). */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<VaultStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.effect(
      VaultStore,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap
        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "vault",
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
              module: "vault",
              key: "bun:sqlite",
              message: "bun:sqlite module has no `Database` export",
            }),
          )
        }
        const db = new Database(dbPath)
        db.run("PRAGMA journal_mode = WAL")
        db.run("PRAGMA synchronous = NORMAL")

        const nowMs = yield* clock.nowMs()
        ensureSchemaVersions(db as never)
        applyMigration(db as never, "vault_items", 1, ITEMS_SCHEMA_V1, nowMs)
        applyMigration(db as never, "vault_sync_config", 1, SYNC_SCHEMA_V1, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements — vault_items.
        const listStmt = db.query(
          `SELECT id, name, kind, ref, source, description,
                  created_at, updated_at, op_item_id
           FROM vault_items ORDER BY created_at ASC`,
        )
        const getByIdStmt = db.query(
          `SELECT id, name, kind, ref, source, description,
                  created_at, updated_at, op_item_id
           FROM vault_items WHERE id = ?`,
        )
        const getByNameLowerStmt = db.query(
          `SELECT id, created_at FROM vault_items WHERE name_lower = ?`,
        )
        const insertStmt = db.query(
          `INSERT INTO vault_items
             (id, name, name_lower, kind, ref, source, description, created_at, updated_at, op_item_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        const updateStmt = db.query(
          `UPDATE vault_items
           SET name=?, name_lower=?, kind=?, ref=?, source=?, description=?,
               updated_at=?, op_item_id=?
           WHERE id=?`,
        )
        const removeStmt = db.query(
          `DELETE FROM vault_items WHERE id = ?`,
        )

        // Prepared statements — vault_sync_config.
        const getSyncStmt = db.query(
          `SELECT enabled, op_label, op_vault, poll_seconds,
                  last_synced_at, last_error
           FROM vault_sync_config WHERE id = 1`,
        )
        const setSyncStmt = db.query(
          `INSERT INTO vault_sync_config
             (id, enabled, op_label, op_vault, poll_seconds, last_synced_at, last_error)
           VALUES (1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             enabled=excluded.enabled, op_label=excluded.op_label,
             op_vault=excluded.op_vault, poll_seconds=excluded.poll_seconds,
             last_synced_at=excluded.last_synced_at, last_error=excluded.last_error`,
        )

        type ItemRow = {
          id: string
          name: string
          kind: string
          ref: string
          source: string
          description: string | null
          created_at: number
          updated_at: number
          op_item_id: string | null
        }
        const toItem = (r: ItemRow): VaultItem => ({
          id: r.id,
          name: r.name,
          kind: r.kind as VaultItem["kind"],
          ref: r.ref,
          source: r.source as VaultItem["source"],
          description: r.description,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          opItemId: r.op_item_id,
        })

        type SyncRow = {
          enabled: number
          op_label: string
          op_vault: string
          poll_seconds: number
          last_synced_at: number | null
          last_error: string | null
        }
        const toSyncConfig = (r: SyncRow): VaultSyncConfig => ({
          enabled: r.enabled !== 0,
          opLabel: r.op_label,
          opVault: r.op_vault,
          pollSeconds: r.poll_seconds,
          lastSyncedAt: r.last_synced_at,
          lastError: r.last_error,
        })

        return {
          list: () =>
            Effect.sync(() => (listStmt.all() as ItemRow[]).map(toItem)),

          upsertByName: (item) =>
            Effect.sync(() => {
              const nameLower = item.name.toLowerCase()
              // bun:sqlite .get() returns null (not undefined) when no row matches.
              const existing = (getByNameLowerStmt.get(nameLower) ?? undefined) as
                | { id: string; created_at: number }
                | undefined
              if (existing !== undefined) {
                updateStmt.run(
                  item.name,
                  nameLower,
                  item.kind,
                  item.ref,
                  item.source,
                  item.description ?? null,
                  item.updatedAt,
                  item.opItemId ?? null,
                  existing.id,
                )
              } else {
                insertStmt.run(
                  item.id,
                  item.name,
                  nameLower,
                  item.kind,
                  item.ref,
                  item.source,
                  item.description ?? null,
                  item.createdAt,
                  item.updatedAt,
                  item.opItemId ?? null,
                )
              }
            }),

          getById: (id) =>
            Effect.sync(() => {
              const row = getByIdStmt.get(id) as ItemRow | undefined
              return row ? toItem(row) : null
            }),

          remove: (id) =>
            Effect.sync(() => removeStmt.run(id).changes > 0),

          getSyncConfig: () =>
            Effect.sync(() => {
              const row = getSyncStmt.get() as SyncRow | undefined
              return row ? toSyncConfig(row) : null
            }),

          setSyncConfig: (cfg) =>
            Effect.sync(() => {
              setSyncStmt.run(
                cfg.enabled ? 1 : 0,
                cfg.opLabel,
                cfg.opVault,
                cfg.pollSeconds,
                cfg.lastSyncedAt ?? null,
                cfg.lastError ?? null,
              )
            }),
        } satisfies VaultStoreApi
      }),
    )
  }
}
