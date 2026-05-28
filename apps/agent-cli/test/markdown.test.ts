import { describe, expect, it } from "vitest"
import { parseMarkdown } from "../src/tui/markdown.js"

describe("parseMarkdown", () => {
  it("parses a heading", () => {
    expect(parseMarkdown("# Title")).toEqual([{ kind: "heading", level: 1, text: "Title" }])
  })
  it("parses a fenced code block with language", () => {
    expect(parseMarkdown("```ts\nconst x = 1\n```")).toEqual([
      { kind: "code", lang: "ts", lines: ["const x = 1"] },
    ])
  })
  it("parses a bullet list", () => {
    expect(parseMarkdown("- a\n- b")).toEqual([
      { kind: "list", ordered: false, items: ["a", "b"] },
    ])
  })
  it("parses a paragraph with inline spans", () => {
    expect(parseMarkdown("hello **world** and `code`")).toEqual([
      { kind: "paragraph", spans: [
        { type: "text", text: "hello " },
        { type: "bold", text: "world" },
        { type: "text", text: " and " },
        { type: "code", text: "code" },
      ] },
    ])
  })
})
