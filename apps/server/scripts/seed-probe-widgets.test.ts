/**
 * seed-probe-widgets.test.ts - characterization tests for the probe seeder's
 * minimal markdown to HTML converter.
 *
 * WHY THIS EXISTS. `markdownToHtml` was deliberately exported ("skipped on
 * import, so tests can use markdownToHtml") but never actually tested. #444
 * then required editing all through it - 26 strictNullChecks /
 * noUncheckedIndexedAccess fixes - to fold apps/server/scripts into the tsc
 * gate. Refactoring an untested parser is how silent output regressions ship,
 * so the #444 change was first proven byte-identical against the pre-change
 * implementation across 31 inputs, and this file makes that coverage
 * permanent instead of a one-off.
 *
 * These are CHARACTERIZATION tests: they assert what the converter does
 * today, not what an ideal markdown parser would do. Several expectations
 * below encode acknowledged quirks (see the "quirks, pinned deliberately"
 * block). If you are improving the parser, expect to change them - just do it
 * knowingly rather than discovering the old behavior was load-bearing for the
 * widget-system doc probe.
 *
 * The output is injected into a sandboxed iframe's srcdoc, so the escaping
 * assertions are the security-relevant ones.
 */
import { describe, expect, it } from "vitest"
import { markdownToHtml } from "./seed-probe-widgets.js"

