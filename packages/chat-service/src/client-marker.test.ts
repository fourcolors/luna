/**
 * client-marker.test.ts — pure formatting tests for applyClientMarker.
 */
import { describe, expect, it } from "vitest"
import { applyClientMarker } from "./client-marker.js"

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
