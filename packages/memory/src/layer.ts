/**
 * MemoryLayer — composition helper that builds a MemoryRouter from a list of
 * namespace→backend rules and provides it via the MemoryRouter Tag.
 *
 * Backends carry their own Layer requirements (e.g. SqliteVectorBackend needs
 * EmbedderService); MemoryLayer is namespace-routing only and does no I/O of
 * its own. Compose backend Layers upstream and pass already-resolved backends
 * here as data.
 */
import { Layer } from "effect"
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
): Layer.Layer<MemoryRouter, never, never> =>
  Layer.sync(MemoryRouterTag, () => makeRouter(cfg.rules))
