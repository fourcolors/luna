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
 * Continuation chunks (chunkIndex > 0, long final answers) are fresh
 * messages. "Message is not modified" errors (Telegram error 400 /
 * "Bad Request") are silently ignored — content-identical edits are benign.
 *
 * ## Formatting
 *
 * All outbound content is Luna markdown, converted to Telegram HTML by
 * telegram-format.ts (parse_mode: "HTML", link previews disabled). When
 * Telegram rejects the HTML ("can't parse entities") the send retries once
 * as plain text. Group replies thread onto the triggering message via
 * reply_parameters; DMs do not.
 *
 * ## Loading indication
 *
 * Each accepted inbound message starts a "typing…" chat-action refresh loop
 * (4 s cadence — Telegram clears the action after ≤5 s) that the first
 * deliver() for that chat interrupts. Step-indicator edits take over from
 * there (see delivery.ts).
 *
 * ## Commands
 *
 * start() registers the built-in channel commands (commands.ts) via
 * setMyCommands (best-effort) and resolves the bot's username via getMe so
 * group-addressed "/verb@BotName" commands are normalized — ours stripped,
 * other bots' dropped (see normalizeCommandMention).
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
 * The token must be supplied as a `Redacted<string>` via `config.token`, or the
 * adapter will read `TELEGRAM_BOT_TOKEN` from the environment (via EnvSecretProvider
 * convention) and wrap it in `Redacted.make()` at start() time. The plain-text
 * value is only unwrapped with `Redacted.value(token)` at the single URL-building
 * call site inside `makeRealTransport`, so it never appears in logs or traces.
 *
 * ## Reconnection
 *
 * The poll loop is wrapped in `Effect.retry(Schedule.exponential(...))` capped
 * at 30 s, so transient errors (network blips, Telegram 429/503) cause a brief
 * back-off rather than killing the adapter.
 */
import { Effect, Fiber, Redacted, Ref, Schedule } from "effect"
import type { ChannelAdapter, ChannelMessage, DeliverOptions, DeliveryTarget } from "../types.js"
import { markdownToTelegramHtml, toPlainTextFallback } from "./telegram-format.js"
import { channelCommands } from "../commands.js"

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

/* -------------------------------------------------------------------------- */
/* Typing indicator                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Telegram shows the "typing…" chat action for ≤5 s and clears it as soon as
 * the bot sends a message, so the loop re-sends every 4 s until the first
 * deliver() for the chat interrupts it (or the safety cap expires — a turn
 * that produces neither a delta nor a tool step within 2 minutes has bigger
 * problems than a stale indicator).
 */
const TYPING_REFRESH_MS = 4000
const TYPING_MAX_REFRESHES = 30

/* -------------------------------------------------------------------------- */
/* Command-mention normalization                                               */
/* -------------------------------------------------------------------------- */

/**
 * Telegram group members address commands as "/verb@BotName". Normalize the
 * leading token against OUR bot username (from getMe):
 *
 *   "/new@LunaBot …"  (ours)     → "/new …"        (mention stripped)
 *   "/new@OtherBot …" (not ours) → null            (drop: addressed elsewhere)
 *   "/new …"          (bare)     → unchanged
 *   username unknown (getMe failed) → unchanged    (degraded: bare verbs only)
 *
 * Non-command text always passes through unchanged.
 */
