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
    expect(out).toContain("- (0.90, comms) strong")
    expect(out).toContain("- (0.20, comms) weak")
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
  it("returns '' for degenerate topN with active beliefs (no orphaned header)", () => {
    expect(composeBeliefsSection([active("x", 0.9)], 0, { topN: 0 })).toBe("")
  })
  it("normalizes whitespace so a multi-line statement renders on one line", () => {
    const out = composeBeliefsSection([active("line one\nline two", 0.9)], 0)
    expect(out).toContain("- (0.90, comms) line one line two")
    expect(out).not.toContain("line one\nline two")
  })
})

describe("composeBeliefsSection date stamps", () => {
  const activeAt = (statement: string, confidence: number, updatedAt: number) => ({
    ...makeBeliefRecord({ statement, confidence, domain: "comms", status: "active" as const }),
    updatedAt,
  })

  it("omits date label when updatedAt is 0 (fail-open)", () => {
    const out = composeBeliefsSection([activeAt("prefers brevity", 0.9, 0)], 0)
    expect(out).toContain("- (0.90, comms) prefers brevity")
    expect(out).not.toMatch(/\[\d{4}-\d{2}-\d{2}\]/)
  })

  it("renders YYYY-MM-DD date label when updatedAt is a valid epoch", () => {
    const updatedAt = Date.parse("2026-06-14T12:00:00Z")
    const out = composeBeliefsSection([activeAt("likes dark mode", 0.8, updatedAt)], Date.now())
    expect(out).toContain("[2026-06-14]")
    expect(out).toContain("- (0.80, comms) [2026-06-14] likes dark mode")
  })
})
