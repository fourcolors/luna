/**
 * telegram-format.test.ts — markdown → Telegram HTML converter.
 *
 * The converter's contract: output uses ONLY Telegram-supported tags, all
 * non-tag & < > are entity-escaped, and any input (including mid-stream
 * partials with unclosed fences) produces parseable HTML.
 */
import { describe, expect, it } from "vitest"
import {
  markdownToTelegramHtml,
  toPlainTextFallback,
  escapeTelegramHtml,
} from "../src/adapters/telegram-format.js"

describe("markdownToTelegramHtml — inline styles", () => {
  it("converts bold, italic, and strikethrough", () => {
    expect(markdownToTelegramHtml("**bold** and *italic* and ~~gone~~")).toBe(
      "<b>bold</b> and <i>italic</i> and <s>gone</s>",
    )
  })

  it("converts bold-italic triple stars without orphaning a star", () => {
    expect(markdownToTelegramHtml("***loud***")).toBe("<b><i>loud</i></b>")
  })

  it("converts inline code and protects its contents from other passes", () => {
    expect(markdownToTelegramHtml("run `bun test **now**` please")).toBe(
      "run <code>bun test **now**</code> please",
    )
  })

  it("converts links and protects URLs from emphasis rewriting", () => {
    expect(markdownToTelegramHtml("see [docs](https://example.com/a*b*c)")).toBe(
      'see <a href="https://example.com/a*b*c">docs</a>',
    )
  })

  it("does NOT treat underscores as emphasis (tool names survive)", () => {
    expect(markdownToTelegramHtml("call mcp__web__search or snake_case_name")).toBe(
      "call mcp__web__search or snake_case_name",
    )
  })

  it("does not italicize bare asterisks in math", () => {
    expect(markdownToTelegramHtml("2 * 3 * 4 = 24")).toBe("2 * 3 * 4 = 24")
  })

  it("escapes HTML-special characters in text", () => {
    expect(markdownToTelegramHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d")
  })

  it("escapes HTML inside inline code", () => {
    expect(markdownToTelegramHtml("`<div>&</div>`")).toBe(
      "<code>&lt;div&gt;&amp;&lt;/div&gt;</code>",
    )
  })

  it("supports double-backtick code spans containing a literal backtick", () => {
    expect(markdownToTelegramHtml("Use `` `backtick` `` inline")).toBe(
      "Use <code>`backtick`</code> inline",
    )
  })

  it("renders code spans inside link text as the plain span text", () => {
    expect(
      markdownToTelegramHtml("See the [`README.md`](https://example.com/README.md) for details."),
    ).toBe('See the <a href="https://example.com/README.md">README.md</a> for details.')
  })

  it("never emits mis-nested tags for asterisk runs", () => {
    // Six-star run: no empty overlapping spans, output stays literal.
    expect(markdownToTelegramHtml("x******y")).toBe("x******y")
    // Back-to-back bold segments pair cleanly instead of overlapping.
    expect(markdownToTelegramHtml("**A****B****C**")).toBe("<b>A</b><b>B</b><b>C</b>")
  })

  it("keeps emphasis from crossing tag boundaries of earlier passes", () => {
    // Bold pairs around the middle stars; the leading/trailing single stars
    // must not italicize ACROSS the inserted <b> tags (Telegram rejects
    // overlapping entities).
    const html = markdownToTelegramHtml("*x**y*z**w")
    const opens = [...html.matchAll(/<(\w+)>/g)].map((m) => m[1])
    const closes = [...html.matchAll(/<\/(\w+)>/g)].map((m) => m[1])
    expect(opens).toEqual(closes) // balanced, in matching order for this flat case
  })
})

describe("markdownToTelegramHtml — block structure", () => {
  it("downgrades headings to bold", () => {
    expect(markdownToTelegramHtml("## Results\ntext")).toBe("<b>Results</b>\ntext")
  })

  it("converts bullet markers to bullets, preserving indentation", () => {
    expect(markdownToTelegramHtml("- one\n  - nested\n* two")).toBe(
      "• one\n  • nested\n• two",
    )
  })

  it("keeps numbered lists as-is", () => {
    expect(markdownToTelegramHtml("1. first\n2. second")).toBe("1. first\n2. second")
  })

  it("converts fenced code blocks with a language class", () => {
    expect(markdownToTelegramHtml("```ts\nconst a = 1\n```")).toBe(
      '<pre><code class="language-ts">const a = 1</code></pre>',
    )
  })

  it("converts fenced code blocks without a language", () => {
    expect(markdownToTelegramHtml("```\nplain\n```")).toBe("<pre>plain</pre>")
  })

  it("escapes code block contents and ignores markdown inside", () => {
    expect(markdownToTelegramHtml("```\n**not bold** <tag>\n```")).toBe(
      "<pre>**not bold** &lt;tag&gt;</pre>",
    )
  })

  it("auto-closes an unclosed fence (streaming partial safety)", () => {
    expect(markdownToTelegramHtml("before\n```py\nprint(1)")).toBe(
      'before\n<pre><code class="language-py">print(1)</code></pre>',
    )
  })

  it("groups consecutive quote lines into one blockquote", () => {
    expect(markdownToTelegramHtml("> line one\n> line two")).toBe(
      "<blockquote>line one\nline two</blockquote>",
    )
  })

  it('renders the internal ">! " marker as an expandable blockquote', () => {
    expect(markdownToTelegramHtml(">! ⚙ Worked for 2 steps\n>! ✓ Read")).toBe(
      "<blockquote expandable>⚙ Worked for 2 steps\n✓ Read</blockquote>",
    )
  })

  it("keeps regular and expandable quotes separate when adjacent", () => {
    const html = markdownToTelegramHtml("> normal\n>! expandable")
    expect(html).toBe(
      "<blockquote>normal</blockquote>\n<blockquote expandable>expandable</blockquote>",
    )
  })

  it("renders tables as monospace pre blocks", () => {
    const html = markdownToTelegramHtml("| a | b |\n|---|---|\n| 1 | 2 |")
    expect(html).toBe("<pre>| a | b |\n|---|---|\n| 1 | 2 |</pre>")
  })

  it("renders horizontal rules as a divider line, not a bullet", () => {
    expect(markdownToTelegramHtml("---")).toBe("──────────")
    expect(markdownToTelegramHtml("***")).toBe("──────────")
  })

  it("applies inline styling inside headings, bullets, and quotes", () => {
    expect(markdownToTelegramHtml("# The **Plan**")).toBe("<b>The <b>Plan</b></b>")
    expect(markdownToTelegramHtml("- uses `code`")).toBe("• uses <code>code</code>")
    expect(markdownToTelegramHtml("> *soft*")).toBe("<blockquote><i>soft</i></blockquote>")
  })

  it("strips NUL characters so placeholder restoration cannot be forged", () => {
    expect(markdownToTelegramHtml("a\x000\x00b")).toBe("a0b")
  })
})

describe("toPlainTextFallback", () => {
  it("downgrades the expandable marker to a plain quote and keeps markdown", () => {
    expect(toPlainTextFallback(">! ⚙ Worked for 2 steps\n**bold**")).toBe(
      "> ⚙ Worked for 2 steps\n**bold**",
    )
  })
})

describe("escapeTelegramHtml", () => {
  it("escapes exactly the required entity set", () => {
    expect(escapeTelegramHtml('& < > "')).toBe('&amp; &lt; &gt; "')
  })
})
