/**
 * EnvSecretProvider — resolves `env:VARNAME` refs from `process.env`.
 *
 * Refs that don't start with `env:` are treated as misses (ConfigError);
 * `firstOf([env, file])` composition will fall through to the next
 * provider on miss.
 */
import { Effect, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"

const ENV_PREFIX = "env:"

export const EnvSecretProvider = {
  Default: Layer.effect(
    SecretProvider,
    Effect.sync(
      (): SecretProviderApi => ({
        get: (ref) =>
          Effect.sync(() => {
            if (!ref.startsWith(ENV_PREFIX)) return null
            const name = ref.slice(ENV_PREFIX.length)
            const v = process.env[name]
            return v === undefined ? null : v
          }).pipe(
            Effect.flatMap((v) =>
              v === null
                ? Effect.fail(
                    new ConfigError({
                      module: "EnvSecretProvider",
                      key: ref,
                      message: ref.startsWith(ENV_PREFIX)
                        ? `env var "${ref.slice(ENV_PREFIX.length)}" is not set`
                        : `ref "${ref}" is not an env: ref`,
                    }),
                  )
                : Effect.succeed(Redacted.make(v)),
            ),
          ),
      }),
    ),
  ),
} as const
