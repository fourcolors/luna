import { describe, expect, it } from "vitest"
import { HELP_TEXT, parseSlashCommand } from "../src/chat/slash.js"

describe("chat slash commands", () => {
  it("parses local shell toggles", () => {
    expect(parseSlashCommand("/local-shell on")).toEqual({
      type: "local_shell",
      action: "on",
    })
    expect(parseSlashCommand("/local-shell off")).toEqual({
      type: "local_shell",
      action: "off",
    })
    expect(parseSlashCommand("/local-shell status")).toEqual({
      type: "local_shell",
      action: "status",
    })
  })

  it("parses thread and lifecycle commands", () => {
    expect(parseSlashCommand("/help")).toEqual({ type: "help" })
    expect(parseSlashCommand("/threads")).toEqual({ type: "threads" })
    expect(parseSlashCommand("/new")).toEqual({ type: "new_thread" })
    expect(parseSlashCommand("/switch thread-123")).toEqual({
      type: "switch_thread",
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

  it("rejects local shell run commands", () => {
    expect(parseSlashCommand("/local-shell run pwd")).toEqual({
      type: "error",
      message: "local shell supports only on, off, and status",
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
