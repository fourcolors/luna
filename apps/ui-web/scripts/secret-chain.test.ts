/**
 * secret-chain.test.ts - app-side SecretProvider composition, op-token
 * discovery precedence, the boot integrity gate, and normalize v2.
 *
 * Chain composition is pinned by RESOLUTION BEHAVIOR (not by inspecting layer
 * internals): a fake keychain reader, a fake luna-vault reader, process.env and
 * a fake op account let us assert exactly which tier wins for a given ref. The
 * legacy modes (env / keychain-*) must resolve byte-identically to today; auto
 * inserts the lunaVault tier between keychain and env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect, Exit, Layer, Redacted } from "effect"
import {
  ConfigError,
  SecretProvider,
  type KeychainQuery,
  type SecretProviderApi,
} from "@luna/core"
import {
  assertVaultBootIntegrity,
  buildSecretChainLayer,
  buildStorageStatus,
  discoverOpTokens,
  normalizeVaultStorageModeV2,
  type RoutedOpAccountLayer,
} from "./secret-chain.js"
import type { OpAccountConfig } from "./op-accounts.js"

/* -------------------------------------------------------------------------- */
/* Chain harness - resolve a ref through a freshly-built chain layer.          */
/* -------------------------------------------------------------------------- */

/** Resolve `ref`, returning the plaintext value or null on a chain-wide miss. */
const resolve = async (
  layer: Layer.Layer<SecretProvider, ConfigError>,
  ref: string,
): Promise<string | null> => {
  const program = Effect.gen(function* () {
    const sp = yield* SecretProvider
    const v = yield* sp.get(ref).pipe(Effect.option)
    return v._tag === "Some" ? Redacted.value(v.value) : null
  })
  return Effect.runPromise(Effect.scoped(Effect.provide(program, layer)))
}

/** A fake single-account op layer: resolves `op://<rest>` to a fixed value. */
const fakeOpAccount = (label: string, value: string): RoutedOpAccountLayer => ({
  label,
  layer: Layer.succeed(SecretProvider, {
    get: (ref) =>
      ref.startsWith("op://")
        ? Effect.succeed(Redacted.make(value))
        : Effect.fail(
            new ConfigError({
              module: "FakeOp",
              key: ref,
              message: `not an op ref: ${ref}`,
            }),
          ),
  } satisfies SecretProviderApi),
})

/** A keychain reader fake: hits for names in `hits`, misses otherwise. */
const fakeKeychainRead =
  (hits: Record<string, string>) =>
  (q: KeychainQuery): Effect.Effect<string, ConfigError> => {
    const value = hits[q.account]
    return value === undefined
      ? Effect.fail(
          new ConfigError({
            module: "FakeKeychain",
            key: q.account,
            message: "keychain miss",
          }),
        )
      : Effect.succeed(value)
  }

/** A luna-vault reader fake: hits for names in `hits`, misses otherwise. */
const fakeVaultRead =
  (hits: Record<string, string>) =>
  (name: string): Promise<string | undefined> =>
    Promise.resolve(hits[name])

/* -------------------------------------------------------------------------- */
/* Chain composition per mode                                                  */
/* -------------------------------------------------------------------------- */

describe("buildSecretChainLayer: env mode (routedOp → env, byte-compat)", () => {
  const OLD = process.env["CHAIN_TEST_KEY"]
  beforeEach(() => {
    process.env["CHAIN_TEST_KEY"] = "from-env"
  })
  afterEach(() => {
    if (OLD === undefined) delete process.env["CHAIN_TEST_KEY"]
    else process.env["CHAIN_TEST_KEY"] = OLD
  })

  it("resolves env:NAME from process.env", async () => {
    const layer = buildSecretChainLayer({
      mode: "env",
      platform: "linux",
      opAccounts: [],
      lunaVaultRead: fakeVaultRead({ CHAIN_TEST_KEY: "from-vault" }),
    })
    // env mode has NO vault tier: the vault hit must be ignored, env wins.
    expect(await resolve(layer, "env:CHAIN_TEST_KEY")).toBe("from-env")
  })

  it("op refs never fall through to env (routed op wins, no env leak)", async () => {
    const layer = buildSecretChainLayer({
      mode: "env",
      platform: "linux",
      opAccounts: [fakeOpAccount("primary", "op-secret")],
      lunaVaultRead: fakeVaultRead({}),
    })
    expect(await resolve(layer, "luna-op://primary/vault/item")).toBe(
      "op-secret",
    )
  })
})

