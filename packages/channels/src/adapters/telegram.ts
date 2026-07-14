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
 * ## Inbound attachments
 *
 * Photos and file documents (PDF or image by mime/extension) are ingested:
 * classifyInboundMedia resolves the media ref, getFile resolves a short-lived
 * file_path, and a separate raw-byte transport (`TelegramFileTransport`)
 * downloads it. The type allowlist and size caps come from @luna/core
 * attachment-limits.ts (the same limits ui-ws enforces on Moon uploads), and
 * downloaded bytes are magic-byte sniffed so a misnamed file is corrected or
 * rejected before it reaches the model. Media captions ride in
 * ChannelMessage.text and are never treated as channel commands. Unsupported
 * media (voice, video, GIFs, unrecognized file types) gets a user-facing
 * explanation instead of a silent drop, restricted to DMs for ambient group
 * media; stickers are dropped silently. Downloads run off the poll fiber
 * behind a small semaphore, and dispatch is per-chat FIFO: same-chat messages
 * reach the handler in arrival order (a follow-up text queues behind its
 * PDF's download) while different chats stay fully concurrent.
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
 * Raw file BYTES travel through a second seam, `TelegramFileTransport`
 * (config `fileTransport` override; production `makeRealFileTransport`),
 * because downloads use the separate `/file/bot<token>/<file_path>` URL
 * scheme rather than the JSON-RPC-style method endpoint.
 *
 * ## Token
 *
 * The token must be supplied as a `Redacted<string>` via `config.token`, or the
 * adapter will read `TELEGRAM_BOT_TOKEN` from the environment (via EnvSecretProvider
 * convention) and wrap it in `Redacted.make()` at start() time. The plain-text
 * value is only unwrapped with `Redacted.value(token)` at the URL-building
 * call sites inside `makeRealTransport` and `makeRealFileTransport`, so it
 * never appears in logs or traces.
 *
 * ## Reconnection
 *
 * The poll loop is wrapped in `Effect.retry(Schedule.exponential(...))` capped
 * at 30 s, so transient errors (network blips, Telegram 429/503) cause a brief
 * back-off rather than killing the adapter.
 *
 * ## Tap-to-stop inline button
 *
 * `allowed_updates` includes "callback_query". Button taps are handled
 * OUTSIDE the per-chat FIFO chain (chatChains) — a stop must never queue
 * behind the turn it interrupts. Every callback is answered immediately
 * (Telegram expires an unanswered one after ~10s); the tapper is then
 * re-checked through the SAME allowlist messages use (callback_data is
 * attacker-controlled) before a synthetic "/stop" ChannelMessage is built
 * and dispatched straight to the installed messageHandler, reusing dedup +
 * commands.ts's existing /stop handling rather than a parallel interrupt
 * path. The "⏹ Stop" reply_markup rides on every deliver() call while
 * `opts.isPartial` is true and is omitted once the turn finalizes, so the
 * button disappears with the turn.
 *
 * ## "Working" reaction glyph
 *
 * setMessageReaction (Bot API 7.0+) reacts to the Chairman's own inbound
 * message with 👀 when a turn starts (same call site as startTyping).
 * Fire-and-forget/best-effort — a 400 from a chat with restricted
 * available_reactions must never break delivery. Deliberately NOT cleared
 * on turn completion (see reactWorking's doc comment and the PR description
 * for the DM-notification tradeoff this avoids).
 *
 * ## Forum-topic session scoping
 *
 * When `chat.is_forum` is true and an inbound message/callback carries
 * `is_topic_message`/`message_thread_id`, the session threadingKey becomes
 * `"<chatId>:topic:<messageThreadId>"` instead of plain chatId, so each
 * forum topic gets its own Luna thread (forumTopicIdFor/threadingKeyFor).
 * Gated strictly on is_forum: DMs and non-forum groups are byte-identical
 * to before, so no migration is needed for existing channel_sessions rows.
 * message_thread_id is threaded through every outbound sendMessage/
 * sendChatAction for the topic (typing indicators and multi-chunk replies
 * land in the topic, not "General"); editMessageText needs no such
 * threading since it targets an existing message_id whose topic is fixed.
 */
import { Buffer } from "node:buffer"
import { Cause, Effect, Either, Fiber, Redacted, Ref, Schedule } from "effect"
import {
  ALLOWED_ATTACHMENT_MEDIA_TYPES,
  MAX_IMAGE_RAW_BYTES,
  MAX_PDF_RAW_BYTES,
  attachmentByteCap,
} from "@luna/core"
import type { ChannelAdapter, ChannelAttachment, ChannelMessage, DeliverOptions, DeliveryTarget } from "../types.js"
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
  /** Media messages carry their user text here instead of `text`. */
  readonly caption?: string
  /** Compressed image — several size variants (ordering not guaranteed). */
  readonly photo?: ReadonlyArray<TelegramPhotoSize>
  /** File sent uncompressed ("attach as file") — PDFs arrive here. */
  readonly document?: TelegramDocument
  // Media kinds we recognize but do not ingest (see classifyInboundMedia).
  // NB: animation messages (GIFs) also set `document` — animation is checked first.
  readonly animation?: unknown
  readonly voice?: unknown
  readonly audio?: unknown
  readonly video?: unknown
  readonly video_note?: unknown
  readonly sticker?: unknown
  readonly date: number
  /** Forum-topic threading (only present in forum supergroups). */
  readonly is_topic_message?: boolean
  readonly message_thread_id?: number
}

/** One size variant of a Telegram photo. Telegram photos are always JPEG. */
interface TelegramPhotoSize {
  readonly file_id: string
  readonly width: number
  readonly height: number
  readonly file_size?: number
}

/** A Telegram document (file attachment sent uncompressed). */
interface TelegramDocument {
  readonly file_id: string
  readonly file_name?: string
  readonly mime_type?: string
  readonly file_size?: number
}

