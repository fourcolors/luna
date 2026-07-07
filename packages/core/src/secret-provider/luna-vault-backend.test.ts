/**
 * LunaVaultSecretProvider tests - the Effect-facing wrapper. Uses a fake
 * `read` injection (no real fs) to verify: env: grammar routing, clean-miss vs
 * integrity-failure DISTINCT messages, Redacted wrapping, and that non-env refs
 * fail fast so `firstOf` keeps routing them onward.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Redacted } from "effect"
import { SecretProvider } from "./secret-provider.js"
import {
  LunaVaultSecretProvider,
  LUNA_VAULT_INTEGRITY_PREFIX,
} from "./luna-vault-backend.js"
import { LunaVaultIntegrityError } from "./luna-vault-file.js"

const resolveRef = (
  read: (name: string) => Promise<string | undefined>,
  ref: string,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const sp = yield* SecretProvider
      return yield* sp.get(ref)
    }).pipe(Effect.provide(LunaVaultSecretProvider.make({ read }))),
  )

describe("LunaVaultSecretProvider", () => {
  it("resolves an env: ref to a Redacted value", async () => {
    const exit = await resolveRef(async (name) => {
      expect(name).toBe("OPENAI_API_KEY")
      return "sk-value"
    }, "env:OPENAI_API_KEY")
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(Redacted.value(exit.value)).toBe("sk-value")
      // Redacted must not leak through stringification.
      expect(JSON.stringify(exit.value)).not.toContain("sk-value")
      expect(String(exit.value)).not.toContain("sk-value")
    }
  })

  it("non-env ref → ConfigError fail-fast (so firstOf routes onward)", async () => {
    let called = false
    const exit = await resolveRef(async () => {
      called = true
      return "should-not-be-read"
    }, "op://vault/item/field")
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("ConfigError")
      expect(j).toContain("is not an env: ref")
    }
    expect(called).toBe(false)
  })

  it("clean miss (undefined) → ConfigError 'is not set'", async () => {
    const exit = await resolveRef(async () => undefined, "env:MISSING")
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      // JSON escapes the inner quotes, so match the stable substrings.
      expect(j).toContain("luna vault secret")
      expect(j).toContain("MISSING")
      expect(j).toContain("is not set")
      // A clean miss must NOT carry the integrity prefix.
      expect(j).not.toContain(LUNA_VAULT_INTEGRITY_PREFIX)
    }
  })

  it("integrity failure → DISTINCT ConfigError with the integrity prefix", async () => {
    const exit = await resolveRef(async () => {
      throw new LunaVaultIntegrityError(
        "key-missing",
        "luna vault key missing but store present",
      )
    }, "env:LOCKED_OUT")
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("ConfigError")
      expect(j).toContain(LUNA_VAULT_INTEGRITY_PREFIX)
      expect(j).toContain("key-missing")
      // Distinct from the clean-miss message.
      expect(j).not.toContain("is not set")
    }
  })

  it("miss and integrity messages are greppably distinct", async () => {
    const miss = await resolveRef(async () => undefined, "env:X")
    const integ = await resolveRef(async () => {
      throw new LunaVaultIntegrityError("auth-failed", "tag failed")
    }, "env:X")
    const missMsg = JSON.stringify(Exit.isFailure(miss) ? miss.cause : "")
    const integMsg = JSON.stringify(Exit.isFailure(integ) ? integ.cause : "")
    expect(missMsg).toContain("is not set")
    expect(missMsg).not.toContain(LUNA_VAULT_INTEGRITY_PREFIX)
    expect(integMsg).toContain(LUNA_VAULT_INTEGRITY_PREFIX)
    expect(integMsg).not.toContain("is not set")
  })

  it("an unexpected read error fails closed (never treated as a miss)", async () => {
    const exit = await resolveRef(async () => {
      throw new Error("disk exploded")
    }, "env:BOOM")
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("ConfigError")
      // Not a clean miss.
      expect(j).not.toContain("is not set")
    }
  })
})
