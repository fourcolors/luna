/**
 * Discord ChannelAdapter.
 *
 * Written fresh against the current `ChannelAdapter` contract, using
 * `telegram.ts` as the structural template and the May-2026 `GatewayAdapter`
 * Discord adapter as a parts bin (intents/partials, 429 parsing, allowlist
 * semantics). The donor's streaming/chunking/step-rendering half (~520 LOC)
 * is deliberately NOT ported: `delivery.ts` owns placeholder creation,
 * throttled edits and chunk splitting now, so re-porting it would be dead
 * code fighting the delivery layer for the same job.
 *
 * SECURITY, read before changing anything in here
 * ------------------------------------------------
 * The bot behind this adapter reaches an agent with an unrestricted local
 * shell. The inbound allowlist is therefore the entire authentication story,
 * and it is deliberately FAIL-CLOSED in three distinct ways:
 *
 *   1. `makeDiscordAdapter` THROWS when `allowedUsers` is empty. There is no
 *      "unconfigured is open" default. `telegram.ts` fails OPEN on an empty
 *      list on purpose ("never brick an install"); that trade is wrong here
 *      and is not copied.
 *   2. The gate is AND, not OR: a message is accepted iff the AUTHOR is
 *      allowed AND the CHANNEL is allowed. `telegram.ts` uses a sender-OR-chat
 *      union, under which allowlisting a channel authorizes every member of
 *      it. That is not acceptable in front of a shell.
 *   3. The check runs in the inbound handler, before dispatch, before any
 *      command parsing and before any session is created. Checking later (in
 *      `service.ts` or `chat-service`) is too late: slash commands execute at
 *      the channels layer, so a stranger could `/stop` a live turn.
 *
 * Discord sender ids are server-asserted and not spoofable, so a sender-id
 * gate is sound. Keep the `authorBot` filter, and keep the application set to
 * non-public in the developer portal so nobody else can invite the bot.
 *
 * v1 is TEXT-ONLY. Inbound attachments are ignored (the donor never
 * downloaded them either); `telegram.ts`'s download/sniff pipeline is the
 * template when that lands.
 */
import { Duration, Effect, Either, Redacted } from "effect"
import { Client, Events, GatewayIntentBits, Partials } from "discord.js"
import type {
  ChannelAdapter,
  ChannelMessage,
  DeliverOptions,
  DeliveryTarget,
} from "../types.js"

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/** Discord's hard per-message limit. delivery.ts splits to this before deliver(). */
const DISCORD_MAX_MESSAGE_LENGTH = 2000

/** Attempts for a rate-limited (429) REST call before giving up. */
const MAX_RATE_LIMIT_ATTEMPTS = 3

/** Ceiling on an honoured retry-after, so a hostile value can't park a fiber. */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Edit failures that are expected and MUST stay silent:
 *  - "not modified" — we re-sent identical content (delivery.ts may finalize
 *    with the same text it last streamed).
 *  - "Unknown Message" — the user deleted the placeholder mid-turn.
 */
const BENIGN_EDIT_ERRORS = ["not modified", "unknown message"] as const

/* -------------------------------------------------------------------------- */
/* 429 parsing (harvested from the May-2026 donor)                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse a Discord 429 retry-after (seconds, possibly fractional) into ms.
 * Returns null when this is not a rate-limit error.
 */
export const parseDiscord429RetryMs = (err: unknown): number | null => {
  if (err === null || typeof err !== "object") return null
  const e = err as {
    code?: unknown
    retry_after?: unknown
    retryAfter?: unknown
    status?: unknown
    httpStatus?: unknown
  }
  const isRateLimit = e.code === 429 || e.status === 429 || e.httpStatus === 429
  if (!isRateLimit) return null
  const raw = e.retry_after ?? e.retryAfter
  const seconds =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && !Number.isNaN(Number(raw))
        ? Number(raw)
        : null
  if (seconds === null || seconds < 0) return null
  return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS)
}

