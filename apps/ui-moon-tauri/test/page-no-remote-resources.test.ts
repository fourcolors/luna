// @vitest-environment node
//
// page-no-remote-resources.test.ts - no Moon page may wait on the network to
// paint.
//
// A <link rel="stylesheet"> or <script src> in <head> blocks parsing and first
// paint until it arrives. The four pages used to load their fonts from
// fonts.googleapis.com, so on a stalled network every window came up blank
// (reproduced in the real app: the Cmd+K launcher sat at readyState
// "loading" with no <body> until the request was released), and the WebView
// cache purge after each app update made the first open after an update
// always hit the network. The fonts now ship with the app
// (src/fonts/moon-fonts.css).
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const PAGES = ["index.html", "chat.html", "panel.html", "widget.html"]
const root = resolve(__dirname, "../frontend-react")

describe("Moon pages load nothing from the network", () => {
  for (const page of PAGES) {
    const html = readFileSync(resolve(root, page), "utf8")

    it(`${page} links no remote stylesheet, script or preconnect`, () => {
      const remote = [...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)\s*=\s*["'](?:https?:)?\/\/[^"']*["'][^>]*>/gi)].map((m) => m[0])
      expect(remote, "a remote resource in the page blocks its first paint on a stalled network").toEqual([])
    })

    it(`${page} links the bundled fonts`, () => {
      expect(html).toContain('<link rel="stylesheet" href="/src/fonts/moon-fonts.css">')
    })
  }
})
