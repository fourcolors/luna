import { describe, expect, it } from "vitest"
import { slashState, slashComplete } from "../src/tui/slash.js"

const cmds = [
  { name: "new", help: "start a new thread" },
  { name: "newish", help: "x" },
  { name: "help", help: "show help" },
]

describe("slashState", () => {
  it("is inactive when input does not start with /", () => {
    expect(slashState("hello", cmds).active).toBe(false)
  })
  it("lists all commands for a bare slash", () => {
    expect(slashState("/", cmds).matches.map((c) => c.name)).toEqual(["new", "newish", "help"])
  })
  it("filters by prefix", () => {
    expect(slashState("/new", cmds).matches.map((c) => c.name)).toEqual(["new", "newish"])
  })
  it("is active but empty when nothing matches", () => {
    const s = slashState("/zzz", cmds)
    expect(s.active).toBe(true)
    expect(s.matches).toEqual([])
  })
  it("completes a single match fully with a trailing space", () => {
    expect(slashComplete("/he", cmds)).toBe("/help ")
  })
  it("completes multiple matches to their longest common prefix", () => {
    expect(slashComplete("/ne", cmds)).toBe("/new")
  })
  it("returns null when completion would add nothing", () => {
    expect(slashComplete("/", cmds)).toBeNull() // lcp empty
    expect(slashComplete("/new", cmds)).toBeNull() // already at lcp of new/newish
    expect(slashComplete("hello", cmds)).toBeNull() // not a slash
    expect(slashComplete("/zzz", cmds)).toBeNull() // no matches
  })

  it("treats non-string input as inactive instead of throwing", () => {
    // The textarea change-event is an object, not a string; slashState must
    // never throw on it (regression: input.startsWith is not a function).
    const bad = { foo: 1 } as unknown as string
    expect(() => slashState(bad, cmds)).not.toThrow()
    expect(slashState(bad, cmds).active).toBe(false)
    expect(slashState(undefined as unknown as string, cmds).active).toBe(false)
  })
})
