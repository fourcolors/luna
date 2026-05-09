/**
 * agent-loader — unit tests for frontmatter parsing and AgentDefinition mapping.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadAgents } from "../src/agent-loader.js"

// ── Test helpers ──────────────────────────────────────────────────────────────

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "luna-agent-loader-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a `.md` file into the temp directory. */
const write = (name: string, content: string) =>
  writeFileSync(join(dir, name), content, "utf8")

/** Build a minimal valid agent file with optional extra frontmatter lines. */
const agentFile = (extras: string[] = [], body = "You are an agent."): string =>
  ["---", 'name: agent', 'description: "A test agent"', ...extras, "---", "", body].join("\n")

// ── Directory handling ────────────────────────────────────────────────────────

describe("directory handling", () => {
  it("returns {} when directory does not exist", () => {
    expect(loadAgents("/does/not/exist/luna-test")).toEqual({})
  })

  it("returns {} for an empty directory", () => {
    expect(loadAgents(dir)).toEqual({})
  })

  it("skips non-.md files", () => {
    write("notes.txt", "not an agent")
    write("config.json", "{}")
    expect(loadAgents(dir)).toEqual({})
  })

  it("loads multiple agents from one directory", () => {
    write("a.md", agentFile(["name: alpha"]))
    write("b.md", agentFile(["name: beta"]))
    expect(Object.keys(loadAgents(dir)).sort()).toEqual(["alpha", "beta"])
  })
})

// ── Required fields ───────────────────────────────────────────────────────────

describe("required fields", () => {
  it("skips files with no frontmatter", () => {
    write("raw.md", "Just markdown, no frontmatter.")
    expect(loadAgents(dir)).toEqual({})
  })

  it("skips files with missing description", () => {
    write("no-desc.md", ["---", "name: no-desc", "model: haiku", "---", "Body."].join("\n"))
    expect(loadAgents(dir)).toEqual({})
  })

  it("uses the body as the agent prompt", () => {
    write("agent.md", agentFile([], "You are a test agent. Be helpful."))
    expect(loadAgents(dir)["agent"]!.prompt).toBe("You are a test agent. Be helpful.")
  })

  it("uses filename stem as key when name field is absent", () => {
    write("unnamed.md", ["---", 'description: "No name field"', "---", "Body."].join("\n"))
    const agents = loadAgents(dir)
    expect(agents["unnamed"]).toBeDefined()
    expect(agents["unnamed"]!.description).toBe("No name field")
  })
})

// ── Frontmatter parser ────────────────────────────────────────────────────────

describe("frontmatter parser", () => {
  it("parses a single-line unquoted description", () => {
    write("agent.md", ["---", "name: agent", "description: An unquoted description", "---", "Body."].join("\n"))
    expect(loadAgents(dir)["agent"]!.description).toBe("An unquoted description")
  })

  it("parses a single-line double-quoted description", () => {
    write("agent.md", agentFile())
    expect(loadAgents(dir)["agent"]!.description).toBe("A test agent")
  })

  it("parses a single-line single-quoted description", () => {
    write("agent.md", ["---", "name: agent", "description: 'Single quoted'", "---", "Body."].join("\n"))
    expect(loadAgents(dir)["agent"]!.description).toBe("Single quoted")
  })

  it("parses a folded scalar (>-) description", () => {
    write("agent.md", [
      "---",
      "name: agent",
      "description: >-",
      "  Senior technical advisor — consult BEFORE substantive work.",
      "  Also invoke when uncertain about tradeoffs.",
      "model: opus",
      "---",
      "Body.",
    ].join("\n"))
    const agent = loadAgents(dir)["agent"]!
    expect(agent.description).not.toBe(">-")
    expect(agent.description).toContain("Senior technical advisor")
    expect(agent.description).toContain("Also invoke")
    // Folded scalars join lines with a space
    expect(agent.description).not.toContain("\n")
  })

  it("parses a folded scalar (>) description", () => {
    write("agent.md", [
      "---",
      "name: agent",
      "description: >",
      "  Line one.",
      "  Line two.",
      "---",
      "Body.",
    ].join("\n"))
    const desc = loadAgents(dir)["agent"]!.description
    expect(desc).toContain("Line one")
    expect(desc).toContain("Line two")
    expect(desc).not.toContain("\n")
  })

  it("folded scalar (>-) with a blank line mid-block does not prematurely terminate", () => {
    write("agent.md", [
      "---",
      "name: agent",
      "description: >-",
      "  First paragraph.",
      "",
      "  Second paragraph.",
      "model: opus",
      "---",
      "Body.",
    ].join("\n"))
    const desc = loadAgents(dir)["agent"]!.description
    expect(desc).toContain("First paragraph")
    expect(desc).toContain("Second paragraph")
  })

  it("parses a literal block (|) description — lines joined with newlines", () => {
    write("agent.md", [
      "---",
      "name: agent",
      "description: |",
      "  Line one.",
      "  Line two.",
      "---",
      "Body.",
    ].join("\n"))
    const desc = loadAgents(dir)["agent"]!.description
    expect(desc).toContain("Line one")
    expect(desc).toContain("Line two")
    expect(desc).toContain("\n")
  })

  it("parses a literal block strip (|-) description", () => {
    write("agent.md", [
      "---",
      "name: agent",
      "description: |-",
      "  Line A.",
      "  Line B.",
      "model: haiku",
      "---",
      "Body.",
    ].join("\n"))
    const desc = loadAgents(dir)["agent"]!.description
    expect(desc).toContain("Line A")
    expect(desc).toContain("Line B")
    expect(desc).toContain("\n")
  })

  it("parses a block list", () => {
    write("agent.md", agentFile(["tools:", "  - Read", "  - Grep", "  - Glob"]))
    expect(loadAgents(dir)["agent"]!.tools).toEqual(["Read", "Grep", "Glob"])
  })
})

