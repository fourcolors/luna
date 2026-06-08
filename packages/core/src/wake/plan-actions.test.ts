import { describe, expect, it } from "vitest"
import { normalizeAction, planNextActions } from "./plan-actions.js"
import type { WakeProposedAction } from "./types.js"

const prop = (action: string, priority = 3, goalSlug: string | null = null): WakeProposedAction => ({
  action,
  priority,
  rationale: "because",
  goalSlug,
})

describe("normalizeAction", () => {
  it("lowercases, collapses whitespace, trims", () => {
    expect(normalizeAction("  Ship   the   PR\n")).toBe("ship the pr")
  })
})

describe("planNextActions", () => {
  it("files genuinely-new proposals", () => {
    const out = planNextActions([prop("Add a regression test")], [], [])
    expect(out).toEqual([{ action: "Add a regression test", priority: 3, goalSlug: null }])
  })

  it("DEDUPS against existing open actions (the unbounded-queue hazard)", () => {
    const out = planNextActions(
      [prop("Ship the PR"), prop("brand new thing")],
      [{ action: "ship the   PR" }], // same after normalization
      [],
    )
    expect(out.map((a) => a.action)).toEqual(["brand new thing"])
  })

  it("dedups duplicates WITHIN one proposal batch", () => {
    const out = planNextActions([prop("do X"), prop("DO  x")], [], [])
    expect(out).toHaveLength(1)
  })

  it("nulls an unknown goal_slug (FK safety) but keeps a known one", () => {
    const out = planNextActions(
      [prop("known", 3, "ship-infra"), prop("unknown", 3, "ghost-goal")],
      [],
      ["ship-infra"],
    )
    expect(out.find((a) => a.action === "known")?.goalSlug).toBe("ship-infra")
    expect(out.find((a) => a.action === "unknown")?.goalSlug).toBeNull()
  })

  it("clamps priority into 1..5 and rounds", () => {
    expect(planNextActions([prop("a", 9)], [], [])[0]?.priority).toBe(5)
    expect(planNextActions([prop("b", 0)], [], [])[0]?.priority).toBe(1)
    expect(planNextActions([prop("c", 3.6)], [], [])[0]?.priority).toBe(4)
    expect(planNextActions([prop("d", Number.NaN)], [], [])[0]?.priority).toBe(1)
  })

  it("drops empty/whitespace-only proposals", () => {
    expect(planNextActions([prop("   "), prop("real")], [], [])).toHaveLength(1)
  })

  it("returns nothing for an empty proposal list", () => {
    expect(planNextActions([], [{ action: "x" }], ["g"])).toEqual([])
  })
})
