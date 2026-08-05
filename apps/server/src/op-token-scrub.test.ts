/**
 * op-token-scrub.test.ts - the anti-resurrection DELETE contract for op tokens
 * (F3): discovery falls through keychain → env → luna vault → legacy file, so a
 * delete must scrub EVERY applicable persisted tier on EVERY platform. Mirrors
 * the env-secret DELETE-contract tests in vault-secret-store.test.ts.
 */
import { describe, expect, it } from "vitest"
import { makeScrubOpToken, type ScrubOpTokenDeps } from "./op-token-scrub.js"

interface Recorder {
  readonly keychainDeletes: string[]
  readonly vaultDeletes: string[]
  readonly fileDeletes: string[]
}

const makeScrub = (opts: {
  platform?: NodeJS.Platform
  failKeychain?: boolean
  failVault?: boolean
  failFile?: boolean
  vaultReturns?: boolean
}): { scrub: (label: string) => Promise<void>; rec: Recorder } => {
  const rec: Recorder = {
    keychainDeletes: [],
    vaultDeletes: [],
    fileDeletes: [],
  }
  const deps: ScrubOpTokenDeps = {
    platform: opts.platform ?? "darwin",
    deleteKeychain: async (label) => {
      if (opts.failKeychain) throw new Error("keychain boom")
      rec.keychainDeletes.push(label)
    },
    deleteVault: async (label) => {
      if (opts.failVault) throw new Error("vault boom")
      rec.vaultDeletes.push(label)
      return opts.vaultReturns ?? false
    },
    deleteLegacyFile: async (label) => {
      if (opts.failFile) throw new Error("file boom")
      rec.fileDeletes.push(label)
    },
  }
  return { scrub: makeScrubOpToken(deps), rec }
}

describe("makeScrubOpToken: anti-resurrection DELETE contract (F3)", () => {
  it("darwin scrubs keychain + vault + legacy file in one call (anti-resurrection)", async () => {
    const { scrub, rec } = makeScrub({ platform: "darwin" })
    await scrub("primary")
    // A darwin delete must ALSO scrub vault + file, not just the keychain -
    // discovery falls through to them and would re-adopt a leftover copy.
    expect(rec.keychainDeletes).toEqual(["primary"])
    expect(rec.vaultDeletes).toEqual(["primary"])
    expect(rec.fileDeletes).toEqual(["primary"])
  })

  it("non-darwin skips the keychain but still scrubs vault + legacy file", async () => {
    const { scrub, rec } = makeScrub({ platform: "linux" })
    await scrub("primary")
    expect(rec.keychainDeletes).toEqual([]) // no keychain off darwin
    expect(rec.vaultDeletes).toEqual(["primary"])
    expect(rec.fileDeletes).toEqual(["primary"])
  })

  it("not-found everywhere still succeeds (all tiers report a clean miss)", async () => {
    const { scrub } = makeScrub({ platform: "darwin", vaultReturns: false })
    await expect(scrub("never-stored")).resolves.toBeUndefined()
  })

  it("partial failure (vault throws) still attempts the file, then rejects listing the failed tier", async () => {
    const { scrub, rec } = makeScrub({ platform: "linux", failVault: true })
    await expect(scrub("primary")).rejects.toThrow(
      /failed to remove op token "primary" from: luna-vault/,
    )
    // The file scrub STILL happened despite the vault failure.
    expect(rec.fileDeletes).toEqual(["primary"])
  })

  it("collects MULTIPLE tier failures and lists them all", async () => {
    const { scrub } = makeScrub({
      platform: "darwin",
      failKeychain: true,
      failVault: true,
    })
    await expect(scrub("primary")).rejects.toThrow(
      /from: keychain, luna-vault/,
    )
  })

  it("never leaks the token value - the message carries the LABEL only", async () => {
    const { scrub } = makeScrub({ platform: "linux", failVault: true })
    await scrub("primary").catch((e: Error) => {
      expect(e.message).toContain("primary")
      // The label is safe; there is no token value in scope here at all, but
      // pin the contract that only the label surfaces.
      expect(e.message).not.toContain("ops_")
    })
  })
})
