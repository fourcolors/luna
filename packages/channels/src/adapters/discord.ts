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
import { Duration, Effect, Either, Fiber, Redacted } from "effect"
import { Client, Events, GatewayIntentBits, Partials, Routes } from "discord.js"
import type {
  ChannelAdapter,
  ChannelMessage,
  DeliverOptions,
  DeliveryTarget,
} from "../types.js"

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Message budget handed to delivery.ts for chunking: 1900 against Discord's
 * 2000 platform limit, so fence repair (+4 worst case on the single-chunk fast
 * path: "\n" + a 3-char closer) and any future marker can never cross the
 * platform limit. Fast path worst case 1900 + 4 = 1904 <= 2000; split-path
 * chunks are bounded by maxLen = 1900 <= 2000. Ported from Sol Agent
 * lib/discord/markdown.ts (MAX_LEN = 1900, "leave room for overhead").
 */
const DISCORD_MAX_MESSAGE_LENGTH = 1900

/** Attempts for a rate-limited (429) REST call before giving up. */
const MAX_RATE_LIMIT_ATTEMPTS = 3

/** Ceiling on an honoured retry-after, so a hostile value can't park a fiber. */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Flat pause before the single app-level retry of a transient FINAL-send
 * failure. Ported as-is from Sol Agent (DELIVERY_RETRY_MS, sol flo-local
 * lib/discord/streaming.ts:37): by the time send() rejects, @discordjs/rest
 * has already run its own retry curve, so stacking a second curve on top only
 * burns the delivery deadline. One flat pause, one re-attempt, then the
 * failure surfaces. Exported for the spec's pin test.
 */
export const discordDeliveryRetryMs = 750

/**
 * Edit failures that are expected and MUST stay silent:
 *  - "not modified" — we re-sent identical content (delivery.ts may finalize
 *    with the same text it last streamed).
 *  - "Unknown Message" — the user deleted the placeholder mid-turn.
 */
const BENIGN_EDIT_ERRORS = ["not modified", "unknown message"] as const

/**
 * Discord clears "is typing…" ~10s after the last trigger, so a turn that
 * outlives that window has to re-trigger it. 8s leaves ~2s of slack for a slow
 * REST round-trip rather than letting the indicator visibly stutter.
 */
const TYPING_REFRESH_MS = 8_000

/**
 * Hard bound on one channel's refresh loop, expressed as a COUNT of refreshes
 * (~2 minutes of cover). A turn that never delivers is ordinary rather than
 * exotic — this adapter's gate runs BEFORE the service-level dedup that drops
 * a gateway-resume redelivery — and nothing else bounds the loop, because the
 * breaker below only counts FAILURES and those attempts all succeed.
 */
const TYPING_MAX_REFRESHES = 15

/**
 * Consecutive sendTyping failures that open a channel's typing breaker. The
 * realistic cause is a missing VIEW_CHANNEL/SEND_MESSAGES grant, which Discord
 * reports as 50001/50013 — channel-scoped, and it does not self-heal.
 */
const TYPING_FAILURE_THRESHOLD = 3

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
/* FINAL-send failure classification (Sol Agent's measured classifier)         */
/* -------------------------------------------------------------------------- */

type FinalSendClass = "retry" | "refetch" | "permanent"

/**
 * Classify a rejected FINAL send. Port of Sol Agent's classifySendError
 * (sol flo-local lib/discord/streaming.ts:155-181), which was written against
 * measured production failures, not against the API reference. Of the 1,295
 * send failures Sol logged, exactly ZERO were rate-limit rejections: Luna's
 * Client shares the @discordjs/rest defaults that queue and honour 429s
 * inside the library, so a send cannot reject on 429 by construction and
 * this classifier deliberately has NO 429 branch.
 *
 *  - refetch:   discord.js throws "Could not find the channel" when its
 *               channel handle went stale (the donor's top failure). Luna's
 *               transport.send re-fetches the channel on every call, so the
 *               donor's separate REST re-fetch collapses into one IMMEDIATE
 *               re-attempt of send().
 *  - permanent: "Expected token to be set" means @discordjs/rest dropped its
 *               token after an auth failure; every request fails identically
 *               until re-login, so retrying only burns the delivery deadline.
 *               Likewise any real DiscordAPIError with a NUMERIC 4xx status
 *               (other than 429): a 403/404 will not fix itself. Status-less
 *               errors are never treated as 4xx.
 *  - retry:     everything else (network, abort, 5xx). The library already
 *               ran its own retry curve, so this earns exactly ONE app-level
 *               re-attempt after a flat discordDeliveryRetryMs pause.
 */
