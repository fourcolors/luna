/**
 * channel_sessions store — durable (transport, channelId, threadingKey) → threadId map.
 *
 * Threading policy (the `threadingKey` knob):
 *
 *   DM / 1-to-1 conversation:
 *     Pass `threadingKey = senderId` (or omit it — the caller normalizes to
 *     channelId when absent). Each peer gets a PERSISTENT dedicated thread:
 *     every message from the same Telegram user id on the same bot always
 *     routes to the same Luna thread, preserving conversation history across
 *     hours/days.
 *
 *   Group channel / room:
 *     Pass `threadingKey = channelId` (or a sub-topic id). All participants
 *     in the group share ONE Luna thread. The agent sees the full group
 *     context and replies into a single history.
 *
 * The (transport, channelId, threadingKey) triple is the normalized lookup key.
 * When `threadingKey` is absent it defaults to `channelId`.
 *
 * `lookupOrCreate` is the primary API: it looks up the existing Luna thread
 * for a key, or creates a new one via ChatService and records the mapping.
 * Thread creation goes through ChatService.createThread so the thread is
 * registered in the service's in-memory map and receives the PubSub.
 *
 * Follows the same bun:sqlite + WAL pattern as packages/connectors/src/store.ts.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock, ConfigError, LunaSqliteBootstrap, applyMigration, ensureSchemaVersions } from "@luna/core"
import { ChatService } from "@luna/chat-service"
import type { ChannelMessage } from "./types.js"

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS channel_sessions (
    transport      TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    threading_key  TEXT NOT NULL,
    thread_id      TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (transport, channel_id, threading_key)
  );
  CREATE INDEX IF NOT EXISTS idx_channel_sessions_thread_id
    ON channel_sessions(thread_id);
`

/* -------------------------------------------------------------------------- */
/* BunSqlite shims (same pattern as connectors/store.ts)                     */
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

export interface ChannelSessionStoreApi {
  /**
   * Resolve the Luna threadId for a (transport, channelId, threadingKey)
   * triple, or null if no mapping exists yet.
   */
  readonly lookup: (
    transport: string,
    channelId: string,
    threadingKey: string,
  ) => Effect.Effect<string | null>

  /**
   * Record a (transport, channelId, threadingKey) → threadId mapping.
   * Idempotent: if the row already exists it is left unchanged (the first
   * writer wins — concurrent deliveries for the same key may both call
   * insert, but only one thread is ever assigned).
   */
  readonly insert: (
    transport: string,
    channelId: string,
    threadingKey: string,
    threadId: string,
    createdAt: number,
  ) => Effect.Effect<void>

  /**
   * Forget the mapping for a (transport, channelId, threadingKey) triple.
   * The next lookupOrCreate for that key creates a fresh Luna thread — this
   * is the "/new conversation" primitive for channel commands. The old
   * thread itself is left intact (history preserved in ChatService); only
   * the routing row is dropped. Idempotent: removing an absent key is a
   * no-op.
   */
  readonly remove: (
    transport: string,
    channelId: string,
    threadingKey: string,
  ) => Effect.Effect<void>
}

