/**
 * SecretProvider — Foundation-layer service that resolves opaque
 * `SecretRef` strings (e.g. `env:ANTHROPIC_TOKEN`) to redacted secret
 * values.
 *
 * DESIGN.md §2.2.11 lists 1Password / env / file as backends; Phase 9
 * ships ENV and FILE only (1Password deferred to Phase 10+).
 *
 * §5.1 anchors the wire format: `secret_ref TEXT` — a string pointer.
 * §6 anchors errors: failures surface as `ConfigError` (no new error
 * classes invented for this module).
 *
 * The returned `SecretValue` is `Redacted<string>` so the secret cannot
 * leak through `JSON.stringify`, `String(..)`, `util.inspect`, or
 * Effect cause traces. Callers obtain plaintext explicitly via
 * `Redacted.value(...)` only at the moment of use.
 */
import { Context, Effect, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"

/**
 * Opaque pointer string. Convention used by reference backends:
 *   - `env:VARNAME` → process env
 *   - bare key      → file backend lookup
 * The shape is intentionally permissive — backends decide how to
 * interpret refs they recognize.
 */
export type SecretRef = string

/** Redacted secret value — log-safe by construction. */
export type SecretValue = Redacted.Redacted<string>

export interface SecretProviderApi {
  readonly get: (ref: SecretRef) => Effect.Effect<SecretValue, ConfigError>
}

export class SecretProvider extends Effect.Tag(
  "luna/SecretProvider",
)<SecretProvider, SecretProviderApi>() {}

/**
 * Compose multiple SecretProvider layers into a single layer that tries
 * each in declaration order and returns the first success. If every
 * provider fails, the final ConfigError propagates.
 *
 * Implementation detail: each input layer is built once into its own
 * service instance, then a composite SecretProvider is exposed.
 *
 * INTEGRITY MUST NOT DEGRADE INTO A FALL-THROUGH MISS. A provider can fail
 * for two very different reasons: a clean miss ("this secret isn't stored
 * here, try the next tier") or an integrity-class failure ("the store IS
 * here but is locked out / corrupt / tampered"). The default loop treats
 * every Left the same and keeps trying later tiers - which is correct for a
 * miss but catastrophic for an integrity failure, because a corrupt luna
 * vault would silently fall through to the plaintext `.env` tail and resolve
 * a STALE value the operator believed encrypted. Pass `options.stopOn` to
 * make a matching error fail the whole chain IMMEDIATELY (no later provider
 * is consulted), so post-boot vault corruption surfaces loudly instead of
 * resolving stale plaintext. Without the option the behavior is unchanged.
 */
export const firstOf = (
  layers: ReadonlyArray<Layer.Layer<SecretProvider, ConfigError>>,
  options?: { stopOn?: (e: ConfigError) => boolean },
): Layer.Layer<SecretProvider, ConfigError> => {
  if (layers.length === 0) {
    return Layer.effect(
      SecretProvider,
      Effect.sync(
        (): SecretProviderApi => ({
          get: (ref) =>
            Effect.fail(
              new ConfigError({
                module: "SecretProvider",
                key: ref,
                message: "no providers configured",
              }),
            ),
        }),
      ),
    )
  }
  return Layer.effect(
    SecretProvider,
    Effect.gen(function* () {
      const providers: Array<SecretProviderApi> = []
      for (const layer of layers) {
        // Build each layer in isolation, extract its SecretProvider impl.
        const ctx = yield* Layer.build(layer).pipe(Effect.scoped)
        providers.push(Context.get(ctx, SecretProvider))
      }
      const get: SecretProviderApi["get"] = (ref) =>
        Effect.gen(function* () {
          let lastErr: ConfigError | undefined
          for (const p of providers) {
            const result = yield* Effect.either(p.get(ref))
            if (result._tag === "Right") return result.right
            // Integrity-class failure: fail the whole chain now rather than
            // degrading into a fall-through miss that resolves stale plaintext.
            if (options?.stopOn?.(result.left) === true) {
              return yield* Effect.fail(result.left)
            }
            lastErr = result.left
          }
          return yield* Effect.fail(
            lastErr ??
              new ConfigError({
                module: "SecretProvider",
                key: ref,
                message: "no providers configured",
              }),
          )
        })
      return { get } satisfies SecretProviderApi
    }),
  )
}
