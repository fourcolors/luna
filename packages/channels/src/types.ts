/**
 * packages/channels — domain types.
 *
 * This package is the inbound/outbound seam between external communication
 * platforms (Discord, Telegram, Slack, …) and Luna's ChatService. It is a
 * PURE DOWNSTREAM CONSUMER: it subscribes to the existing
 * `chat.subscribe(threadId)` ChatFrame stream exactly as ui-ws does, and
 * adapts that stream to each platform's delivery capability.
 *
 * Nothing in this package modifies chat-service, ui-ws, or the boot path.
 */
import { Data } from "effect"

/* -------------------------------------------------------------------------- */
/* Transport identity                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Identifies the external platform this message originated from.
 * Mirrors core/gateway TransportKind but defined locally so packages/channels
 * has no dependency on the dormant gateway seam.
 */
export type TransportKind = "discord" | "telegram" | "slack" | "cli" | "http" | string

/* -------------------------------------------------------------------------- */
/* Inbound                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalized inbound message from any platform.
 *
 * `threadingKey` is the policy knob for thread routing:
 *   - DM / 1-1 conversation: omit threadingKey (or set to senderId).
 *     The session-map creates a PERSISTENT per-peer thread.
 *   - Group channel / room: set threadingKey to the channel's own id (or a
 *     sub-topic id) so the whole group shares one Luna thread. The value
 *     lives in the session-map as the lookup discriminant alongside
 *     (transport, channelId).
 *
 * `platformMessageId` is used by dedup.ts to suppress at-least-once
 * redeliveries (long-poll retry, webhook retry). Must be platform-globally
 * unique within a (transport, channelId) scope — use the platform's own
 * message-id field (Telegram message_id, Discord snowflake, etc.).
 */
/**
 * Inline binary attachment (image or PDF) carried with an inbound message.
 * `data` is raw base64 (no `data:` URI prefix). The shape deliberately mirrors
 * the `attachments` parameter of `ChatService.send` so the service can pass
 * attachments straight through — chat-service turns them into Anthropic
 * image/document content blocks.
 */
export interface ChannelAttachment {
  /** MIME type: image/jpeg, image/png, image/gif, image/webp, application/pdf. */
  readonly mediaType: string
  /** Raw base64 payload (no data: prefix). */
  readonly data: string
}

