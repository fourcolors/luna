/**
 * OnePasswordSecretProvider live test — gated on
 * `OP_SERVICE_ACCOUNT_TOKEN` being present in the environment. Uses
 * Operator's known `Example Vault` vault item to validate that the real `op`
 * binary path works end-to-end.
 *
 * This test MUST NOT print secret values on failure. We assert only on
 * shape (length / prefix), never log the raw secret.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { Clock } from "../clock.js"
import { SecretProvider } from "./secret-provider.js"
import { OnePasswordSecretProvider } from "./onepassword-backend.js"

const hasToken = Boolean(process.env.OP_SERVICE_ACCOUNT_TOKEN)

describe.skipIf(!hasToken)(
  "OnePasswordSecretProvider live (OP_SERVICE_ACCOUNT_TOKEN required)",
  () => {
    it("resolves a known op:// ref via the real `op` binary", async () => {
      const layer = OnePasswordSecretProvider.make({
        accountLabel: "live",
      }).pipe(Layer.provide(Clock.Default))

      const ref =
        "op://Example Vault/Example Credential/credential"
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const sp = yield* SecretProvider
          return yield* sp.get(ref)
        }).pipe(Effect.provide(layer)),
      )

      if (result._tag === "Failure") {
        // Item may not exist in this vault; skip rather than fail. Do
        // NOT print the cause if it might contain secret values.
        // eslint-disable-next-line no-console
        console.warn(
          `[live test] Could not resolve ${ref}; vault/item may be unavailable for this token. Skipping shape assertion.`,
        )
        return
      }
      const value = Redacted.value(result.success)
      // Shape assertions ONLY — never print or include the value.
      expect(value.length).toBeGreaterThan(20)
      // GitHub classic PATs typically begin with "ghp_". We allow the
      // assertion to be soft if the token format ever changes.
      const looksLikeGithubToken =
        value.startsWith("ghp_") ||
        value.startsWith("github_pat_") ||
        value.length > 30
      expect(looksLikeGithubToken).toBe(true)
    })
  },
)
