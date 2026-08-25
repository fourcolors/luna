/**
 * ChannelService — the orchestrator.
 *
 * Responsibilities:
 *   1. Register ChannelAdapter instances (one per platform/bot-token).
 *   2. Call each adapter's start() lifecycle when the service starts.
 *   3. Route inbound ChannelMessages through the pipeline:
 *        dedup → built-in slash commands → session lookupOrCreate →
 *        chat.send (text + any attachments) → spawn delivery fiber
 *      Attachment-carrying messages skip the slash-command step: their
 *      text is a media caption, never a command.
 *   4. Manage delivery fiber lifecycle: one fiber per (threadId, adapterId)
 *      pair; idempotent — a second inbound message on the same thread
 *      reuses the existing fiber (no double-fan-out).
 *   5. Call each adapter's stop() on service teardown.
 *
 * ChatService is an injected dependency (Context.Service). Tests supply a
 * stub via Layer so no real SDK subprocess is involved.
 *
 * Effect discipline follows packages/connectors/src/service.ts: Layer.effect
 * with Scope finalizers, Effect.gen throughout.
 */
import { Context, Effect, Fiber, Layer, Option, Ref, Scope } from "effect"
import { Clock } from "@luna/core"
import { ChatService } from "@luna/chat-service"
import type { ChannelAdapter, ChannelMessage, DeliveryTarget } from "./types.js"
import { ChannelSessionStore, lookupOrCreate } from "./session-map.js"
import { InboundDedupStore } from "./dedup.js"
import { subscribeAndDeliver } from "./delivery.js"
import { handleChannelCommand } from "./commands.js"

/* -------------------------------------------------------------------------- */
/* Service API                                                                 */
/* -------------------------------------------------------------------------- */

export interface ChannelServiceApi {
  /**
   * Register a ChannelAdapter. Must be called before `startAdapters()`.
   * Installs the inbound message handler on the adapter.
   */
  readonly registerAdapter: (adapter: ChannelAdapter) => Effect.Effect<void>

  /**
   * Start all registered adapters. Spawns one scoped fiber per adapter.
   * Must be called inside an Effect Scope (the service's own Scope handles
   * teardown of all adapter fibers on shutdown).
   */
  readonly startAdapters: () => Effect.Effect<void, never, Scope.Scope>

  /**
   * Stop all adapters (best-effort graceful shutdown). Called automatically
   * when the service Scope closes via a finalizer.
   */
  readonly stopAdapters: () => Effect.Effect<void>

  /**
   * Process an inbound ChannelMessage through the full pipeline:
   * dedup → session map → chat.send → delivery fiber.
   *
   * Returns false when the message is a duplicate (already seen). Returns
   * true when the message was accepted and a turn was initiated.
   */
  readonly handleMessage: (msg: ChannelMessage) => Effect.Effect<boolean>
}

export class ChannelService extends Context.Service<
  ChannelService,
  ChannelServiceApi
>()("luna/ChannelService") {}

const metadataString = (msg: ChannelMessage, key: string): string | undefined => {
  const value = msg.metadata?.[key]
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text.length > 0 ? text : undefined
}

const telegramGroupChatTypes = new Set(["group", "supergroup", "channel"])

const formatChannelSender = (msg: ChannelMessage): string => {
  const username = metadataString(msg, "username")
  const firstName = metadataString(msg, "firstName")
  const userId = metadataString(msg, "userId") ?? msg.senderId

  if (username !== undefined && userId.length > 0) return `@${username} (id: ${userId})`
  if (username !== undefined) return `@${username}`
  if (firstName !== undefined && userId.length > 0) return `${firstName} (id: ${userId})`
  if (firstName !== undefined) return firstName
  return `id: ${userId}`
}

const buildChannelUserText = (msg: ChannelMessage): string => {
  const chatType = metadataString(msg, "chatType")
  const isTelegramGroup =
    msg.transport === "telegram" &&
    chatType !== undefined &&
    telegramGroupChatTypes.has(chatType)

  if (!isTelegramGroup) return msg.text
  return `[telegram user: ${formatChannelSender(msg)}]\n${msg.text}`
}

/** Build the adapter delivery target for a reply to this inbound message. */
const buildDeliveryTarget = (msg: ChannelMessage): DeliveryTarget => ({
  inReplyTo: msg,
  address: {
    transport: msg.transport,
    channelId: msg.channelId,
    senderId: msg.senderId,
    threadingKey: msg.threadingKey,
    ...(msg.metadata ?? {}),
  },
})

/* -------------------------------------------------------------------------- */
/* Layer                                                                       */
/* -------------------------------------------------------------------------- */