export const normalizeCommandMention = (
  text: string,
  botUsername: string | null,
): string | null => {
  if (!text.startsWith("/")) return text
  const wsIndex = text.search(/\s/)
  const token = wsIndex === -1 ? text : text.slice(0, wsIndex)
  const rest = wsIndex === -1 ? "" : text.slice(wsIndex)
  const atIndex = token.indexOf("@")
  if (atIndex === -1) return text
  if (botUsername === null) return text
  const mention = token.slice(atIndex + 1)
  if (mention.toLowerCase() !== botUsername.toLowerCase()) return null
  return `${token.slice(0, atIndex)}${rest}`
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
 *
 * Accepts a `Redacted<string>` — the plain-text value is unwrapped ONLY at
 * URL construction time via `Redacted.value(token)`. It is never stored as a
 * plain string after this point, so it cannot leak through logs or traces.
 */
export const makeRealTransport = (token: Redacted.Redacted<string>): TelegramHttpTransport =>
  (method, params) =>
    Effect.tryPromise({
      // Declaring the `signal` parameter makes Effect wire an AbortController
      // that fires on fiber interruption. Without it, interrupting a fiber
      // suspended in this fetch (e.g. delivery.ts cancelling a throttled
      // edit) would abandon the promise but leave the HTTP request running —
      // a stale editMessageText could then land AFTER the final edit and
      // permanently overwrite the finished message.
      try: async (signal) => {
        const url = `https://api.telegram.org/bot${Redacted.value(token)}/${method}`
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal,
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
   * Pre-resolved bot token as a Redacted value. When provided the adapter uses
   * this directly and never reads process.env. Callers should resolve the token
   * via SecretProvider (e.g. EnvSecretProvider with ref "env:TELEGRAM_BOT_TOKEN")
   * before constructing the adapter so the token is never a bare string in
   * application code. When omitted, start() reads TELEGRAM_BOT_TOKEN from the
   * environment and wraps it in Redacted.make() — this is the production fallback.
   */
  readonly token?: Redacted.Redacted<string>
  /**
   * Override the HTTP transport for testing. When omitted the adapter constructs
   * the real fetch transport using the resolved token (from config.token or env).
   * Injecting a fake transport takes priority over both config.token and env.
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
 * @param config - Adapter identity + token + optional HTTP transport override.
 *
 * Usage (production — preferred, token pre-resolved via SecretProvider):
 *   const token = yield* secretProvider.get("env:TELEGRAM_BOT_TOKEN")
 *   const adapter = makeTelegramAdapter({ id: "telegram-main", token })
 *
 * Usage (production — fallback, token read from env inside start()):
 *   const adapter = makeTelegramAdapter({ id: "telegram-main" })
 *   // process.env.TELEGRAM_BOT_TOKEN must be set when start() is called.
 *
 * Usage (tests — inject fake transport, no env var needed):
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

  // Our bot's username from getMe, for "/verb@BotName" mention filtering in
  // groups. null until start() resolves it (or when getMe fails — degraded
  // mode: only bare "/verb" commands are recognized).
  let botUsername: string | null = null

  // Loading indication: chat_id → the "typing…" refresh fiber. Started when
  // an inbound message is accepted, interrupted by the first deliver() to
  // that chat (Telegram clears the indicator on send anyway) or by stop().
  const typingFibers = new Map<string, Fiber.RuntimeFiber<void, unknown>>()

  // Set by stop(). The poll loop is interrupted by the service scope closing
  // around the same time stop() runs as a finalizer, with no ordering
  // guarantee — a last buffered update could call startTyping() AFTER the
  // sweep and leak a refresh fiber for up to ~2 minutes. Terminal flag
  // closes that window (all three touch points are synchronous JS).
  let typingSwept = false

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
        userId: msg.from?.id,
        username: msg.from?.username,
        firstName: msg.from?.first_name,
      },
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Typing indicator                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Begin the "typing…" refresh loop for a chat (idempotent per chat). Runs
   * as an independent runFork root — pollOnce's fiber completes every poll
   * cycle, so a child fiber would be auto-interrupted immediately.
   */
  const startTyping = (transport: TelegramHttpTransport, chatId: string): void => {
    if (typingSwept) return
    if (typingFibers.has(chatId)) return
    const loop = Effect.gen(function* () {
      for (let i = 0; i < TYPING_MAX_REFRESHES; i++) {
        yield* transport("sendChatAction", { chat_id: chatId, action: "typing" })
        yield* Effect.sleep(`${TYPING_REFRESH_MS} millis`)
      }
    })
    const fiber = Effect.runFork(loop)
    typingFibers.set(chatId, fiber)
    fiber.addObserver(() => {
      if (typingFibers.get(chatId) === fiber) typingFibers.delete(chatId)
    })
  }

  /** Stop the typing loop for a chat (first reply supersedes it). */
  const stopTyping = (chatId: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const fiber = typingFibers.get(chatId)
      if (fiber === undefined) return Effect.void
      typingFibers.delete(chatId)
      return Fiber.interrupt(fiber).pipe(Effect.asVoid)
    })

  /* ------------------------------------------------------------------------ */
  /* Formatted send/edit (markdown → Telegram HTML, plain-text fallback)      */
  /* ------------------------------------------------------------------------ */

  /**
   * Send or edit with Telegram HTML formatting. `content` is Luna markdown;
   * it is converted via markdownToTelegramHtml. If Telegram rejects the HTML
   * (400 "Bad Request: can't parse entities: …"), the same call is retried
   * once as plain text — a readable message always beats a lost one. Link
   * previews are disabled: agent replies cite URLs constantly and preview
   * cards would dwarf the text.
   */
  const sendFormatted = (
    transport: TelegramHttpTransport,
    method: "sendMessage" | "editMessageText",
    params: Record<string, unknown>,
    content: string,
  ): Effect.Effect<TelegramApiResult> =>
    Effect.gen(function* () {
      const text = content.length > 0 ? content : "…"
      const result = yield* transport(method, {
        ...params,
        text: markdownToTelegramHtml(text),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      })
      if (!result.ok && (result.description ?? "").includes("can't parse entities")) {
        // Plain-text retry keeps the preview suppression — only parse_mode
        // and the HTML conversion are dropped.
        return yield* transport(method, {
          ...params,
          text: toPlainTextFallback(text),
          link_preview_options: { is_disabled: true },
        })
      }
      return result
    })

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

          // Group command addressing: strip our own "@BotName" mention from
          // "/verb@BotName"; drop commands addressed to a DIFFERENT bot.
          const normalizedText = normalizeCommandMention(channelMsg.text, botUsername)
          if (normalizedText === null) continue
          const msg =
            normalizedText === channelMsg.text
              ? channelMsg
              : { ...channelMsg, text: normalizedText }

          // Loading indication: show "typing…" until the first reply (the
          // placeholder or a step-indicator edit) lands for this chat.
          startTyping(transport, msg.channelId)

          if (messageHandler !== null) {
            // Fire-and-forget: the installed handler is a pure Effect<void>
            // closure over all service dependencies. Effect.runFork is the
            // production path documented in the ChannelAdapter contract.
            Effect.runFork(messageHandler(msg))
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
        // Priority: injected httpTransport (tests) > config.token (production)
        // > env var fallback (production legacy).
        if (config.httpTransport !== undefined) {
          resolvedTransport = config.httpTransport
        } else if (resolvedTransport === null) {
          // Prefer the pre-resolved Redacted token from config; fall back to env.
          const redactedToken: Redacted.Redacted<string> | null =
            config.token !== undefined
              ? config.token
              : (() => {
                  const raw = process.env["TELEGRAM_BOT_TOKEN"]
                  if (!raw || raw.trim().length === 0) return null
                  return Redacted.make(raw)
                })()

          if (redactedToken === null) {
            return yield* Effect.die(
              new Error(
                "TelegramAdapter: bot token is not set. " +
                "Provide config.token (Redacted<string> via SecretProvider) or " +
                "set the TELEGRAM_BOT_TOKEN environment variable.",
              ),
            )
          }
          // Redacted.value() is the ONLY site that unwraps the token — inside
          // makeRealTransport at URL construction time.
          resolvedTransport = makeRealTransport(redactedToken)
        }

        const transport = resolvedTransport

        // Best-effort identity: our username enables "/verb@BotName" mention
        // filtering in groups. Failure degrades to bare-verb commands only.
        // The transport's error channel is `never` (the real transport folds
        // failures into { ok: false }), but a defect — or an injected
        // transport that dies — must still not take down start(): catch the
        // full cause so polling always begins.
        const me = yield* transport("getMe", {}).pipe(
          Effect.catchAllCause(() =>
            Effect.succeed<TelegramApiResult>({ ok: false, description: "getMe failed" }),
          ),
        )
        if (me.ok && me.result !== null && me.result !== undefined) {
          const user = me.result as TelegramUser
          botUsername = typeof user.username === "string" ? user.username : null
        }

        // Best-effort command menu: registers the built-in channel commands
        // so Telegram clients autocomplete them. A failure here must never
        // block message handling (same defect-proofing as getMe above).
        yield* transport("setMyCommands", {
          commands: channelCommands.map((c) => ({
            command: c.id,
            description: c.description,
          })),
        }).pipe(Effect.catchAllCause(() => Effect.void))

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
      // start() runs the poll loop directly and is forked by service.ts, so
      // fiber interruption (via the service scope finalizer) handles the
      // poll loop. Typing-refresh fibers are independent runFork roots and
      // need an explicit sweep here.
      return Effect.suspend(() => {
        typingSwept = true
        const fibers = Array.from(typingFibers.values())
        typingFibers.clear()
        return Fiber.interruptAll(fibers).pipe(Effect.asVoid)
      })
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

        // Anything we send supersedes the "typing…" loading indication.
        yield* stopTyping(chatId)

        // The inbound message's update_id is the turn key for stream-edit state.
        const turnKey = target.inReplyTo.platformMessageId

        // Capture the edit-routing entry, then drop it UP-FRONT on final
        // deliveries: the turn is over whether or not the send below
        // succeeds, and cleanup placed after a yield* would be skipped by a
        // transport defect (delivery.ts swallows failures), leaking the
        // entry forever (update_ids are never reused).
        const existingMsgId = sentMessageIds.get(turnKey)
        if (opts.isFinal) {
          sentMessageIds.delete(turnKey)
        }

        // In group chats, thread the reply onto the triggering message so
        // the conversation stays legible amid other traffic. DMs stay clean
        // (no quote header). Only the FIRST message of a turn replies;
        // continuation chunks would re-ping the user for nothing.
        const chatType = target.address["chatType"]
        const inboundMessageId = target.address["messageId"]
        const replyParams =
          typeof chatType === "string" &&
          chatType !== "private" &&
          typeof inboundMessageId === "number"
            ? { reply_parameters: { message_id: inboundMessageId } }
            : {}

        // Continuation chunks of a long final answer (chunkIndex > 0) are
        // always their own fresh messages — never edits of the placeholder.
        if (opts.chunkIndex > 0) {
          yield* sendFormatted(transport, "sendMessage", { chat_id: chatId }, content)
          return
        }

        if (existingMsgId === undefined) {
          // First send of the turn (placeholder, a status-first turn, a
          // command reply, or a recovery after an earlier failed send).
          const result = yield* sendFormatted(
            transport,
            "sendMessage",
            { chat_id: chatId, ...replyParams },
            content,
          )
          // Record the message id for follow-up edits — pointless when this
          // delivery already ended the turn (the entry was dropped above).
          if (!opts.isFinal && result.ok && result.result !== null && result.result !== undefined) {
            const sent = result.result as TelegramMessage
            sentMessageIds.set(turnKey, sent.message_id)
          }
        } else {
          // Edit the existing message in place (stream-edit progress or the
          // finalization pass). Telegram 400 "message is not modified" is
          // silently ignored; delivery.ts wraps deliver in catchAllCause.
          yield* sendFormatted(
            transport,
            "editMessageText",
            { chat_id: chatId, message_id: existingMsgId },
            content,
          )
        }
      })
    },
  }

  return adapter
}
