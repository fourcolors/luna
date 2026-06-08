import { describe, expect, it } from "vitest"
import {
  envTokenFor,
  fileTokenFor,
  resolveOpAccounts,
  tokenFilePathFor,
} from "../op-accounts.js"

describe("resolveOpAccounts", () => {
  it("does not bake deployment-specific accounts into the repo", () => {
    expect(resolveOpAccounts({})).toEqual([])
    expect(resolveOpAccounts({ LUNA_OP_ACCOUNTS: "   " })).toEqual([])
  })

  it("derives keychain coords and the env-var fallback from each label", () => {
    expect(resolveOpAccounts({ LUNA_OP_ACCOUNTS: "primary,ops" })).toEqual([
      {
        label: "primary",
        keychainService: "luna.op.primary",
        keychainAccount: "primary",
        tokenEnvVar: "LUNA_OP_TOKEN_PRIMARY",
      },
      {
        label: "ops",
        keychainService: "luna.op.ops",
        keychainAccount: "ops",
        tokenEnvVar: "LUNA_OP_TOKEN_OPS",
      },
    ])
  })

  it("collapses hyphens to underscores in the env-var name", () => {
    expect(resolveOpAccounts({ LUNA_OP_ACCOUNTS: "ops-flow" })).toEqual([
      {
        label: "ops-flow",
        keychainService: "luna.op.ops-flow",
        keychainAccount: "ops-flow",
        tokenEnvVar: "LUNA_OP_TOKEN_OPS_FLOW",
      },
    ])
  })

  it("ignores empty entries from stray/trailing commas", () => {
    expect(resolveOpAccounts({ LUNA_OP_ACCOUNTS: "primary, ,ops," })).toEqual([
      {
        label: "primary",
        keychainService: "luna.op.primary",
        keychainAccount: "primary",
        tokenEnvVar: "LUNA_OP_TOKEN_PRIMARY",
      },
      {
        label: "ops",
        keychainService: "luna.op.ops",
        keychainAccount: "ops",
        tokenEnvVar: "LUNA_OP_TOKEN_OPS",
      },
    ])
  })

  it("rejects malformed labels (uppercase, or the dropped colon syntax)", () => {
    expect(() =>
      resolveOpAccounts({ LUNA_OP_ACCOUNTS: "Primary" }),
    ).toThrow(/label/)
    // The legacy `<label>:<service>:<account>` form is gone — a colon is
    // no longer a valid label character, so it is rejected.
    expect(() =>
      resolveOpAccounts({ LUNA_OP_ACCOUNTS: "primary:com.example:svc" }),
    ).toThrow(/LUNA_OP_ACCOUNTS/)
  })
})

describe("envTokenFor (Linux/fallback token read)", () => {
  const [primary] = resolveOpAccounts({ LUNA_OP_ACCOUNTS: "primary" })

  it("reads the trimmed token from LUNA_OP_TOKEN_<LABEL>", () => {
    expect(
      envTokenFor(primary!, { LUNA_OP_TOKEN_PRIMARY: "  ops_abc123  " }),
    ).toBe("ops_abc123")
  })

  it("returns undefined when the env var is unset", () => {
    expect(envTokenFor(primary!, {})).toBeUndefined()
  })

  it("treats a blank/whitespace value as unset", () => {
    expect(envTokenFor(primary!, { LUNA_OP_TOKEN_PRIMARY: "   " })).toBeUndefined()
  })
})

describe("fileTokenFor (runtime token-file read)", () => {
  const [primary] = resolveOpAccounts({ LUNA_OP_ACCOUNTS: "primary" })

  it("derives the token-file path under ~/.luna/op-tokens/<label>", () => {
    expect(tokenFilePathFor("primary")).toMatch(/\/\.luna\/op-tokens\/primary$/)
    expect(tokenFilePathFor("ops-flow")).toMatch(/\/op-tokens\/ops-flow$/)
  })

  it("reads the trimmed token from the label's file", () => {
    const read = (p: string) => {
      expect(p).toBe(tokenFilePathFor("primary"))
      return "  ops_filetoken\n"
    }
    expect(fileTokenFor(primary!, read)).toBe("ops_filetoken")
  })

  it("returns undefined when the file is absent (read throws)", () => {
    const read = (): string => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    }
    expect(fileTokenFor(primary!, read)).toBeUndefined()
  })

  it("treats a blank file as unset", () => {
    expect(fileTokenFor(primary!, () => "  \n")).toBeUndefined()
  })
})
