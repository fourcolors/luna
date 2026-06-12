import { describe, expect, it } from "vitest"
import {
  makeVaultSecretStore,
  normalizeVaultStorageMode,
} from "./vault-secret-store.js"

describe("makeVaultSecretStore", () => {
  it("defaults to env mode and writes only env", async () => {
    const env: Record<string, string | undefined> = {}
    const writes: string[] = []
    const store = makeVaultSecretStore({
      platform: "darwin",
      mode: "env",
      env,
      writeEnv: async (name, value) => {
        writes.push(`${name}=${value}`)
        env[name] = value
      },
      removeEnv: async (name) => {
        delete env[name]
      },
      writeKeychain: async () => {
        throw new Error("must not write keychain")
      },
      deleteKeychain: async () => {
        throw new Error("must not delete keychain")
      },
    })

    await store.persistEnvSecret("OPENAI_API_KEY", "sk-test")

    expect(writes).toEqual(["OPENAI_API_KEY=sk-test"])
    expect(env.OPENAI_API_KEY).toBe("sk-test")
  })

  it("keychain-preferred on darwin writes keychain and process env but not env file", async () => {
    const env: Record<string, string | undefined> = {}
    const keychainWrites: string[] = []
    const store = makeVaultSecretStore({
      platform: "darwin",
      mode: "keychain-preferred",
      env,
      writeEnv: async () => {
        throw new Error("must not write env file")
      },
      removeEnv: async () => {},
      writeKeychain: async (name, value) => {
        keychainWrites.push(`${name}=${value}`)
      },
      deleteKeychain: async () => {},
    })

    await store.persistEnvSecret("OPENAI_API_KEY", "sk-test")

    expect(keychainWrites).toEqual(["OPENAI_API_KEY=sk-test"])
    expect(env.OPENAI_API_KEY).toBe("sk-test")
  })

  it("non-darwin keychain-preferred falls back to env mode", async () => {
    const env: Record<string, string | undefined> = {}
    const writes: string[] = []
    const store = makeVaultSecretStore({
      platform: "linux",
      mode: "keychain-preferred",
      env,
      writeEnv: async (name, value) => {
        writes.push(`${name}=${value}`)
        env[name] = value
      },
      removeEnv: async () => {},
      writeKeychain: async () => {
        throw new Error("must not write keychain")
      },
      deleteKeychain: async () => {},
    })

    await store.persistEnvSecret("OPENAI_API_KEY", "sk-test")

    expect(writes).toEqual(["OPENAI_API_KEY=sk-test"])
  })

  it("delete in keychain-preferred scrubs BOTH the keychain entry and the .env line (no resurrection on restart)", async () => {
    // An explicit operator delete must not leave the value in .env: on the
    // next boot .env reloads into process.env and the env-provider tail would
    // resurrect a secret the operator believed revoked (review finding).
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: "old" }
    const deleted: string[] = []
    const removedEnv: string[] = []
    const store = makeVaultSecretStore({
      platform: "darwin",
      mode: "keychain-preferred",
      env,
      writeEnv: async () => {},
      removeEnv: async (name) => {
        removedEnv.push(name)
      },
      writeKeychain: async () => {},
      deleteKeychain: async (name) => {
        deleted.push(name)
      },
    })

    await store.removeEnvSecret("OPENAI_API_KEY")

    expect(deleted).toEqual(["OPENAI_API_KEY"])
    expect(removedEnv).toEqual(["OPENAI_API_KEY"])
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })
})

describe("normalizeVaultStorageMode", () => {
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
