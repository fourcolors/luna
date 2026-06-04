import { describe, expect, it } from "vitest"
import { HELP_TEXT, parseSlashCommand } from "../src/chat/slash.js"

describe("chat slash commands", () => {
  it("parses local shell toggles", () => {
    expect(parseSlashCommand("/local-shell on")).toEqual({
      type: "local-shell",
      action: "on",
    })
    expect(parseSlashCommand("/local-shell off")).toEqual({
      type: "local-shell",
      action: "off",
    })
    expect(parseSlashCommand("/local-shell status")).toEqual({
      type: "local-shell-status",
    })
    // Bare /local-shell shows status rather than erroring.
    expect(parseSlashCommand("/local-shell")).toEqual({
      type: "local-shell-status",
    })
  })

  it("parses local shell scope subcommands", () => {
    expect(parseSlashCommand("/local-shell add /Users/me/proj")).toEqual({
      type: "local-shell-attach",
      root: "/Users/me/proj",
    })
    expect(parseSlashCommand("/local-shell attach ~/code")).toEqual({
      type: "local-shell-attach",
      root: "~/code",
    })
    expect(parseSlashCommand("/local-shell rm /Users/me/proj")).toEqual({
      type: "local-shell-detach",
      root: "/Users/me/proj",
    })
    expect(parseSlashCommand("/local-shell full-access on")).toEqual({
      type: "local-shell-full-access",
      enabled: true,
    })
    expect(parseSlashCommand("/local-shell full-access off")).toEqual({
      type: "local-shell-full-access",
      enabled: false,
    })
    expect(parseSlashCommand("/local-shell add")).toEqual({
      type: "error",
      message: "/local-shell add requires a path",
    })
    expect(parseSlashCommand("/local-shell full-access maybe")).toEqual({
      type: "error",
      message: "/local-shell full-access requires on or off",
    })
  })

  it("parses thread and lifecycle commands", () => {
    expect(parseSlashCommand("/help")).toEqual({ type: "help" })
    expect(parseSlashCommand("/threads")).toEqual({ type: "threads" })
    expect(parseSlashCommand("/new")).toEqual({ type: "new-thread" })
    expect(parseSlashCommand("/switch thread-123")).toEqual({
      type: "switch-thread",
      threadId: "thread-123",
    })
    expect(parseSlashCommand("/interrupt")).toEqual({ type: "interrupt" })
    expect(parseSlashCommand("/quit")).toEqual({ type: "quit" })
    expect(parseSlashCommand("/exit")).toEqual({ type: "quit" })
  })

  it("returns non-slash input as a message", () => {
    expect(parseSlashCommand("hello /help")).toEqual({
      type: "message",
      text: "hello /help",
    })
  })

  it("rejects unknown local shell subcommands", () => {
    expect(parseSlashCommand("/local-shell run pwd")).toEqual({
      type: "error",
      message:
        "local shell supports on, off, status, add <path>, rm <path>, full-access <on|off>",
    })
  })

  it("exposes help text for supported commands", () => {
    expect(HELP_TEXT).toContain("/help")
    expect(HELP_TEXT).toContain("/threads")
    expect(HELP_TEXT).toContain("/new")
    expect(HELP_TEXT).toContain("/switch <thread-id>")
    expect(HELP_TEXT).toContain("/interrupt")
    expect(HELP_TEXT).toContain("/quit")
    expect(HELP_TEXT).toContain("/exit")
    expect(HELP_TEXT).toContain("/local-shell on")
    expect(HELP_TEXT).toContain("/local-shell off")
    expect(HELP_TEXT).toContain("/local-shell status")
  })
})

import { SLASH_COMMANDS } from "../src/chat/slash.js"

describe("SLASH_COMMANDS registry", () => {
  it("exports every command name referenced by HELP_TEXT", () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    for (const expected of ["/help", "/threads", "/new", "/switch", "/interrupt", "/quit", "/exit", "/local-shell"]) {
      expect(names).toContain(expected)
    }
  })

  it("each entry has a one-line description", () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.description.length).toBeGreaterThan(0)
      expect(cmd.description).not.toContain("\n")
    }
  })

  it("entries with arguments declare argHint", () => {
    const withArgs = SLASH_COMMANDS.find((c) => c.name === "/switch")
    expect(withArgs?.argHint).toBe("<thread-id>")
  })
})
