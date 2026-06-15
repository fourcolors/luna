/**
 * TelegramAdapter — Telegram Bot API adapter for @luna/channels.
 *
 * Implements ChannelAdapter with:
 *   transport:   "telegram"
 *   capability:  "stream-edit"   (sendMessage on first partial, editMessageText
 *                                 on subsequent partials/final)
 *   maxMessageLength: 4096       (Telegram hard limit)
 *
 * ## Inbound — long-poll (getUpdates)
 *
 * start() runs the getUpdates polling loop directly (it never returns normally;
 * it only terminates via fiber interruption). service.ts forks start() into the
 * service scope via `Effect.forkIn(adapter.start(), serviceScope)`, so the poll
 * loop fiber is supervised by the service scope and tears down on service shutdown.
 *
 * This pattern (start() blocks forever) is the correct design for an adapter
 * whose job is long-polling. Compared to forking inside start():
 *   - start() returning immediately would cause `Effect.scoped(start())` to close
 *     the scope before any messages are processed.
 *   - start() blocking until interrupted ensures the scope remains open for the
 *     adapter's full lifetime (which is the service's lifetime).
 *
 * stop() is a belt-and-braces sweep called by ChannelService after the scope
 * closes. Since start() is forked by service.ts and that fork is supervised by
 * the service scope, the scope finalizer handles primary interruption.
 *
 * Threading policy:
 *   Both DMs and group chats key threadingKey on chat.id.
 *   - DM (chat.type = "private"): chat.id == user.id → one thread per user.
 *   - Group (chat.type = "group" | "supergroup" | "channel"): chat.id is the
 *     group id → all participants share one Luna thread, which sees full group
 *     context.
 *   This means `channelId === threadingKey` for all Telegram chat types, and
 *   session-map.ts's `normalizeThreadingKey` fallback (channelId when absent)
 *   would produce the same result — but we set it explicitly for clarity.
 *
 * platformMessageId = String(update_id)  — monotonically increasing per bot,
 * globally unique across all chats for a given bot token. The foundation's
 * InboundDedupStore keys on (transport, platformMessageId) which is correct.
 *
 * ## Outbound — stream-edit
 *
 * delivery.ts calls deliver() with:
 *   (isPartial=true,  chunkIndex=0, isFinal=false) → first delta (placeholder "…")
 *   (isPartial=true,  chunkIndex=0, isFinal=false) → throttled delta edits
 *   (isPartial=false, chunkIndex=0, isFinal=true)  → final content
 *
 * The adapter tracks a `sentMessageId` keyed by `target.inReplyTo.platformMessageId`
 * (the inbound message's Telegram update_id). On the first partial it calls
 * sendMessage, captures the returned message_id, and edits from then on.
 * "Message is not modified" errors (Telegram error 400 / "Bad Request") are
 * silently ignored — content-identical edits are benign.
 *
 * ## HTTP transport injection
 *
 * The real Telegram API call path is isolated in `TelegramHttpTransport`:
 *   (method: string, params: Record<string, unknown>) => Effect.Effect<TelegramApiResult>
 *
 * Tests pass a fake transport that records calls and returns scripted responses
 * with no network. The production TelegramAdapter factory (`makeTelegramAdapter`)
 * accepts an optional `httpTransport` override; omitting it uses the real
 * fetch-based implementation wired against the bot token.
 *
 * ## Token
 *
 * The token is read from the environment variable `TELEGRAM_BOT_TOKEN` at
 * adapter start time (inside start(), not at construction). It is never logged.
 *
 * ## Reconnection
 *
 * The poll loop is wrapped in `Effect.retry(Schedule.exponential(...))` capped
 * at 30 s, so transient errors (network blips, Telegram 429/503) cause a brief
 * back-off rather than killing the adapter.
 */
import { Effect, Ref, Schedule } from "effect"
import type { ChannelAdapter, ChannelMessage, DeliverOptions, DeliveryTarget } from "../types.js"

/* -------------------------------------------------------------------------- */
/* Telegram Bot API types                                                      */
/* -------------------------------------------------------------------------- */

