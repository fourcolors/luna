import { describe, expect, it } from "vitest"
import { resolveOpAccounts } from "../op-accounts.js"

describe("resolveOpAccounts", () => {
  it("does not bake deployment-specific keychain accounts into the repo", () => {
    expect(resolveOpAccounts({})).toEqual([])
    expect(resolveOpAccounts({ LUNA_OP_ACCOUNTS: "   " })).toEqual([])
  })

  it("parses generic labels into conventional keychain entries", () => {
    expect(resolveOpAccounts({ LUNA_OP_ACCOUNTS: "primary,ops" })).toEqual([
      {
        label: "primary",
        keychainService: "luna.op.primary",
        keychainAccount: "primary",
      },
      {
        label: "ops",
        keychainService: "luna.op.ops",
        keychainAccount: "ops",
      },
    ])
  })

  it("allows explicit keychain service and account names", () => {
    expect(
      resolveOpAccounts({
        LUNA_OP_ACCOUNTS:
          "primary:com.example.luna.primary:svc-primary",
      }),
    ).toEqual([
      {
        label: "primary",
        keychainService: "com.example.luna.primary",
        keychainAccount: "svc-primary",
      },
    ])
  })

  it("rejects malformed entries", () => {
    expect(() =>
      resolveOpAccounts({ LUNA_OP_ACCOUNTS: "Primary" }),
    ).toThrow(/label/)
    expect(() =>
      resolveOpAccounts({ LUNA_OP_ACCOUNTS: "primary:svc" }),
    ).toThrow(/LUNA_OP_ACCOUNTS/)
  })
})
