import { describe, it, expect } from "vitest"
import { parseCommandLine, filterCommands, completeCommand, type CapabilityDescriptor } from "../src/index.js"

const command = (id: string): CapabilityDescriptor => ({
  kind: "command",
  id,
  title: id,
  executor: "client",
  schemaVersion: 1,
})
const skill = (id: string): CapabilityDescriptor => ({
  kind: "skill",
  id,
  title: id,
  executor: "server",
  schemaVersion: 1,
})

// Parity fixture mirrors apps/agent-cli/test/slash.test.ts — but ids carry NO leading "/".
const cmds: CapabilityDescriptor[] = [command("new"), command("newish"), command("help")]

describe("filterCommands (parity with agent-cli slashState)", () => {
  it("returns [] when input does not start with /", () => {
    expect(filterCommands("hello", cmds)).toEqual([])
  })
  it("lists all command capabilities for a bare slash", () => {
    expect(filterCommands("/", cmds).map((c) => c.id)).toEqual(["new", "newish", "help"])
  })
  it("filters by prefix on the bare id", () => {
    expect(filterCommands("/new", cmds).map((c) => c.id)).toEqual(["new", "newish"])
  })
  it("is empty when nothing matches", () => {
    expect(filterCommands("/zzz", cmds)).toEqual([])
  })
  it("treats non-string input as [] instead of throwing", () => {
    const bad = { foo: 1 } as unknown as string
    expect(() => filterCommands(bad, cmds)).not.toThrow()
    expect(filterCommands(bad, cmds)).toEqual([])
    expect(filterCommands(undefined as unknown as string, cmds)).toEqual([])
  })
  it("excludes non-command kinds (a skill named like a command never appears)", () => {
    const mixed = [command("help"), skill("help"), skill("new")]
    expect(filterCommands("/", mixed).map((c) => `${c.kind}/${c.id}`)).toEqual(["command/help"])
  })
  it("matches ids containing separators like local-shell", () => {
    const m = [command("local-shell"), command("local")]
    expect(filterCommands("/local-", m).map((c) => c.id)).toEqual(["local-shell"])
  })
  it("returns a frozen array", () => {
    expect(Object.isFrozen(filterCommands("/", cmds))).toBe(true)
  })
  it("wraps the same descriptor references (does not copy), like merge", () => {
    const c = command("new")
    expect(filterCommands("/n", [c])[0]).toBe(c)
  })
})

describe("completeCommand (parity with agent-cli slashComplete)", () => {
  it("completes a single match fully with a trailing space", () => {
    expect(completeCommand("/he", cmds)).toBe("/help ")
  })
  it("completes multiple matches to their longest common prefix", () => {
    expect(completeCommand("/ne", cmds)).toBe("/new")
  })
  it("returns null when completion would add nothing", () => {
    expect(completeCommand("/", cmds)).toBeNull() // lcp empty
    expect(completeCommand("/new", cmds)).toBeNull() // already at lcp of new/newish
    expect(completeCommand("hello", cmds)).toBeNull() // not a slash
    expect(completeCommand("/zzz", cmds)).toBeNull() // no matches
  })
  it("re-prepends exactly one leading slash", () => {
    expect(completeCommand("/he", cmds)?.startsWith("//")).toBe(false)
  })
  it("ignores non-command kinds when completing", () => {
    const mixed = [skill("help"), command("helpdesk")]
    expect(completeCommand("/he", mixed)).toBe("/helpdesk ")
  })
})

describe("parseCommandLine", () => {
  it("returns null for a non-command line", () => {
    expect(parseCommandLine("hello luna")).toBeNull()
    expect(parseCommandLine("hello /help")).toBeNull() // only a LEADING slash counts
    expect(parseCommandLine(undefined as unknown as string)).toBeNull()
  })
  it("parses a bare verb with empty args", () => {
    expect(parseCommandLine("/help")).toEqual({ name: "help", args: "" })
  })
  it("splits the verb from its args", () => {
    expect(parseCommandLine("/copy 5")).toEqual({ name: "copy", args: "5" })
  })
  it("trims trailing whitespace to empty args", () => {
    expect(parseCommandLine("/copy   ")).toEqual({ name: "copy", args: "" })
  })
  it("preserves multi-word args verbatim (agent-cli re-splits them downstream)", () => {
    expect(parseCommandLine("/local-shell add /Users/me/proj")).toEqual({
      name: "local-shell",
      args: "add /Users/me/proj",
    })
  })
  it("parses a bare slash to empty name and args", () => {
    expect(parseCommandLine("/")).toEqual({ name: "", args: "" })
  })
  it("returns a name WITHOUT the leading slash", () => {
    expect(parseCommandLine("/help")?.name).toBe("help")
  })
  it("treats a leading space before the slash as a non-command line (entry-boundary parity)", () => {
    expect(parseCommandLine("  /copy")).toBeNull()
  })
  it("keeps a second slash inside the name (verb semantics are the edge's concern)", () => {
    expect(parseCommandLine("//x")).toEqual({ name: "/x", args: "" })
  })
})