/** getFile result payload. */
interface TelegramFileInfo {
  readonly file_id: string
  readonly file_size?: number
  readonly file_path?: string
}

interface TelegramChat {
  readonly id: number
  readonly type: "private" | "group" | "supergroup" | "channel"
  /** True for forum-mode supergroups (topics enabled). */
  readonly is_forum?: boolean
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

/**
 * Minimal reference to the message a callback query's inline keyboard is
 * attached to. Telegram's real type is `Message | InaccessibleMessage`
 * (a message can age out of the bot's cache); only `chat`/`message_id`/
 * `message_thread_id` are used here, so both cases satisfy this shape.
 */
interface TelegramCallbackMessageRef {
  readonly chat: TelegramChat
  readonly message_id: number
  readonly message_thread_id?: number
}

/**
 * An inline-keyboard button tap. `data` is the button's `callback_data` —
 * attacker-controlled (any chat member can tap a button in a group), so it
 * is never trusted without an allowlist check against `from`.
 */
interface TelegramCallbackQuery {
  readonly id: string
  readonly from: TelegramUser
  readonly data?: string
  readonly message?: TelegramCallbackMessageRef
}

/* -------------------------------------------------------------------------- */
/* Forum-topic threading                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the forum-topic id for an inbound message/callback, or undefined
 * when the chat is not a forum or the update carries no topic info. Gated
 * STRICTLY on `chat.is_forum` so DMs and plain (non-forum) groups are never
 * affected — their session key must keep resolving to plain chat.id with no
 * migration required for existing `channel_sessions` rows.
 */
const forumTopicIdFor = (
  chat: TelegramChat,
  isTopicMessage: boolean | undefined,
  messageThreadId: number | undefined,
): number | undefined =>
  chat.is_forum === true && (isTopicMessage === true || messageThreadId !== undefined)
    ? messageThreadId
    : undefined

/**
 * Session threading key for a chat, optionally scoped to a forum topic.
 * Non-forum chats (the ":topic:" suffix absent) resolve to the plain chat id
 * — byte-identical to the pre-existing key, so old rows never orphan.
 */
const threadingKeyFor = (chatId: string, forumTopicId: number | undefined): string =>
  forumTopicId !== undefined ? `${chatId}:topic:${forumTopicId}` : chatId

/* -------------------------------------------------------------------------- */
/* Tap-to-stop inline button                                                  */
/* -------------------------------------------------------------------------- */

/** callback_data value for the "⏹ Stop" inline button. */
const STOP_CALLBACK_DATA = "stop"

/**
 * Inline keyboard attached to partial (in-flight) stream-edit deliveries.
 * Omitted on the final delivery of a turn so the button disappears once
 * there is nothing left to interrupt.
 */
const STOP_KEYBOARD = {
  inline_keyboard: [[{ text: "⏹ Stop", callback_data: STOP_CALLBACK_DATA }]],
} as const

/* -------------------------------------------------------------------------- */
/* "Working" reaction glyph                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reaction set on the Chairman's inbound message when a turn starts.
 * Must come from Telegram's fixed ReactionTypeEmoji allowed set — this is
 * not a free-form emoji field.
 */
const REACTION_EMOJI = "👀"

/**
 * Best-effort "I'm working on this" reaction on the triggering message.
 * Fire-and-forget: some chats restrict `available_reactions` and this call
 * can 400 — that must never break message delivery. The real transport
 * already folds HTTP failures into `{ ok: false }`; we simply don't inspect
 * the result, and catchAllCause absorbs any defect from an injected/test
 * transport.
 *
 * Deliberately NOT cleared on turn completion — see telegram-ux-improvements
 * PR description for the tradeoff (clearing/re-reacting on every turn would
 * double Telegram's per-reaction notification in DMs).
 */
const reactWorking = (
  transport: TelegramHttpTransport,
  chatId: string,
  messageId: number,
): Effect.Effect<void> =>
  transport("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji: REACTION_EMOJI }],
  }).pipe(
    Effect.asVoid,
    Effect.catchAllCause(() => Effect.void),
  )

