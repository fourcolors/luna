/**
 * Base Prompt composition tests — BDD scenarios for the four-fragment model.
 */
import { describe, expect, it } from "vitest"
import { composeBasePrompt } from "../../src/prompt/base-prompt.js"

describe("composeBasePrompt", () => {
  it("returns undefined for empty input (SDK uses default)", () => {
    expect(composeBasePrompt({})).toBeUndefined()
  })

  it("returns plain string when only identity is set", () => {
    const out = composeBasePrompt({ identity: "You are Atlas." })
    expect(out).toBe("You are Atlas.")
  })

  it("emits string[] when multiple fragments are present", () => {
    const out = composeBasePrompt({
      identity: "You are Atlas.",
      skillSegments: ["You have git-ops."],
      projectContext: "Project: reference-agent",
      hookAppend: "Session: daytime",
    })
    expect(Array.isArray(out)).toBe(true)
    expect(out as string[]).toEqual([
      "You are Atlas.",
      "You have git-ops.",
      "Project: reference-agent",
      "Session: daytime",
    ])
  })

  it("emits preset struct when preset:true, ignoring identity", () => {
    const out = composeBasePrompt({
      preset: true,
      identity: "this-is-ignored",
      skillSegments: ["skill-a"],
      projectContext: "proj-b",
      hookAppend: "hook-c",
    })
    expect(out).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "skill-a\n\nproj-b\n\nhook-c",
    })
  })

  it("omits append in preset mode when no dynamic content", () => {
    const out = composeBasePrompt({ preset: true })
    expect(out).toEqual({ type: "preset", preset: "claude_code" })
  })

  it("filters empty / whitespace-only fragments", () => {
    const out = composeBasePrompt({
      identity: "Atlas",
      skillSegments: ["", "   ", "real"],
      projectContext: "",
    })
    expect(out).toEqual(["Atlas", "real"])
  })
})