const classifyFinalSendError = (e: unknown): FinalSendClass => {
  const err = e as { status?: unknown; message?: unknown }
  const msg = typeof err?.message === "string" ? err.message : ""
  if (msg.includes("Could not find the channel")) return "refetch"
  if (msg.includes("Expected token to be set")) return "permanent"
  const status = typeof err?.status === "number" ? err.status : null
  if (status !== null && status >= 400 && status < 500 && status !== 429) return "permanent"
  return "retry"
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
 * A chat-input slash-command interaction, normalized to what this adapter
 * needs. Mirror of `InboundDiscordMessage` for the SECOND gated inbound path
 * (Slice 3a).
 *
 * TOKEN HYGIENE: `token` is the interaction callback token, a ~15-minute
 * capability to post AS THE BOT. It exists on this shape ONLY so the ack can
 * be sent, and it is read at exactly one site (the ack call in
 * `handleInteraction`). It must never enter the synthesized ChannelMessage,
 * its metadata (service.ts spreads metadata into the delivery address, so it
 * would ride the delivery layer, hazard H4's mechanism with a worse payload),
 * or any log line.
 */
export interface InboundDiscordInteraction {
  /** Interaction snowflake. Stable across gateway resume replay, the dedup key. */
  readonly id: string
  readonly channelId: string
  readonly authorId: string
  /** The slash-command verb, without the leading "/". */
  readonly commandName: string
  /** Interaction callback token. Read at exactly one site: the ack call. */
  readonly token: string
  readonly guildId?: string | undefined
  readonly isThread: boolean
  /** Parent channel id when `isThread`, so a thread inherits its parent's grant. */
  readonly parentId?: string | undefined
  readonly isDM: boolean
  /** ISO-8601. */
  readonly createdAt: string
}

/**
 * Normalize a raw discord.js interaction into the adapter's inbound shape.
 *
 * THE WRAPPER'S FILTER, advisor ruling 9: ONLY chat-input application
 * commands normalize. Autocomplete, components, modals, malformed shapes and
 * hostile probes all return null, never throw, mirroring the try/catch in
 * makeRealDiscordTransport's onMessage listener. Acking an autocomplete with a message
 * callback is an API error, and components/modals would synthesize garbage,
 * so the filter lives at the transport seam rather than depending on what we
 * remember to register.
 *
 * THREAD PARENTAGE FAILS CLOSED: `interaction.channel` is nullable. A null
 * channel cannot prove parentage, so the result says "not a thread" and a
 * channel-allowlisted deploy DROPS the invocation instead of guessing. When
 * the channel is present, `isThread`/`parentId` are populated so the gate's
 * thread-inherits-parent grant behaves identically to the message path.
 */
export const normalizeDiscordInteraction = (
  raw: unknown,
): InboundDiscordInteraction | null => {
  try {
    const i = raw as {
      readonly id?: unknown
      readonly token?: unknown
      readonly channelId?: unknown
      readonly user?: { readonly id?: unknown } | null
      readonly commandName?: unknown
      readonly guildId?: unknown
      readonly channel?: {
        readonly isThread?: () => boolean
        readonly parentId?: unknown
        readonly isDMBased?: () => boolean
      } | null
      readonly createdTimestamp?: unknown
      readonly isChatInputCommand?: () => boolean
    }
    if (typeof i.isChatInputCommand !== "function" || i.isChatInputCommand() !== true) {
      return null
    }
    const id = i.id
    const token = i.token
    const channelId = i.channelId
    const commandName = i.commandName
    const authorId = i.user?.id
    if (
      typeof id !== "string" ||
      typeof token !== "string" ||
      typeof channelId !== "string" ||
      typeof commandName !== "string" ||
      typeof authorId !== "string" ||
      typeof i.createdTimestamp !== "number"
    ) {
      return null
    }
    const channel = i.channel ?? null
    const isThread =
      channel !== null && typeof channel.isThread === "function" && channel.isThread() === true
    return {
      id,
      channelId,
      authorId,
      commandName,
      token,
      guildId: typeof i.guildId === "string" ? i.guildId : undefined,
      isThread,
      parentId: isThread && typeof channel?.parentId === "string" ? channel.parentId : undefined,
      isDM:
        channel !== null && typeof channel.isDMBased === "function" && channel.isDMBased() === true,
      createdAt: new Date(i.createdTimestamp).toISOString(),
    }
  } catch {
    return null
  }
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
  /**
   * Deliver a normalized chat-input command interaction. The real transport
   * runs every InteractionCreate through `normalizeDiscordInteraction` and
   * stays silent on null, so this callback fires ONLY for chat-input
   * application commands, never for autocomplete/component/modal events.
   */
  readonly onInteraction: (cb: (i: InboundDiscordInteraction) => void) => void
  readonly onReady: (cb: (botTag: string) => void) => void
  readonly onError: (cb: (e: Error) => void) => void
  readonly login: () => Promise<void>
  readonly destroy: () => Promise<void>
  /** Post a new message. Resolves with the created message's snowflake. */
  readonly send: (channelId: string, content: string) => Promise<{ id: string }>
  /** Edit an existing message in place. */
  readonly edit: (channelId: string, messageId: string, content: string) => Promise<void>
  /**
   * Show the "is typing…" indicator in a channel. Expires after ~10s, so the
   * adapter refreshes it. NOTE: deliver() is NOT inbound-gated — it trusts the
   * service layer — so typing must never be started from the
   * deliver()/standalone path, only from the post-gate inbound path.
   */
  readonly sendTyping: (channelId: string) => Promise<void>
  /**
   * Post the interaction callback: an ephemeral acknowledgment visible only
   * to the invoker. The real implementation posts callback type 4 with
   * content and the ephemeral flag 64, NEVER a deferred callback: replies go
   * out-of-band via `send`, so a deferred ack with no webhook follow-up
   * would strand every interaction in "thinking...".
   */
  readonly ackInteractionEphemeral: (
    interactionId: string,
    token: string,
    content: string,
  ) => Promise<void>
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
    onInteraction: (cb) => {
      client.on(Events.InteractionCreate, (i) => {
        // The wrapper's filter, advisor ruling 9: only chat-input commands
        // normalize; null is silent. No synthesis, no callback, no error.
        const normalized = normalizeDiscordInteraction(i)
        if (normalized === null) return
        cb(normalized)
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
    sendTyping: async (channelId) => {
      // Same shape guard `send` uses above, for the same reason: `fetch` can
      // reject and a non-text channel has no sendTyping. Both surface as a
      // rejection, which is what the caller's per-channel breaker counts —
      // a channel we cannot see is exactly the case worth giving up on.
      const channel = await client.channels.fetch(channelId)
      if (
        channel === null ||
        !("sendTyping" in channel) ||
        typeof channel.sendTyping !== "function"
      ) {
        throw new Error(`channel ${channelId} cannot show a typing indicator`)
      }
      await (channel as { sendTyping: () => Promise<void> }).sendTyping()
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
    ackInteractionEphemeral: async (interactionId, token, content) => {
      // Interaction callback: respond-with-message, ephemeral (visible only
      // to the invoker). The route is addressed by the interaction's own id
      // and token, so this call is the ONLY site that reads the token, and
      // `auth: false` matches discord.js's own interaction replies: the
      // callback endpoint authenticates via the token in the URL, not the
      // bot token.
      await client.rest.post(Routes.interactionCallback(interactionId, token), {
        auth: false,
        body: { type: 4, data: { content, flags: 64 } },
      })
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Slash-command registration manifest (DATA; Slice 3b wires it to Discord)    */
/* -------------------------------------------------------------------------- */

/**
 * The commands this bot registers, as registration payload DATA. Nothing in
 * this file calls Discord with it; Slice 3b performs the actual guild-scoped
 * registration.
 *
 * ZERO-OPTION COMMANDS ONLY, advisor ruling 4: the synthesized text is
 * "/" + commandName, which drops interaction options, and an option-stripped
 * "/deploy target" in front of an agent that guesses is the dangerous state.
 * Option serialization is deliberately deferred, so no manifest entry may
 * declare an `options` key at all.
 *
 * Scoping fields, advisor D1 complement: `default_member_permissions: "0"`
 * hides the commands from non-admin members, `contexts: [0]` is
 * guild-context only (no DMs), `integration_types: [0]` is guild-install
 * only (no user-install). These keep the no-ack stranger-drop path RARE by
 * making the commands invisible to strangers in the client UI. Command
 * permissions are guild-admin-overridable, so this scoping is NOISE
 * REDUCTION, NEVER AN AUTH LAYER: `isInboundAllowed` remains the only
 * boundary.
 */
export const discordCommandManifest: ReadonlyArray<{
  readonly name: string
  readonly description: string
  /** 1 = CHAT_INPUT. */
  readonly type: number
  readonly default_member_permissions: string
  readonly contexts: ReadonlyArray<number>
  readonly integration_types: ReadonlyArray<number>
}> = [
  {
    name: "help",
    description: "What Luna can do here",
    type: 1,
    default_member_permissions: "0",
    contexts: [0],
    integration_types: [0],
  },
  {
    name: "new",
    description: "Start a fresh conversation",
    type: 1,
    default_member_permissions: "0",
    contexts: [0],
    integration_types: [0],
  },
  {
    name: "stop",
    description: "Stop the current response",
    type: 1,
    default_member_permissions: "0",
    contexts: [0],
    integration_types: [0],
  },
]

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
  /**
   * Override the "is typing…" refresh interval, in ms. A TEST SEAM, for the
   * same reason `transport` above is one: the refresh CAP is a hard rail, and
   * at the production 8s cadence observing it would cost ~2 minutes of wall
   * clock. ONLY the interval is overridable — the cap stays a module constant.
   * Leave unset in production.
   */
  readonly typingRefreshMs?: number
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
  // A non-positive override would busy-loop the refresh fiber, so it falls
  // back rather than being trusted.
  const typingRefreshMs =
    config.typingRefreshMs !== undefined && config.typingRefreshMs > 0
      ? config.typingRefreshMs
      : TYPING_REFRESH_MS

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

  /**
   * Log the first drop per (channel:author:kind) so a spammer cannot flood
   * the log. The KIND is part of the key on purpose, advisor D1 adoption: a
   * stranger who messaged once and then starts probing slash commands has
   * changed vector, and at a shell boundary the vector change is the thing
   * you most want to see, so it earns a new line.
   */
  const loggedDrops = new Set<string>()

  /**
   * Interaction ids already accepted. Gateway session resume can REPLAY
   * INTERACTION_CREATE, and a replayed command would re-ack an
   * already-consumed callback and RE-EXECUTE against the shell, so the
   * adapter dedups at this seam on the interaction snowflake (advisor
   * ruling 10). The service-level (transport, platformMessageId) dedup
   * would also drop the replayed dispatch, but only AFTER a second ack had
   * gone out, so it is not a substitute.
   */
  const seenInteractionIds = new Set<string>()

  /**
   * channelId → its live "is typing…" refresh loop.
   *
   * Keyed by CHANNEL, never per turn: service.ts's delivery fiber is per
   * (threadId, adapterId) and PERSISTS across turns, so a per-turn key would
   * orphan every follow-up turn's fiber. Discord's threadingKey IS the
   * channelId (see toChannelMessage), so one channel has at most one loop and
   * starting is idempotent.
   */
  const typingFibers = new Map<string, Fiber.RuntimeFiber<void, never>>()

  /** channelId → consecutive sendTyping failures. 429s are excluded, see below. */
  const typingFailures = new Map<string, number>()

  /**
   * Channels whose typing breaker has opened — permanent for the life of the
   * adapter, and deliberately with no half-open state. Typing is cosmetic, so
   * a dark indicator costs nothing, while retrying a channel we are probably
   * not allowed to see costs log spam and rate-limit pressure on every turn.
   */
  const typingBreakerOpen = new Set<string>()

  /**
   * Set by stop(). The service scope closes around the same time stop() runs,
   * with no ordering guarantee, so a gateway event already in flight could
   * otherwise call startTyping() AFTER the sweep and leak a refresh loop for
   * the length of the cap. All three touch points are synchronous JS, so the
   * flag closes that window.
   */
  let typingSwept = false

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

  const noteDrop = (m: InboundDiscordMessage, kind: "message" | "interaction"): void => {
    const key = `${m.channelId}:${m.authorId}:${kind}`
    if (loggedDrops.has(key)) return
    loggedDrops.add(key)
    console.warn(
      `[discord-adapter] dropped inbound ${kind} from user=${m.authorId} ` +
        `channel=${m.channelId}, not on the allowlist (logged once per channel:author:kind)`,
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
  /* Typing indicator                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * One sendTyping attempt plus the breaker bookkeeping for its outcome.
   * NEVER fails: the indicator is cosmetic and must not be able to take a turn
   * down with it.
   *
   * A 429 neither increments NOR resets the count. Rate limiting is the one
   * realistic TRANSIENT here and it self-heals, so the "does not self-heal"
   * rationale for opening does not apply to it: counting 429s would let three
   * rate-limited refreshes kill typing permanently, and resetting on them
   * would stop a rate-limited channel opening at all. It is deliberately NOT
   * routed through withRateLimitRetry — that parks the fiber for the whole
   * retry-after and console.errors every failure, which is the wrong trade for
   * a spinner that the next refresh will retry anyway.
   */
  const attemptTyping = (t: DiscordTransport, channelId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const outcome = yield* Effect.either(
        Effect.tryPromise({ try: () => t.sendTyping(channelId), catch: (e) => e as unknown }),
      )
      if (Either.isRight(outcome)) {
        typingFailures.delete(channelId)
        return
      }
      const err = outcome.left
      if (parseDiscord429RetryMs(err) !== null) return
      const consecutive = (typingFailures.get(channelId) ?? 0) + 1
      typingFailures.set(channelId, consecutive)
      if (consecutive < TYPING_FAILURE_THRESHOLD) return
      typingBreakerOpen.add(channelId)
      // Exactly one line per channel for the life of the process: the loop
      // stops attempting, so there is nothing further to report, and a
      // per-failure log would spam every turn in a channel we cannot see.
      console.warn(
        `[discord-adapter] typing indicator disabled for channel=${channelId} — ` +
          `${TYPING_FAILURE_THRESHOLD} consecutive sendTyping failures ` +
          `(usually a missing VIEW_CHANNEL/SEND_MESSAGES grant). Replies are ` +
          `unaffected. Last error: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

  /**
   * Start the indicator for `channelId`, and keep it alive while the turn is.
   *
   * SECURITY: only ever call this AFTER `isInboundAllowed` has accepted the
   * message — see handleInbound for why that ordering is the whole point.
   *
   * Idempotent per channel: a second inbound while a loop is live must not
   * start a second one.
   */
  const startTyping = (channelId: string): void => {
    const t = transport
    if (t === null || typingSwept) return
    if (typingBreakerOpen.has(channelId) || typingFibers.has(channelId)) return
    const loop = Effect.gen(function* () {
      for (let refresh = 0; refresh <= TYPING_MAX_REFRESHES; refresh++) {
        yield* attemptTyping(t, channelId)
        // That attempt opened the breaker: nothing left to refresh.
        if (typingBreakerOpen.has(channelId)) return
        if (refresh === TYPING_MAX_REFRESHES) return
        yield* Effect.sleep(Duration.millis(typingRefreshMs))
      }
    })
    // A runFork ROOT, like telegram.ts's: the handler fiber this is started
    // alongside finishes when the turn's effect does, so a child fiber would
    // be interrupted long before the reply that supersedes the indicator.
    const fiber = Effect.runFork(loop)
    typingFibers.set(channelId, fiber)
    fiber.addObserver(() => {
      // Only ever retire OUR OWN entry — a stop-and-restart in between will
      // have installed a different fiber under this key.
      if (typingFibers.get(channelId) === fiber) typingFibers.delete(channelId)
    })
  }

  /** Stop the indicator for `channelId` (the first reply supersedes it). */
  const stopTyping = (channelId: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const fiber = typingFibers.get(channelId)
      if (fiber === undefined) return Effect.void
      typingFibers.delete(channelId)
      return Fiber.interrupt(fiber).pipe(Effect.asVoid)
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
        noteDrop(m, "message")
        return
      }
      const handler = messageHandler
      if (handler === null) return
      // The adapter's FIRST observable side effect, and it is observable by
      // the SENDER — so it sits below BOTH preconditions. Below the gate,
      // because a pre-gate indicator is an "is the bot listening to me?"
      // oracle for a stranger probing the front door of a shell. Below the
      // handler check, because otherwise the bot claims to be working on a
      // message that nothing will ever process.
      startTyping(m.channelId)
      Effect.runFork(handler(toChannelMessage(m)))
    } catch (err) {
      console.error("[discord-adapter] inbound handler error:", err)
    }
  }

  /**
   * Project an interaction onto the inbound-message shape so the SAME gate
   * and the SAME `toChannelMessage` builder serve both inbound paths. A
   * hand-built ChannelMessage would mis-stamp `transport` (hazard H1) and
   * every reply then dies silently at three sites: the service fan-out, the
   * service command replies, and this adapter's own foreign-transport guard
   * in deliver().
   *
   * The interaction TOKEN is deliberately absent from this shape; see the
   * hygiene note on `InboundDiscordInteraction`.
   */
  const interactionAsInbound = (i: InboundDiscordInteraction): InboundDiscordMessage => ({
    id: i.id,
    channelId: i.channelId,
    authorId: i.authorId,
    // Interactions cannot be authored by bots or the system.
    authorBot: false,
    system: false,
    // Zero-option commands only (see discordCommandManifest), so the verb
    // IS the whole text.
    content: `/${i.commandName}`,
    guildId: i.guildId,
    isThread: i.isThread,
    parentId: i.parentId,
    isDM: i.isDM,
    createdAt: i.createdAt,
  })

  /**
   * The SECOND gated inbound path (Slice 3a): gate, then dedup, then ack,
   * then dispatch, in that order. Async so the ack can be AWAITED before the
   * dispatch fork; the body never rejects (everything is inside the
   * try/catch), so the floating promise the gateway listener holds is safe.
   */
  const handleInteraction = async (i: InboundDiscordInteraction): Promise<void> => {
    try {
      const m = interactionAsInbound(i)
      // GATE: before the ack, before dispatch, before any session exists.
      // A stranger's invocation is a SILENT drop, ruling R1/D1: the ack is
      // invoker-observable state, so acking (or rejecting) a stranger is an
      // "is something listening" oracle at the front door of a shell.
      if (!isInboundAllowed(m)) {
        noteDrop(m, "interaction")
        return
      }
      const handler = messageHandler
      const t = transport
      if (handler === null || t === null) return
      // Dedup on the interaction snowflake: a gateway-resume replay must
      // neither re-ack an already-consumed callback nor re-execute against
      // the shell.
      if (seenInteractionIds.has(i.id)) return
      seenInteractionIds.add(i.id)
      // AWAIT the ack, THEN fork the dispatch: the callback's 3s deadline
      // must front-run event-loop contention from the forked turn. The
      // .catch is load-bearing: an un-caught expired-token rejection is an
      // unhandledRejection, which by Node default kills the process, and an
      // allowed user's stale interaction taking the bot down is a self-DoS.
      // A dead ack must not eat the turn either: the reply path is t.send,
      // out-of-band, so the dispatch below proceeds after one log line.
      //
      // RESIDUAL GAP, advisor item 2, documented rather than closed: slash
      // availability follows the INVOKER's permissions, and the interaction
      // callback endpoint bypasses channel permissions, but t.send does
      // not. An allowed user invoking in a channel the bot cannot post to
      // therefore gets this ack and then silence, with the turn's side
      // effects already committed. The message path cannot reach that
      // state, because a visible message proves the bot can see the
      // channel. Slice 3b's guild-scoped registration makes this rare; it
      // does NOT make it impossible.
      await t.ackInteractionEphemeral(i.id, i.token, "On it.").catch((err) => {
        console.error(
          "[discord-adapter] interaction ack failed (turn continues):",
          // message ONLY, never the raw object: @discordjs/rest errors carry
          // an enumerable .url with the live interaction token in the path.
          err instanceof Error ? err.message : String(err),
        )
      })
      Effect.runFork(handler(toChannelMessage(m)))
    } catch (err) {
      console.error("[discord-adapter] inbound interaction handler error:", err)
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Outbound helpers                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Run a Discord REST op, honouring 429 retry-after. Returns null when the
   * op ultimately failed. Its remaining callers are the PARTIAL-send,
   * placeholder-EDIT and standalone paths, which delivery.ts treats as
   * best-effort (their failures are swallowed upstream), so returning null
   * keeps the turn alive. FINAL sends go through sendFinalClassified below,
   * which surfaces terminal failures instead of swallowing them.
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

  /**
   * One FINAL send through the measured classifier (donor: sol flo-local
   * lib/discord/streaming.ts finalize loop). At most TWO transport.send
   * calls ever happen here:
   *
   *   attempt 1 fails -> refetch:   immediate second attempt (transport.send
   *                                 re-fetches the channel internally).
   *                      retry:     second attempt after a flat
   *                                 discordDeliveryRetryMs pause.
   *                      permanent: no second attempt.
   *
   * A terminal failure surfaces as a defect (Effect.die): the deliver()
   * contract is Effect<void> with no error channel (types.ts is frozen for
   * this slice), and delivery.ts's finalize loop inspects the Exit, so a
   * defect is exactly enough for "stop at the first failed chunk". No 429
   * handling here, see classifyFinalSendError; deliberately NOT stacked on
   * withRateLimitRetry, which would multiply attempts.
   */
  const sendFinalClassified = (
    t: DiscordTransport,
    channelId: string,
    text: string,
  ): Effect.Effect<{ id: string }> =>
    Effect.gen(function* () {
      const first = yield* Effect.either(
        Effect.tryPromise({ try: () => t.send(channelId, text), catch: (e) => e as unknown }),
      )
      if (Either.isRight(first)) return first.right
      const err = first.left
      const klass = classifyFinalSendError(err)
      console.error(`[discord-adapter] send(final) failed (${klass}):`, err)
      if (klass === "permanent") {
        return yield* Effect.die(err)
      }
      if (klass === "retry") {
        yield* Effect.sleep(Duration.millis(discordDeliveryRetryMs))
      }
      const second = yield* Effect.either(
        Effect.tryPromise({ try: () => t.send(channelId, text), catch: (e) => e as unknown }),
      )
      if (Either.isRight(second)) return second.right
      console.error(`[discord-adapter] send(final) failed after one ${klass} re-attempt:`, second.left)
      return yield* Effect.die(second.left)
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
          // A restart after stop() must be able to type again.
          typingSwept = false
          t.onMessage(handleInbound)
          t.onInteraction(handleInteraction)
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
      return Effect.gen(function* () {
        // The refresh loops are runFork ROOTS, so the service scope closing
        // does not touch them, and ChannelService calls stop() only AFTER
        // that scope has closed: this sweep is the only thing that ends them.
        // Breaker state deliberately survives — it describes a channel grant,
        // not a connection.
        typingSwept = true
        const fibers = Array.from(typingFibers.values())
        typingFibers.clear()
        yield* Fiber.interruptAll(fibers)

        const t = transport
        if (t === null) return
        started = false
        sentMessageIds.clear()
        yield* Effect.promise(() => t.destroy().catch(() => undefined))
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

        // Anything we send supersedes the indicator. Placed BELOW the
        // transport guard — a Telegram-addressed delivery must not clear a
        // live Discord indicator — and ABOVE the empty-text return, so an
        // empty first chunk cannot leave it spinning for the rest of the cap.
        yield* stopTyping(channelId)

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
        // messages, never edits of the placeholder. Non-partial means the
        // finalize phase: those sends are classified and their terminal
        // failures surface, so delivery.ts can stop instead of silently
        // dropping the middle of the answer.
        if (opts.chunkIndex > 0) {
          if (opts.isPartial) {
            yield* withRateLimitRetry(() => t.send(channelId, text), "send(chunk)", false)
          } else {
            yield* sendFinalClassified(t, channelId, text)
          }
          return
        }

        if (existing === undefined) {
          if (!opts.isPartial) {
            // FINAL send with no placeholder to edit: classified, surfacing.
            // Nothing is recorded: finalize-phase messages never receive
            // follow-up edits, and any placeholder entry was dropped above.
            yield* sendFinalClassified(t, channelId, text)
            return
          }
          const sent = yield* withRateLimitRetry(
            () => t.send(channelId, text),
            "send",
            false,
          )
          // Record for follow-up edits (partials only ever reach this point
          // with isFinal false, but keep the guard explicit).
          if (!opts.isFinal && sent !== null) {
            sentMessageIds.set(turnKey, sent.id)
          }
        } else {
          // Placeholder EDIT path: pinned to today's best-effort behavior
          // (benign failures stay silent, others log and swallow). The
          // classifier applies to FINAL SENDS only.
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
