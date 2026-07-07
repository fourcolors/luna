/**
 * FileSecretProvider - reads a PLAINTEXT JSON object file `{ [ref]: secret }`
 * from a fixed path and resolves refs against it.
 *
 * Caching: NONE. The file is read fresh on EVERY `get` call (see `make` below),
 * so an external edit between calls is picked up without a restart. (An earlier
 * version of this header claimed the file was "read once at layer build and
 * cached" - that was never true of the code; the read is inside `get`. Header
 * corrected to match behaviour.)
 *
 * No chmod enforcement - the values are plaintext on disk. This provider is NOT
 * wired into production: it is kept deliberately as a TEST FIXTURE for the
 * account-broker suites (and secret-provider composition tests), which need a
 * simple, injectable SecretProvider backed by a temp JSON file. Real at-rest
 * protection lives in the keychain and luna-vault tiers.
 *
 * Failure modes (all surface as ConfigError):
 *   - file does not exist
 *   - file contents are not valid JSON
 *   - file root is not a JSON object
 *   - ref not present in object
 *   - value at ref is not a string
 */
import * as fs from "node:fs"
import { Effect, Layer, Redacted } from "effect"
import { ConfigError } from "../errors.js"
import { SecretProvider, type SecretProviderApi } from "./secret-provider.js"

const readJsonObject = (
  path: string,
): Effect.Effect<Record<string, unknown>, ConfigError> =>
  Effect.try({
    try: () => fs.readFileSync(path, "utf8"),
    catch: (cause) =>
      new ConfigError({
        module: "FileSecretProvider",
        key: path,
        message: `failed to read file: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((raw) =>
      Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) =>
          new ConfigError({
            module: "FileSecretProvider",
            key: path,
            message: `malformed JSON: ${String(cause)}`,
          }),
      }),
    ),
    Effect.flatMap((parsed) => {
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return Effect.fail(
          new ConfigError({
            module: "FileSecretProvider",
            key: path,
            message: "JSON root must be an object",
          }),
        )
      }
      return Effect.succeed(parsed as Record<string, unknown>)
    }),
  )

export const FileSecretProvider = {
  /**
   * Build a layer that resolves refs against the JSON object stored at
   * `path`. The file is read on every `get` call so updates are picked
   * up between calls (no caching) — this phase doesn't need a
   * file-watcher.
   */
  make: (path: string): Layer.Layer<SecretProvider> =>
    Layer.effect(
      SecretProvider,
      Effect.sync(
        (): SecretProviderApi => ({
          get: (ref) =>
            readJsonObject(path).pipe(
              Effect.flatMap((obj) => {
                if (!(ref in obj)) {
                  return Effect.fail(
                    new ConfigError({
                      module: "FileSecretProvider",
                      key: ref,
                      message: `ref "${ref}" not found in ${path}`,
                    }),
                  )
                }
                const v = obj[ref]
                if (typeof v !== "string") {
                  return Effect.fail(
                    new ConfigError({
                      module: "FileSecretProvider",
                      key: ref,
                      message: `value at "${ref}" is not a string`,
                    }),
                  )
                }
                return Effect.succeed(Redacted.make(v))
              }),
            ),
        }),
      ),
    ),
} as const
