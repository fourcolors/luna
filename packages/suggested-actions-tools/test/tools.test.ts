// packages/suggested-actions-tools/test/tools.test.ts
//
// The MCP SDK validates tool input against this Zod schema BEFORE the handler
// runs, so over-long / malformed proposals are rejected at the tool layer
// (before anything reaches the store / a spawned subagent).
import { describe, expect, it } from "vitest"
import { suggestActionInputSchema } from "../src/tools.js"

describe("suggest_action input bounds", () => {
  it("accepts a valid proposal", () => {
    const r = suggestActionInputSchema.safeParse({
      action_type: "research",
      title: "Look into pricing",
      prompt: "go research the pricing tiers",
    })
    expect(r.success).toBe(true)
  })

  it("rejects an empty title", () => {
    const r = suggestActionInputSchema.safeParse({
      action_type: "task",
      title: "",
      prompt: "go",
    })
    expect(r.success).toBe(false)
  })

  it("rejects an over-long title (>200)", () => {
    const r = suggestActionInputSchema.safeParse({
      action_type: "task",
      title: "x".repeat(201),
      prompt: "go",
    })
    expect(r.success).toBe(false)
  })

  it("rejects an over-long prompt (>8000)", () => {
    const r = suggestActionInputSchema.safeParse({
      action_type: "task",
      title: "ok",
      prompt: "x".repeat(8001),
    })
    expect(r.success).toBe(false)
  })

  it("rejects an unknown action_type", () => {
    const r = suggestActionInputSchema.safeParse({
      action_type: "delete_everything",
      title: "ok",
      prompt: "go",
    })
    expect(r.success).toBe(false)
  })
})
