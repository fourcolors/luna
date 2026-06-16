/**
 * widget-sandbox.parity.test.ts — the anti-drift guard for the widget trust
 * boundary.
 *
 * The web client imports the ES module (widget-sandbox.ts); Moon ships a
 * hand-vendored IIFE (apps/ui-moon-tauri/frontend/vendor/widget-sandbox.js)
 * because its frontend has no bundler. Two copies of a SECURITY cage is exactly
 * the drift risk the review flagged — so this test loads BOTH and asserts they
 * produce byte-identical srcdoc/CSP/sandbox output. If anyone edits one cage
 * without the other, CI fails here.
 *
 * Also pins the standalone security invariants (no allow-same-origin, no
 * network) so a regression in EITHER copy is caught even if they drift together.
 */
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import * as Shared from "./widget-sandbox.js"

interface VendorSandbox {
  buildSrcdoc: (html: string) => string
  buildMcpSrcdoc: (html: string) => string
  buildGeneratedAppSrcdoc: (html: string) => string
  subscribeAllowed: (caps: ReadonlyArray<string> | null, kind: string) => boolean
  SANDBOX_ATTR: string
  CSP: string
}

let VENDOR: VendorSandbox

beforeAll(() => {
  const src = readFileSync(
    path.resolve(
      __dirname,
      "../../../apps/ui-moon-tauri/frontend/vendor/widget-sandbox.js",
    ),
    "utf8",
  )
  const g = {} as { LunaWidgetSandbox?: VendorSandbox }
  // The vendor IIFE attaches LunaWidgetSandbox to the globalThis it's handed.
  new Function("globalThis", src)(g)
  if (!g.LunaWidgetSandbox) throw new Error("vendor IIFE did not expose LunaWidgetSandbox")
  VENDOR = g.LunaWidgetSandbox
})

const SAMPLES = ["", "<h1>hi</h1>", "<script>alert(1)<\/script>", "plain text & <b>x</b>"]

describe("widget-sandbox parity (ES module ↔ Moon vendor IIFE)", () => {
  it("SANDBOX_ATTR and CSP are byte-identical", () => {
    expect(Shared.SANDBOX_ATTR).toBe(VENDOR.SANDBOX_ATTR)
    expect(Shared.CSP).toBe(VENDOR.CSP)
  })

  it("buildSrcdoc (luna bridge cage) is byte-identical for every sample", () => {
    for (const s of SAMPLES) expect(Shared.buildSrcdoc(s)).toBe(VENDOR.buildSrcdoc(s))
  })

  it("buildMcpSrcdoc (no-shim cage) is byte-identical for every sample", () => {
    for (const s of SAMPLES) expect(Shared.buildMcpSrcdoc(s)).toBe(VENDOR.buildMcpSrcdoc(s))
  })

  it("buildGeneratedAppSrcdoc (mcp client cage) is byte-identical for every sample", () => {
    for (const s of SAMPLES) {
      expect(Shared.buildGeneratedAppSrcdoc(s)).toBe(VENDOR.buildGeneratedAppSrcdoc(s))
    }
  })

  it("subscribeAllowed agrees on representative cap/kind cases", () => {
    const cases: Array<[ReadonlyArray<string> | null, string]> = [
      [null, "ToolCall"],
      [[], "ToolCall"],
      [["obs:*"], "ToolCall"],
      [["obs:ToolCall"], "ToolCall"],
      [["obs:ToolCall"], "Other"],
      [["evil"], "ToolCall"],
      [["obs:ToolCall"], ""],
    ]
    for (const [caps, kind] of cases) {
      expect(Shared.subscribeAllowed(caps, kind)).toBe(VENDOR.subscribeAllowed(caps, kind))
    }
  })
})

describe("widget-sandbox security invariants (the ES source of truth)", () => {
  it("the sandbox attribute is exactly 'allow-scripts' — NEVER allow-same-origin", () => {
    expect(Shared.SANDBOX_ATTR).toBe("allow-scripts")
    expect(Shared.SANDBOX_ATTR).not.toContain("allow-same-origin")
    expect(Shared.SANDBOX_ATTR).not.toContain("allow-top-navigation")
    expect(Shared.SANDBOX_ATTR).not.toContain("allow-popups")
  })

  it("the CSP forbids all network and disallows eval", () => {
    expect(Shared.CSP).toContain("default-src 'none'")
    expect(Shared.CSP).toContain("connect-src 'none'")
    expect(Shared.CSP).not.toContain("'unsafe-eval'")
  })

  it("buildMcpSrcdoc does NOT inject the luna.* bridge (a plain HTML preview has no door)", () => {
    expect(Shared.buildMcpSrcdoc("<p>x</p>")).not.toContain("window.luna")
    expect(Shared.buildSrcdoc("<p>x</p>")).toContain("window.luna")
  })

  it("the MCP-app cages carry the passive theme shim; the legacy widget cage does not", () => {
    const marker = "ui/notifications/host-context-changed"
    // Every MCP-app cage themes automatically — the shim is present.
    expect(Shared.buildMcpSrcdoc("<p>x</p>")).toContain(marker)
    expect(Shared.buildGeneratedAppSrcdoc("<p>x</p>")).toContain(marker)
    // The legacy luna.* widget cage is untouched (no MCP theme channel feeds it).
    expect(Shared.buildSrcdoc("<p>x</p>")).not.toContain(marker)
    // The theme shim grants NO capability: it references neither bridge.
    const bare = Shared.buildMcpSrcdoc("<p>x</p>")
    expect(bare).not.toContain("window.luna")
    expect(bare).not.toContain("window.mcp")
  })
})