describe("buildSecretChainLayer: keychain modes (routedOp → keychainEnv → env, byte-compat)", () => {
  const OLD = process.env["KC_TEST_KEY"]
  beforeEach(() => {
    process.env["KC_TEST_KEY"] = "from-env"
  })
  afterEach(() => {
    if (OLD === undefined) delete process.env["KC_TEST_KEY"]
    else process.env["KC_TEST_KEY"] = OLD
  })

  for (const mode of ["keychain-preferred", "keychain-only"] as const) {
    it(`${mode}: keychain HIT beats env`, async () => {
      const layer = buildSecretChainLayer({
        mode,
        platform: "darwin",
        opAccounts: [],
        lunaVaultRead: fakeVaultRead({ KC_TEST_KEY: "from-vault" }),
        _keychainRead: fakeKeychainRead({ KC_TEST_KEY: "from-keychain" }),
      })
      // keychain wins; the vault is NOT in a keychain-mode chain, so its hit is
      // irrelevant (byte-compat: today's chain has no vault tier).
      expect(await resolve(layer, "env:KC_TEST_KEY")).toBe("from-keychain")
    })

    it(`${mode}: keychain MISS falls through to env`, async () => {
      const layer = buildSecretChainLayer({
        mode,
        platform: "darwin",
        opAccounts: [],
        lunaVaultRead: fakeVaultRead({ KC_TEST_KEY: "from-vault" }),
        _keychainRead: fakeKeychainRead({}), // miss
      })
      // No vault tier in keychain mode: falls straight through to env.
      expect(await resolve(layer, "env:KC_TEST_KEY")).toBe("from-env")
    })
  }
})

describe("buildSecretChainLayer: auto mode inserts lunaVault between keychain and env", () => {
  const OLD = process.env["AUTO_TEST_KEY"]
  beforeEach(() => {
    process.env["AUTO_TEST_KEY"] = "from-env"
  })
  afterEach(() => {
    if (OLD === undefined) delete process.env["AUTO_TEST_KEY"]
    else process.env["AUTO_TEST_KEY"] = OLD
  })

  it("darwin: keychain HIT beats vault and env", async () => {
    const layer = buildSecretChainLayer({
      mode: "auto",
      platform: "darwin",
      opAccounts: [],
      lunaVaultRead: fakeVaultRead({ AUTO_TEST_KEY: "from-vault" }),
      _keychainRead: fakeKeychainRead({ AUTO_TEST_KEY: "from-keychain" }),
    })
    expect(await resolve(layer, "env:AUTO_TEST_KEY")).toBe("from-keychain")
  })

  it("darwin: keychain MISS falls to vault (before env)", async () => {
    const layer = buildSecretChainLayer({
      mode: "auto",
      platform: "darwin",
      opAccounts: [],
      lunaVaultRead: fakeVaultRead({ AUTO_TEST_KEY: "from-vault" }),
      _keychainRead: fakeKeychainRead({}), // keychain miss
    })
    expect(await resolve(layer, "env:AUTO_TEST_KEY")).toBe("from-vault")
  })

  it("non-darwin: keychain tier is SKIPPED; vault beats env", async () => {
    const layer = buildSecretChainLayer({
      mode: "auto",
      platform: "linux",
      opAccounts: [],
      lunaVaultRead: fakeVaultRead({ AUTO_TEST_KEY: "from-vault" }),
      // _keychainRead would never be consulted off darwin, but supplying a hit
      // proves the tier is truly skipped (would otherwise win over vault).
      _keychainRead: fakeKeychainRead({ AUTO_TEST_KEY: "from-keychain" }),
    })
    expect(await resolve(layer, "env:AUTO_TEST_KEY")).toBe("from-vault")
  })

  it("vault MISS falls through to env (load-bearing env tail)", async () => {
    const layer = buildSecretChainLayer({
      mode: "auto",
      platform: "linux",
      opAccounts: [],
      lunaVaultRead: fakeVaultRead({}), // vault miss
    })
    expect(await resolve(layer, "env:AUTO_TEST_KEY")).toBe("from-env")
  })

  it("vault INTEGRITY failure fails the chain loudly and NEVER consults the env tail (F1)", async () => {
    const { LunaVaultIntegrityError } = await import("@luna/core")
    const layer = buildSecretChainLayer({
      mode: "auto",
      platform: "linux",
      opAccounts: [],
      // The vault is present but locked out: read throws an integrity error.
      lunaVaultRead: async () => {
        throw new LunaVaultIntegrityError("key-missing", "vault locked out")
      },
    })
    // AUTO_TEST_KEY IS set in process.env (beforeEach), so a fall-through to the
    // env tail WOULD resolve "from-env". The stopOn guard must prevent that:
    // resolution must FAIL with the integrity-prefixed message instead of
    // silently resolving stale plaintext.
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            const sp = yield* SecretProvider
            return yield* sp.get("env:AUTO_TEST_KEY")
          }),
          layer,
        ),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const j = JSON.stringify(exit.cause)
      expect(j).toContain("luna vault integrity:")
      // The env tail value must NOT have leaked through.
      expect(j).not.toContain("from-env")
    }
  })

  it("op refs never fall through even in auto", async () => {
    const layer = buildSecretChainLayer({
      mode: "auto",
      platform: "linux",
      opAccounts: [fakeOpAccount("primary", "op-secret")],
      lunaVaultRead: fakeVaultRead({}),
    })
    expect(await resolve(layer, "luna-op://primary/x")).toBe("op-secret")
  })
})

