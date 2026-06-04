import { describe, expect, it } from "vitest"
import { closeOpenFences } from "../src/streaming.js"

describe("closeOpenFences", () => {
  it("returns empty input unchanged", () => {
    expect(closeOpenFences("")).toBe("")
  })

  it("returns prose without fences unchanged", () => {
    const src = "Hello, **world**. _italic_ and `inline`."
    expect(closeOpenFences(src)).toBe(src)
  })

  it("returns balanced fences unchanged", () => {
    const src = "before\n```ts\nconst x = 1\n```\nafter"
    expect(closeOpenFences(src)).toBe(src)
  })

  it("closes an open fence at end of input (no trailing newline)", () => {
    const src = "intro\n```ts\nconst x = 1"
    expect(closeOpenFences(src)).toBe("intro\n```ts\nconst x = 1\n```")
  })

  it("closes an open fence at end of input (with trailing newline)", () => {
    const src = "intro\n```ts\nconst x = 1\n"
    expect(closeOpenFences(src)).toBe("intro\n```ts\nconst x = 1\n```")
  })

  it("closes the LAST open fence when several are present", () => {
    // 1 closed pair + 1 open = 3 fences (odd) → append closer
    const src = "```js\nfoo\n```\nmid\n```py\nbar"
    expect(closeOpenFences(src)).toBe(
      "```js\nfoo\n```\nmid\n```py\nbar\n```",
    )
  })

  it("handles a fence opener that has not yet received its language tag", () => {
    const src = "Here is code:\n```"
    expect(closeOpenFences(src)).toBe("Here is code:\n```\n```")
  })

  it("does not touch inline backticks (different syntax)", () => {
    // Inline ` is single-backtick; closeOpenFences only counts triple.
    const src = "use `foo` and `bar"
    expect(closeOpenFences(src)).toBe(src)
  })

  it("is idempotent on already-closed output", () => {
    const src = "intro\n```ts\nconst x = 1"
    const once = closeOpenFences(src)
    const twice = closeOpenFences(once)
    expect(twice).toBe(once)
  })
})