const isBenignEditError = (err: unknown): boolean => {
  const msg =
    err !== null && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err)
  const lowered = msg.toLowerCase()
  return BENIGN_EDIT_ERRORS.some((s) => lowered.includes(s))
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Translate the internal ">! " expandable-blockquote convention that
 * `delivery.ts` emits for collapsed step summaries. Telegram renders it as
 * `<blockquote expandable>`; Discord has no equivalent, and untranslated the
 * literal ">! " leaks into the rendered message. Degrade to a plain
 * blockquote, which Discord does support.
 */
export const stripExpandableQuoteMarker = (content: string): string =>
  content.replace(/^>!\s?/gm, "> ")

/* -------------------------------------------------------------------------- */
/* Transport seam (testability)                                                */
/* -------------------------------------------------------------------------- */

/**
 * A Discord message, normalized to what this adapter actually needs.
 * Decoupling from discord.js's `Message` is what makes the allowlist
 * testable without a live gateway connection.
 */
export interface InboundDiscordMessage {
  /** Message snowflake. Stable across gateway resume redelivery → dedup key. */
  readonly id: string
  readonly channelId: string
  readonly authorId: string
  readonly authorBot: boolean
  readonly system: boolean
  readonly content: string
  // `| undefined` is explicit because the package compiles with
  // exactOptionalPropertyTypes: true, under which `?:` alone rejects an
  // explicitly-undefined value.
  readonly guildId?: string | undefined
  readonly isThread: boolean
  /** Parent channel id when `isThread` — a thread inherits its parent's grant. */
  readonly parentId?: string | undefined
  readonly isDM: boolean
  /** ISO-8601. */
  readonly createdAt: string
}

/**
 * The minimal Discord surface the adapter uses. The real implementation wraps
 * discord.js; tests inject a fake that emits messages synchronously.
 *
 * discord.js's `Client` has no injection seam of its own, which is why this
 * interface exists — without it the allowlist could not be honestly tested.
 */
export interface DiscordTransport {
  readonly onMessage: (cb: (m: InboundDiscordMessage) => void) => void
  readonly onReady: (cb: (botTag: string) => void) => void
  readonly onError: (cb: (e: Error) => void) => void
  readonly login: () => Promise<void>
  readonly destroy: () => Promise<void>
  /** Post a new message. Resolves with the created message's snowflake. */
  readonly send: (channelId: string, content: string) => Promise<{ id: string }>
  /** Edit an existing message in place. */
  readonly edit: (channelId: string, messageId: string, content: string) => Promise<void>
}

/**
 * Real transport, wrapping discord.js.
 *
 * `Redacted.value()` is unwrapped at exactly one site (the `login` call), so
 * the token never reaches a log line, a trace, or an error message.
 */
