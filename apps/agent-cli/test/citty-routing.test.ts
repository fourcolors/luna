import { describe, it, expect } from "vitest"
import { defineCommand } from "citty"
import { accountCommand } from "../src/commands/account/index.js"

describe("citty account routing", () => {
  it("exposes list/add/rm subcommands", () => {
    expect(accountCommand.meta?.name).toBe("account")
    const subs = accountCommand.subCommands as Record<string, ReturnType<typeof defineCommand>>
    expect(Object.keys(subs).sort()).toEqual(["add", "list", "rm"])
  })
})
