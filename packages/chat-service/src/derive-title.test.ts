/**
 * Tests for deriveTitleFromMessage — the cheap, no-model-call title heuristic.
 * Phase 3 audit fix #3.
 */
import { describe, expect, it } from "vitest"
import { deriveTitleFromMessage } from "./chat-service.js"

describe("deriveTitleFromMessage — cheap title heuristic", () => {
  it("returns the first line trimmed for a single-line message", () => {
    expect(deriveTitleFromMessage("Hello world")).toBe("Hello world")
  })

  it("takes only the first line when the message is multi-line", () => {
    expect(deriveTitleFromMessage("First line\nSecond line\nThird line")).toBe(
      "First line",
    )
  })

  it("trims leading and trailing whitespace from the first line", () => {
    expect(deriveTitleFromMessage("  padded  \nrest")).toBe("padded")
  })

  it("truncates to 60 characters when the first line is longer", () => {
    const long = "A".repeat(80)
    const result = deriveTitleFromMessage(long)
    expect(result).toHaveLength(60)
    expect(result).toBe("A".repeat(60))
  })

  it("does NOT truncate a 60-character line (boundary exact)", () => {
    const exact = "B".repeat(60)
    expect(deriveTitleFromMessage(exact)).toBe(exact)
  })

  it("returns null for an empty string", () => {
    expect(deriveTitleFromMessage("")).toBeNull()
  })

  it("returns null for a whitespace-only message", () => {
    expect(deriveTitleFromMessage("   \n   ")).toBeNull()
  })

  it("returns null when the first line is only whitespace", () => {
    expect(deriveTitleFromMessage("   \nActual content")).toBeNull()
  })

  it("handles a CRLF line ending (treats \\r as part of the trimmed text)", () => {
    // split("\n") on "Hello\r\nWorld" => ["Hello\r", "World"]
    // trim() removes the trailing \r => "Hello"
    expect(deriveTitleFromMessage("Hello\r\nWorld")).toBe("Hello")
  })

  it("a 61-char first line is truncated to 60", () => {
    const s = "C".repeat(61)
    expect(deriveTitleFromMessage(s)).toBe("C".repeat(60))
  })
})