describe("markdownToHtml", () => {
  describe("block constructs", () => {
    it("renders h1 to h3", () => {
      expect(markdownToHtml("# One")).toBe("<h1>One</h1>")
      expect(markdownToHtml("## Two")).toBe("<h2>Two</h2>")
      expect(markdownToHtml("### Three")).toBe("<h3>Three</h3>")
    })

    it("renders a fenced code block, escaping its contents", () => {
      expect(markdownToHtml("```\nconst x = 1 < 2 && 3 > 2;\n```")).toBe(
        "<pre><code>const x = 1 &lt; 2 &amp;&amp; 3 &gt; 2;</code></pre>",
      )
    })

    it("renders a horizontal rule from three or more dashes", () => {
      expect(markdownToHtml("---")).toBe("<hr>")
      expect(markdownToHtml("----------")).toBe("<hr>")
    })

    it("renders a table with a header row", () => {
      expect(markdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
        "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
      )
    })

    it("renders an alignment-marker separator row the same way", () => {
      expect(markdownToHtml("| a | b |\n| :-- | --: |\n| 1 | 2 |")).toContain("<th>a</th>")
    })

    it("renders unordered and ordered lists", () => {
      expect(markdownToHtml("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>")
      expect(markdownToHtml("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>")
    })

    it("folds an indented continuation line into the preceding list item", () => {
      expect(markdownToHtml("- wrapped item\n  continued here\n- second")).toBe(
        "<ul><li>wrapped item continued here</li><li>second</li></ul>",
      )
    })

    it("gathers consecutive lines into one paragraph", () => {
      expect(markdownToHtml("line one\nline two")).toBe("<p>line one line two</p>")
    })

    it("ends a paragraph at a structural line", () => {
      expect(markdownToHtml("para\n# heading")).toBe("<p>para</p>\n<h1>heading</h1>")
    })
  })

  describe("inline constructs", () => {
    it("renders code spans, bold and italic", () => {
      expect(markdownToHtml("a `code` b")).toBe("<p>a <code>code</code> b</p>")
      expect(markdownToHtml("a **bold** b")).toBe("<p>a <strong>bold</strong> b</p>")
      expect(markdownToHtml("a _italic_ b")).toBe("<p>a <em>italic</em> b</p>")
    })

    it("renders an http(s) link as a title-only anchor, never an href", () => {
      // Deliberate: the iframe sandbox does not block user-initiated
      // self-navigation, so a live href would let one click replace the
      // srcdoc with an external site.
      const html = markdownToHtml("see [docs](https://example.com) here")
      expect(html).toBe('<p>see <a title="https://example.com">docs</a> here</p>')
      expect(html).not.toContain("href")
    })

    it("strips a non-http link down to its text", () => {
      expect(markdownToHtml("see [docs](/local/path) here")).toBe("<p>see docs here</p>")
    })

    it("protects code-span contents from the later bold/italic passes", () => {
      expect(markdownToHtml("`**not bold**`")).toBe("<p><code>**not bold**</code></p>")
    })
  })

  describe("escaping (the output lands in an iframe srcdoc)", () => {
    it("escapes the four dangerous characters in prose", () => {
      expect(markdownToHtml("a & b < c > d \" e")).toBe(
        "<p>a &amp; b &lt; c &gt; d &quot; e</p>",
      )
    })

    it("escapes markup inside table cells and code fences", () => {
      expect(markdownToHtml("| <script> |\n|---|\n| x |")).toContain("&lt;script&gt;")
      expect(markdownToHtml("```\n<script>\n```")).toBe("<pre><code>&lt;script&gt;</code></pre>")
    })

    it("never emits an unescaped tag for any construct", () => {
      const hostile = [
        "# <script>alert(1)</script>",
        "- <script>alert(1)</script>",
        "<script>alert(1)</script>",
        "[x](javascript:alert(1))",
        "| <img onerror=x> |\n|---|\n| y |",
        "```\n<iframe src=x>\n```",
        "**<svg onload=x>**",
      ]
      for (const md of hostile) {
        const html = markdownToHtml(md)
        // The check is for an unescaped OPENING TAG, not for scary
        // substrings: `&lt;img onerror=x&gt;` is inert text and is the
        // correct, expected output. Matching on "onerror=" alone would
        // flag that safe case and teach the next reader nothing.
        expect(html, md).not.toMatch(/<(script|img|iframe|svg|object|embed)\b/i)
      }
    })
  })

  describe("degenerate input never throws (the #444 index-safety surface)", () => {
    // Every case below reaches an out-of-range or no-match index read. Before
    // #444 these relied on unchecked indexing; they must still produce the
    // same output, and must never throw.
    const degenerate: ReadonlyArray<readonly [string, string]> = [
      ["", ""],
      ["\n\n\n", ""],
      ["   ", ""],
      ["```\nunclosed fence", "<pre><code>unclosed fence</code></pre>"],
      ["| a | b |\n|---|---|", "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody></tbody></table>"],
      ["|not a table", "<p>|not a table</p>"],
      ["#no space", "<p>#no space</p>"],
      ["#### four hashes", "<p>#### four hashes</p>"],
      ["`unclosed code", "<p>`unclosed code</p>"],
      ["**unclosed bold", "<p>**unclosed bold</p>"],
    ]
    for (const [input, expected] of degenerate) {
      it(`handles ${JSON.stringify(input)}`, () => {
        expect(() => markdownToHtml(input)).not.toThrow()
        expect(markdownToHtml(input)).toBe(expected)
      })
    }

    it("survives a long document without throwing", () => {
      const doc = Array.from({ length: 500 }, (_, n) =>
        n % 5 === 0 ? `## Section ${n}` : n % 5 === 1 ? `- item ${n}` : `prose ${n}`,
      ).join("\n")
      expect(() => markdownToHtml(doc)).not.toThrow()
      expect(markdownToHtml(doc)).toContain("<h2>Section 0</h2>")
    })
  })

  // ── quirks, pinned deliberately ────────────────────────────────────────────
  //
  // Not endorsements. This is a minimal converter for one repo-authored doc,
  // and these are the places it diverges from CommonMark. Pinned so a future
  // edit reveals which ones something depended on.
  describe("known divergences from CommonMark", () => {
    it("treats a trailing unclosed fence as a complete code block", () => {
      expect(markdownToHtml("```\nx")).toBe("<pre><code>x</code></pre>")
    })

    it("ignores the info string on a fence", () => {
      expect(markdownToHtml("```js\nx\n```")).toBe("<pre><code>x</code></pre>")
    })

    it("flattens a nested list into siblings", () => {
      // The item regex allows leading whitespace, so an indented "- inner"
      // matches as an item before the continuation branch can fold it in.
      expect(markdownToHtml("- outer\n  - inner")).toBe("<ul><li>outer</li><li>inner</li></ul>")
    })

    it("leaves a stray paren when a link target itself contains parens", () => {
      // The href pattern is `\(([^)\s]+)\)`, so it stops at the FIRST ")".
      // Harmless here - non-http targets degrade to their text - but it is
      // real output, so it is pinned rather than discovered later.
      expect(markdownToHtml("[x](javascript:alert(1))")).toBe("<p>x)</p>")
    })

    it("renders an ordered list from any digit-dot prefix, ignoring the numbers", () => {
      expect(markdownToHtml("7. seven\n7. also seven")).toBe("<ol><li>seven</li><li>also seven</li></ol>")
    })
  })
})
