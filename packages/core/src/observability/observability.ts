/**
 * ObservabilityService — Phase 14.
 *
 * Per DESIGN §16: structured events written to a local JSONL sink.
 * @effect/opentelemetry is deferred until a v3-compatible release is
 * available (currently only v4 betas exist).
 *
 * Architecture:
 *   - In-memory PubSub (unbounded) for fan-out: multiple consumers can
 *     subscribe independently without racing each other for events.
 *   - Background JSONL writer fiber (forkDaemon) subscribes to the PubSub
 *     and appends to the sink file.
 *   - PubSub.shutdown on scope close terminates all subscriber queues cleanly.
 *   - Emit is fire-and-forget (PubSub.publish + Effect.ignore); JSONL write
 *     errors are swallowed — observability must never bring down the host.
 *   - `events` property is Stream.fromPubSub — each caller gets a fresh
 *     independent subscription; events are NOT consumed from other subscribers.
 *   - Clock dependency for timestamps.
 *
 * Invariants:
 *   - §3.4 #4 interruption: Layer.scoped finalizer shuts down the PubSub,
 *     which terminates all subscriber queues and their fibers cleanly.
 *   - §3.4 #1 no cross-Scope refs: writer fiber is a daemon.
 *   - emit() is always Effect<void, never> — failure is swallowed.
 */
import {
  Effect,
  Either,
  Layer,
  PubSub,
  Queue,
  Stream,
} from "effect"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Clock } from "../clock.js"
import { decodeObsEvent } from "./schema.js"
import type {
  CostAccruedEvent,
  ErrorEvent,
  ObservabilityApi,
  ObservabilityConfig,
  ObsEvent,
} from "./types.js"

const DEFAULT_JSONL_PATH = join(homedir(), ".experiment-agent", "events.jsonl")
// Claude 3.5 Sonnet pricing (approximate) — callers can override.
const DEFAULT_PRICE_PER_M_INPUT = 3.0  // $3/M tokens
const DEFAULT_PRICE_PER_M_OUTPUT = 15.0 // $15/M tokens

export class ObservabilityService extends Effect.Tag(
  "experiment-agent/ObservabilityService",
)<ObservabilityService, ObservabilityApi>() {
  static readonly Default: Layer.Layer<ObservabilityService, never, Clock> =
    ObservabilityService.makeLayer({})

  static makeLayer(
    config: ObservabilityConfig,
  ): Layer.Layer<ObservabilityService, never, Clock> {
    return Layer.scoped(
      ObservabilityService,
      Effect.gen(function* () {
        const clock = yield* Clock
        const jsonlPath = config.jsonlPath ?? DEFAULT_JSONL_PATH
        const logToConsole = config.logToConsole ?? false
        const minLevel = config.minLevel ?? "info"

        // PubSub fans out to all subscribers independently (JSONL writer + live consumers).
        const hub = yield* PubSub.unbounded<ObsEvent>()
        yield* Effect.addFinalizer(() => PubSub.shutdown(hub))

        // Background JSONL writer — subscribes to hub and persists events.
        const levelOrder = { info: 0, warn: 1, error: 2 } as const
        const minLevelOrd = levelOrder[minLevel]

        yield* Effect.forkDaemon(
          Effect.scoped(
            Effect.gen(function* () {
              const sub = yield* hub.subscribe
              yield* Stream.fromQueue(sub).pipe(
                Stream.runForEach((ev: ObsEvent) =>
                  Effect.gen(function* () {
                    if (levelOrder[ev.level] < minLevelOrd) return
                    const line = JSON.stringify(ev) + "\n"
                    if (logToConsole) {
                      yield* Effect.log(`[obs:${ev.kind}] ${line.trim()}`)
                    }
                    // Best-effort append to JSONL (ignore errors)
                    yield* Effect.tryPromise({
                      try: async () => {
                        await mkdir(dirname(jsonlPath), { recursive: true })
                        await appendFile(jsonlPath, line, "utf8")
                      },
                      catch: () => null,
                    }).pipe(Effect.ignore)
                  }),
                ),
              )
            }),
          ).pipe(Effect.catchAllCause(() => Effect.void)),
        )

        const buildBase = (
          kind: ObsEvent["kind"],
          level: "info" | "warn" | "error",
        ) =>
          clock.nowIso().pipe(
            Effect.map((ts) => ({ ts, kind, level })),
          )

        const emit: ObservabilityApi["emit"] = (event) =>
          Effect.gen(function* () {
            // Validate at the boundary — catches producer drift (e.g. wrong
            // field names) before events reach the JSONL sink or any wire
            // protocol. On failure: drop the malformed event, publish a
            // synthetic Error event so the violation is observable.
            const decoded = decodeObsEvent(event as unknown)
            if (Either.isRight(decoded)) {
              // Schema.optional decodes to `field?: T | undefined`, but our
              // domain types use `field?: T` (exactOptionalPropertyTypes).
              // The shapes are equivalent at runtime; cast through unknown.
              yield* PubSub.publish(hub, decoded.right as unknown as ObsEvent).pipe(
                Effect.asVoid,
                Effect.ignore,
              )
              return
            }
            const ts = yield* clock.nowIso()
            const violation: ErrorEvent = {
              ts,
              kind: "Error",
              level: "error",
              errorTag: "ObsSchemaViolation",
              message: `Malformed ObsEvent dropped: ${decoded.left.message}`,
              context: {
                offendingKind: (event as { kind?: unknown })?.kind ?? null,
              },
            }
            yield* PubSub.publish(hub, violation).pipe(
              Effect.asVoid,
              Effect.ignore,
            )
          })

        const recordCost: ObservabilityApi["recordCost"] = (opts) =>
          Effect.gen(function* () {
            const base = yield* buildBase("CostAccrued", "info")
            const pIn = opts.pricePerMillionInputTokens ?? DEFAULT_PRICE_PER_M_INPUT
            const pOut = opts.pricePerMillionOutputTokens ?? DEFAULT_PRICE_PER_M_OUTPUT
            const cacheR = opts.cacheRead ?? 0
            const cacheW = opts.cacheWrite ?? 0
            const estimatedUsd =
              (opts.tokensIn * pIn +
                opts.tokensOut * pOut +
                cacheR * (pIn * 0.1) +
                cacheW * (pIn * 1.25)) /
              1_000_000
            const ev: CostAccruedEvent = {
              ...base,
              kind: "CostAccrued",
              ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
              ...(opts.teamName !== undefined ? { teamName: opts.teamName } : {}),
              ...(opts.workflowId !== undefined ? { workflowId: opts.workflowId } : {}),
              tokensIn: opts.tokensIn,
              tokensOut: opts.tokensOut,
              cacheRead: cacheR,
              cacheWrite: cacheW,
              estimatedUsd,
            }
            yield* emit(ev)
          })

        // Each caller gets their own independent subscription via PubSub fan-out.
        // Lazy — subscription created when stream is consumed.
        const events: ObservabilityApi["events"] = Stream.fromPubSub(hub)

        // Eager subscription — subscribe NOW (in the caller's Scope).
        // Any events emitted after subscribeEvents resolves are guaranteed to
        // be delivered to the returned Stream.
        const subscribeEvents: ObservabilityApi["subscribeEvents"] = Effect.gen(
          function* () {
            const sub = yield* PubSub.subscribe(hub)
            yield* Effect.addFinalizer(() => Queue.shutdown(sub))
            return Stream.fromQueue(sub)
          },
        )

        return {
          emit,
          recordCost,
          events,
          subscribeEvents,
        } satisfies ObservabilityApi
      }),
    )
  }
}
