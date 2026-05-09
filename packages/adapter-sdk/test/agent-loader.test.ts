/**
 * agent-loader — unit tests for frontmatter parsing and agent loading.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadAgents } from "../src/agent-loader.js"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "luna-agent-loader-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, content: string) =>
  writeFileSync(join(dir, name), content, "utf8")

describe("loadAgents", () => {
  it("returns {} when directory does not exist", () => {
    expect(loadAgents("/does/not/exist/ever")).toEqual({})
  })

  it("returns {} for empty directory", () => {
    expect(loadAgents(dir)).toEqual({})
  })

  it("skips non-.md files", () => {
    write("notes.txt", "not an agent")
    expect(loadAgents(dir)).toEqual({})
  })

  it("parses a minimal agent with single-line description", () => {
    write(
      "helper.md",
      [
        "---",
        'name: helper',
        'description: "A helpful agent"',
        "model: sonnet",
        "effort: high",
        "---",
        "",
        "You are a helper.",
      ].join("\n"),
    )
    const agents = loadAgents(dir)
    expect(agents["helper"]).toMatchObject({
      description: "A helpful agent",
      prompt: "You are a helper.",
      model: "sonnet",
      effort: "high",
    })
  })

  it("parses folded scalar description (>-)", () => {
    write(
      "advisor.md",
      [
        "---",
        "name: advisor",
        "description: >-",
        "  Senior technical advisor — consult BEFORE substantive work.",
        "  Also invoke when uncertain about tradeoffs.",
        "model: opus",
        "effort: max",
        "tools:",
        "  - Read",
        "  - Grep",
        "---",
        "",
        "You are a senior technical advisor.",
      ].join("\n"),
    )
    const agents = loadAgents(dir)
    const advisor = agents["advisor"]
    expect(advisor).toBeDefined()
    // Description must not be the literal ">-"
    expect(advisor!.description).not.toBe(">-")
    expect(advisor!.description.length).toBeGreaterThan(20)
    expect(advisor!.description).toContain("Senior technical advisor")
    expect(advisor!.tools).toEqual(["Read", "Grep"])
    expect(advisor!.effort).toBe("max")
    expect(advisor!.model).toBe("opus")
  })

  it("parses literal block scalar description (|)", () => {
    write(
      "auditor.md",
      [
        "---",
        "name: auditor",
        "description: |",
        "  Post-work quality auditor.",
        "  Returns SHIP / REVISE / REWORK.",
        "model: opus",
        "effort: xhigh",
        "---",
        "",
        "You are an auditor.",
      ].join("\n"),
    )
    const agents = loadAgents(dir)
    const auditor = agents["auditor"]
    expect(auditor).toBeDefined()
    expect(auditor!.description).not.toBe("|")
    expect(auditor!.description).toContain("Post-work quality auditor")
  })

  it("uses filename stem as key when name field is absent", () => {
    write(
      "unnamed.md",
      [
        "---",
        'description: "No name field"',
        "model: haiku",
        "---",
        "Do things.",
      ].join("\n"),
    )
    const agents = loadAgents(dir)
    expect(agents["unnamed"]).toBeDefined()
    expect(agents["unnamed"]!.description).toBe("No name field")
  })

  it("skips files with no description", () => {
    write(
      "broken.md",
      ["---", "name: broken", "model: haiku", "---", "Body."].join("\n"),
    )
    expect(loadAgents(dir)).toEqual({})
  })

  it("skips files with no frontmatter", () => {
    write("raw.md", "Just markdown, no frontmatter.")
    expect(loadAgents(dir)).toEqual({})
  })

  it("loads multiple agents from one directory", () => {
    write(
      "a.md",
      ["---", "name: alpha", 'description: "Alpha"', "---", "Alpha."].join("\n"),
    )
    write(
      "b.md",
      ["---", "name: beta", 'description: "Beta"', "---", "Beta."].join("\n"),
    )
    const agents = loadAgents(dir)
    expect(Object.keys(agents).sort()).toEqual(["alpha", "beta"])
  })

  it("parses memory field with valid enum values", () => {
    for (const memVal of ["user", "project", "local"] as const) {
      write(
        `mem-${memVal}.md`,
        ["---", `name: mem-${memVal}`, 'description: "Agent"', `memory: ${memVal}`, "---", "Body."].join("\n"),
      )
    }
    const agents = loadAgents(dir)
    expect(agents["mem-user"]!.memory).toBe("user")
    expect(agents["mem-project"]!.memory).toBe("project")
    expect(agents["mem-local"]!.memory).toBe("local")
  })

  it("ignores invalid memory values", () => {
    write(
      "bad-mem.md",
      ["---", "name: bad-mem", 'description: "Agent"', "memory: global", "---", "Body."].join("\n"),
    )
    expect(loadAgents(dir)["bad-mem"]!.memory).toBeUndefined()
  })

  it("parses maxTurns as integer", () => {
    write(
      "turns.md",
      ["---", "name: turns", 'description: "Agent"', "maxTurns: 20", "---", "Body."].join("\n"),
    )
    expect(loadAgents(dir)["turns"]!.maxTurns).toBe(20)
  })

  it("parses background boolean", () => {
    write(
      "bg.md",
      ["---", "name: bg", 'description: "Agent"', "background: true", "---", "Body."].join("\n"),
    )
    expect(loadAgents(dir)["bg"]!.background).toBe(true)
  })

  it("parses permissionMode enum values", () => {
    for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"] as const) {
      write(
        `pm-${mode}.md`,
        ["---", `name: pm-${mode}`, 'description: "Agent"', `permissionMode: ${mode}`, "---", "Body."].join("\n"),
      )
    }
    const agents = loadAgents(dir)
    expect(agents["pm-default"]!.permissionMode).toBe("default")
    expect(agents["pm-acceptEdits"]!.permissionMode).toBe("acceptEdits")
    expect(agents["pm-bypassPermissions"]!.permissionMode).toBe("bypassPermissions")
  })

  it("parses mcpServers as string reference list", () => {
    write(
      "mcp.md",
      [
        "---",
        "name: mcp",
        'description: "Agent"',
        "mcpServers:",
        "  - my-server",
        "  - other-server",
        "---",
        "Body.",
      ].join("\n"),
    )
    expect(loadAgents(dir)["mcp"]!.mcpServers).toEqual(["my-server", "other-server"])
  })

  it("loads the real advisor.md from agents/ with a valid description", () => {
    // Regression: the real agent files use >- folded scalars
    const repoAgentsDir = new URL("../../../agents", import.meta.url).pathname
    let agents: ReturnType<typeof loadAgents>
    try {
      agents = loadAgents(repoAgentsDir)
    } catch {
      // agents/ dir may not exist in CI — skip gracefully
      return
    }
    if (!agents["advisor"]) return // not found, skip
    expect(agents["advisor"]!.description).not.toBe(">-")
    expect(agents["advisor"]!.description.length).toBeGreaterThan(30)
  })
})
