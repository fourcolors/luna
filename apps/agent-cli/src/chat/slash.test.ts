/**
 * slash.test.ts — parser cases for slash commands.
 *
 * Initially added to lock in the /copy command shape (issue #17). Existing
 * commands have light coverage here too so future renames notice they broke
 * something.
 */
import { describe, expect, it } from "vitest"
import { parseSlashCommand } from "./slash.js"

describe("parseSlashCommand — /copy", () => {
  it("/copy with no args → last assistant message", () => {
    expect(parseSlashCommand("/copy")).toEqual({
      type: "copy",
      target: "last",
      count: 1,
    })
  })

  it("/copy <N> → last N messages", () => {
    expect(parseSlashCommand("/copy 5")).toEqual({
      type: "copy",
      target: "messages",
      count: 5,
    })
  })

  it("/copy thread → entire thread (case-insensitive)", () => {
    expect(parseSlashCommand("/copy thread")).toEqual({
      type: "copy",
      target: "thread",
      count: 0,
    })
    expect(parseSlashCommand("/copy Thread")).toEqual({
      type: "copy",
      target: "thread",
      count: 0,
    })
  })

  it("/copy 0 → error (count must be ≥ 1)", () => {
    const c = parseSlashCommand("/copy 0")
    expect(c.type).toBe("error")
  })

  it("/copy garbage → error", () => {
    const c = parseSlashCommand("/copy frogs")
    expect(c.type).toBe("error")
  })

  it("/copy ignores trailing whitespace", () => {
    expect(parseSlashCommand("/copy   ")).toEqual({
      type: "copy",
      target: "last",
      count: 1,
    })
    expect(parseSlashCommand("/copy 3   ")).toEqual({
      type: "copy",
      target: "messages",
      count: 3,
    })
  })
})

describe("parseSlashCommand — sanity for existing commands", () => {
  it("plain text → message", () => {
    expect(parseSlashCommand("hello luna")).toEqual({
      type: "message",
      text: "hello luna",
    })
  })

  it("/help → help", () => {
    expect(parseSlashCommand("/help")).toEqual({ type: "help" })
  })

  it("/exit → quit", () => {
    expect(parseSlashCommand("/exit")).toEqual({ type: "quit" })
  })

  it("/unknown → error", () => {
    const c = parseSlashCommand("/totallyfake")
    expect(c.type).toBe("error")
  })
})

describe("parseSlashCommand — /select", () => {
  it("/select with no args → toggle", () => {
    expect(parseSlashCommand("/select")).toEqual({ type: "select", mode: "toggle" })
  })

  it("/select toggle → toggle (explicit)", () => {
    expect(parseSlashCommand("/select toggle")).toEqual({ type: "select", mode: "toggle" })
  })

  it("/select on → on", () => {
    expect(parseSlashCommand("/select on")).toEqual({ type: "select", mode: "on" })
  })

  it("/select off → off", () => {
    expect(parseSlashCommand("/select off")).toEqual({ type: "select", mode: "off" })
  })

  it("/selection alias works the same way", () => {
    expect(parseSlashCommand("/selection")).toEqual({ type: "select", mode: "toggle" })
    expect(parseSlashCommand("/selection on")).toEqual({ type: "select", mode: "on" })
  })

  it("/select garbage → error", () => {
    const c = parseSlashCommand("/select sometimes")
    expect(c.type).toBe("error")
  })

  it("/select arg is case-insensitive", () => {
    expect(parseSlashCommand("/select ON")).toEqual({ type: "select", mode: "on" })
    expect(parseSlashCommand("/select Off")).toEqual({ type: "select", mode: "off" })
  })
})