// ── String scalar fields ──────────────────────────────────────────────────────

describe("string fields", () => {
  it("parses model", () => {
    write("agent.md", agentFile(["model: opus"]))
    expect(loadAgents(dir)["agent"]!.model).toBe("opus")
  })

  it("parses initialPrompt", () => {
    write("agent.md", agentFile(["initialPrompt: Go do the thing"]))
    expect(loadAgents(dir)["agent"]!.initialPrompt).toBe("Go do the thing")
  })

  it("parses criticalSystemReminder_EXPERIMENTAL", () => {
    write("agent.md", agentFile(["criticalSystemReminder_EXPERIMENTAL: Remember this always"]))
    expect(loadAgents(dir)["agent"]!.criticalSystemReminder_EXPERIMENTAL).toBe("Remember this always")
  })
})

// ── Numeric fields ────────────────────────────────────────────────────────────

describe("effort field", () => {
  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "accepts named effort value: %s",
    (level) => {
      write("agent.md", agentFile([`effort: ${level}`]))
      expect(loadAgents(dir)["agent"]!.effort).toBe(level)
    },
  )

  it("accepts a positive numeric effort", () => {
    write("agent.md", agentFile(["effort: 5"]))
    expect(loadAgents(dir)["agent"]!.effort).toBe(5)
  })

  it("ignores effort: 0 (must be positive)", () => {
    write("agent.md", agentFile(["effort: 0"]))
    expect(loadAgents(dir)["agent"]!.effort).toBeUndefined()
  })

  it("ignores negative numeric effort", () => {
    write("agent.md", agentFile(["effort: -1"]))
    expect(loadAgents(dir)["agent"]!.effort).toBeUndefined()
  })

  it("ignores unrecognised named effort", () => {
    write("agent.md", agentFile(["effort: ultra"]))
    expect(loadAgents(dir)["agent"]!.effort).toBeUndefined()
  })
})

describe("maxTurns field", () => {
  it("parses a positive integer", () => {
    write("agent.md", agentFile(["maxTurns: 20"]))
    expect(loadAgents(dir)["agent"]!.maxTurns).toBe(20)
  })

  it("ignores maxTurns: 0", () => {
    write("agent.md", agentFile(["maxTurns: 0"]))
    expect(loadAgents(dir)["agent"]!.maxTurns).toBeUndefined()
  })

  it("ignores negative maxTurns", () => {
    write("agent.md", agentFile(["maxTurns: -5"]))
    expect(loadAgents(dir)["agent"]!.maxTurns).toBeUndefined()
  })

  it("ignores fractional maxTurns", () => {
    write("agent.md", agentFile(["maxTurns: 1.5"]))
    expect(loadAgents(dir)["agent"]!.maxTurns).toBeUndefined()
  })

  it("ignores non-numeric maxTurns", () => {
    write("agent.md", agentFile(["maxTurns: many"]))
    expect(loadAgents(dir)["agent"]!.maxTurns).toBeUndefined()
  })
})