/** Minimal Telegram API response envelope. */
interface TelegramApiResult {
  readonly ok: boolean
  readonly result?: unknown
  readonly error_code?: number
  readonly description?: string
}

/** A Telegram message object (minimal fields we use). */
interface TelegramMessage {
  readonly message_id: number
  readonly chat: TelegramChat
  readonly from?: TelegramUser
  readonly text?: string
  readonly date: number
}

interface TelegramChat {
  readonly id: number
  readonly type: "private" | "group" | "supergroup" | "channel"
}

interface TelegramUser {
  readonly id: number
  readonly username?: string
  readonly first_name?: string
}

/** A single Telegram update from getUpdates. */
interface TelegramUpdate {
  readonly update_id: number
  readonly message?: TelegramMessage
}

/* -------------------------------------------------------------------------- */
/* HTTP transport abstraction (the testability seam)                          */
/* -------------------------------------------------------------------------- */

/**
 * The single abstraction that makes this adapter testable without a network.
 * Tests inject a fake; production uses `makeRealTransport(token)`.
 */
export type TelegramHttpTransport = (
  method: string,
  params: Record<string, unknown>,
) => Effect.Effect<TelegramApiResult>

/**
 * Build the real fetch-based transport for a given bot token.
 * The token is embedded once at construction — never re-read per call.
 */
export const makeRealTransport = (token: string): TelegramHttpTransport =>
  (method, params) =>
    Effect.tryPromise({
      try: async () => {
        const url = `https://api.telegram.org/bot${token}/${method}`
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        })
        return (await res.json()) as TelegramApiResult
      },
      catch: (e) => new Error(`Telegram fetch error: ${String(e)}`),
    }).pipe(
      // Surface HTTP-level errors as TelegramApiResult { ok: false } so the
      // adapter's error handling is uniform.
      Effect.catchAll((e) =>
        Effect.succeed<TelegramApiResult>({ ok: false, description: String(e) }),
      ),
    )

/* -------------------------------------------------------------------------- */
/* Adapter config                                                              */
/* -------------------------------------------------------------------------- */

export interface TelegramAdapterConfig {
  /** Unique id for this adapter instance (e.g. "telegram-main"). */
  readonly id: string
  /**
   * Override the HTTP transport for testing. When omitted the adapter reads
   * TELEGRAM_BOT_TOKEN from the environment inside start() and constructs
   * the real fetch transport.
   */
  readonly httpTransport?: TelegramHttpTransport
}

/* -------------------------------------------------------------------------- */
/* Poll parameters                                                             */
/* -------------------------------------------------------------------------- */

/** getUpdates long-poll timeout in seconds. Telegram max is 50; we use 20. */
const POLL_TIMEOUT_SECONDS = 20

/** Retry schedule for the poll loop: exponential from 1 s, capped at 30 s. */
const pollRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.union(Schedule.spaced("30 seconds")),
)

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create a TelegramAdapter.
 *
 * @param config - Adapter identity + optional HTTP transport override.
 *
 * Usage (production):
 *   const adapter = makeTelegramAdapter({ id: "telegram-main" })
 *   // TELEGRAM_BOT_TOKEN must be in process.env when start() is called.
 *
 * Usage (tests):
 *   const adapter = makeTelegramAdapter({ id: "tg-test", httpTransport: fakeTransport })
 */
