// packages/core/src/alignment/types.test.ts
import { describe, expect, it } from "vitest"
import { EWMA_ELIGIBLE, type SignalKind } from "./types.js"

describe("EWMA_ELIGIBLE", () => {
  it("includes task_quality and outreach_welcome", () => {
    expect(EWMA_ELIGIBLE.has("task_quality")).toBe(true)
    expect(EWMA_ELIGIBLE.has("outreach_welcome")).toBe(true)
  })
  it("EXCLUDES belief_validation (category boundary §2.3)", () => {
    // belief_validation is logged + applied per-belief, but never rolls into the
    // global EWMA — the spec's load-bearing isolation rule.
    expect(EWMA_ELIGIBLE.has("belief_validation")).toBe(false)
  })
  it("covers exactly the three signal kinds", () => {
    const all: SignalKind[] = ["task_quality", "belief_validation", "outreach_welcome"]
    expect(all.length).toBe(3)
  })
})
