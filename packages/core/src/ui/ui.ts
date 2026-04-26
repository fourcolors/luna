/**
 * UIService — server-side observability multiplexer (Phase 22).
 *
 * Wraps ObservabilityService.subscribeEvents() (eager) and filters by
 * configured kind whitelist. NO transport — a separate adapter
 * package will translate the resulting Stream into WS/SSE traffic.
 *
 * Critical: must use `obs.subscribeEvents` (eager subscribe), NOT the
 * lazy `obs.events`. The Phase 14 fix established this contract:
 * every §16 consumer uses subscribeEvents to avoid pre-consumption
 * event loss.
 */
import { Effect, Layer, Stream } from "effect"
import { ObservabilityService } from "../observability/index.js"
import { DEFAULT_UI_KINDS, type UIApi, type UIConfig } from "./types.js"

export class UIService extends Effect.Tag("luna/UIService")<
  UIService,
  UIApi
>() {
  static makeLayer(
    config?: UIConfig,
  ): Layer.Layer<UIService, never, ObservabilityService> {
    const kinds = new Set(config?.kinds ?? DEFAULT_UI_KINDS)
    return Layer.effect(
      UIService,
      Effect.gen(function* () {
        const obs = yield* ObservabilityService

        const subscribe: UIApi["subscribe"] = Effect.gen(function* () {
          // Eager subscribe — uses Phase-14's subscribeEvents API so no
          // events are dropped between Layer init and Stream consumption.
          const eventStream = yield* obs.subscribeEvents
          return eventStream.pipe(Stream.filter((e) => kinds.has(e.kind)))
        })

        return { subscribe } satisfies UIApi
      }),
    )
  }
}
