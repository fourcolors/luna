import { describe, expect, it } from "vitest"
import { composeBeliefsSection } from "./inject.js"
import { makeBeliefRecord } from "./types.js"

const active = (statement: string, confidence: number, domain = "comms") =>
  makeBeliefRecord({ statement, confidence, domain, status: "active", now: 0 })

describe("composeBeliefsSection", () => {
  it("returns '' when there are no active beliefs", () => {
    const proposed = makeBeliefRecord({ statement: "p", confidence: 0.9, domain: "d", status: "proposed", now: 0 })
    expect(composeBeliefsSection([proposed], 0)).toBe("")
    expect(composeBeliefsSection([], 0)).toBe("")
  })
  it("includes only active beliefs, ranked strongest-first", () => {
    const out = composeBeliefsSection([active("weak", 0.2), active("strong", 0.9)], 0)
    expect(out).toContain("strong")
    expect(out).toContain("weak")
    expect(out.indexOf("strong")).toBeLessThan(out.indexOf("weak"))
    expect(out).toMatch(/^## /m) // has a markdown header
  })
  it("respects topN", () => {
    // Use distinctive tokens that are not substrings of the header prose
    // ("a"/"b"/"c" collide with "validated"/"believe"/"correction" etc.)
    const recs = [active("alpha", 0.9), active("bravo", 0.8), active("charlie", 0.7)]
    const out = composeBeliefsSection(recs, 0, { topN: 2 })
    expect(out).toContain("alpha")
    expect(out).toContain("bravo")
    expect(out).not.toContain("charlie")
  })
})
