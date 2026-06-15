/**
 * Inbound message dedup — prevents at-least-once delivery from double-offering
 * a user turn to the agent.
 *
 * Platforms that use long-polling (Telegram getUpdates) or webhook retry
 * semantics will re-deliver the same message if the consumer crashes between
 * receipt and ack. Without dedup, a retried message would create a second
 * assistant turn in the same thread.
 *
 * Key: (transport, platformMessageId). The platformMessageId must be the
 * platform's own stable identifier (Telegram message_id, Discord snowflake,
 * Slack ts, etc.) — not a Luna-generated id.
 *
 * TTL: rows are never automatically pruned in this v1 implementation. For
 * high-volume bots a background pruner (e.g. DELETE WHERE created_at < 30 days
 * ago) can be added later without changing the public API.
 *
 * Follows the same bun:sqlite + WAL pattern as packages/connectors/src/store.ts.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock, ConfigError, LunaSqliteBootstrap, applyMigration, ensureSchemaVersions } from "@luna/core"

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS channel_inbound_seen (
    transport           TEXT NOT NULL,
    platform_message_id TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    PRIMARY KEY (transport, platform_message_id)
  );
`

/* -------------------------------------------------------------------------- */
/* BunSqlite shims                                                             */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Store API                                                                   */
/* -------------------------------------------------------------------------- */

export interface InboundDedupStoreApi {
  /**
   * Returns true when this (transport, platformMessageId) pair has been seen
   * before (i.e. the message is a duplicate and should be dropped).
   */
  readonly seenBefore: (
    transport: string,
    platformMessageId: string,
  ) => Effect.Effect<boolean>

  /**
   * Mark this (transport, platformMessageId) pair as seen. Idempotent:
   * if the row already exists the call is a no-op.
   */
  readonly markSeen: (
    transport: string,
    platformMessageId: string,
    createdAt: number,
  ) => Effect.Effect<void>
}

export class InboundDedupStore extends Effect.Tag(
  "luna/InboundDedupStore",
)<InboundDedupStore, InboundDedupStoreApi>() {
  /** In-memory variant for unit tests. */
  static readonly Memory: Layer.Layer<InboundDedupStore> = Layer.effect(
    InboundDedupStore,
    Effect.gen(function* () {
      const seen = yield* Ref.make<Set<string>>(new Set())
      const key = (t: string, id: string) => `${t}\x00${id}`

      return {
        seenBefore: (transport, platformMessageId) =>
          Ref.get(seen).pipe(
            Effect.map((s) => s.has(key(transport, platformMessageId))),
          ),
        markSeen: (transport, platformMessageId, _createdAt) =>
          Ref.update(seen, (s) => {
            const next = new Set(s)
            next.add(key(transport, platformMessageId))
            return next
          }),
      } satisfies InboundDedupStoreApi
    }),
  )

  /** SQLite-backed layer over luna.db. */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<InboundDedupStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      InboundDedupStore,
      Effect.gen(function* () {
        yield* LunaSqliteBootstrap
        const clock = yield* Clock

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () => import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>,
          catch: (cause) =>
            new ConfigError({
              module: "channels",
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
              module: "channels",
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
        applyMigration(db as never, "channel_inbound_seen", 1, SCHEMA_V1, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        const seenStmt = db.query(
          `SELECT 1 FROM channel_inbound_seen
           WHERE transport = ? AND platform_message_id = ?`,
        )
        const insertStmt = db.query(
          `INSERT OR IGNORE INTO channel_inbound_seen
             (transport, platform_message_id, created_at)
           VALUES (?, ?, ?)`,
        )

        return {
          seenBefore: (transport, platformMessageId) =>
            Effect.sync(() => seenStmt.get(transport, platformMessageId) !== undefined),
          markSeen: (transport, platformMessageId, createdAt) =>
            Effect.sync(() => {
              insertStmt.run(transport, platformMessageId, createdAt)
            }),
        } satisfies InboundDedupStoreApi
      }),
    )
  }
}
