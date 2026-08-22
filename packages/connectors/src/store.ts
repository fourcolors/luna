/**
 * ConnectorInstanceStore — durable connector connections (PRD Part A §19).
 *
 * One table in luna.db via the per-component migration ledger, mirroring
 * the accounts table's secret-ref discipline: `secret_ref` is a pointer
 * (`env:…` / `luna-op://…` / "none"), never a credential value.
 *
 * Memory variant for unit tests; SQLite for production — same idioms as
 * skill-prefs-store / agent-notes (dynamic bun:sqlite, WAL, close-on-scope).
 */
import { Context, Effect, Layer, Ref } from "effect"
import { Clock, ConfigError, LunaSqliteBootstrap, applyMigration, ensureSchemaVersions } from "@luna/core"
import type { ConnectorInstance, ConnectorStatus } from "./types.js"

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS connector_instances (
    id              TEXT NOT NULL PRIMARY KEY,
    definition_id   TEXT NOT NULL,
    label           TEXT NOT NULL,
    status          TEXT NOT NULL,
    secret_ref      TEXT NOT NULL,
    granted_scopes  TEXT NOT NULL,
    account_kind    TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    last_healthy_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_connector_instances_definition
    ON connector_instances(definition_id);
`

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

export interface ConnectorInstanceStoreApi {
  readonly list: () => Effect.Effect<ReadonlyArray<ConnectorInstance>>
  readonly insert: (instance: ConnectorInstance) => Effect.Effect<void>
  readonly setStatus: (
    id: string,
    status: ConnectorStatus,
    lastHealthyAt?: number,
  ) => Effect.Effect<boolean>
  readonly remove: (id: string) => Effect.Effect<boolean>
}

export class ConnectorInstanceStore extends Context.Service<ConnectorInstanceStore, ConnectorInstanceStoreApi>()("luna/ConnectorInstanceStore") {
  /** In-memory variant — unit tests. */
  static readonly Memory: Layer.Layer<ConnectorInstanceStore> = Layer.effect(
    ConnectorInstanceStore,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, ConnectorInstance>>(new Map())
      return {
        list: () =>
          Ref.get(store).pipe(Effect.map((m) => Array.from(m.values()))),
        insert: (instance) =>
          Ref.update(store, (m) => new Map(m).set(instance.id, instance)),
        setStatus: (id, status, lastHealthyAt) =>
          Ref.modify(store, (m): readonly [boolean, Map<string, ConnectorInstance>] => {
            const cur = m.get(id)
            if (cur === undefined) return [false, m] as const
            const next = new Map(m)
            next.set(id, {
              ...cur,
              status,
              lastHealthyAt: lastHealthyAt ?? cur.lastHealthyAt,
            })
            return [true, next] as const
          }),
        remove: (id) =>
          Ref.modify(store, (m): readonly [boolean, Map<string, ConnectorInstance>] => {
            if (!m.has(id)) return [false, m] as const
            const next = new Map(m)
            next.delete(id)
            return [true, next] as const
          }),
      } satisfies ConnectorInstanceStoreApi
    }),
  )

  /** SQLite-backed layer over luna.db (":memory:" works for tests under bun). */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<ConnectorInstanceStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.effect(
      ConnectorInstanceStore,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap
        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "connectors",
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
              module: "connectors",
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
        applyMigration(db as never, "connector_instances", 1, SCHEMA_V1, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        const listStmt = db.query(
          `SELECT id, definition_id, label, status, secret_ref, granted_scopes,
                  account_kind, created_at, last_healthy_at
           FROM connector_instances ORDER BY created_at ASC`,
        )
        const insertStmt = db.query(
          `INSERT INTO connector_instances
             (id, definition_id, label, status, secret_ref, granted_scopes,
              account_kind, created_at, last_healthy_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        const statusStmt = db.query(
          `UPDATE connector_instances SET status = ?, last_healthy_at = COALESCE(?, last_healthy_at) WHERE id = ?`,
        )
        const removeStmt = db.query(
          `DELETE FROM connector_instances WHERE id = ?`,
        )

        type Row = {
          id: string
          definition_id: string
          label: string
          status: string
          secret_ref: string
          granted_scopes: string
          account_kind: string
          created_at: number
          last_healthy_at: number | null
        }
        /**
         * `toInstance` runs inside a `.map` over the whole connector list, and
         * that call site is `Effect.sync` — so a throw here escaped as an
         * unhandled DEFECT that killed the fiber rather than a recoverable
         * failure. Degrade one corrupt row to "no scopes" instead.
         */
        const parseGrantedScopes = (raw: string, id: string): string[] => {
          try {
            const parsed = JSON.parse(raw) as unknown
            return Array.isArray(parsed) ? (parsed as string[]) : []
          } catch (cause) {
            console.warn(
              `[connectors] instance "${id}": unparseable granted_scopes; defaulting to []: ${String(cause)}`,
            )
            return []
          }
        }
        const toInstance = (r: Row): ConnectorInstance => ({
          id: r.id,
          definitionId: r.definition_id,
          label: r.label,
          status: r.status as ConnectorStatus,
          secretRef: r.secret_ref,
          grantedScopes: parseGrantedScopes(r.granted_scopes, r.id),
          accountKind: r.account_kind,
          createdAt: r.created_at,
          lastHealthyAt: r.last_healthy_at,
        })

        return {
          list: () =>
            Effect.sync(() => (listStmt.all() as Row[]).map(toInstance)),
          insert: (i) =>
            Effect.sync(() => {
              insertStmt.run(
                i.id,
                i.definitionId,
                i.label,
                i.status,
                i.secretRef,
                JSON.stringify(i.grantedScopes),
                i.accountKind,
                i.createdAt,
                i.lastHealthyAt,
              )
            }),
          setStatus: (id, status, lastHealthyAt) =>
            Effect.sync(
              () => statusStmt.run(status, lastHealthyAt ?? null, id).changes > 0,
            ),
          remove: (id) =>
            Effect.sync(() => removeStmt.run(id).changes > 0),
        } satisfies ConnectorInstanceStoreApi
      }),
    )
  }
}