export interface ChannelMessage {
  /** Which platform sent this. */
  readonly transport: TransportKind
  /** Channel / chat / room identifier within the transport. */
  readonly channelId: string
  /** User or bot identifier within the transport. */
  readonly senderId: string
  /**
   * Threading discriminant. Optional — when absent the session-map defaults
   * to channelId (suitable for DMs where channelId is already unique per
   * peer). For group channels, pass the channel id or topic id explicitly.
   */
  readonly threadingKey?: string
  /** Plain text content (media messages carry their caption here, or ""). */
  readonly text: string
  /**
   * Inline binary attachments downloaded by the adapter (images / PDFs).
   * Optional — text-only messages omit it. At most a handful per message;
   * adapters enforce per-type size caps before populating this.
   */
  readonly attachments?: ReadonlyArray<ChannelAttachment>
  /**
   * Platform-assigned message id for dedup. Must be stable across retries.
   * Long-poll adapters and webhook adapters that retry on failure will see
   * the same message twice; dedup.ts drops the second delivery.
   */
  readonly platformMessageId: string
  /** Wall-clock timestamp (ISO-8601 or ms epoch). */
  readonly ts: string
  /** Adapter-specific extras (Telegram update_id, Discord guild_id, …). */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/* -------------------------------------------------------------------------- */
/* Delivery capability                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Declares how a platform can receive agent output.
 *
 * `stream-edit`     — The platform supports in-place message editing
 *   (Telegram Bot API editMessageText, Discord PATCH message). The adapter
 *   delivers a placeholder message then edits it as deltas arrive, throttled
 *   to respect platform rate limits. Finalizes on turn-complete.
 *
 * `discrete-chunks` — The platform accepts multiple sends but cannot edit.
 *   The adapter delivers on natural boundaries (per assistant-done message
 *   or paragraph), each chunk split to maxMessageLength.
 *
 * `final-only`      — The platform prefers a single, complete reply (HTTP
 *   webhooks, CLI oneshot, email). The adapter buffers the entire turn and
 *   delivers once, split into maxMessageLength chunks only when needed.
 */
export type DeliveryCapability = "stream-edit" | "discrete-chunks" | "final-only"

/* -------------------------------------------------------------------------- */
/* Adapter interface                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Delivery target returned by `ChannelAdapter.resolveTarget`.
 * Opaque to the delivery layer — the adapter knows its own addressing.
 * Using an opaque record keeps delivery.ts free of per-platform types.
 */
export interface DeliveryTarget {
  /** Original inbound message this reply addresses. */
  readonly inReplyTo: ChannelMessage
  /** Adapter-specific routing info (chat_id, channel_id, reply_to_id, …). */
  readonly address: Readonly<Record<string, unknown>>
}

/**
 * Options passed to `ChannelAdapter.deliver`.
 * `isPartial` — true while the turn is still in-flight (stream-edit mode).
 * `isFinal`   — true on the last chunk of a completed turn.
 * `chunkIndex`/ `totalChunks` — populated when a single response had to be
 *   split across multiple messages (maxMessageLength exceeded).
 */
export interface DeliverOptions {
  readonly isPartial: boolean
  readonly isFinal: boolean
  readonly chunkIndex: number
  readonly totalChunks: number
}

/**
 * ChannelAdapter — the surface a platform author implements.
 *
 * CONTRACT for implementors:
 *
 * 1. `id` — unique slug for this adapter instance (e.g. "telegram-main").
 * 2. `transport` — platform kind (e.g. "telegram").
 * 3. `capability` — how this platform accepts output (see DeliveryCapability).
 * 4. `maxMessageLength` — hard per-message character limit enforced by
 *    delivery.ts before calling `deliver`. Telegram = 4096, Discord = 2000,
 *    Slack = 40000.
 * 5. `start()` — called once by ChannelService. The adapter OWNS its
 *    connection: it must set up polling/webhook listeners, handle reconnection
 *    with exponential backoff, and forward every inbound message to the
 *    `onMessage` callback registered via `setMessageHandler`. Must resolve
 *    when ready; interrupt on Scope close (Effect.addFinalizer for teardown).
 * 6. `stop()` — graceful shutdown (close connections, cancel timers).
 * 7. `setMessageHandler(cb)` — ChannelService calls this once (before start)
 *    to install the inbound routing callback. The adapter fires it for every
 *    received ChannelMessage. The callback returns an Effect — the adapter
 *    may await it or fire-and-forget; fire-and-forget is fine for platforms
 *    that have no back-pressure.
 * 8. `deliver(target, content, opts)` — called by the delivery layer. Must
 *    not throw; errors are caught by delivery.ts. For `stream-edit`, the
 *    adapter should create a message on the first call (`isPartial=true,
 *    chunkIndex=0`) and edit it on subsequent partials. The `address` field
 *    in `target` carries whatever routing the adapter needs.
 *
 * Design for diversity: a long-poll adapter (Telegram getUpdates) blocks
 * inside `start()` in a forked fiber. A webhook adapter (Telegram webhook
 * mode) registers an HTTP handler inside `start()`. A WebSocket adapter
 * (Discord) opens a gateway connection inside `start()`. All three patterns
 * fit this interface because `start()` runs inside an Effect Scope and the
 * adapter can fork sub-fibers that tear down with the Scope.
 */
export interface ChannelAdapter {
  /** Unique adapter instance id (e.g. "telegram-bot-1"). */
  readonly id: string
  /** Platform transport kind. */
  readonly transport: TransportKind
  /** Platform delivery capability. */
  readonly capability: DeliveryCapability
  /** Hard per-message character limit for this platform. */
  readonly maxMessageLength: number

  /**
   * Install the inbound message routing callback. Called by ChannelService
   * before `start()`. The callback is `Effect<void>` so the adapter can
   * optionally await processing (for back-pressure), but fire-and-forget
   * via `Effect.runFork` is equally valid.
   */
  readonly setMessageHandler: (
    handler: (msg: ChannelMessage) => import("effect").Effect.Effect<void>,
  ) => void

  /**
   * Lifecycle: start the adapter. The adapter OWNS reconnection logic here.
   * Runs inside an Effect Scope; add finalizers for teardown.
   */
  readonly start: () => import("effect").Effect.Effect<void, never, import("effect").Scope.Scope>

  /**
   * Lifecycle: stop the adapter gracefully. Called by ChannelService on
   * shutdown AFTER the Scope closes, as a belt-and-braces sweep.
   */
  readonly stop: () => import("effect").Effect.Effect<void>

  /**
   * Deliver content to a target on the platform. Called by delivery.ts.
   * For stream-edit adapters: create a new message on the first call
   * (isPartial && chunkIndex === 0), then edit it on subsequent partials,
   * and finalize on isFinal. The adapter keeps an internal message-id map
   * keyed by `target.inReplyTo.platformMessageId` for edit routing.
   */
  readonly deliver: (
    target: DeliveryTarget,
    content: string,
    opts: DeliverOptions,
  ) => import("effect").Effect.Effect<void>
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class ChannelError extends Data.TaggedError("ChannelError")<{
  readonly op: string
  readonly message: string
}> {}
