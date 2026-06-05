/**
 * selection.test.ts — pure transition table for selection mode.
 */
import { describe, expect, it } from "vitest"
import { applySelection, describeSelection } from "./selection.js"

describe("applySelection", () => {
  it("toggle from off → on", () => {
    expect(applySelection(false, "toggle")).toEqual({ next: true, changed: true })
  })

  it("toggle from on → off", () => {
    expect(applySelection(true, "toggle")).toEqual({ next: false, changed: true })
  })

  it("on when off → on, changed", () => {
    expect(applySelection(false, "on")).toEqual({ next: true, changed: true })
  })

  it("on when already on → on, not changed", () => {
    expect(applySelection(true, "on")).toEqual({ next: true, changed: false })
  })

  it("off when on → off, changed", () => {
    expect(applySelection(true, "off")).toEqual({ next: false, changed: true })
  })

  it("off when already off → off, not changed", () => {
    expect(applySelection(false, "off")).toEqual({ next: false, changed: false })
  })
})

describe("describeSelection", () => {
  it("on message mentions how to resume", () => {
    const s = describeSelection(true)
    expect(s).toContain("on")
    expect(s).toMatch(/F2|\/select off/)
  })

  it("off message confirms restoration", () => {
    const s = describeSelection(false)
    expect(s).toContain("off")
    expect(s).toContain("mouse")
  })
})
