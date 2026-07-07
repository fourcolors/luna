import { describe, expect, it } from "vitest"
import type { WriteTier } from "@luna/core"
import {
  makeVaultSecretStore,
  normalizeVaultStorageMode,
  type VaultSecretStoreDeps,
} from "./vault-secret-store.js"

/* -------------------------------------------------------------------------- */
/* Test harness - a store wired with recording fakes for every tier.          */
/* -------------------------------------------------------------------------- */

interface Recorder {
  readonly envWrites: string[]
  readonly envRemoves: string[]
  readonly keychainWrites: string[]
  readonly keychainDeletes: string[]
  readonly vaultWrites: string[]
  readonly vaultDeletes: string[]
  readonly env: Record<string, string | undefined>
}

const makeStore = (
  opts: {
    platform?: NodeJS.Platform
    writeTier: WriteTier
    env?: Record<string, string | undefined>
    // Optional failure injectors - throw from the named tier's delete.
    failEnvRemove?: boolean
    failKeychainDelete?: boolean
    failVaultDelete?: boolean
    // vaultFile.deleteSecret return value (default false = absent).
    vaultDeleteReturns?: boolean
  },
): { store: ReturnType<typeof makeVaultSecretStore>; rec: Recorder } => {
  const env = opts.env ?? {}
  const rec: Recorder = {
    envWrites: [],
    envRemoves: [],
    keychainWrites: [],
    keychainDeletes: [],
    vaultWrites: [],
    vaultDeletes: [],
    env,
  }
  const deps: VaultSecretStoreDeps = {
    platform: opts.platform ?? "darwin",
    writeTier: opts.writeTier,
    env,
    writeEnv: async (name, value) => {
      rec.envWrites.push(`${name}=${value}`)
      env[name] = value
    },
    removeEnv: async (name) => {
      if (opts.failEnvRemove) throw new Error("env remove boom")
      rec.envRemoves.push(name)
    },
    writeKeychain: async (name, value) => {
      rec.keychainWrites.push(`${name}=${value}`)
    },
    deleteKeychain: async (name) => {
      if (opts.failKeychainDelete) throw new Error("keychain delete boom")
      rec.keychainDeletes.push(name)
    },
    vaultFile: {
      writeSecret: async (name, value) => {
        rec.vaultWrites.push(`${name}=${value}`)
      },
      deleteSecret: async (name) => {
        if (opts.failVaultDelete) throw new Error("vault delete boom")
        rec.vaultDeletes.push(name)
        return opts.vaultDeleteReturns ?? false
      },
    },
  }
  return { store: makeVaultSecretStore(deps), rec }
}

/* -------------------------------------------------------------------------- */
/* WRITE routing matrix - one tier per writeTier.                             */
/* -------------------------------------------------------------------------- */

describe("makeVaultSecretStore v2: persistEnvSecret routes by writeTier", () => {
  it("writeTier=env writes only .env (+ process.env mirror)", async () => {
    const { store, rec } = makeStore({ writeTier: "env" })
    await store.persistEnvSecret("OPENAI_API_KEY", "sk-test")
    expect(rec.envWrites).toEqual(["OPENAI_API_KEY=sk-test"])
    expect(rec.keychainWrites).toEqual([])
    expect(rec.vaultWrites).toEqual([])
    expect(rec.env.OPENAI_API_KEY).toBe("sk-test")
  })

  it("writeTier=keychain writes only the keychain (+ process.env mirror)", async () => {
    const { store, rec } = makeStore({ writeTier: "keychain" })
    await store.persistEnvSecret("OPENAI_API_KEY", "sk-test")
    expect(rec.keychainWrites).toEqual(["OPENAI_API_KEY=sk-test"])
    expect(rec.envWrites).toEqual([])
    expect(rec.vaultWrites).toEqual([])
    expect(rec.env.OPENAI_API_KEY).toBe("sk-test")
  })

  it("writeTier=luna-vault writes only the vault (+ process.env mirror)", async () => {
    const { store, rec } = makeStore({ writeTier: "luna-vault" })
    await store.persistEnvSecret("OPENAI_API_KEY", "sk-test")
    expect(rec.vaultWrites).toEqual(["OPENAI_API_KEY=sk-test"])
    expect(rec.envWrites).toEqual([])
    expect(rec.keychainWrites).toEqual([])
    expect(rec.env.OPENAI_API_KEY).toBe("sk-test")
  })

  it("exposes the resolved writeTier", () => {
    const { store } = makeStore({ writeTier: "luna-vault" })
    expect(store.writeTier).toBe("luna-vault")
  })
})

/* -------------------------------------------------------------------------- */
/* DELETE contract - attempt every tier unconditionally, in every mode.       */
/* -------------------------------------------------------------------------- */

