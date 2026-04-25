/**
 * TelemetryService — Counter-only metrics (Phase 18).
 *
 * Minimal in-process metrics. Counters keyed by (name, tags) where the
 * tag key is the JSON-stringified sorted tag map. Pull-based snapshots
 * via `snapshot()`; no automatic emission into ObservabilityService.
 */
import { Effect, Layer, Ref } from "effect"
import { Clock } from "../clock.js"
import type {
  CounterSnapshot,
  MetricTags,
  TelemetryApi,
  TelemetryConfig,
} from "./types.js"

interface CounterState {
  readonly name: string
  readonly tags: MetricTags
  value: number
  lastUpdatedTs: string
}

/** Stable key for (name, tags). Sort keys to make tag order irrelevant. */
function counterKey(name: string, tags: MetricTags): string {
  const keys = Object.keys(tags).sort()
  const parts = keys.map((k) => `${k}=${tags[k] ?? ""}`)
  return `${name}\u0000${parts.join("\u0001")}`
}

export class TelemetryService extends Effect.Tag("TelemetryService")<
  TelemetryService,
  TelemetryApi
>() {
  static makeLayer(_config?: TelemetryConfig): Layer.Layer<TelemetryService, never, Clock> {
    return Layer.effect(
      TelemetryService,
      Effect.gen(function* () {
        const clock = yield* Clock
        const counters = yield* Ref.make<Map<string, CounterState>>(new Map())

        const inc: TelemetryApi["inc"] = (name, tags = {}, n = 1) =>
          Effect.gen(function* () {
            const key = counterKey(name, tags)
            const ts = yield* clock.nowIso()
            yield* Ref.update(counters, (map) => {
              const next = new Map(map)
              const existing = next.get(key)
              if (existing) {
                existing.value += n
                existing.lastUpdatedTs = ts
              } else {
                next.set(key, {
                  name,
                  tags: { ...tags },
                  value: n,
                  lastUpdatedTs: ts,
                })
              }
              return next
            })
          })

        const get: TelemetryApi["get"] = (name, tags = {}) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(counters)
            return map.get(counterKey(name, tags))?.value ?? 0
          })

        const snapshot: TelemetryApi["snapshot"] = Effect.gen(function* () {
          const map = yield* Ref.get(counters)
          const out: CounterSnapshot[] = []
          for (const c of map.values()) {
            out.push({
              name: c.name,
              tags: c.tags,
              value: c.value,
              lastUpdatedTs: c.lastUpdatedTs,
            })
          }
          return out
        })

        const reset: TelemetryApi["reset"] = Ref.set(counters, new Map())

        return {
          inc,
          get,
          snapshot,
          reset,
        } satisfies TelemetryApi
      }),
    )
  }
}