// ── Boolean fields ────────────────────────────────────────────────────────────

describe("background field", () => {
  it("parses background: true", () => {
    write("agent.md", agentFile(["background: true"]))
    expect(loadAgents(dir)["agent"]!.background).toBe(true)
  })

  it("parses background: false", () => {
    write("agent.md", agentFile(["background: false"]))
    expect(loadAgents(dir)["agent"]!.background).toBe(false)
  })

  it("ignores background: True (case-sensitive)", () => {
    write("agent.md", agentFile(["background: True"]))
    expect(loadAgents(dir)["agent"]!.background).toBeUndefined()
  })
})

// ── Enum fields ───────────────────────────────────────────────────────────────

describe("memory field", () => {
  it.each(["user", "project", "local"] as const)(
    "accepts memory: %s",
    (scope) => {
      write("agent.md", agentFile([`memory: ${scope}`]))
      expect(loadAgents(dir)["agent"]!.memory).toBe(scope)
    },
  )

  it("ignores invalid memory value", () => {
    write("agent.md", agentFile(["memory: global"]))
    expect(loadAgents(dir)["agent"]!.memory).toBeUndefined()
  })
})

describe("permissionMode field", () => {
  it.each([
    "default",
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "dontAsk",
    "plan",
  ] as const)("accepts permissionMode: %s", (mode) => {
    write("agent.md", agentFile([`permissionMode: ${mode}`]))
    expect(loadAgents(dir)["agent"]!.permissionMode).toBe(mode)
  })

  it("ignores invalid permissionMode value", () => {
    write("agent.md", agentFile(["permissionMode: yolo"]))
    expect(loadAgents(dir)["agent"]!.permissionMode).toBeUndefined()
  })
})

// ── List fields ───────────────────────────────────────────────────────────────

describe("list fields", () => {
  it("parses tools list", () => {
    write("agent.md", agentFile(["tools:", "  - Read", "  - Grep"]))
    expect(loadAgents(dir)["agent"]!.tools).toEqual(["Read", "Grep"])
  })

  it("parses disallowedTools list", () => {
    write("agent.md", agentFile(["disallowedTools:", "  - Write", "  - Edit"]))
    expect(loadAgents(dir)["agent"]!.disallowedTools).toEqual(["Write", "Edit"])
  })

  it("parses skills list", () => {
    write("agent.md", agentFile(["skills:", "  - api-conventions", "  - error-handling"]))
    expect(loadAgents(dir)["agent"]!.skills).toEqual(["api-conventions", "error-handling"])
  })

  it("parses mcpServers as string references", () => {
    write("agent.md", agentFile(["mcpServers:", "  - my-server", "  - other-server"]))
    expect(loadAgents(dir)["agent"]!.mcpServers).toEqual(["my-server", "other-server"])
  })
})

// ── Regression: real agent files ──────────────────────────────────────────────

describe("real agent files (regression)", () => {
  it("advisor.md loads with a non-trivial description (guards against >- regression)", () => {
    const repoAgentsDir = new URL("../../../agents", import.meta.url).pathname
    let agents: ReturnType<typeof loadAgents>
    try {
      agents = loadAgents(repoAgentsDir)
    } catch {
      return // agents/ dir not present — skip
    }
    const advisor = agents["advisor"]
    if (advisor === undefined) return // not found — skip

    expect(advisor.description).not.toBe(">-")
    expect(advisor.description).not.toBe(">")
    expect(advisor.description.length).toBeGreaterThan(30)
    expect(advisor.model).toBe("opus")
    expect(advisor.effort).toBe("max")
    expect(advisor.tools).toContain("Read")
  })

  it("auditor.md loads with a non-trivial description", () => {
    const repoAgentsDir = new URL("../../../agents", import.meta.url).pathname
    let agents: ReturnType<typeof loadAgents>
    try {
      agents = loadAgents(repoAgentsDir)
    } catch {
      return
    }
    const auditor = agents["auditor"]
    if (auditor === undefined) return

    expect(auditor.description).not.toBe(">-")
    expect(auditor.description.length).toBeGreaterThan(30)
    expect(auditor.model).toBe("opus")
    expect(auditor.effort).toBe("xhigh")
  })
})
