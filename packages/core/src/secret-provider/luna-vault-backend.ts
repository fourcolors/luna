/**
 * LunaVaultSecretProvider - resolves `env:VARNAME` refs from Luna's own
 * encrypted vault (luna-vault-file.ts) instead of `process.env` or a keychain.
 *
 * Shape mirrors KeychainEnvSecretProvider exactly so the two are drop-in
 * interchangeable in the SecretProvider chain:
 *   - the public ref format is unchanged: callers pass `env:OPENAI_API_KEY`.
 *   - only `env:` refs are handled; anything else fails fast with ConfigError so
 *     `firstOf([...routedOp, lunaVault, env])` keeps routing 1Password (`op://`,
 *     `luna-op://`) refs to the providers ahead of it.
 *   - a clean miss (secret not present) surfaces as ConfigError so the chain
 *     falls through to the `.env` tail - the dual-read that makes copy-only
 *     migration and one-var rollback safe.
 *
 * The one deliberate departure from a plain keychain miss: an INTEGRITY failure
 * (store present but the key is missing / wrong / the ciphertext is tampered)
 * is NOT a platform miss. It is mapped to a ConfigError whose message begins
 * `luna vault integrity:` - a distinct, greppable prefix so the boot gate and
 * operators can tell "vault is locked out, fix it" apart from "this secret
 * isn't stored here, fall through". Conflating the two would silently treat a
 * broken vault as an empty one and fall through to plaintext.
 *
 * Injection: `make({ read })` takes an async `read(name) => Promise<string |
 * undefined>` that throws LunaVaultIntegrityError on integrity failure. In
 * production this is `lunaVaultFile.readSecret.bind(lunaVaultFile)`; tests pass
 * a fake. This keeps the Effect layer free of node:fs and matches how the app
 * composes the chain (composition lives in the app script, not the package).
 *
 * Hard rules (mirrors keychain backends): never log the value, never include it
 * in error messages, errors only via the existing `ConfigError` tag.
 */
import { Effect, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"
import { LunaVaultIntegrityError } from "./luna-vault-file.js"

const ENV_PREFIX = "env:"

/** Distinct, greppable prefix for integrity failures. */
export const LUNA_VAULT_INTEGRITY_PREFIX = "luna vault integrity:"

export interface LunaVaultBackendOptions {
  /**
   * Reads a stored secret by NAME (the part after `env:`). Resolves to the
   * plaintext value, or undefined for a clean miss. Throws
   * LunaVaultIntegrityError when the store is present but undecryptable.
   */
  readonly read: (name: string) => Promise<string | undefined>
}

export const LunaVaultSecretProvider = {
  make: (
    opts: LunaVaultBackendOptions,
  ): Layer.Layer<SecretProvider, ConfigError> =>
    Layer.effect(
      SecretProvider,
      Effect.sync(
        (): SecretProviderApi => ({
          get: (ref) => {
            if (!ref.startsWith(ENV_PREFIX)) {
              return Effect.fail(
                new ConfigError({
                  module: "LunaVaultSecretProvider",
                  key: ref,
                  message: `ref "${ref}" is not an env: ref`,
                }),
              )
            }
            const name = ref.slice(ENV_PREFIX.length)
            return Effect.tryPromise({
              try: () => opts.read(name),
              catch: (cause) => cause,
            }).pipe(
              // Distinguish clean miss (undefined) from a real value.
              Effect.flatMap((value) =>
                value === undefined
                  ? Effect.fail(
                      new ConfigError({
                        module: "LunaVaultSecretProvider",
                        key: ref,
                        message: `luna vault secret "${name}" is not set`,
                      }),
                    )
                  : Effect.succeed(Redacted.make(value)),
              ),
              // Map integrity failures to a DISTINCT ConfigError; anything else
              // (unexpected fs error) also fails closed but as a generic config
              // error - never leak the value, never treat integrity as a miss.
              Effect.catchAll((cause) => {
                if (cause instanceof LunaVaultIntegrityError) {
                  return Effect.fail(
                    new ConfigError({
                      module: "LunaVaultSecretProvider",
                      key: ref,
                      message: `${LUNA_VAULT_INTEGRITY_PREFIX} ${cause.reason} (${cause.message})`,
                    }),
                  )
                }
                if (cause instanceof ConfigError) return Effect.fail(cause)
                return Effect.fail(
                  new ConfigError({
                    module: "LunaVaultSecretProvider",
                    key: ref,
                    message: `luna vault read failed for "${name}": ${String(
                      cause instanceof Error ? cause.message : cause,
                    )}`,
                  }),
                )
              }),
            )
          },
        }),
      ),
    ),
} as const
