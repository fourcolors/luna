/**
 * EventCounter — mirrors ObservabilityService events into TelemetryService
 * counters.
 *
 * ObservabilityService remains the canonical event stream. This layer adds
 * low-cardinality counters that MetricsFlusher can persist into
 * metric_snapshots for quick operational summaries.
 */
import { Effect, Layer, Stream } from "effect"
import { ObservabilityService } from "../observability/observability.js"
import type { ObsEvent } from "../observability/types.js"
import { TelemetryService } from "./telemetry.js"

export class EventCounter extends Effect.Tag("luna/EventCounter")<
  EventCounter,
  Record<string, never>
>() {
  static makeLayer(): Layer.Layer<
    EventCounter,
    never,
    ObservabilityService | TelemetryService
  > {
    return Layer.scoped(
      EventCounter,
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const tel = yield* TelemetryService
        const stream = yield* obs.subscribeEvents

        const inc = (
          name: string,
          tags: Readonly<Record<string, string>> = {},
          n = 1,
        ): Effect.Effect<void, never> =>
          tel.inc(name, tags, n).pipe(Effect.catchAllCause(() => Effect.void))

        const countEvent = (event: ObsEvent): Effect.Effect<void, never> =>
          Effect.gen(function* () {
            yield* inc("luna.obs.events.total", {
              kind: event.kind,
              level: event.level,
            })

            switch (event.kind) {
              case "SessionStart":
                yield* inc("luna.obs.sessions.started", { model: event.model })
                return
              case "SessionEnd":
                yield* inc("luna.obs.sessions.ended")
                return
              case "ToolCall":
                yield* inc("luna.obs.tool_calls.total", {
                  tool: event.toolName,
                  status: event.status,
                })
                return
              case "CostAccrued":
                yield* inc("luna.obs.cost.tokens_in", {}, event.tokensIn)
                yield* inc("luna.obs.cost.tokens_out", {}, event.tokensOut)
                yield* inc("luna.obs.cost.cache_read", {}, event.cacheRead)
                yield* inc("luna.obs.cost.cache_write", {}, event.cacheWrite)
                yield* inc(
                  "luna.obs.cost.usd_micros",
                  {},
                  Math.round(event.estimatedUsd * 1_000_000),
                )
                return
              case "Error":
                yield* inc("luna.obs.errors.total", {
                  errorTag: event.errorTag,
                })
                return
              default:
                return
            }
          })

        yield* Effect.forkDaemon(
          stream.pipe(
            Stream.runForEach(countEvent),
            Effect.catchAllCause(() => Effect.void),
          ),
        )

        return {} as Record<string, never>
      }),
    )
  }
}