export const makeRealDiscordTransport = (
  token: Redacted.Redacted<string>,
): DiscordTransport => {
  const client = new Client({
    // Matches the intents the Sol gateway has run in production. Note there is
    // deliberately NO GuildMembers: it is privileged, needs portal enablement,
    // and nothing here reads the member list.
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
    // Without these, DMs and uncached messages arrive as empty partials.
    partials: [Partials.Channel, Partials.Message],
  })

  return {
    onMessage: (cb) => {
      client.on(Events.MessageCreate, (m) => {
        try {
          const channel = m.channel
          const isThread = typeof channel.isThread === "function" && channel.isThread()
          cb({
            id: m.id,
            channelId: m.channelId,
            authorId: m.author.id,
            authorBot: m.author.bot,
            system: m.system ?? false,
            content: m.content ?? "",
            guildId: m.guild?.id,
            isThread,
            parentId: isThread ? ((channel as { parentId?: string }).parentId ?? undefined) : undefined,
            isDM: typeof channel.isDMBased === "function" && channel.isDMBased(),
            createdAt: new Date(m.createdTimestamp).toISOString(),
          })
        } catch (err) {
          console.error("[discord-adapter] inbound normalization failed:", err)
        }
      })
    },
    onReady: (cb) => {
      client.on(Events.ClientReady, (c) => cb(c.user.tag))
    },
    onError: (cb) => {
      client.on(Events.Error, (e) => cb(e as Error))
    },
    login: async () => {
      // The ONLY unwrap of the token.
      await client.login(Redacted.value(token))
    },
    destroy: async () => {
      await client.destroy()
    },
    send: async (channelId, content) => {
      const channel = await client.channels.fetch(channelId)
      if (channel === null || !("send" in channel) || typeof channel.send !== "function") {
        throw new Error(`channel ${channelId} is not sendable`)
      }
      const sent = await (channel as { send: (c: string) => Promise<{ id: string }> }).send(content)
      return { id: sent.id }
    },
    edit: async (channelId, messageId, content) => {
      const channel = await client.channels.fetch(channelId)
      if (channel === null || !("messages" in channel)) {
        throw new Error(`channel ${channelId} has no message store`)
      }
      const msgs = (channel as { messages: { fetch: (id: string) => Promise<{ edit: (c: string) => Promise<unknown> }> } }).messages
      const target = await msgs.fetch(messageId)
      await target.edit(content)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Config                                                                      */
/* -------------------------------------------------------------------------- */

export interface DiscordAdapterConfig {
  /** Unique adapter instance id (e.g. "discord-main"). */
  readonly id: string
  /**
   * Bot token, pre-resolved through the SecretProvider chain and passed as a
   * Redacted so it cannot be logged. Required unless `transport` is injected.
   */
  readonly token?: Redacted.Redacted<string>
  /**
   * Discord user ids permitted to talk to this bot. REQUIRED and must be
   * non-empty — the factory throws otherwise. See the security note at the
   * top of this file for why there is no fail-open default.
   */
  readonly allowedUsers: Iterable<string>
  /**
   * Channel ids the bot will respond in. Empty means "any channel the bot can
   * see", which is still gated by `allowedUsers` (AND semantics). A thread
   * whose parent id is listed is allowed.
   */
  readonly allowedChannels?: Iterable<string>
  /** Inject a fake transport for tests. Takes priority over `token`. */
  readonly transport?: DiscordTransport
  /** Log "logged in as ..." on ready. Default true. */
  readonly logLogin?: boolean
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create a Discord ChannelAdapter.
 *
 * THROWS synchronously when `allowedUsers` is empty. That is intentional: a
 * misconfigured deploy must fail loudly at construction rather than silently
 * booting an open bot in front of a shell.
 *
 * Usage (production):
 *   const token = yield* secretProvider.get("env:DISCORD_BOT_TOKEN")
 *   const adapter = makeDiscordAdapter({
 *     id: "discord-main",
 *     token,
 *     allowedUsers: ["000000000000000000"],
 *   })
 *
 * Usage (tests):
 *   const adapter = makeDiscordAdapter({
 *     id: "d-test",
 *     transport: fakeTransport,
 *     allowedUsers: ["u1"],
 *   })
 */
export const makeDiscordAdapter = (config: DiscordAdapterConfig): ChannelAdapter => {
  const allowedUsers: ReadonlySet<string> = new Set(config.allowedUsers)
  const allowedChannels: ReadonlySet<string> = new Set(config.allowedChannels ?? [])
  const logLogin = config.logLogin ?? true

  // FAIL-CLOSED GATE #1 — construction. Not a warning, not a default: a throw.
  if (allowedUsers.size === 0) {
    throw new Error(
      "DiscordAdapter: allowedUsers is empty. This bot fronts an agent with " +
        "an unrestricted local shell, so an open inbound gate is refused at " +
        "construction. Set LUNA_DISCORD_ALLOWED_USER_IDS to a comma-separated " +
        "list of Discord user ids.",
    )
  }

  let messageHandler: ((msg: ChannelMessage) => Effect.Effect<void>) | null = null
  let transport: DiscordTransport | null = config.transport ?? null
  let started = false

  /** Turn key → the message id we are stream-editing for that turn. */
  const sentMessageIds = new Map<string, string>()

  /** Log the first drop per (channel:user) so a spammer cannot flood the log. */
  const loggedDrops = new Set<string>()

  /* ---------------------------------------------------------------------- */
  /* The gate                                                                */
  /* ---------------------------------------------------------------------- */

  const isAllowedChannel = (m: InboundDiscordMessage): boolean => {
    if (allowedChannels.size === 0) return true
    if (allowedChannels.has(m.channelId)) return true
    // A thread inherits its parent channel's grant.
    if (m.isThread && m.parentId !== undefined) return allowedChannels.has(m.parentId)
    return false
  }

  /**
   * FAIL-CLOSED GATE #2 — AND semantics.
   *
   * Author allowed AND channel allowed. Deliberately NOT the sender-OR-chat
   * union `telegram.ts` uses: under OR, listing a channel would authorize
   * every member of that channel.
   */
  const isInboundAllowed = (m: InboundDiscordMessage): boolean =>
    allowedUsers.has(m.authorId) && isAllowedChannel(m)

  const noteDrop = (m: InboundDiscordMessage): void => {
    const key = `${m.channelId}:${m.authorId}`
    if (loggedDrops.has(key)) return
    loggedDrops.add(key)
    console.warn(
      `[discord-adapter] dropped inbound from user=${m.authorId} ` +
        `channel=${m.channelId} — not on the allowlist (logged once per pair)`,
    )
  }

  const toChannelMessage = (m: InboundDiscordMessage): ChannelMessage => ({
    transport: "discord",
    channelId: m.channelId,
    senderId: m.authorId,
    // In Discord a thread has its own snowflake, so channelId already
    // separates threads from their parent. DMs are likewise unique per peer.
    threadingKey: m.channelId,
    text: m.content,
    platformMessageId: m.id,
    ts: m.createdAt,
    metadata: {
      guildId: m.guildId,
      isThread: m.isThread,
      parentId: m.parentId,
      isDM: m.isDM,
      messageId: m.id,
    },
  })

  /* ---------------------------------------------------------------------- */
  /* Inbound                                                                 */
  /* ---------------------------------------------------------------------- */

  const handleInbound = (m: InboundDiscordMessage): void => {
    try {
      // Never react to ourselves or to other bots — the fastest loop there is.
      if (m.authorBot || m.system) return
      // GATE: before dispatch, before commands, before any session exists.
      if (!isInboundAllowed(m)) {
        noteDrop(m)
        return
      }
      const handler = messageHandler
      if (handler === null) return
      Effect.runFork(handler(toChannelMessage(m)))
    } catch (err) {
      console.error("[discord-adapter] inbound handler error:", err)
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Outbound helpers                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Run a Discord REST op, honouring 429 retry-after. Returns null when the
   * op ultimately failed; delivery.ts treats deliver() as best-effort and
   * swallows failures, so returning null keeps the turn alive.
   */
  const withRateLimitRetry = <A>(
    op: () => Promise<A>,
    label: string,
    benignOk: boolean,
  ): Effect.Effect<A | null> =>
    Effect.gen(function* () {
      for (let attempt = 1; attempt <= MAX_RATE_LIMIT_ATTEMPTS; attempt++) {
        const outcome = yield* Effect.either(
          Effect.tryPromise({ try: op, catch: (e) => e as unknown }),
        )
        if (Either.isRight(outcome)) return outcome.right
        const err = outcome.left
        if (benignOk && isBenignEditError(err)) return null
        const retryMs = parseDiscord429RetryMs(err)
        if (retryMs === null) {
          console.error(`[discord-adapter] ${label} failed:`, err)
          return null
        }
        if (attempt === MAX_RATE_LIMIT_ATTEMPTS) {
          console.error(`[discord-adapter] ${label} rate-limited, attempts exhausted`)
          return null
        }
        yield* Effect.sleep(Duration.millis(retryMs))
      }
      return null
    })

  /* ---------------------------------------------------------------------- */
  /* ChannelAdapter                                                          */
  /* ---------------------------------------------------------------------- */

  const adapter: ChannelAdapter = {
    id: config.id,
    transport: "discord",
    capability: "stream-edit",
    maxMessageLength: DISCORD_MAX_MESSAGE_LENGTH,

    setMessageHandler(handler) {
      messageHandler = handler
    },

    start() {
      return Effect.gen(function* () {
        if (transport === null) {
          if (config.token === undefined) {
            return yield* Effect.die(
              new Error(
                "DiscordAdapter: bot token is not set. Provide config.token " +
                  "(Redacted<string> via SecretProvider) or inject config.transport.",
              ),
            )
          }
          transport = makeRealDiscordTransport(config.token)
        }
        const t = transport

        if (!started) {
          started = true
          t.onMessage(handleInbound)
          t.onError((e) => {
            console.error("[discord-adapter] client error:", e.message)
          })
          t.onReady((tag) => {
            if (logLogin) {
              console.log(`[discord-adapter] logged in as ${tag}`)
              console.log(
                `[discord-adapter] allowlist: ${allowedUsers.size} user(s), ` +
                  `${allowedChannels.size === 0 ? "any" : String(allowedChannels.size)} channel(s)`,
              )
            }
          })
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(() => t.destroy().catch(() => undefined)),
        )

        yield* Effect.tryPromise({ try: () => t.login(), catch: (e) => e as unknown }).pipe(
          Effect.catchAll((e) => {
            console.error("[discord-adapter] login failed:", e)
            return Effect.void
          }),
        )

        // Park forever: the gateway is event-driven, so start() must not
        // return or service.ts would treat the adapter as finished. The fiber
        // is interrupted when the service scope closes.
        yield* Effect.never
      }) as Effect.Effect<void, never, import("effect").Scope.Scope>
    },

    stop() {
      return Effect.suspend(() => {
        const t = transport
        if (t === null) return Effect.void
        started = false
        sentMessageIds.clear()
        return Effect.promise(() => t.destroy().catch(() => undefined))
      })
    },

    deliver(target: DeliveryTarget, content: string, opts: DeliverOptions): Effect.Effect<void> {
      return Effect.gen(function* () {
        const t = transport
        if (t === null) return

        // Belt-and-braces transport check. service.ts already filters by
        // transport before forking a delivery fiber, but an adapter must never
        // rely on a caller for that: a Telegram snowflake posted to Discord
        // (or the reverse) fails silently on every single turn.
        if (target.inReplyTo.transport !== "discord") return

        const channelId = target.address["channelId"] as string | undefined
        if (channelId === undefined) return

        const text = stripExpandableQuoteMarker(content)
        if (text.length === 0) return

        // Standalone (background job) deliveries always post a fresh message
        // and never touch the live stream-edit map, so a concurrent live turn
        // in the same channel keeps editing its own placeholder.
        if (opts.standalone) {
          yield* withRateLimitRetry(() => t.send(channelId, text), "send(standalone)", false)
          return
        }

        const turnKey = target.inReplyTo.platformMessageId

        // Drop the edit-routing entry UP-FRONT on a final delivery: the turn
        // is over whether or not the call below succeeds, and cleanup placed
        // after a yield* would be skipped on a defect, leaking the entry.
        const existing = sentMessageIds.get(turnKey)
        if (opts.isFinal) sentMessageIds.delete(turnKey)

        // Continuation chunks of a long answer are always their own fresh
        // messages, never edits of the placeholder.
        if (opts.chunkIndex > 0) {
          yield* withRateLimitRetry(() => t.send(channelId, text), "send(chunk)", false)
          return
        }

        if (existing === undefined) {
          const sent = yield* withRateLimitRetry(
            () => t.send(channelId, text),
            "send",
            false,
          )
          // Record for follow-up edits — pointless if this already ended the turn.
          if (!opts.isFinal && sent !== null) {
            sentMessageIds.set(turnKey, sent.id)
          }
        } else {
          yield* withRateLimitRetry(
            () => t.edit(channelId, existing, text),
            "edit",
            true,
          )
        }
      })
    },
  }

  return adapter
}