export class ChannelSessionStore extends Effect.Tag(
  "luna/ChannelSessionStore",
)<ChannelSessionStore, ChannelSessionStoreApi>() {
  /** In-memory variant for unit tests. */
  static readonly Memory: Layer.Layer<ChannelSessionStore> = Layer.effect(
    ChannelSessionStore,
    Effect.gen(function* () {
      const store = yield* Ref.make<
        Map<string, string>
      >(new Map())

      const key = (t: string, c: string, k: string) => `${t}\x00${c}\x00${k}`

      return {
        lookup: (transport, channelId, threadingKey) =>
          Ref.get(store).pipe(
            Effect.map((m) => m.get(key(transport, channelId, threadingKey)) ?? null),
          ),
        insert: (transport, channelId, threadingKey, threadId, _createdAt) =>
          Ref.update(store, (m) => {
            const k = key(transport, channelId, threadingKey)
            if (m.has(k)) return m
            const next = new Map(m)
            next.set(k, threadId)
            return next
          }),
        remove: (transport, channelId, threadingKey) =>
          Ref.update(store, (m) => {
            const k = key(transport, channelId, threadingKey)
            if (!m.has(k)) return m
            const next = new Map(m)
            next.delete(k)
            return next
          }),
      } satisfies ChannelSessionStoreApi
    }),
  )

  /** SQLite-backed layer over luna.db. */
  static makeLayer(
    dbPath: string,
  ): Layer.Layer<ChannelSessionStore, ConfigError, Clock | LunaSqliteBootstrap> {
    return Layer.scoped(
      ChannelSessionStore,
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
        applyMigration(db as never, "channel_sessions", 1, SCHEMA_V1, nowMs)

        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        const lookupStmt = db.query(
          `SELECT thread_id FROM channel_sessions
           WHERE transport = ? AND channel_id = ? AND threading_key = ?`,
        )
        const insertStmt = db.query(
          `INSERT OR IGNORE INTO channel_sessions
             (transport, channel_id, threading_key, thread_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        const removeStmt = db.query(
          `DELETE FROM channel_sessions
           WHERE transport = ? AND channel_id = ? AND threading_key = ?`,
        )

        type Row = { thread_id: string }

        return {
          lookup: (transport, channelId, threadingKey) =>
            Effect.sync(() => {
              const row = lookupStmt.get(transport, channelId, threadingKey) as Row | undefined
              return row?.thread_id ?? null
            }),
          insert: (transport, channelId, threadingKey, threadId, createdAt) =>
            Effect.sync(() => {
              insertStmt.run(transport, channelId, threadingKey, threadId, createdAt)
            }),
          remove: (transport, channelId, threadingKey) =>
            Effect.sync(() => {
              removeStmt.run(transport, channelId, threadingKey)
            }),
        } satisfies ChannelSessionStoreApi
      }),
    )
  }
}

/* -------------------------------------------------------------------------- */
/* lookupOrCreate                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Normalize the threading key from an inbound ChannelMessage.
 * When absent, falls back to channelId — appropriate for DMs where the
 * channelId is already unique per peer.
 */
export const normalizeThreadingKey = (msg: ChannelMessage): string =>
  msg.threadingKey ?? msg.channelId

const shouldStoreThreadUserIdentity = (msg: ChannelMessage): boolean =>
  msg.transport !== "telegram" || msg.metadata?.chatType === "private"

/**
 * Look up the Luna threadId for this message, or create a new thread and
 * record the mapping.
 *
 * Uses ChatService.createThread to ensure the thread is registered in the
 * service's in-memory PubSub map before we return — so delivery.ts can
 * immediately subscribe without a cache miss.
 *
 * Thread title is set to a human-readable label for the settings sidebar.
 */
export const lookupOrCreate = (
  msg: ChannelMessage,
): Effect.Effect<string, never, ChannelSessionStore | ChatService | Clock> =>
  Effect.gen(function* () {
    const store = yield* ChannelSessionStore
    const chat = yield* ChatService
    const clock = yield* Clock
    const threadingKey = normalizeThreadingKey(msg)

    const existing = yield* store.lookup(msg.transport, msg.channelId, threadingKey)
    if (existing !== null) return existing

    // Create a new Luna thread for this channel session.
    // Title is intentionally short and human-readable (sidebar label).
    const title = `[${msg.transport}] ${msg.channelId}`
    const includeUserIdentity = shouldStoreThreadUserIdentity(msg)
    const summary = yield* chat
      .createThread({
        title,
        tags: ["channel", msg.transport],
        // Eric's call (2026-08-04): channel-originated threads (Discord et
        // al) previously omitted model/effort entirely, so they rode the
        // "daily-driver" broker lane (claude-sonnet-5, resolver.ts) instead
        // of whatever the operator actually wants for chat. Pin explicitly
        // rather than relying on that lane, which is a dead role-binding
        // (see packages/adapter-sdk/src/adapter.ts:84 — evaluated once at
        // import time against a null store, never reads provider_settings).
        model: "claude-opus-5",
        effort: "high",
        channelMeta: {
          interface: msg.transport === "telegram" ? "Telegram" : msg.transport,
          chatId: String(msg.channelId),
          ...(includeUserIdentity && msg.metadata?.userId != null
            ? { userId: String(msg.metadata.userId) }
            : {}),
          ...(includeUserIdentity && msg.metadata?.username != null
            ? { username: String(msg.metadata.username) }
            : {}),
          ...(includeUserIdentity && msg.metadata?.firstName != null
            ? { firstName: String(msg.metadata.firstName) }
            : {}),
        },
      })
      .pipe(Effect.orDie)

    const nowMs = yield* clock.nowMs()
    yield* store.insert(
      msg.transport,
      msg.channelId,
      threadingKey,
      summary.id,
      nowMs,
    )
    return summary.id
  })
