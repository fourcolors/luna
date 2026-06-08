import { describe, expect, it } from "vitest"
import { decideShip, parseCherry } from "../src/ship-guard.ts"

describe("parseCherry", () => {
  it("counts '+' (new) and '-' (already-upstream) lines", () => {
    const out = "+ 1111111 add feature\n- 2222222 already merged\n- 3333333 also merged\n"
    expect(parseCherry(out)).toEqual({ newCommits: 1, mergedCommits: 2 })
  })
  it("the 14-duplicate-branch failure mode: every line is '-'", () => {
    const out = "- aaa msg\n- bbb msg\n- ccc msg\n"
    expect(parseCherry(out)).toEqual({ newCommits: 0, mergedCommits: 3 })
  })
  it("empty output → nothing", () => {
    expect(parseCherry("")).toEqual({ newCommits: 0, mergedCommits: 0 })
    expect(parseCherry("\n\n")).toEqual({ newCommits: 0, mergedCommits: 0 })
  })
  it("ignores noise lines that aren't +/-", () => {
    expect(parseCherry("warning: something\n+ aaa real\n")).toEqual({ newCommits: 1, mergedCommits: 0 })
  })
})

describe("decideShip", () => {
  it("SKIPS already-merged work (the exact bug: all commits patch-equal upstream)", () => {
    const v = decideShip({ cherry: { newCommits: 0, mergedCommits: 5 }, openPrCount: 0 })
    expect(v.action).toBe("skip")
    if (v.action === "skip") expect(v.cause).toBe("already-merged")
  })
  it("SKIPS a branch with no commits ahead at all", () => {
    const v = decideShip({ cherry: { newCommits: 0, mergedCommits: 0 }, openPrCount: 0 })
    expect(v.action).toBe("skip")
    if (v.action === "skip") expect(v.cause).toBe("no-commits")
  })
  it("SKIPS when an open PR already exists for the head (idempotency)", () => {
    const v = decideShip({ cherry: { newCommits: 3, mergedCommits: 0 }, openPrCount: 1 })
    expect(v.action).toBe("skip")
    if (v.action === "skip") expect(v.cause).toBe("open-pr")
  })
  it("SHIPS genuinely-new work with no open PR", () => {
    const v = decideShip({ cherry: { newCommits: 2, mergedCommits: 4 }, openPrCount: 0 })
    expect(v.action).toBe("ship")
    if (v.action === "ship") expect(v.reason).toContain("2 new commit")
  })
  it("already-merged takes precedence over open-PR (0 new commits short-circuits)", () => {
    const v = decideShip({ cherry: { newCommits: 0, mergedCommits: 2 }, openPrCount: 5 })
    expect(v.action).toBe("skip")
    if (v.action === "skip") expect(v.cause).toBe("already-merged")
  })
})