export const ChannelServiceLayer: Layer.Layer<
  ChannelService,
  never,
  ChannelSessionStore | InboundDedupStore | ChatService | Clock
> = Layer.effect(
  ChannelService,
  Effect.gen(function* () {
    const sessionStore = yield* ChannelSessionStore
    const dedupStore = yield* InboundDedupStore
    const chat = yield* ChatService
    const clock = yield* Clock
    const serviceScope = yield* Effect.scope

    // Registered adapters (mutable, set before startAdapters)
    const adapters = yield* Ref.make<ReadonlyArray<ChannelAdapter>>([])

    // Ids of adapters whose start() has already been forked, so a second
    // startAdapters() call is a no-op for them. See startAdapters below.
    const startedAdapterIds = yield* Ref.make<ReadonlySet<string>>(new Set())

    // Active delivery fibers: (threadId:adapterId) → Fiber
    // One fiber per (thread, adapter) pair. Idempotent — the second inbound
    // on the same thread+adapter reuses the existing fiber.
    const deliveryFibers = yield* Ref.make<
      ReadonlyMap<string, Fiber.Fiber<void, never>>
    >(new Map())

    // ── Inbound message pipeline ────────────────────────────────────────────

    const handleMessage: ChannelServiceApi["handleMessage"] = (msg: ChannelMessage) =>
      Effect.gen(function* () {
        // 1. Dedup — drop at-least-once redeliveries.
        // seenBefore guard is up-front as before. markSeen is moved to AFTER
        // chat.send() returns and ONLY when send returns Option.some (i.e. the
        // message was accepted and persisted). If send() returns Option.none
        // (Case C: unknown thread, or store failure), we do NOT mark seen so
        // the adapter can redeliver. This closes the at-most-once hole that the
        // old "mark before send" approach had: a dropped message was permanently
        // suppressed even though it was never actually processed.
        const isDup = yield* dedupStore.seenBefore(msg.transport, msg.platformMessageId)
        if (isDup) return false
        const nowMs = yield* clock.nowMs()

        // 1.5. Built-in slash commands (/new, /stop, /help, /start) are
        // answered at the channel level and never reach the LLM. Unknown
        // "/verb" text falls through so Luna's own skills handle it. The
        // reply is delivered directly through this transport's adapter(s)
        // as a single final message.
        //
        // A message CARRYING ATTACHMENTS never takes the command path: its
        // text is a media caption (e.g. a photo captioned "/new"), and the
        // short-circuit would silently discard the already-downloaded file —
        // the caption goes to the LLM as plain text instead.
        const hasAttachments = msg.attachments !== undefined && msg.attachments.length > 0
        const command = hasAttachments
          ? { handled: false as const }
          : yield* handleChannelCommand(msg).pipe(
          Effect.provide(
            Layer.succeed(ChannelSessionStore, sessionStore).pipe(
              Layer.merge(Layer.succeed(ChatService, chat)),
            ),
          ),
        )
        if (command.handled) {
          if (command.reply !== undefined) {
            const adapterList = yield* Ref.get(adapters)
            const target = buildDeliveryTarget(msg)
            for (const adapter of adapterList) {
              if (adapter.transport !== msg.transport) continue
              yield* adapter
                .deliver(target, command.reply, {
                  isPartial: false,
                  isFinal: true,
                  chunkIndex: 0,
                  totalChunks: 1,
                })
                .pipe(Effect.catchCause(() => Effect.void))
            }
          }
          return true
        }

        // 2. Session map — get or create a Luna thread for this channel
        const threadId = yield* lookupOrCreate(msg).pipe(
          Effect.provide(
            Layer.succeed(ChannelSessionStore, sessionStore).pipe(
              Layer.merge(Layer.succeed(ChatService, chat)),
              Layer.merge(Layer.succeed(Clock, clock)),
            ),
          ),
        )

        // 3. Send the user message to the thread.
        // markSeen is deferred to after send() so a dropped message (Case C
        // unknown thread, or store failure) is not permanently suppressed —
        // the adapter can redeliver it on the next attempt.
        // Attachments (images/PDFs downloaded by the adapter) pass straight
        // through — chat-service turns them into Anthropic content blocks.
        const sendResult = yield* chat.send(threadId, buildChannelUserText(msg), msg.attachments)
        if (Option.isSome(sendResult)) {
          yield* dedupStore.markSeen(msg.transport, msg.platformMessageId, nowMs)
        }
        // If send returned Option.none (thread unknown after reap — Case C),
        // we do NOT mark seen. The adapter will redeliver the message and
        // the next attempt may succeed once the service is healthy.

        // 4. Spawn a delivery fiber per (threadId, adapter) — idempotent
        const adapterList = yield* Ref.get(adapters)
        for (const adapter of adapterList) {
          // Only the adapter owning this transport may deliver. Without this
          // guard every registered adapter forks a delivery fiber for every
          // turn, so a Discord turn is also pushed at Telegram (and vice
          // versa) using a foreign id - silently failing on every message.
          // The command-reply path above already filters this way.
          if (adapter.transport !== msg.transport) continue
          const fiberKey = `${threadId}:${adapter.id}`
          const fibers = yield* Ref.get(deliveryFibers)
          if (!fibers.has(fiberKey)) {
            // Build the delivery target from the inbound message
            const target = buildDeliveryTarget(msg)

            // Spawn delivery fiber into the service scope so it survives the
            // inbound handler's transient runFork root fiber. Without forkIn
            // (serviceScope), auto-supervision would interrupt the delivery
            // fiber as soon as the root fiber of Effect.runFork completes —
            // before any ChatFrame is consumed and no reply ever delivered.
            const fiber = yield* subscribeAndDeliver(threadId, adapter, target, serviceScope).pipe(
              Effect.provide(Layer.succeed(ChatService, chat)),
              Effect.orDie,
            )

            yield* Ref.update(deliveryFibers, (m) => {
              const next = new Map(m)
              next.set(fiberKey, fiber)
              return next
            })

            // When the fiber finishes naturally, remove it from the map
            // so the next inbound on the same thread+adapter re-forks.
            fiber.addObserver(() => {
              Effect.runFork(
                Ref.update(deliveryFibers, (m) => {
                  if (m.get(fiberKey) !== fiber) return m
                  const next = new Map(m)
                  next.delete(fiberKey)
                  return next
                }),
              )
            })
          }
        }

        return true
      })

    // ── Adapter lifecycle ────────────────────────────────────────────────────

    const registerAdapter: ChannelServiceApi["registerAdapter"] = (adapter) =>
      Effect.gen(function* () {
        // Install the inbound handler before the adapter starts.
        // The adapter will call this callback for each received message.
        adapter.setMessageHandler((msg) => handleMessage(msg).pipe(Effect.asVoid))
        yield* Ref.update(adapters, (list) => [...list, adapter])
      })

    const startAdapters: ChannelServiceApi["startAdapters"] = () =>
      Effect.gen(function* () {
        const adapterList = yield* Ref.get(adapters)
        for (const adapter of adapterList) {
          // Idempotent per adapter id. Boot registers adapters in SEPARATE
          // blocks (telegram, then discord) and each block calls
          // startAdapters(), so without this guard the second call re-forks
          // every adapter the first one already started. Two gateway
          // connections on one bot token means 409-flapping long-polls for
          // Telegram and an immediately-closed duplicate session for Discord.
          const started = yield* Ref.get(startedAdapterIds)
          if (started.has(adapter.id)) continue
          yield* Ref.update(startedAdapterIds, (ids) => new Set(ids).add(adapter.id))
          // Fork each adapter's start() into the service scope so adapter
          // connections tear down with the service. Errors are swallowed —
          // one adapter failure must not prevent others from running.
          yield* Effect.forkIn(
            adapter.start().pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  console.warn(
                    `[luna/channels] adapter '${adapter.id}' start failed: ${String(cause)}`,
                  )
                }),
              ),
            ),
            serviceScope,
          )
        }
      })

    const stopAdapters: ChannelServiceApi["stopAdapters"] = () =>
      Effect.gen(function* () {
        const adapterList = yield* Ref.get(adapters)
        for (const adapter of adapterList) {
          yield* adapter.stop().pipe(Effect.catchCause(() => Effect.void))
        }
        // Every registered adapter is now stopped, so the started-id guard
        // must forget them: it means "currently started", not "ever started".
        // Without this clear a later startAdapters() hits the guard and the
        // restart is a silent no-op - no fork, no error, no log.
        // The no-double-fork property is untouched: within one started
        // generation the guard still skips already-started ids.
        yield* Ref.set(startedAdapterIds, new Set<string>())
        // Interrupt all delivery fibers
        const fibers = yield* Ref.get(deliveryFibers)
        yield* Fiber.interruptAll(Array.from(fibers.values()))
      })

    // Finalizer: stop adapters when the service scope closes
    yield* Effect.addFinalizer(() => stopAdapters())

    return {
      registerAdapter,
      startAdapters,
      stopAdapters,
      handleMessage,
    } satisfies ChannelServiceApi
  }),
)
