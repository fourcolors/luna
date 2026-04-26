/**
 * GatewayService — Phase 17.
 *
 * Plugin-play message routing hub for Discord/Telegram/CLI/HTTP transports.
 *
 * Architecture:
 *   - Adapters stored in Ref<GatewayAdapter[]>.
 *   - Handler stored in Ref<GatewayHandler | null>.
 *   - `start()` merges all adapter message streams and runs them through
 *     the handler concurrently (Stream.mergeAll + Stream.runForEach).
 *   - Each adapter's start() (if present) is run in a forked daemon scope.
 *   - Handler errors are swallowed (never crash the gateway).
 *   - Scope.Scope in `start()` requirement: the merged stream's scope is the
 *     caller's scope. Callers use Effect.scoped(gateway.start) to control
 *     the lifetime.
 *
 * Invariants:
 *   - §3.4 #1: no cross-Scope Fiber refs — all fibers are daemon or
 *     scoped to the caller-provided Scope.
 *   - §3.4 #4: Scope.close terminates the merged stream (adapter streams
 *     must complete or be interrupted when their scope closes).
 *   - §6.2 frozen errors: GatewayError; handlers never fail externally.
 *   - No external dependencies beyond Effect and Clock.
 */
import {
  Effect,
  Layer,
  Ref,
  Stream,
} from "effect"
import { Clock } from "../clock.js"
import type {
  GatewayAdapter,
  GatewayApi,
  GatewayConfig,
  GatewayHandler,
  GatewayMessage,
  GatewayResponse,
  TransportKind,
} from "./types.js"

export class GatewayService extends Effect.Tag(
  "luna/GatewayService",
)<GatewayService, GatewayApi>() {
  static readonly Default: Layer.Layer<GatewayService, never, Clock> =
    GatewayService.makeLayer({})

  static makeLayer(
    config: GatewayConfig,
  ): Layer.Layer<GatewayService, never, Clock> {
    return Layer.scoped(
      GatewayService,
      Effect.gen(function* () {
        const clock = yield* Clock
        const logMessages = config.logMessages ?? false

        const adaptersRef = yield* Ref.make<GatewayAdapter[]>([])
        const handlerRef = yield* Ref.make<GatewayHandler | null>(null)

        const registerAdapter: GatewayApi["registerAdapter"] = (adapter) =>
          Ref.update(adaptersRef, (list) => [...list, adapter])

        const setHandler: GatewayApi["setHandler"] = (handler) =>
          Ref.set(handlerRef, handler)

        const start: GatewayApi["start"] = Effect.gen(function* () {
          const adapters = yield* Ref.get(adaptersRef)

          // Run each adapter's start() in a scoped daemon if provided.
          for (const adapter of adapters) {
            if (adapter.start !== undefined) {
              yield* Effect.forkDaemon(
                Effect.scoped(adapter.start).pipe(
                  Effect.catchAllCause(() => Effect.void),
                ),
              )
            }
          }

          // Merge all adapter message streams and dispatch.
          const allMessages: Stream.Stream<GatewayMessage> =
            adapters.length === 0
              ? Stream.empty
              : Stream.mergeAll(
                  adapters.map((a) => a.messages),
                  { concurrency: "unbounded" },
                )

          yield* allMessages.pipe(
            Stream.runForEach((msg) =>
              Effect.gen(function* () {
                if (logMessages) {
                  yield* Effect.log(`[gateway:${msg.transport}] ${msg.senderId}: ${msg.text}`)
                }

                const handler = yield* Ref.get(handlerRef)
                if (handler === null) return

                // Run handler; catch all causes so gateway never crashes.
                const responseText = yield* handler(msg).pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.logError(`Gateway handler error: ${String(cause)}`).pipe(
                      Effect.as(`Error: handler failed (${String(cause)})`),
                    ),
                  ),
                )

                // Find the adapter and send response.
                const adapter = adapters.find((a) => a.transport === msg.transport)
                if (adapter !== undefined) {
                  const response: GatewayResponse = {
                    inReplyTo: msg,
                    text: responseText,
                  }
                  yield* adapter.send(response).pipe(
                    Effect.catchAllCause(() => Effect.void),
                  )
                }
              }),
            ),
            Effect.catchAllCause(() => Effect.void),
          )
        })

        const send: GatewayApi["send"] = (transport, channelId, text, metadata) =>
          Effect.gen(function* () {
            const adapters = yield* Ref.get(adaptersRef)
            const adapter = adapters.find((a) => a.transport === transport)
            if (adapter === undefined) return

            const ts = yield* clock.nowIso()
            const fakeMsg: GatewayMessage = {
              id: `push-${ts}`,
              transport: transport as TransportKind,
              channelId,
              senderId: "gateway",
              text: "",
              metadata: {},
              ts,
            }
            yield* adapter.send({
              inReplyTo: fakeMsg,
              text,
              ...(metadata !== undefined ? { metadata } : {}),
            }).pipe(Effect.catchAllCause(() => Effect.void))
          })

        return {
          registerAdapter,
          setHandler,
          start,
          send,
        } satisfies GatewayApi
      }),
    )
  }
}
