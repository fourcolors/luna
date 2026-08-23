/**
 * agent-roster.test.ts — pins for the wire-safety projection and the
 * mentionable-name grammar (agent sidebar S1).
 *
 * The load-bearing pin is LEAKAGE: projectAgentRoster consumes FULL agent
 * definitions (prompts, tool allowlists, MCP references, permission modes)
 * and must emit records whose key set is EXACTLY {name, description}. A
 * spread creeping into the projection would ship system prompts to every
 * connected client — these tests fail on any extra key, not just known
 * ones.
 */
import { describe, expect, it } from "vitest"
import {
  AGENT_NAME_RE,
  isValidAgentName,
  projectAgentRoster,
} from "../src/agent-roster.js"

/** A full-fat definition shaped like loadAgents() output — everything here
 *  except description must vanish in projection. */
const fullDef = (description: string) => ({
  description,
  prompt: "TOP-SECRET SYSTEM PROMPT — must never reach the wire",
  tools: ["Read", "Bash"],
  mcpServers: ["internal-server"],
  permissionMode: "bypassPermissions",
  model: "opus",
  effort: "max",
  memory: "user",
})

describe("AGENT_NAME_RE / isValidAgentName", () => {
  it("accepts names that survive the mention token grammar", () => {
    for (const name of ["advisor", "dev-agent", "a", "Agent2", "x_y-z"]) {
      expect(AGENT_NAME_RE.test(name), name).toBe(true)
      expect(isValidAgentName(name), name).toBe(true)
    }
  })

  it("rejects names the composer could never insert as a token", () => {
    for (const name of ["has space", "-leading", "_lead", "", "naïve", "a b c", "@at"]) {
      expect(isValidAgentName(name), JSON.stringify(name)).toBe(false)
    }
  })

  it("reserves luna in any case", () => {
    for (const name of ["luna", "Luna", "LUNA"]) {
      // Grammatical — the rejection is the reservation, not the regex.
      expect(AGENT_NAME_RE.test(name), name).toBe(true)
      expect(isValidAgentName(name), name).toBe(false)
    }
  })
})

describe("projectAgentRoster", () => {
  it("emits EXACTLY {name, description} — nothing else survives", () => {
    const roster = projectAgentRoster({ advisor: fullDef("Critiques plans.") })
    expect(roster).toHaveLength(1)
    const entry = roster[0]!
    // Exact key set, not a subset check — a new leaked field must fail here.
    expect(Object.keys(entry).sort()).toEqual(["description", "name"])
    expect(entry).toEqual({ name: "advisor", description: "Critiques plans." })
    // Belt-and-braces: the secret string appears nowhere in the serialized frame.
    expect(JSON.stringify(roster)).not.toContain("TOP-SECRET")
  })

  it("drops reserved and ungrammatical names, warning for each", () => {
    const warnings: string[] = []
    const roster = projectAgentRoster(
      {
        "advisor": fullDef("ok"),
        "Luna": fullDef("identity collision"),
        "has space": fullDef("cannot be mentioned"),
      },
      (m) => warnings.push(m),
    )
    expect(roster.map((r) => r.name)).toEqual(["advisor"])
    expect(warnings).toHaveLength(2)
    expect(warnings.join("\n")).toContain("reserved")
    expect(warnings.join("\n")).toContain("grammar")
  })

  it("sorts by name for deterministic frames", () => {
    const roster = projectAgentRoster({
      "zeta": fullDef("z"),
      "alpha": fullDef("a"),
      "mid": fullDef("m"),
    })
    expect(roster.map((r) => r.name)).toEqual(["alpha", "mid", "zeta"])
  })

  it("normalizes a missing or blank description to empty string", () => {
    const roster = projectAgentRoster({
      bare: { prompt: "secret" },
      blank: { description: "   ", prompt: "secret" },
      padded: { description: "  trimmed  ", prompt: "secret" },
    })
    expect(roster).toEqual([
      { name: "bare", description: "" },
      { name: "blank", description: "" },
      { name: "padded", description: "trimmed" },
    ])
  })

  it("returns [] for an empty map (the no-~/.luna/agents case)", () => {
    expect(projectAgentRoster({})).toEqual([])
  })
})
