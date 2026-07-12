/**
 * client-marker.test.ts — pure formatting tests for applyClientMarker and
 * its inverse stripClientMarker.
 */
import { describe, expect, it } from "vitest"
import { applyClientMarker, stripClientMarker } from "./client-marker.js"

describe("applyClientMarker", () => {
  it("returns text unchanged when client is undefined", () => {
    expect(applyClientMarker("hi luna", undefined)).toBe("hi luna")
  })

  it("returns text unchanged when client.name is empty/whitespace", () => {
    expect(applyClientMarker("hi", { name: "" })).toBe("hi")
    expect(applyClientMarker("hi", { name: "   " })).toBe("hi")
  })

  it("name only → [client: name]", () => {
    expect(applyClientMarker("hi", { name: "luna-tui" })).toBe(
      "[client: luna-tui]\nhi",
    )
  })

  it("name + version → [client: name version]", () => {
    expect(
      applyClientMarker("hi", { name: "luna-moon", version: "0.0.1" }),
    ).toBe("[client: luna-moon 0.0.1]\nhi")
  })

  it("name + platform → [client: name on platform]", () => {
    expect(
      applyClientMarker("hi", { name: "luna-web", platform: "browser" }),
    ).toBe("[client: luna-web on browser]\nhi")
  })

  it("name + version + platform → [client: name version on platform]", () => {
    expect(
      applyClientMarker("hi", {
        name: "luna-moon",
        version: "0.0.1",
        platform: "darwin",
      }),
    ).toBe("[client: luna-moon 0.0.1 on darwin]\nhi")
  })

  it("ignores empty version and platform strings", () => {
    expect(
      applyClientMarker("hi", {
        name: "luna-tui",
        version: "",
        platform: "",
      }),
    ).toBe("[client: luna-tui]\nhi")
  })

  it("preserves leading whitespace and multiline text after the marker", () => {
    expect(
      applyClientMarker("line 1\nline 2", { name: "luna-tui" }),
    ).toBe("[client: luna-tui]\nline 1\nline 2")
  })

  it("works on empty text (still marks)", () => {
    expect(applyClientMarker("", { name: "luna-tui" })).toBe("[client: luna-tui]\n")
  })
})

describe("stripClientMarker", () => {
  it("round-trips applyClientMarker output back to the raw text", () => {
    const client = { name: "luna-moon", version: "0.0.55", platform: "darwin" }
    expect(stripClientMarker(applyClientMarker("hi luna", client))).toBe("hi luna")
    expect(stripClientMarker(applyClientMarker("line 1\nline 2", client))).toBe(
      "line 1\nline 2",
    )
    expect(stripClientMarker(applyClientMarker("", client))).toBe("")
  })

  it("strips every marker shape the formatter produces", () => {
    expect(stripClientMarker("[client: luna-tui]\nhi")).toBe("hi")
    expect(stripClientMarker("[client: luna-moon 0.0.1]\nhi")).toBe("hi")
    expect(stripClientMarker("[client: luna-web on browser]\nhi")).toBe("hi")
    expect(stripClientMarker("[client: luna-moon 0.0.1 on darwin]\nhi")).toBe("hi")
  })

  it("returns text without a marker unchanged", () => {
    expect(stripClientMarker("hi luna")).toBe("hi luna")
    expect(stripClientMarker("")).toBe("")
    expect(stripClientMarker("line 1\nline 2")).toBe("line 1\nline 2")
  })

  it("leaves a first line that only resembles a marker alone", () => {
    expect(stripClientMarker("[clients: luna-tui]\nhi")).toBe("[clients: luna-tui]\nhi")
    expect(stripClientMarker("[client: unterminated\nhi")).toBe(
      "[client: unterminated\nhi",
    )
  })

  it("strips a marker-only line with no trailing newline to empty text", () => {
    expect(stripClientMarker("[client: luna-tui]")).toBe("")
  })
})