describe("makeVaultSecretStore v2: removeEnvSecret DELETE contract", () => {
  it("scrubs keychain + vault + env in ONE call on darwin, regardless of writeTier", async () => {
    const { store, rec } = makeStore({
      platform: "darwin",
      writeTier: "env", // even in env mode, every tier is scrubbed
      env: { OPENAI_API_KEY: "old" },
    })
    await store.removeEnvSecret("OPENAI_API_KEY")
    expect(rec.keychainDeletes).toEqual(["OPENAI_API_KEY"])
    expect(rec.vaultDeletes).toEqual(["OPENAI_API_KEY"])
    expect(rec.envRemoves).toEqual(["OPENAI_API_KEY"])
    expect(rec.env.OPENAI_API_KEY).toBeUndefined()
  })

  it("skips the keychain on non-darwin (no keychain to scrub) but still scrubs vault + env", async () => {
    const { store, rec } = makeStore({
      platform: "linux",
      writeTier: "luna-vault",
      env: { OPENAI_API_KEY: "old" },
    })
    await store.removeEnvSecret("OPENAI_API_KEY")
    expect(rec.keychainDeletes).toEqual([]) // never attempted off darwin
    expect(rec.vaultDeletes).toEqual(["OPENAI_API_KEY"])
    expect(rec.envRemoves).toEqual(["OPENAI_API_KEY"])
  })

  it("not-found everywhere still succeeds (all tiers report a clean miss)", async () => {
    const { store, rec } = makeStore({
      platform: "darwin",
      writeTier: "keychain",
      // vault deleteSecret returns false (absent), keychain wrapper treats
      // not-found as success, removeEnv is a no-op on a missing line.
      vaultDeleteReturns: false,
    })
    await expect(
      store.removeEnvSecret("NEVER_STORED"),
    ).resolves.toBeUndefined()
    expect(rec.keychainDeletes).toEqual(["NEVER_STORED"])
    expect(rec.vaultDeletes).toEqual(["NEVER_STORED"])
    expect(rec.envRemoves).toEqual(["NEVER_STORED"])
  })

  it("PARTIAL FAILURE (vault delete throws) still calls removeEnv, then rejects listing the failed tier", async () => {
    const { store, rec } = makeStore({
      platform: "linux", // keychain skipped; vault + env attempted
      writeTier: "luna-vault",
      failVaultDelete: true,
      env: { OPENAI_API_KEY: "old" },
    })
    await expect(store.removeEnvSecret("OPENAI_API_KEY")).rejects.toThrow(
      /failed to remove secret "OPENAI_API_KEY" from: luna-vault/,
    )
    // The env scrub STILL happened despite the vault failure (resurrection
    // guard): a partial scrub must not silently leave a rollback copy behind.
    expect(rec.envRemoves).toEqual(["OPENAI_API_KEY"])
    expect(rec.env.OPENAI_API_KEY).toBeUndefined()
  })

  it("collects MULTIPLE tier failures and lists them all", async () => {
    const { store } = makeStore({
      platform: "darwin",
      writeTier: "keychain",
      failKeychainDelete: true,
      failVaultDelete: true,
      env: { K: "v" },
    })
    await expect(store.removeEnvSecret("K")).rejects.toThrow(
      /from: keychain, luna-vault/,
    )
  })

  it("does not leak the value in the failure message (name only)", async () => {
    const { store } = makeStore({
      platform: "linux",
      writeTier: "luna-vault",
      failVaultDelete: true,
      env: { SECRET_NAME: "super-secret-value" },
    })
    await store.removeEnvSecret("SECRET_NAME").catch((e: Error) => {
      expect(e.message).toContain("SECRET_NAME")
      expect(e.message).not.toContain("super-secret-value")
    })
  })
})

/* -------------------------------------------------------------------------- */
/* Legacy v1 normalizer - retained for compat.                                */
/* -------------------------------------------------------------------------- */

describe("normalizeVaultStorageMode (legacy v1, retained)", () => {
  it("defaults unknown values to env", () => {
    expect(normalizeVaultStorageMode(undefined, "darwin")).toBe("env")
    expect(normalizeVaultStorageMode("bad", "darwin")).toBe("env")
  })

  it("allows keychain modes only on darwin", () => {
    expect(normalizeVaultStorageMode("keychain-preferred", "darwin")).toBe(
      "keychain-preferred",
    )
    expect(normalizeVaultStorageMode("keychain-only", "darwin")).toBe(
      "keychain-only",
    )
    expect(normalizeVaultStorageMode("keychain-preferred", "linux")).toBe("env")
    expect(normalizeVaultStorageMode("keychain-only", "linux")).toBe("env")
  })
})
