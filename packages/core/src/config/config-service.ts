/**
 * ConfigService — resolves layered SessionOptions from global → project →
 * session sources, runs schema validation, and emits a validated bundle.
 *
 * Sources are abstract (just `Record<string, unknown>`) so the same engine
 * serves file-based configs, env-based overrides, and in-memory test
 * fixtures. File/env readers live in adapter packages (Phase 15 gateway).
 */
import { Effect, Layer } from "effect"
import { ConfigError } from "../errors.js"
import {
  decodeSessionOptions,
  type ValidatedSessionOptions,
} from "../schema/session-options.js"
import { composeLayers } from "./merge-policy.js"

export interface ConfigSource {
  readonly name: string
  readonly load: () => Effect.Effect<Record<string, unknown>, ConfigError>
}

export interface ConfigServiceApi {
  /**
   * Compose layers from all registered sources + an optional per-call
   * override, then validate. Returns the validated options.
   */
  readonly resolve: (
    override?: Record<string, unknown>,
  ) => Effect.Effect<ValidatedSessionOptions, ConfigError>
}

export class ConfigService extends Effect.Tag("luna/ConfigService")<
  ConfigService,
  ConfigServiceApi
>() {
  static fromSources(
    sources: ReadonlyArray<ConfigSource>,
  ): Layer.Layer<ConfigService> {
    return Layer.succeed(ConfigService, {
      resolve: (override) =>
        Effect.gen(function* () {
          const loaded: Record<string, unknown>[] = []
          for (const src of sources) {
            const layer = yield* src.load()
            loaded.push(layer)
          }
          if (override) loaded.push(override)
          const composed = composeLayers(loaded)
          const validated = yield* decodeSessionOptions(composed).pipe(
            Effect.mapError(
              (cause) =>
                new ConfigError({
                  module: "config",
                  key: "SessionOptions",
                  message: `schema decode failed: ${String(cause)}`,
                }),
            ),
          )
          return validated
        }),
    })
  }

  static readonly Empty: Layer.Layer<ConfigService> = ConfigService.fromSources(
    [],
  )
}

/** Convenience constructor for an in-memory source (tests). */
export const memorySource = (
  name: string,
  data: Record<string, unknown>,
): ConfigSource => ({
  name,
  load: () => Effect.succeed(data),
})