/** A single Telegram update from getUpdates. */
interface TelegramUpdate {
  readonly update_id: number
  readonly message?: TelegramMessage
  readonly callback_query?: TelegramCallbackQuery
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

/**
 * Raw file download seam — the Bot API method transport above only speaks
 * JSON-RPC-style methods; actual file BYTES come from a different URL scheme
 * (`/file/bot<token>/<file_path>`). Tests inject a fake; production uses
 * `makeRealFileTransport(token)`.
 */
export type TelegramFileTransport = (
  filePath: string,
) => Effect.Effect<Uint8Array, Error>

/**
 * Real file-download transport. Same Redacted-token discipline as
 * makeRealTransport: the token is unwrapped only at URL construction time.
 * Error messages never embed the URL, so the token cannot leak through logs
 * or the user-facing failure replies built from them.
 *
 * Hardening (the caller's byte cap runs only AFTER the body is in memory, so
 * the transport enforces its own absolute ceiling):
 *   - file_path segments are percent-encoded, so a hostile path cannot alter
 *     the URL structure.
 *   - Content-Length is checked before reading when present.
 *   - The body is read as a stream and aborted the moment the cumulative
 *     bytes exceed the ceiling — a lying/absent Content-Length cannot make
 *     us buffer a multi-GB body.
 */
export const makeRealFileTransport = (
  token: Redacted.Redacted<string>,
): TelegramFileTransport =>
  (filePath) =>
    Effect.tryPromise({
      try: async (signal) => {
        const encodedPath = filePath.split("/").map(encodeURIComponent).join("/")
        const url = `https://api.telegram.org/file/bot${Redacted.value(token)}/${encodedPath}`
        const res = await fetch(url, { signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const declared = res.headers.get("content-length")
        if (declared !== null && Number(declared) > MAX_PDF_RAW_BYTES) {
          throw new Error("file exceeds the size limit")
        }
        if (res.body === null) return new Uint8Array(0)
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > MAX_PDF_RAW_BYTES) {
            await reader.cancel()
            throw new Error("file exceeds the size limit")
          }
          chunks.push(value)
        }
        return new Uint8Array(Buffer.concat(chunks))
      },
      catch: (e) =>
        new Error(
          `download failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
    })

/* -------------------------------------------------------------------------- */
/* Inbound media classification + download                                     */
/* -------------------------------------------------------------------------- */

// Allowlist + size caps come from @luna/core attachment-limits.ts — the same
// source ui-ws server.ts validateAttachments (the Moon-upload gate) enforces,
// so Telegram files obey identical Anthropic content-block limits.
// Telegram's own getFile additionally refuses files over ~20 MB for bots.

/**
 * Shape gate for a mime string that gets ECHOED back to the chat. The
 * sender controls document.mime_type; an unconstrained echo through the
 * markdown→HTML formatter would let a crafted mime render as a clickable
 * link in a bot-authored message. Anything not shaped like a mime type is
 * reported as "unknown".
 */
const MIME_SHAPE = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/
const safeMimeForEcho = (mediaType: string | null): string =>
  mediaType !== null && MIME_SHAPE.test(mediaType) ? mediaType : "unknown"

/**
 * getFile's file_path is interpolated into the token-bearing download URL.
 * It comes from Telegram itself over TLS, but the boundary should not assume
 * benign metadata: reject anything outside a conservative charset or with a
 * ".." segment before it reaches the transport.
 */
const FILE_PATH_SHAPE = /^[A-Za-z0-9_\-./]{1,512}$/
const isSafeFilePath = (filePath: string): boolean =>
  FILE_PATH_SHAPE.test(filePath) && !filePath.split("/").includes("..")

/**
 * Magic-byte sniff for the five ingestible types. The declared mime is
 * sender-controlled; a misnamed file (report.pdf that is actually a JPEG)
 * would otherwise produce a content block the Anthropic API rejects mid-turn
 * — a deep-pipeline error instead of the immediate reply this path exists
 * to give. Returns null when the bytes match none of the known signatures.
 */
const sniffMediaType = (bytes: Uint8Array): string | null => {
  const startsWith = (sig: number[], offset = 0): boolean =>
    bytes.byteLength >= offset + sig.length &&
    sig.every((b, i) => bytes[offset + i] === b)
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf" // %PDF-
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return "image/png"
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return "image/gif" // GIF8
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp" // RIFF....WEBP
  }
  return null
}

/** Fallback mime inference for documents Telegram sends without mime_type. */
const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
}

const inferDocumentMediaType = (doc: TelegramDocument): string | null => {
  // Normalize: senders and clients disagree on casing ("Application/PDF").
  const declared = doc.mime_type === undefined ? undefined : doc.mime_type.trim().toLowerCase()
  if (declared !== undefined && ALLOWED_ATTACHMENT_MEDIA_TYPES.has(declared)) return declared
  // Declared mime is missing, generic (application/octet-stream), or
  // unrecognized — fall back to the filename extension before rejecting.
  // The magic-byte sniffer stays the final authority on the actual bytes.
  const name = doc.file_name ?? ""
  const dot = name.lastIndexOf(".")
  const ext = dot === -1 ? null : name.slice(dot + 1).toLowerCase()
  const fromExtension =
    ext !== null && Object.hasOwn(EXTENSION_MEDIA_TYPES, ext)
      ? (EXTENSION_MEDIA_TYPES[ext] ?? null)
      : null
  if (fromExtension !== null) return fromExtension
  // Nothing ingestible: surface the (normalized) declared type so the
  // unsupported-type reply can echo it, or null for "unknown".
  return declared !== undefined && declared.length > 0 ? declared : null
}

/**
 * What an inbound message's media resolves to:
 *   - "file": an ingestible attachment — download it and hand it to the agent.
 *   - "unsupported": media we cannot ingest. `userReply` is the explanation to
 *     send back (null = drop silently); `dmOnly` restricts the reply to private
 *     chats so ambient group media (voice notes, videos) doesn't trigger bot
 *     noise. Replying beats the old silent drop — that silence is exactly what
 *     made the agent gaslight the user with "it didn't come through, resend?".
 */
type InboundMediaRef =
  | {
      readonly _tag: "file"
      readonly fileId: string
      readonly mediaType: string
      readonly fileName?: string
      readonly declaredSize?: number
    }
  | {
      readonly _tag: "unsupported"
      readonly userReply: string | null
      readonly dmOnly: boolean
    }

const SUPPORTED_TYPES_HINT =
  "I can read images (JPEG/PNG/GIF/WebP) and PDF files sent as photos or file attachments."

const classifyInboundMedia = (msg: TelegramMessage): InboundMediaRef | null => {
  if (msg.photo !== undefined && msg.photo.length > 0) {
    // Pick the largest variant by area — the Bot API does not guarantee the
    // array ordering, and silently ingesting a thumbnail would degrade what
    // the model sees with no error. Telegram photos are always JPEG.
    const best = msg.photo.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))
    return {
      _tag: "file",
      fileId: best.file_id,
      mediaType: "image/jpeg",
      ...(best.file_size !== undefined ? { declaredSize: best.file_size } : {}),
    }
  }
  // Animations (GIFs) set BOTH `animation` and `document` (Bot API backward
  // compatibility), so this check MUST precede the document branch —
  // otherwise every ambient group GIF triggers an "unsupported file type"
  // reply. Treated like video: explain in DMs, stay silent in groups.
  if (msg.animation !== undefined) {
    return {
      _tag: "unsupported",
      userReply: `⚠️ I can't watch GIFs or animations yet. ${SUPPORTED_TYPES_HINT}`,
      dmOnly: true,
    }
  }
  if (msg.document !== undefined) {
    const mediaType = inferDocumentMediaType(msg.document)
    if (mediaType === null || !ALLOWED_ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
      return {
        _tag: "unsupported",
        userReply:
          `⚠️ I can't accept this file type (${safeMimeForEcho(mediaType)}). ` +
          SUPPORTED_TYPES_HINT,
        dmOnly: false, // a file explicitly sent to the bot deserves an answer even in groups
      }
    }
    return {
      _tag: "file",
      fileId: msg.document.file_id,
      mediaType,
      ...(msg.document.file_name !== undefined ? { fileName: msg.document.file_name } : {}),
      ...(msg.document.file_size !== undefined ? { declaredSize: msg.document.file_size } : {}),
    }
  }
  if (msg.voice !== undefined || msg.audio !== undefined) {
    return {
      _tag: "unsupported",
      userReply: `⚠️ I can't listen to audio yet — please type it out. ${SUPPORTED_TYPES_HINT}`,
      dmOnly: true, // group voice notes are ambient chatter, not bot input
    }
  }
  if (msg.video !== undefined || msg.video_note !== undefined) {
    return {
      _tag: "unsupported",
      userReply: `⚠️ I can't watch videos yet. ${SUPPORTED_TYPES_HINT}`,
      dmOnly: true,
    }
  }
  if (msg.sticker !== undefined) {
    // Stickers are reactions, not attachments — never worth a bot reply.
    return { _tag: "unsupported", userReply: null, dmOnly: true }
  }
  return null
}

const tooLargeReply = (bytes: number, cap: number): string =>
  `⚠️ That file is too large (${Math.ceil(bytes / (1024 * 1024))} MB). ` +
  `I can take images up to ${MAX_IMAGE_RAW_BYTES / (1024 * 1024)} MB and ` +
  `PDFs up to ${MAX_PDF_RAW_BYTES / (1024 * 1024)} MB` +
  (cap === MAX_PDF_RAW_BYTES ? "." : " — try sending it as a smaller file or a link.")

type AttachmentFetchOutcome =
  | { readonly _tag: "ok"; readonly attachment: ChannelAttachment }
  | { readonly _tag: "failed"; readonly userReply: string }

const fetchFailed = (userReply: string): AttachmentFetchOutcome => ({
  _tag: "failed",
  userReply,
})

/**
 * Two-step Telegram file download: getFile (via the method transport) resolves
 * a short-lived file_path, then the file transport fetches the raw bytes.
 * Total — every failure mode folds into a "failed" outcome with a user-facing
 * explanation; nothing here can fail the poll loop.
 *
 * Size is enforced three times deliberately: the declared size before any
 * network call (cheap rejection), getFile's reported size (authoritative
 * pre-download), and the actual byte length (defence against lying metadata).
 */
const fetchTelegramAttachment = (
  transport: TelegramHttpTransport,
  fileTransport: TelegramFileTransport | null,
  ref: Extract<InboundMediaRef, { _tag: "file" }>,
): Effect.Effect<AttachmentFetchOutcome> =>
  Effect.gen(function* () {
    const cap = attachmentByteCap(ref.mediaType)
    if (ref.declaredSize !== undefined && ref.declaredSize > cap) {
      return fetchFailed(tooLargeReply(ref.declaredSize, cap))
    }
    if (fileTransport === null) {
      return fetchFailed(
        "⚠️ I received your file but downloads aren't configured on my end — tell my operator.",
      )
    }
    // Bounded getFile: makeRealTransport has no client-side timeout of its
    // own (undici defaults run to minutes) and a hang is not an error, so
    // without this the fiber could be pinned far longer than the download cap.
    const info = yield* transport("getFile", { file_id: ref.fileId }).pipe(
      Effect.timeoutTo({
        duration: "30 seconds",
        onTimeout: (): TelegramApiResult => ({ ok: false, description: "getFile timed out" }),
        onSuccess: (r: TelegramApiResult) => r,
      }),
    )
    const fileInfo = (info.ok ? info.result : undefined) as TelegramFileInfo | undefined
    if (fileInfo === undefined || typeof fileInfo.file_path !== "string" || fileInfo.file_path.length === 0) {
      // Telegram's bot download ceiling (~20 MB) surfaces here as
      // "file is too big" — pass the description through when present.
      return fetchFailed(
        `⚠️ Telegram wouldn't hand over that file (${info.description ?? "no download path"}). ` +
          "Bots can only download files up to 20 MB — try a smaller file or a link.",
      )
    }
    if (!isSafeFilePath(fileInfo.file_path)) {
      // file_path feeds the token-bearing download URL; never forward a
      // path that could alter the URL structure.
      return fetchFailed(
        "⚠️ Telegram returned an unusable download path for that file. Please try again.",
      )
    }
    if (fileInfo.file_size !== undefined && fileInfo.file_size > cap) {
      return fetchFailed(tooLargeReply(fileInfo.file_size, cap))
    }
    const bytes = yield* fileTransport(fileInfo.file_path).pipe(
      Effect.timeoutFail({
        duration: "60 seconds",
        onTimeout: () => new Error("download timed out"),
      }),
      Effect.either,
    )
    if (Either.isLeft(bytes)) {
      return fetchFailed(
        `⚠️ I couldn't download that file (${bytes.left.message}). Please try sending it again.`,
      )
    }
    if (bytes.right.byteLength === 0) {
      return fetchFailed("⚠️ That file came back empty from Telegram. Please try sending it again.")
    }
    if (bytes.right.byteLength > cap) {
      return fetchFailed(tooLargeReply(bytes.right.byteLength, cap))
    }
    // Verify the bytes against the declared type; correct a misnamed file
    // when the actual type is itself ingestible (report.pdf that is really a
    // JPEG becomes an image block instead of a mid-turn Anthropic rejection).
    const sniffed = sniffMediaType(bytes.right)
    let mediaType = ref.mediaType
    if (sniffed !== ref.mediaType) {
      if (sniffed === null || !ALLOWED_ATTACHMENT_MEDIA_TYPES.has(sniffed)) {
        return fetchFailed(
          `⚠️ That file's content doesn't match a type I can read. ${SUPPORTED_TYPES_HINT}`,
        )
      }
      mediaType = sniffed
      // The corrected type may carry a smaller cap (PDF-labelled JPEG:
      // 20 MB claimed cap, 10 MB actual image cap).
      const correctedCap = attachmentByteCap(sniffed)
      if (bytes.right.byteLength > correctedCap) {
        return fetchFailed(tooLargeReply(bytes.right.byteLength, correctedCap))
      }
    }
    return {
      _tag: "ok",
      attachment: {
        mediaType,
        data: Buffer.from(bytes.right).toString("base64"),
      },
    } satisfies AttachmentFetchOutcome
  }).pipe(
    // A dying injected transport (or any defect) must not kill the poll loop.
    Effect.catchAllCause(() =>
      Effect.succeed(
        fetchFailed("⚠️ Something went wrong downloading that file. Please try sending it again."),
      ),
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
  /**
   * Override the raw file-download transport for testing (getFile's second
   * step — fetching bytes from /file/bot<token>/<file_path>). When omitted the
   * adapter constructs the real one from the resolved token. When neither a
   * fileTransport nor a token is available (e.g. a test injecting only
   * httpTransport), inbound attachments fail gracefully with a user-facing
   * reply instead of being dropped.
   */
  readonly fileTransport?: TelegramFileTransport
  /**
   * Optional inbound allowlist — the ONLY authentication in front of Luna over
   * Telegram. When provided and non-empty, an inbound message is accepted iff
   * its sender id (`message.from.id`) OR its chat id (`message.chat.id`),
   * stringified, is in this set; every other message is silently dropped.
   *
   * The union of sender AND chat id is deliberate. Telegram user ids are
   * positive and group/supergroup/channel chat ids are negative, so one flat
   * list unambiguously authorizes both a DM user (list their positive user id)
   * and a whole group (list the group's negative chat id — every member of that
   * group is then served, which is the intended multi-user group experience).
   *
   * When omitted or empty the bot accepts messages from ANY Telegram user
   * (fail-open), so an unconfigured install is never bricked. Once any id is
   * present the gate is fail-closed for everyone else.
   */
  readonly allowedIds?: Iterable<string>
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

  // Raw file-download transport (attachments). Same lifecycle as
  // resolvedTransport: injected at construction (tests) or built from the
  // resolved token in start() (production). Stays null when neither exists —
  // attachment fetches then fail gracefully with a user-facing reply.
  let resolvedFileTransport: TelegramFileTransport | null =
    config.fileTransport !== undefined ? config.fileTransport : null

  // Inbound allowlist (union gate). null when unconfigured; an empty set also
  // means "open" (fail-open). See TelegramAdapterConfig.allowedIds for the
  // sender-OR-chat union rationale and the positive/negative id convention.
  const allowedIds: ReadonlySet<string> | null =
    config.allowedIds !== undefined ? new Set(config.allowedIds) : null
  // Shared by isInboundAllowed (messages) and the callback-query handler
  // (button taps) — the SAME allowlist gate, not a parallel copy, so a tap
  // is never trusted on any weaker basis than a typed message would be.
  const isIdAllowedPair = (senderId: string, channelId: string): boolean =>
    allowedIds === null ||
    allowedIds.size === 0 ||
    allowedIds.has(senderId) ||
    allowedIds.has(channelId)
  const isInboundAllowed = (msg: ChannelMessage): boolean =>
    isIdAllowedPair(msg.senderId, msg.channelId)
  // Rate-limit drop logging to the first hit per (chatId:senderId) so a busy
  // open group or a spammer cannot flood the log.
  const loggedDrops = new Set<string>()

  // stream-edit state: inbound platformMessageId → sent Telegram message_id.
  // One entry per active turn; cleaned up on isFinal.
  const sentMessageIds = new Map<string, number>()

  // Bound on concurrent attachment downloads. Media units run as forked
  // fibers off the poll loop; the semaphore keeps a photo flood from turning
  // into unbounded parallel 20 MB downloads (it degrades to queuing instead).
  const downloadSemaphore = Effect.unsafeMakeSemaphore(3)

  // Per-chat FIFO dispatch. Media units run off the poll fiber (so downloads
  // never starve other chats), but messages for the SAME chat must reach the
  // handler in arrival order — "here's the PDF" followed by "please summarize
  // it" must not deliver the text before the attachment. Each chat keeps a
  // chain of fibers: a new unit awaits the previous one, so same-chat order
  // is strict while different chats stay fully concurrent. Entries are
  // removed when their chain drains, so the map stays bounded by the number
  // of chats with in-flight work.
  const chatChains = new Map<string, Fiber.RuntimeFiber<void, never>>()
  const dispatchChained = (chatId: string, unit: Effect.Effect<void>): void => {
    const safeUnit = unit.pipe(
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          try {
            console.warn(
              `[luna/channels] telegram: dispatch unit failed for chat=${chatId}: ` +
                Cause.pretty(cause),
            )
          } catch {
            // logging must never fail the chain
          }
        }),
      ),
    )
    const prev = chatChains.get(chatId)
    const chained =
      prev === undefined
        ? safeUnit
        : Fiber.await(prev).pipe(Effect.andThen(safeUnit))
    const fiber = Effect.runFork(chained)
    chatChains.set(chatId, fiber)
    fiber.addObserver(() => {
      if (chatChains.get(chatId) === fiber) chatChains.delete(chatId)
    })
  }

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

  /**
   * Envelope pairing the normalized message with its media classification.
   * Classification runs ONCE here — the metadata stamp and the poll loop's
   * download decision both derive from the same value, so they cannot desync.
   */
  interface BuiltInbound {
    readonly msg: ChannelMessage
    readonly media: InboundMediaRef | null
  }

  const buildChannelMessage = (update: TelegramUpdate): BuiltInbound | null => {
    const msg = update.message
    if (msg === undefined) return null          // non-message update (callback, etc.)
    const media = classifyInboundMedia(msg)
    // Accept text messages AND recognized media (photo/document/voice/…).
    // Media messages carry their user text in `caption`; service-membership
    // updates and other exotic message kinds still fall through to null.
    if (msg.text === undefined && media === null) return null
    if (msg.from === undefined) return null     // channels have no `from`; skip

    const chatId = String(msg.chat.id)
    // Forum-topic scoping: each topic in a forum-mode supergroup gets its
    // own Luna thread. Gated strictly on chat.is_forum — DMs and plain
    // (non-forum) groups are byte-identical to before (no migration).
    const forumTopicId = forumTopicIdFor(msg.chat, msg.is_topic_message, msg.message_thread_id)

    const channelMsg: ChannelMessage = {
      transport: "telegram" as const,
      channelId: chatId,
      senderId: String(msg.from.id),
      // Threading policy: both DMs and groups key on chat.id, EXCEPT forum
      // topics, which key on (chat.id, message_thread_id) — see
      // forumTopicIdFor/threadingKeyFor above.
      // - private chat: chat.id === from.id → one thread per user-bot pair.
      // - group/supergroup: chat.id is the group → all members share one thread.
      // - forum topic: chat.id + topic id → one thread PER TOPIC.
      threadingKey: threadingKeyFor(chatId, forumTopicId),
      text: msg.text ?? msg.caption ?? "",
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
        // Threaded through outbound sends (sendMessage/sendChatAction) so
        // typing indicators and multi-chunk replies land in the same topic.
        ...(forumTopicId !== undefined ? { messageThreadId: forumTopicId } : {}),
        ...(media?._tag === "file"
          ? {
              attachmentMediaType: media.mediaType,
              ...(media.fileName !== undefined ? { attachmentFileName: media.fileName } : {}),
            }
          : {}),
      },
    }
    return { msg: channelMsg, media }
  }

  /* ------------------------------------------------------------------------ */
  /* Typing indicator                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Begin the "typing…" refresh loop for a chat (idempotent per chat). Runs
   * as an independent runFork root — pollOnce's fiber completes every poll
   * cycle, so a child fiber would be auto-interrupted immediately.
   *
   * Returns true iff THIS call created the fiber. The fiber is shared per
   * chat, so a caller that wants to cancel it on failure must only do so
   * when it was the creator — otherwise a failed download would kill the
   * indicator an earlier still-in-flight turn depends on.
   */
  /**
   * Typing fibers are keyed per (chat, forum-topic) so two topics in the
   * same forum chat can each show their own indicator instead of one topic
   * silently suppressing the other's (typingFibers.has(chatId) would
   * otherwise be true from an unrelated topic's in-flight turn).
   */
  const typingKey = (chatId: string, messageThreadId: number | undefined): string =>
    messageThreadId !== undefined ? `${chatId}:${messageThreadId}` : chatId

  const startTyping = (
    transport: TelegramHttpTransport,
    chatId: string,
    messageThreadId?: number,
  ): boolean => {
    if (typingSwept) return false
    const key = typingKey(chatId, messageThreadId)
    if (typingFibers.has(key)) return false
    const loop = Effect.gen(function* () {
      for (let i = 0; i < TYPING_MAX_REFRESHES; i++) {
        yield* transport("sendChatAction", {
          chat_id: chatId,
          action: "typing",
          ...(messageThreadId !== undefined ? { message_thread_id: messageThreadId } : {}),
        })
        yield* Effect.sleep(`${TYPING_REFRESH_MS} millis`)
      }
    })
    const fiber = Effect.runFork(loop)
    typingFibers.set(key, fiber)
    fiber.addObserver(() => {
      if (typingFibers.get(key) === fiber) typingFibers.delete(key)
    })
    return true
  }

  /** Stop the typing loop for a chat/topic (first reply supersedes it). */
  const stopTyping = (chatId: string, messageThreadId?: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      const key = typingKey(chatId, messageThreadId)
      const fiber = typingFibers.get(key)
      if (fiber === undefined) return Effect.void
      typingFibers.delete(key)
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
          allowed_updates: ["message", "callback_query"],
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

          // Inline-button taps (tap-to-stop). Handled OUTSIDE the per-chat
          // FIFO chain (dispatchChained/chatChains) deliberately: a stop
          // must reach ChatService.interrupt immediately, never queued
          // behind the very turn it exists to interrupt.
          if (update.callback_query !== undefined) {
            const cb = update.callback_query
            // Answer every callback query immediately regardless of
            // allowlist outcome — Telegram expires an unanswered callback
            // after ~10s ("query is too old") and answering only dismisses
            // the tapper's client-side loading spinner; it reveals nothing.
            Effect.runFork(
              transport("answerCallbackQuery", { callback_query_id: cb.id }).pipe(
                Effect.asVoid,
                Effect.catchAllCause(() => Effect.void),
              ),
            )
            const cbMessage = cb.message
            if (cb.data === STOP_CALLBACK_DATA && cbMessage !== undefined && messageHandler !== null) {
              const cbChatId = String(cbMessage.chat.id)
              const cbSenderId = String(cb.from.id)
              // Gate through the SAME allowlist as messages — callback_data
              // is attacker-controlled and never trusted on its own, and in
              // groups any member can tap a button.
              if (isIdAllowedPair(cbSenderId, cbChatId)) {
                const cbForumTopicId = forumTopicIdFor(
                  cbMessage.chat,
                  undefined,
                  cbMessage.message_thread_id,
                )
                const stopMsg: ChannelMessage = {
                  transport: "telegram" as const,
                  channelId: cbChatId,
                  senderId: cbSenderId,
                  threadingKey: threadingKeyFor(cbChatId, cbForumTopicId),
                  // Synthesized /stop reuses the EXISTING commands.ts path
                  // (dedup, allowlist, "⏹ Stopped." delivery) rather than a
                  // new interrupt code path.
                  text: "/stop",
                  // Derived from the callback's own update_id so dedup
                  // (keyed on (transport, platformMessageId)) treats this
                  // consistently with a typed message.
                  platformMessageId: String(update.update_id),
                  ts: new Date().toISOString(),
                  metadata: {
                    chatType: cbMessage.chat.type,
                    messageId: cbMessage.message_id,
                    userId: cb.from.id,
                    username: cb.from.username,
                    firstName: cb.from.first_name,
                    ...(cbForumTopicId !== undefined ? { messageThreadId: cbForumTopicId } : {}),
                  },
                }
                Effect.runFork(messageHandler(stopMsg))
              }
            }
            continue
          }

          const built = buildChannelMessage(update)
          if (built === null) continue   // non-ingestible or non-message update
          const { msg: channelMsg, media } = built

          // Inbound allowlist gate. Accept iff the sender id OR the chat id is
          // allowlisted (union — see config.allowedIds); otherwise silently
          // drop. Silent is deliberate: replying would confirm the bot exists
          // to strangers. The offset was already advanced above, so a rejected
          // update is consumed, not re-polled, and cannot wedge the loop. Drop
          // logging is rate-limited to the first hit per (chat, sender).
          // Media sits BEHIND this gate too: no getFile call or download
          // bandwidth is ever spent on non-allowlisted senders.
          if (!isInboundAllowed(channelMsg)) {
            const dropKey = `${channelMsg.channelId}:${channelMsg.senderId}`
            if (!loggedDrops.has(dropKey)) {
              loggedDrops.add(dropKey)
              console.warn(
                `[luna/channels] telegram: dropped message from non-allowlisted ` +
                  `sender=${channelMsg.senderId} chat=${channelMsg.channelId} ` +
                  `(chatType=${String(channelMsg.metadata?.["chatType"] ?? "?")})`,
              )
            }
            continue
          }

          // Group command addressing applies ONLY to true text messages:
          // strip our own "@BotName" mention from "/verb@BotName"; drop
          // commands addressed to a DIFFERENT bot. Media captions are user
          // text for the LLM, never channel commands — running the null-drop
          // on a caption would silently discard the photo/PDF it rides on
          // (the exact failure mode this path exists to kill).
          let msg = channelMsg
          if (media === null) {
            const normalizedText = normalizeCommandMention(channelMsg.text, botUsername)
            if (normalizedText === null) continue
            if (normalizedText !== channelMsg.text) {
              msg = { ...channelMsg, text: normalizedText }
            }
          }

          if (media !== null && media._tag === "unsupported") {
            // Explain instead of silently dropping (a silent drop makes the
            // agent deny ever receiving the file). dmOnly media (voice,
            // video, GIFs) stays silent in groups — ambient chatter, not bot
            // input. Forked: a hung sendMessage must not stall the poll loop.
            // NB: replies are at-least-once — a crash between this reply and
            // the next getUpdates offset confirm can repeat one batch.
            const isPrivate = channelMsg.metadata?.["chatType"] === "private"
            if (media.userReply !== null && (isPrivate || !media.dmOnly)) {
              const unsupportedMsgThreadId = msg.metadata?.["messageThreadId"] as number | undefined
              Effect.runFork(
                sendFormatted(
                  transport,
                  "sendMessage",
                  {
                    chat_id: msg.channelId,
                    ...(unsupportedMsgThreadId !== undefined
                      ? { message_thread_id: unsupportedMsgThreadId }
                      : {}),
                  },
                  media.userReply,
                ).pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.sync(() => {
                      try {
                        console.warn(
                          `[luna/channels] telegram: unsupported-media reply failed ` +
                            `for chat=${msg.channelId}: ` + Cause.pretty(cause),
                        )
                      } catch {
                        // logging must never fail the fiber
                      }
                    }),
                  ),
                ),
              )
            }
            continue
          }

          if (media !== null) {
            // Fork the whole media unit of work (download → reply-or-dispatch)
            // off the poll fiber, onto the same per-chat FIFO chain as the
            // handler dispatch below. Inline it would serialize up-to-60s
            // downloads in front of getUpdates — one slow CDN or an
            // allowlisted spammer would starve EVERY chat's inbound,
            // including the pager path.
            // The semaphore bounds concurrent downloads so a flood degrades
            // to queuing, never to poll-loop starvation or unbounded memory.
            const mediaMsg = msg
            const mediaMsgThreadId = mediaMsg.metadata?.["messageThreadId"] as number | undefined
            const mediaUnit = Effect.gen(function* () {
              // Typing indicator covers the download — a 20 MB PDF on a slow
              // link takes seconds and the user should see the bot working.
              const createdTyping = startTyping(transport, mediaMsg.channelId, mediaMsgThreadId)
              // Best-effort "I'm on it" reaction on the Chairman's own
              // inbound message — fire-and-forget, never blocks the download.
              const mediaMessageId = mediaMsg.metadata?.["messageId"]
              if (typeof mediaMessageId === "number") {
                Effect.runFork(reactWorking(transport, mediaMsg.channelId, mediaMessageId))
              }
              const outcome = yield* downloadSemaphore.withPermits(1)(
                fetchTelegramAttachment(transport, resolvedFileTransport, media),
              )
              if (outcome._tag === "failed") {
                // Only cancel the typing fiber this unit created — an earlier
                // in-flight turn in the same chat may still own it.
                if (createdTyping) yield* stopTyping(mediaMsg.channelId, mediaMsgThreadId)
                // At-least-once (see unsupported-reply note above).
                yield* sendFormatted(
                  transport,
                  "sendMessage",
                  {
                    chat_id: mediaMsg.channelId,
                    ...(mediaMsgThreadId !== undefined ? { message_thread_id: mediaMsgThreadId } : {}),
                  },
                  outcome.userReply,
                )
                return
              }
              if (messageHandler !== null) {
                yield* messageHandler({ ...mediaMsg, attachments: [outcome.attachment] })
              }
            })
            // Chained per chat: a follow-up text in the same chat queues
            // behind this download instead of racing past it.
            dispatchChained(mediaMsg.channelId, mediaUnit)
            continue
          }

          // Loading indication: show "typing…" until the first reply (the
          // placeholder or a step-indicator edit) lands for this chat.
          const msgThreadId = msg.metadata?.["messageThreadId"] as number | undefined
          startTyping(transport, msg.channelId, msgThreadId)
          // Best-effort "I'm on it" reaction on the Chairman's own inbound
          // message — fire-and-forget, never blocks dispatch.
          const inboundMessageIdForReaction = msg.metadata?.["messageId"]
          if (typeof inboundMessageIdForReaction === "number") {
            Effect.runFork(reactWorking(transport, msg.channelId, inboundMessageIdForReaction))
          }

          if (messageHandler !== null) {
            // Per-chat FIFO dispatch (fire-and-forget relative to the poll
            // loop): the installed handler is a pure Effect<void> closure
            // over all service dependencies. Same-chat messages run in
            // arrival order behind any in-flight media download; a chat with
            // no in-flight work dispatches immediately, and different chats
            // never wait on each other.
            const handlerMsg = msg
            dispatchChained(handlerMsg.channelId, messageHandler(handlerMsg))
          }
        }

        return nextOffset
      })

    // Continuous poll: keeps calling pollOnce, advancing the offset.
    // Never returns normally; only stops on interruption.
    const loop: Effect.Effect<never, never> = Effect.gen(function* () {
      const offset = yield* Ref.get(offsetRef)
      const nextOffset = yield* pollOnce(offset).pipe(
        // Log each transient failure before backing off, so a stalled poll loop
        // is visible instead of silent (previously every getUpdates error was
        // swallowed with no trace). A 409 Conflict specifically means another
        // getUpdates consumer is polling this bot token (a second server
        // instance or a leaked webhook) and will NOT clear on its own — flag it
        // distinctly. Logging only; the retry/offset behavior is unchanged.
        Effect.tapErrorCause((cause) =>
          Effect.sync(() => {
            const text = Cause.pretty(cause)
            if (/\b409\b/.test(text) || text.toLowerCase().includes("conflict")) {
              console.warn(
                `[luna/channels] telegram: getUpdates 409 Conflict — another poller ` +
                  `is consuming this bot token (second instance or leaked webhook); ` +
                  `retrying with backoff. ${text}`,
              )
            } else {
              console.warn(
                `[luna/channels] telegram: getUpdates failed, retrying with backoff: ${text}`,
              )
            }
          }),
        ),
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
        // Resolve the token once for both transports (method calls + raw file
        // downloads). Prefer the pre-resolved Redacted token from config; fall
        // back to env. May be null when a test injects transports directly.
        const redactedToken: Redacted.Redacted<string> | null =
          config.token !== undefined
            ? config.token
            : (() => {
                const raw = process.env["TELEGRAM_BOT_TOKEN"]
                if (!raw || raw.trim().length === 0) return null
                return Redacted.make(raw)
              })()

        // Resolve the HTTP transport.
        // Priority: injected httpTransport (tests) > config.token (production)
        // > env var fallback (production legacy).
        if (config.httpTransport !== undefined) {
          resolvedTransport = config.httpTransport
        } else if (resolvedTransport === null) {
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

        // Resolve the file-download transport (attachments). Stays null when
        // neither an injected fileTransport nor a token exists — attachment
        // fetches then fail gracefully with a user-facing reply.
        if (resolvedFileTransport === null && redactedToken !== null) {
          resolvedFileTransport = makeRealFileTransport(redactedToken)
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

        // Forum-topic routing: service.ts's buildDeliveryTarget spreads
        // msg.metadata into address, so messageThreadId (set on inbound
        // forum-topic messages) rides along here. Only sendMessage (new
        // message) needs it — editMessageText targets an existing
        // message_id whose topic is already fixed.
        const deliverThreadId = target.address["messageThreadId"] as number | undefined
        const threadParams =
          deliverThreadId !== undefined ? { message_thread_id: deliverThreadId } : {}

        // Anything we send supersedes the "typing…" loading indication.
        yield* stopTyping(chatId, deliverThreadId)

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

        // Tap-to-stop keyboard: attached ONLY while the turn is still
        // partial. Telegram drops a keyboard on any edit that omits
        // reply_markup, so this must be threaded through every partial
        // edit; it is OMITTED on the final chunk / interrupt's final edit
        // so the button disappears once there's nothing left to stop. A
        // stale tap after that point still resolves through commands.ts
        // (interrupt is a no-op on an idle thread) — an accepted minor
        // edge case, not a blocker.
        const keyboardParams = opts.isPartial ? { reply_markup: STOP_KEYBOARD } : {}

        // Continuation chunks of a long final answer (chunkIndex > 0) are
        // always their own fresh messages — never edits of the placeholder.
        if (opts.chunkIndex > 0) {
          yield* sendFormatted(
            transport,
            "sendMessage",
            { chat_id: chatId, ...threadParams, ...keyboardParams },
            content,
          )
          return
        }

        if (existingMsgId === undefined) {
          // First send of the turn (placeholder, a status-first turn, a
          // command reply, or a recovery after an earlier failed send).
          const result = yield* sendFormatted(
            transport,
            "sendMessage",
            { chat_id: chatId, ...replyParams, ...threadParams, ...keyboardParams },
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
            { chat_id: chatId, message_id: existingMsgId, ...keyboardParams },
            content,
          )
        }
      })
    },
  }

  return adapter
}