/* -------------------------------------------------------------------------- */
/* discoverOpTokens precedence matrix                                          */
/* -------------------------------------------------------------------------- */

const acct = (label: string): OpAccountConfig => ({
  label,
  keychainService: `luna.op.${label}`,
  keychainAccount: label,
  tokenEnvVar: `LUNA_OP_TOKEN_${label.toUpperCase()}`,
})

describe("discoverOpTokens: precedence keychain → env → vault → legacy file", () => {
  it("keychain wins over everything", async () => {
    const found = await discoverOpTokens({
      accounts: [acct("primary")],
      keychainRead: async () => "kc-token",
      vaultRead: async () => "vault-token",
      env: { LUNA_OP_TOKEN_PRIMARY: "env-token" },
      readFile: () => "file-token",
    })
    expect(found).toEqual([{ label: "primary", token: "kc-token" }])
  })

  it("env var wins over vault when keychain misses (env-AND-vault collision)", async () => {
    const found = await discoverOpTokens({
      accounts: [acct("primary")],
      keychainRead: async () => undefined,
      vaultRead: async () => "vault-token",
      env: { LUNA_OP_TOKEN_PRIMARY: "env-token" },
      readFile: () => "file-token",
    })
    expect(found).toEqual([{ label: "primary", token: "env-token" }])
  })

  it("vault wins over the legacy file (vault-AND-file collision)", async () => {
    const found = await discoverOpTokens({
      accounts: [acct("primary")],
      keychainRead: async () => undefined,
      vaultRead: async () => "vault-token",
      env: {},
      readFile: () => "file-token",
    })
    expect(found).toEqual([{ label: "primary", token: "vault-token" }])
  })

  it("legacy file is the last fallback (readable forever)", async () => {
    const found = await discoverOpTokens({
      accounts: [acct("primary")],
      keychainRead: async () => undefined,
      vaultRead: async () => undefined,
      env: {},
      readFile: () => "file-token",
    })
    expect(found).toEqual([{ label: "primary", token: "file-token" }])
  })

  it("an account with NO token in any source is skipped (non-fatal)", async () => {
    const found = await discoverOpTokens({
      accounts: [acct("primary"), acct("secondary")],
      keychainRead: async (a) => (a.label === "primary" ? "kc" : undefined),
      vaultRead: async () => undefined,
      env: {},
      readFile: () => {
        throw new Error("no file")
      },
    })
    expect(found).toEqual([{ label: "primary", token: "kc" }])
  })

  it("vault integrity failure skips the legacy file for that label and logs without token values", async () => {
    const { LunaVaultIntegrityError } = await import("@luna/core")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const found = await discoverOpTokens({
        accounts: [acct("primary")],
        keychainRead: async () => undefined,
        vaultRead: async () => {
          throw new LunaVaultIntegrityError("key-missing", "locked out")
        },
        env: {},
        readFile: () => "file-token",
      })
      expect(found).toEqual([])
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logged = errorSpy.mock.calls.flat().join(" ")
      expect(logged).toContain("primary")
      expect(logged).toContain("key-missing")
      expect(logged).not.toContain("file-token")
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("blank/whitespace vault value is a miss (falls through)", async () => {
    const found = await discoverOpTokens({
      accounts: [acct("primary")],
      keychainRead: async () => undefined,
      vaultRead: async () => "   ",
      env: {},
      readFile: () => "file-token",
    })
    expect(found).toEqual([{ label: "primary", token: "file-token" }])
  })
})

/* -------------------------------------------------------------------------- */
/* Boot integrity gate                                                         */
/* -------------------------------------------------------------------------- */

describe("assertVaultBootIntegrity", () => {
  it("returns cleanly when the store is ok (fresh/empty)", async () => {
    const logs: string[] = []
    let exited = false
    await assertVaultBootIntegrity(
      { checkIntegrity: async () => ({ ok: true, count: 0 }) },
      "auto",
      (m) => logs.push(m),
      (() => {
        exited = true
        return undefined as never
      }),
    )
    expect(exited).toBe(false)
    expect(logs).toEqual([])
  })

  it("auto mode: logs the restore instruction and exits non-zero on {ok:false}", async () => {
    const logs: string[] = []
    let code: number | null = null
    await assertVaultBootIntegrity(
      { checkIntegrity: async () => ({ ok: false, reason: "key-missing" }) },
      "auto",
      (m) => logs.push(m),
      ((c: number) => {
        code = c
        return undefined as never
      }),
    )
    expect(code).toBe(1)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("key-missing")
    expect(logs[0]).toContain("restore the key or delete both")
  })

  it("non-auto mode: {ok:false} does NOT exit, logs a loud warning and continues (F2)", async () => {
    const logs: string[] = []
    let exited = false
    for (const mode of ["env", "keychain-preferred", "keychain-only"] as const) {
      logs.length = 0
      await assertVaultBootIntegrity(
        { checkIntegrity: async () => ({ ok: false, reason: "key-missing" }) },
        mode,
        (m) => logs.push(m),
        (() => {
          exited = true
          return undefined as never
        }),
      )
      // Continues boot: no exit for a mode that never reads the vault tier.
      expect(exited).toBe(false)
      expect(logs).toHaveLength(1)
      // The warning states the reason and that switching to auto will refuse boot.
      expect(logs[0]).toContain("key-missing")
      expect(logs[0]).toContain(mode)
      expect(logs[0]).toContain("switching to auto will refuse boot")
    }
  })

  it("auto mode: fails closed (exit 1) if checkIntegrity itself throws", async () => {
    const logs: string[] = []
    let code: number | null = null
    await assertVaultBootIntegrity(
      {
        checkIntegrity: async () => {
          throw new Error("unexpected")
        },
      },
      "auto",
      (m) => logs.push(m),
      ((c: number) => {
        code = c
        return undefined as never
      }),
    )
    expect(code).toBe(1)
    expect(logs[0]).toContain("refusing to boot")
  })

  it("non-auto mode: a checkIntegrity throw does NOT exit, warns and continues (F2)", async () => {
    const logs: string[] = []
    let exited = false
    await assertVaultBootIntegrity(
      {
        checkIntegrity: async () => {
          throw new Error("unexpected")
        },
      },
      "env",
      (m) => logs.push(m),
      (() => {
        exited = true
        return undefined as never
      }),
    )
    expect(exited).toBe(false)
    expect(logs[0]).toContain("does not read the vault tier")
  })
})

/* -------------------------------------------------------------------------- */
/* normalizeVaultStorageModeV2 matrix                                          */
/* -------------------------------------------------------------------------- */

describe("normalizeVaultStorageModeV2", () => {
  it("unset/unknown → auto on every platform", () => {
    expect(normalizeVaultStorageModeV2(undefined, "darwin")).toBe("auto")
    expect(normalizeVaultStorageModeV2(undefined, "linux")).toBe("auto")
    expect(normalizeVaultStorageModeV2("bananas", "darwin")).toBe("auto")
    expect(normalizeVaultStorageModeV2("auto", "linux")).toBe("auto")
  })

  it("env → env on every platform", () => {
    expect(normalizeVaultStorageModeV2("env", "darwin")).toBe("env")
    expect(normalizeVaultStorageModeV2("env", "linux")).toBe("env")
  })

  it("keychain-* kept as-is on darwin", () => {
    expect(normalizeVaultStorageModeV2("keychain-preferred", "darwin")).toBe(
      "keychain-preferred",
    )
    expect(normalizeVaultStorageModeV2("keychain-only", "darwin")).toBe(
      "keychain-only",
    )
  })

  it("keychain-* on non-darwin → auto (secure intent, no security shell-out)", () => {
    expect(normalizeVaultStorageModeV2("keychain-preferred", "linux")).toBe(
      "auto",
    )
    expect(normalizeVaultStorageModeV2("keychain-only", "linux")).toBe("auto")
    expect(normalizeVaultStorageModeV2("keychain-preferred", "win32")).toBe(
      "auto",
    )
  })
})

/* -------------------------------------------------------------------------- */
/* buildStorageStatus                                                          */
/* -------------------------------------------------------------------------- */

describe("buildStorageStatus", () => {
  it("projects the boot snapshot to the wire shape (lunaVault always true)", () => {
    const s = buildStorageStatus({
      mode: "auto",
      writeTier: "luna-vault",
      probe: { onePassword: "active", osKeychain: false },
      envResidue: 3,
    })
    expect(s).toEqual({
      mode: "auto",
      writeTier: "luna-vault",
      onePassword: "active",
      osKeychain: false,
      lunaVault: true,
      envResidue: 3,
    })
  })
})
