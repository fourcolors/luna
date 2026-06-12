/**
 * KeychainEnvSecretProvider — resolves `env:VARNAME` refs from the macOS
 * keychain instead of `process.env`.
 *
 * The public ref format is unchanged: callers still pass `env:OPENAI_API_KEY`.
 * Only the *resolution* differs — this provider reads the value from the
 * keychain entry `service=luna.vault.<VARNAME>`, `account=<VARNAME>`. That
 * keeps `vault_items` pointers and every existing `env:*` ref valid while
 * moving the value off plaintext-at-rest in `~/.luna/.env`.
 *
 * Chain placement (see chat-server): inserted BEFORE `EnvSecretProvider` only
 * when `LUNA_VAULT_STORAGE` selects a keychain mode on Darwin. A keychain miss
 * surfaces as ConfigError so `firstOf([...keychain, env])` falls through to the
 * `.env` value — the dual-read that makes copy-only migration and one-env-var
 * rollback safe. Non-env refs also miss, so the chain keeps routing 1Password
 * refs to the op providers ahead of it.
 *
 * Hard rules (mirrors keychain-helper): never log the value, never include it
 * in error messages, errors only via the existing `ConfigError` tag.
 */
import { Effect, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"
import { readKeychainToken, type KeychainQuery } from "./keychain-helper.js"

const ENV_PREFIX = "env:"

/** Keychain coordinates for an `env:<name>` value: `luna.vault.<name>`/`<name>`. */
export const keychainVaultQueryForEnvName = (name: string): KeychainQuery => ({
  service: `luna.vault.${name}`,
  account: name,
})

interface KeychainEnvInternals {
  readonly _platform?: NodeJS.Platform
  readonly _read?: (q: KeychainQuery) => Effect.Effect<string, ConfigError>
}

export const KeychainEnvSecretProvider = {
  make: (
    internals: KeychainEnvInternals = {},
  ): Layer.Layer<SecretProvider, ConfigError> =>
    Layer.effect(
      SecretProvider,
      Effect.sync(
        (): SecretProviderApi => ({
          get: (ref) => {
            if (!ref.startsWith(ENV_PREFIX)) {
              return Effect.fail(
                new ConfigError({
                  module: "KeychainEnvSecretProvider",
                  key: ref,
                  message: `ref "${ref}" is not an env: ref`,
                }),
              )
            }
            const name = ref.slice(ENV_PREFIX.length)
            const read =
              internals._read ??
              ((q: KeychainQuery) =>
                // exactOptionalPropertyTypes: only set _platform when defined
                // — passing an explicit `undefined` is a type error here.
                readKeychainToken(
                  q,
                  internals._platform === undefined
                    ? {}
                    : { _platform: internals._platform },
                ))
            return read(keychainVaultQueryForEnvName(name)).pipe(
              Effect.map((v) => Redacted.make(v)),
              Effect.mapError(
                () =>
                  new ConfigError({
                    module: "KeychainEnvSecretProvider",
                    key: ref,
                    message: `keychain env secret "${name}" is not set`,
                  }),
              ),
            )
          },
        }),
      ),
    ),
} as const
