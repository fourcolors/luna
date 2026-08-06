/**
 * luna-markdown.parity.test.ts - the anti-drift guard for chat.html's
 * markdown sanitizer.
 *
 * moon-markdown.js is FROZEN (Operator hard rule: byte-zero diffs on it,
 * ever). Callers keep calling `window.LunaMarkdown` through the ambient type
 * in luna-markdown.d.ts, which is only honest if it names exactly the
 * members the vendor IIFE actually attaches, so this test loads the REAL
 * vendor file (same technique as the precedent,
 * packages/ui-shared/src/widget-sandbox.parity.test.ts) and asserts against
 * it directly, in both directions: EXPECTED_MEMBERS is bound to
 * `keyof LunaMarkdownApi` at compile time, so an interface member added or
 * removed without a matching edit here is a type error, not just a runtime
 * assertion.
 *
 * `closeOpenFences` additionally has an ES-module twin
 * (packages/ui-shared/src/streaming.ts). It has no production caller today -
 * the Solid chat panel it originally served was retired in S12, leaving only
 * its own unit test and this parity assertion - so for that one member this
 * test also asserts byte-identical output against the vendor, mirroring the
 * precedent's per-sample loop exactly.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { closeOpenFences as closeOpenFencesTwin } from "@luna/ui-shared/core"
import type { LunaMarkdownApi, LunaStreamRenderApi } from "./luna-markdown"

// Record<keyof T, true> makes this bidirectionally checked against the
// interface: a member added to or removed from LunaMarkdownApi without a
// matching edit here is a missing/excess-property compile error, not a
// silent pass.
const EXPECTED_MEMBERS_BY_TYPE: Record<keyof LunaMarkdownApi, true> = {
  renderMarkdown: true,
  closeOpenFences: true,
  renderMarkdownStreaming: true,
  enhanceCodeBlocks: true,
  StreamRender: true,
}
const EXPECTED_MEMBERS = Object.keys(EXPECTED_MEMBERS_BY_TYPE).sort()

const STREAM_RENDER_MEMBERS_BY_TYPE: Record<keyof LunaStreamRenderApi, true> = {
  schedule: true,
  cancel: true,
  append: true,
  reset: true,
  finalize: true,
}
const STREAM_RENDER_MEMBERS = Object.keys(STREAM_RENDER_MEMBERS_BY_TYPE).sort()

let VENDOR: LunaMarkdownApi

beforeAll(() => {
  const src = readFileSync(
    path.resolve(__dirname, "../../../frontend/vendor/moon-markdown.js"),
    "utf8",
  )
  const g = {} as { LunaMarkdown?: LunaMarkdownApi }
  // The vendor IIFE attaches LunaMarkdown to the globalThis it's handed -
  // same load technique the widget-sandbox precedent uses.
  new Function("globalThis", src)(g)
  if (!g.LunaMarkdown) throw new Error("vendor IIFE did not expose LunaMarkdown")
  VENDOR = g.LunaMarkdown
})

describe("window.LunaMarkdown surface (drift guard)", () => {
  it("exposes exactly the five documented members - no more, no less", () => {
    expect(Object.keys(VENDOR).sort()).toEqual(EXPECTED_MEMBERS)
  })

  it("every member has the type luna-markdown.d.ts declares", () => {
    expect(typeof VENDOR.renderMarkdown).toBe("function")
    expect(typeof VENDOR.closeOpenFences).toBe("function")
    expect(typeof VENDOR.renderMarkdownStreaming).toBe("function")
    expect(typeof VENDOR.enhanceCodeBlocks).toBe("function")
    expect(typeof VENDOR.StreamRender).toBe("object")
  })

  it("StreamRender exposes exactly its five documented methods", () => {
    expect(Object.keys(VENDOR.StreamRender).sort()).toEqual(STREAM_RENDER_MEMBERS)
    for (const name of STREAM_RENDER_MEMBERS) {
      expect(typeof VENDOR.StreamRender[name as keyof LunaMarkdownApi["StreamRender"]]).toBe(
        "function",
      )
    }
  })
})

describe("closeOpenFences parity (vendor IIFE ↔ packages/ui-shared ES twin)", () => {
  const SAMPLES = [
    "",
    "no fences here",
    "one open ```",
    "one open ```\n",
    "```js\nconst x = 1;\n```",
    "text ```js\ncode` still open",
    "```\n```\n```",
  ]

  it("is byte-identical for every sample", () => {
    for (const s of SAMPLES) {
      expect(VENDOR.closeOpenFences(s)).toBe(closeOpenFencesTwin(s))
    }
  })
})

describe("markdown pipeline sanity (pure, DOM-free)", () => {
  it("renderMarkdown escapes raw HTML in the source", () => {
    const html = VENDOR.renderMarkdown("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toMatch(/<script/i)
  })

  it("renderMarkdown rejects a javascript: link href - scheme allowlist falls back to plain text", () => {
    const html = VENDOR.renderMarkdown("[x](javascript:alert(1))")
    expect(html).not.toContain("<a ")
  })

  it("renderMarkdown rejects a data: link href - scheme allowlist falls back to plain text", () => {
    const html = VENDOR.renderMarkdown("[x](data:text/html,evil)")
    expect(html).not.toContain("<a ")
  })

  it("renderMarkdown escapes double quotes - closes the attribute-breakout surface", () => {
    const html = VENDOR.renderMarkdown('a " b')
    expect(html).toContain("&quot;")
  })

  it("renderMarkdown renders a fenced code block", () => {
    const html = VENDOR.renderMarkdown("```js\nconst x = 1;\n```")
    expect(html).toContain("code-block")
    expect(html).toContain("const x = 1;")
  })

  it("renderMarkdownStreaming composes renderMarkdown(closeOpenFences(src)), per the vendor's own doc comment", () => {
    const partial = "prose then ```js\nconst x = 1;"
    expect(VENDOR.renderMarkdownStreaming(partial)).toBe(
      VENDOR.renderMarkdown(VENDOR.closeOpenFences(partial)),
    )
  })

  it("enhanceCodeBlocks no-ops on a root with no code blocks, without touching the DOM", () => {
    const stubRoot = { querySelectorAll: () => [] } as unknown as Element
    expect(() => VENDOR.enhanceCodeBlocks(stubRoot)).not.toThrow()
  })

  it("enhanceCodeBlocks no-ops on a null/undefined root", () => {
    expect(() => VENDOR.enhanceCodeBlocks(null)).not.toThrow()
    expect(() => VENDOR.enhanceCodeBlocks(undefined)).not.toThrow()
  })
})