export const makeTelegramAdapter = (config: TelegramAdapterConfig): ChannelAdapter => {
  // Mutable handler slot — installed by ChannelService before start().
  let messageHandler: ((msg: ChannelMessage) => Effect.Effect<void>) | null = null

  // Resolved transport: set at construction time when injected (tests), or in
  // start() when reading from the environment (production). Pre-setting from
  // config enables deliver() to work even before start() is called (useful in
  // isolated unit tests that call deliver() directly).
  let resolvedTransport: TelegramHttpTransport | null =
    config.httpTransport !== undefined ? config.httpTransport : null

  // stream-edit state: inbound platformMessageId → sent Telegram message_id.
  // One entry per active turn; cleaned up on isFinal.
  const sentMessageIds = new Map<string, number>()

  /* ------------------------------------------------------------------------ */
  /* Inbound message construction                                              */
  /* ------------------------------------------------------------------------ */

  const buildChannelMessage = (update: TelegramUpdate): ChannelMessage | null => {
    const msg = update.message
    if (msg === undefined) return null          // non-message update (callback, etc.)
    if (msg.text === undefined) return null     // not a text message (photo, sticker, etc.)
    if (msg.from === undefined) return null     // channels have no `from`; skip

    const chatId = String(msg.chat.id)

    return {
      transport: "telegram" as const,
      channelId: chatId,
      senderId: String(msg.from.id),
      // Threading policy: both DMs and groups key on chat.id.
      // - private chat: chat.id === from.id → one thread per user-bot pair.
      // - group/supergroup: chat.id is the group → all members share one thread.
      // Setting threadingKey explicitly (even though it equals channelId here)
      // documents the intent and is forward-compatible with sub-topic routing.
      threadingKey: chatId,
      text: msg.text,
      // update_id is monotonically increasing per bot, unique across all chats
      // for this bot token. The dedup store keys on (transport, platformMessageId).
      platformMessageId: String(update.update_id),
      ts: new Date(msg.date * 1000).toISOString(),
      metadata: {
        chatType: msg.chat.type,
        messageId: msg.message_id,
      },
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Poll loop                                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Build the forever-running getUpdates polling loop.
   *
   * Returns Effect<never, never> — it never returns normally and is only
   * stopped by fiber interruption. start() runs this directly (rather than
   * forking it) so that start() itself never returns normally; this is correct
   * because service.ts forks start() via Effect.forkIn(adapter.start(), scope).
   */
  const makePollLoop = (transport: TelegramHttpTransport): Effect.Effect<never, never> => {
    const offsetRef = Ref.unsafeMake<number>(0)

    // A single getUpdates call. Returns the new offset after consuming updates.
    // Error channel is `Error` (non-ok responses are surfaced as failures so
    // the retry schedule in `loop` can back off and try again).
    const pollOnce = (currentOffset: number): Effect.Effect<number, Error> =>
      Effect.gen(function* () {
        const result = yield* transport("getUpdates", {
          offset: currentOffset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowed_updates: ["message"],
        })

        if (!result.ok) {
          // Non-ok result: surface as an error so the retry schedule kicks in.
          const desc = result.description ?? "unknown error"
          return yield* Effect.fail(new Error(`getUpdates not ok: ${desc}`))
        }

        const updates = (result.result ?? []) as TelegramUpdate[]

        let nextOffset = currentOffset
        for (const update of updates) {
          // Advance offset past this update regardless of whether we handle it.
          if (update.update_id >= nextOffset) {
            nextOffset = update.update_id + 1
          }

          const channelMsg = buildChannelMessage(update)
          if (channelMsg === null) continue   // non-text or non-message update

          if (messageHandler !== null) {
            // Fire-and-forget: the installed handler is a pure Effect<void>
            // closure over all service dependencies. Effect.runFork is the
            // production path documented in the ChannelAdapter contract.
            Effect.runFork(messageHandler(channelMsg))
          }
        }

        return nextOffset
      })

    // Continuous poll: keeps calling pollOnce, advancing the offset.
    // Never returns normally; only stops on interruption.
    const loop: Effect.Effect<never, never> = Effect.gen(function* () {
      const offset = yield* Ref.get(offsetRef)
      const nextOffset = yield* pollOnce(offset).pipe(
        // Retry on any error with exponential backoff (1 s → 30 s).
        // After retry, the error channel is `never` for our scheduling purposes —
        // we cast via catchAllCause to satisfy the type system.
        Effect.retry(pollRetrySchedule),
        Effect.catchAllCause(() => Effect.succeed(offset)), // fallback: keep same offset
      )
      yield* Ref.set(offsetRef, nextOffset)
      return yield* loop
    }) as Effect.Effect<never, never>

    return loop
  }

  /* ------------------------------------------------------------------------ */
  /* ChannelAdapter implementation                                             */
  /* ------------------------------------------------------------------------ */

  const adapter: ChannelAdapter = {
    id: config.id,
    transport: "telegram",
    capability: "stream-edit",
    maxMessageLength: 4096,

    setMessageHandler(handler) {
      messageHandler = handler
    },

    start() {
      // start() runs the poll loop directly and never returns normally.
      // service.ts forks this via Effect.forkIn(adapter.start(), serviceScope),
      // so the blocking behavior is correct — the fiber stays alive until the
      // service scope closes (which interrupts the fiber).
      //
      // When called in unit tests as Effect.fork(Effect.scoped(adapter.start())),
      // the fork keeps the loop alive; the outer fiber (the test) interrupts it
      // via Fiber.interrupt(fiber) after assertions are collected.
      return Effect.gen(function* () {
        // Resolve the HTTP transport.
        if (config.httpTransport !== undefined) {
          resolvedTransport = config.httpTransport
        } else if (resolvedTransport === null) {
          const token = process.env["TELEGRAM_BOT_TOKEN"]
          if (!token || token.trim().length === 0) {
            return yield* Effect.die(
              new Error(
                "TelegramAdapter: TELEGRAM_BOT_TOKEN environment variable is not set. " +
                "Set it to your Telegram bot token (from @BotFather).",
              ),
            )
          }
          resolvedTransport = makeRealTransport(token)
        }

        const transport = resolvedTransport

        // Run the poll loop directly — this never returns normally.
        // The loop is uninterruptible at the inner level (only interrupted
        // from the outside when the service scope closes or stop() is called).
        yield* makePollLoop(transport)
      }) as Effect.Effect<void, never, import("effect").Scope.Scope>
      // The cast to include Scope.Scope satisfies the ChannelAdapter contract.
      // Our implementation doesn't actually USE Scope (no addFinalizer), but
      // the type signature is mandated by the interface. The service.ts caller
      // still forks start() into a scope, providing scope-based lifecycle
      // management for the fiber itself.
    },

    stop() {
      // start() runs the poll loop directly and is forked by service.ts.
      // stop() is a no-op here because the fiber interruption (via the service
      // scope finalizer) handles cleanup. stop() is kept as a belt-and-braces
      // hook for future use (e.g., Telegram deleteWebhook for webhook mode).
      return Effect.void
    },

    deliver(target: DeliveryTarget, content: string, opts: DeliverOptions): Effect.Effect<void> {
      return Effect.gen(function* () {
        const transport = resolvedTransport
        if (transport === null) {
          // start() has not been called yet (or failed). Skip silently.
          return
        }

        // Extract the chat_id from the delivery target.
        // service.ts builds target.address by spreading msg.metadata and including
        // channelId/senderId/transport. For Telegram, msg.channelId is the chat_id.
        const chatId = target.address["channelId"] as string | undefined
        if (chatId === undefined) return

        // The inbound message's update_id is the turn key for stream-edit state.
        const turnKey = target.inReplyTo.platformMessageId

        const isFirstPartial = opts.isPartial && opts.chunkIndex === 0 && !sentMessageIds.has(turnKey)

        if (isFirstPartial) {
          // First partial: send a new message.
          const result = yield* transport("sendMessage", {
            chat_id: chatId,
            text: content.length > 0 ? content : "…",
          })

          if (result.ok && result.result !== null && result.result !== undefined) {
            const sent = result.result as TelegramMessage
            sentMessageIds.set(turnKey, sent.message_id)
          }
        } else {
          const existingMsgId = sentMessageIds.get(turnKey)
          if (existingMsgId === undefined) {
            // Recovery: sendMessage failed earlier. Try again.
            const result = yield* transport("sendMessage", {
              chat_id: chatId,
              text: content.length > 0 ? content : "…",
            })
            if (result.ok && result.result !== null && result.result !== undefined) {
              const sent = result.result as TelegramMessage
              sentMessageIds.set(turnKey, sent.message_id)
            }
            return
          }

          // Edit the existing message.
          yield* transport("editMessageText", {
            chat_id: chatId,
            message_id: existingMsgId,
            text: content.length > 0 ? content : "…",
          })
          // Telegram 400 "message is not modified" is silently ignored.
          // delivery.ts wraps all deliver calls in catchAllCause anyway.
        }

        // Remove turn state after the final delivery.
        if (opts.isFinal) {
          sentMessageIds.delete(turnKey)
        }
      })
    },
  }

  return adapter
}
