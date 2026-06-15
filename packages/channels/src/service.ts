/**
 * ChannelService — the orchestrator.
 *
 * Responsibilities:
 *   1. Register ChannelAdapter instances (one per platform/bot-token).
 *   2. Call each adapter's start() lifecycle when the service starts.
 *   3. Route inbound ChannelMessages through the pipeline:
 *        dedup → session lookupOrCreate → chat.send → spawn delivery fiber
 *   4. Manage delivery fiber lifecycle: one fiber per (threadId, adapterId)
 *      pair; idempotent — a second inbound message on the same thread
 *      reuses the existing fiber (no double-fan-out).
 *   5. Call each adapter's stop() on service teardown.
 *
 * ChatService is an injected dependency (Effect Context/Tag). Tests supply a
 * stub via Layer so no real SDK subprocess is involved.
 *
 * Effect discipline follows packages/connectors/src/service.ts: scoped
 * Layer, Effect.gen throughout, finalizers for teardown.
 */
import { Effect, Fiber, Layer, Ref, Scope } from "effect"
import { Clock } from "@luna/core"
import { ChatService } from "@luna/chat-service"
import type { ChannelAdapter, ChannelMessage, DeliveryTarget } from "./types.js"
import { ChannelSessionStore, lookupOrCreate } from "./session-map.js"
import { InboundDedupStore } from "./dedup.js"
import { subscribeAndDeliver } from "./delivery.js"

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

export class ChannelService extends Effect.Tag("luna/ChannelService")<
  ChannelService,
  ChannelServiceApi
>() {}

/* -------------------------------------------------------------------------- */
/* Layer                                                                       */
/* -------------------------------------------------------------------------- */

export const ChannelServiceLayer: Layer.Layer<
  ChannelService,
  never,
  ChannelSessionStore | InboundDedupStore | ChatService | Clock
> = Layer.scoped(
  ChannelService,
  Effect.gen(function* () {
    const sessionStore = yield* ChannelSessionStore
    const dedupStore = yield* InboundDedupStore
    const chat = yield* ChatService
    const clock = yield* Clock
    const serviceScope = yield* Effect.scope

    // Registered adapters (mutable, set before startAdapters)
    const adapters = yield* Ref.make<ReadonlyArray<ChannelAdapter>>([])

    // Active delivery fibers: (threadId:adapterId) → Fiber
    // One fiber per (thread, adapter) pair. Idempotent — the second inbound
    // on the same thread+adapter reuses the existing fiber.
    const deliveryFibers = yield* Ref.make<
      ReadonlyMap<string, Fiber.RuntimeFiber<void, never>>
    >(new Map())

    // ── Inbound message pipeline ────────────────────────────────────────────

    const handleMessage: ChannelServiceApi["handleMessage"] = (msg: ChannelMessage) =>
      Effect.gen(function* () {
        // 1. Dedup — drop at-least-once redeliveries
        const isDup = yield* dedupStore.seenBefore(msg.transport, msg.platformMessageId)
        if (isDup) return false
        const nowMs = yield* clock.nowMs()
        yield* dedupStore.markSeen(msg.transport, msg.platformMessageId, nowMs)

        // 2. Session map — get or create a Luna thread for this channel
        const threadId = yield* lookupOrCreate(msg).pipe(
          Effect.provide(
            Layer.succeed(ChannelSessionStore, sessionStore).pipe(
              Layer.merge(Layer.succeed(ChatService, chat)),
              Layer.merge(Layer.succeed(Clock, clock)),
            ),
          ),
        )

        // 3. Send the user message to the thread
        yield* chat.send(threadId, msg.text)

        // 4. Spawn a delivery fiber per (threadId, adapter) — idempotent
        const adapterList = yield* Ref.get(adapters)
        for (const adapter of adapterList) {
          const fiberKey = `${threadId}:${adapter.id}`
          const fibers = yield* Ref.get(deliveryFibers)
          if (!fibers.has(fiberKey)) {
            // Build the delivery target from the inbound message
            const target: DeliveryTarget = {
              inReplyTo: msg,
              address: {
                transport: msg.transport,
                channelId: msg.channelId,
                senderId: msg.senderId,
                threadingKey: msg.threadingKey,
                ...(msg.metadata ?? {}),
              },
            }

            // Spawn delivery fiber in the service scope so it survives the
            // inbound message handler's scope but tears down with the service.
            const fiber = yield* subscribeAndDeliver(threadId, adapter, target).pipe(
              Effect.provide(Layer.succeed(ChatService, chat)),
              Scope.extend(serviceScope),
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
          // Fork each adapter's start() into the service scope so adapter
          // connections tear down with the service. Errors are swallowed —
          // one adapter failure must not prevent others from running.
          yield* Effect.forkIn(
            adapter.start().pipe(
              Effect.catchAllCause((cause) =>
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
          yield* adapter.stop().pipe(Effect.catchAllCause(() => Effect.void))
        }
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
