import { describe, expect, it } from "vitest"
import { normalizeToolResultContent, truncateOutput } from "../src/chat-service.js"

describe("normalizeToolResultContent", () => {
  it("returns a string payload unchanged", () => {
    expect(normalizeToolResultContent("hello")).toBe("hello")
  })
  it("joins text blocks from an array payload", () => {
    const content = [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ]
    expect(normalizeToolResultContent(content)).toBe("line one\nline two")
  })
  it("stringifies non-text payloads as JSON", () => {
    expect(normalizeToolResultContent({ a: 1 })).toBe('{"a":1}')
  })
})

describe("truncateOutput", () => {
  it("passes short output through untouched", () => {
    expect(truncateOutput("short")).toEqual({ output: "short", truncated: false })
  })
  it("truncates by line count and marks truncated", () => {
    const many = Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n")
    const r = truncateOutput(many)
    expect(r.truncated).toBe(true)
    expect(r.output.split("\n").length).toBeLessThanOrEqual(41)
    expect(r.output).toContain("… (truncated)")
  })
})
