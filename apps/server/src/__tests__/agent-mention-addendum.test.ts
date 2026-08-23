/**
 * agent-mention-addendum.test.ts — pins for the @ mention contract's
 * system-prompt addendum (agent sidebar S3).
 */
import { describe, expect, it } from "vitest"
import { buildAgentMentionAddendum } from "../agent-mention-addendum.js"

describe("buildAgentMentionAddendum", () => {
  it("returns '' for an empty roster (chat-server's filter drops it)", () => {
    expect(buildAgentMentionAddendum([])).toBe("")
  })

  it("enumerates every agent as an @row with its description", () => {
    const out = buildAgentMentionAddendum([
      { name: "advisor", description: "Critiques plans." },
      { name: "dev-agent", description: "Ships PRs." },
    ])
    expect(out).toContain("- @advisor: Critiques plans.")
    expect(out).toContain("- @dev-agent: Ships PRs.")
  })

  it("states the per-turn CC contract, not a takeover", () => {
    const out = buildAgentMentionAddendum([{ name: "advisor", description: "" }])
    // The prose is hard-wrapped, so flatten before phrase checks.
    const flat = out.replace(/\s+/g, " ")
    // The three load-bearing clauses of Mr. Cobb's ruling: per-turn, no
    // identity change, no routing of future turns.
    expect(flat).toContain("THIS turn")
    expect(flat).toContain("does not change who you are")
    expect(flat).toContain("does not route future turns")
    // And the false-positive guard for code blocks / quotes / emails.
    expect(flat).toContain("not requests")
  })

  it("omits the trailing colon for a description-less agent", () => {
    const out = buildAgentMentionAddendum([{ name: "bare", description: "" }])
    expect(out.endsWith("- @bare")).toBe(true)
    expect(out).not.toContain("- @bare:")
  })

  it("names the delegation mechanism (Agent tool, foreground)", () => {
    const out = buildAgentMentionAddendum([{ name: "advisor", description: "x" }])
    expect(out).toContain("Agent tool")
    expect(out).toContain("subagent_type")
    expect(out).toContain("run_in_background: false")
  })
})
