/**
 * MemoryLayer — composition helper that builds a MemoryRouter from a list of
 * namespace→backend rules and provides it via the MemoryRouter Tag.
 *
 * Pulls ObservabilityService, EmbedderService, and Clock at construction so
 * every search() emits a RetrievalCallEvent without callers needing to thread
 * those services through the call site. Matches the cost-store-sqlite pattern
 * (services resolved once at boot, captured in closure, used per-call).
 *
 * Backends carry their own Layer requirements (e.g. SqliteVectorBackend needs
 * EmbedderService); MemoryLayer is namespace-routing + telemetry only and does
 * no I/O of its own. Compose backend Layers upstream and pass already-resolved
 * backends here as data.
 */
import { Effect, Layer } from "effect"
import {
  Clock,
  EmbedderService,
  ObservabilityService,
} from "@luna/core"
import {
  MemoryRouterTag,
  makeRouter,
  type MemoryRouter,
  type Rule,
} from "./router.js"

export interface MemoryLayerConfig {
  readonly rules: ReadonlyArray<Rule>
}

export const MemoryLayer = (
  cfg: MemoryLayerConfig,
): Layer.Layer<
  MemoryRouter,
  never,
  ObservabilityService | EmbedderService | Clock
> =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const observability = yield* ObservabilityService
      const embedder = yield* EmbedderService
      const clock = yield* Clock
      return makeRouter(cfg.rules, {
        observability,
        clock,
        embedderInfo: {
          provider: embedder.provider,
          model: embedder.model,
          dimension: embedder.dimension,
        },
      })
    }),
  )
