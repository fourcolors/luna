/**
 * widget-sandbox.test.ts — the W4 sandbox-escape gate (PRD §16).
 *
 * jsdom cannot ENFORCE an iframe sandbox (that's the browser/Tauri's job, and
 * the real escape test is operator-verify). What we CAN pin here, and what
 * actually regresses in code review, is the security CONTRACT the host builds:
 *   - the sandbox attribute never gains allow-same-origin (the escape hatch)
 *   - the CSP forbids ALL network (no exfil / no remote code)
 *   - the bridge shim only trusts the host, and bridge_caps FAILS CLOSED
 * A change that weakens any of these flips a test red.
 */
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { describe, expect, it, beforeAll } from "vitest"

interface Sandbox {
  buildSrcdoc: (html: string) => string
  buildMcpSrcdoc: (html: string) => string
  buildGeneratedAppSrcdoc: (html: string) => string
  subscribeAllowed: (caps: unknown, kind: unknown) => boolean
  SANDBOX_ATTR: string
  CSP: string
}
let SB: Sandbox

beforeAll(() => {
  const src = readFileSync(
    path.resolve(__dirname, "../frontend/vendor/widget-sandbox.js"),
    "utf8",
  )
  const sandbox: Record<string, unknown> = {}
  new Function("globalThis", src)(sandbox)
  SB = sandbox.LunaWidgetSandbox as Sandbox
})

describe("widget sandbox attribute (the escape hatch guard)", () => {
  it("is exactly 'allow-scripts' — NEVER allow-same-origin", () => {
    expect(SB.SANDBOX_ATTR).toBe("allow-scripts")
    expect(SB.SANDBOX_ATTR).not.toContain("allow-same-origin")
    expect(SB.SANDBOX_ATTR).not.toContain("allow-top-navigation")
    expect(SB.SANDBOX_ATTR).not.toContain("allow-popups")
  })
})

describe("widget CSP (no network by default)", () => {
  it("forbids all network and remote code", () => {
    expect(SB.CSP).toContain("default-src 'none'")
    expect(SB.CSP).toContain("connect-src 'none'")
    // No external scripts: only inline is allowed.
    expect(SB.CSP).toContain("script-src 'unsafe-inline'")
    expect(SB.CSP).not.toMatch(/script-src[^;]*https?:/)
    expect(SB.CSP).not.toContain("'unsafe-eval'")
  })
})

describe("buildSrcdoc", () => {
  it("embeds the CSP meta and the bridge shim BEFORE the agent body", () => {
    const doc = SB.buildSrcdoc("<h1>MY WIDGET</h1>")
    expect(doc).toContain('http-equiv="Content-Security-Policy"')
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("window.luna")
    // The bridge shim must appear before the agent's HTML so window.luna exists.
    expect(doc.indexOf("window.luna")).toBeLessThan(doc.indexOf("MY WIDGET"))
  })

  it("does not execute or unwrap agent content at build time (it's just concatenated)", () => {
    // A hostile body is embedded verbatim — the SANDBOX (not this function)
    // contains it. buildSrcdoc must not, e.g., strip the CSP when the body
    // contains a </head> or another CSP meta.
    const hostile =
      "</head><meta http-equiv='Content-Security-Policy' content=\"default-src *\"><script>fetch('http://evil')</script>"
    const doc = SB.buildSrcdoc(hostile)
    // Our strict CSP still precedes the injected body, so the browser applies
    // the FIRST (most restrictive) policy; the body's override comes later.
    expect(doc.indexOf("default-src 'none'")).toBeLessThan(doc.indexOf("default-src *"))
    expect(doc.indexOf("window.luna")).toBeLessThan(doc.indexOf("evil"))
  })

  it("tolerates non-string html", () => {
    expect(() => SB.buildSrcdoc(undefined as unknown as string)).not.toThrow()
    expect(SB.buildSrcdoc(null as unknown as string)).toContain("window.luna")
  })
})

describe("buildMcpSrcdoc (MCP apps — same cage, NO bridge shim)", () => {
  it("keeps the identical strict CSP but injects NO luna.* shim", () => {
    const doc = SB.buildMcpSrcdoc("<h1>MCP APP</h1>")
    expect(doc).toContain('http-equiv="Content-Security-Policy"')
    expect(doc).toContain(SB.CSP) // byte-identical policy to widgets
    expect(doc).toContain("MCP APP")
    // The whole point: an MCP app brings its own protocol script — handing it
    // the cap-gated luna.* door would be an ungated capability grant.
    expect(doc).not.toContain("window.luna")
    expect(doc).not.toContain("__luna")
  })

  it("tolerates non-string html and never strips the CSP on hostile bodies", () => {
    expect(() => SB.buildMcpSrcdoc(undefined as unknown as string)).not.toThrow()
    const hostile =
      "</head><meta http-equiv='Content-Security-Policy' content=\"default-src *\">"
    const doc = SB.buildMcpSrcdoc(hostile)
    expect(doc.indexOf("default-src 'none'")).toBeLessThan(doc.indexOf("default-src *"))
  })

  it("the bare MCP cage injects NO client helper (external apps bring their own)", () => {
    const doc = SB.buildMcpSrcdoc("<h1>X</h1>")
    expect(doc).not.toContain("window.mcp")
  })
})

describe("buildGeneratedAppSrcdoc (generated apps — same cage + window.mcp helper)", () => {
  it("keeps the strict CSP, injects the window.mcp helper, and NO luna.* shim", () => {
    const doc = SB.buildGeneratedAppSrcdoc("<h1>GEN APP</h1>")
    expect(doc).toContain(SB.CSP) // identical no-network policy
    expect(doc).toContain("window.mcp")
    expect(doc).toContain("ui/initialize")
    expect(doc).toContain("tools/call")
    // It's an MCP helper, NOT the cap-gated obs bridge.
    expect(doc).not.toContain("window.luna")
    expect(doc).not.toContain("__luna")
    // Helper must precede the agent body so window.mcp exists when it runs.
    expect(doc.indexOf("window.mcp")).toBeLessThan(doc.indexOf("GEN APP"))
  })

  it("the helper only ever postMessages window.parent (the host) — no network", () => {
    const doc = SB.buildGeneratedAppSrcdoc("<p>x</p>")
    expect(doc).toContain("window.parent.postMessage")
    // No fetch/XHR/WebSocket in the injected helper.
    expect(doc).not.toMatch(/\bfetch\s*\(/)
    expect(doc).not.toContain("XMLHttpRequest")
    expect(doc).not.toContain("new WebSocket")
  })

  it("tolerates non-string html and never strips the CSP on hostile bodies", () => {
    expect(() => SB.buildGeneratedAppSrcdoc(undefined as unknown as string)).not.toThrow()
    const hostile =
      "</head><meta http-equiv='Content-Security-Policy' content=\"default-src *\">"
    const doc = SB.buildGeneratedAppSrcdoc(hostile)
    expect(doc.indexOf("default-src 'none'")).toBeLessThan(doc.indexOf("default-src *"))
  })
})

describe("subscribeAllowed (bridge_caps fails closed)", () => {
  it("permits nothing when caps are null/empty/garbage", () => {
    expect(SB.subscribeAllowed(null, "ToolCall")).toBe(false)
    expect(SB.subscribeAllowed([], "ToolCall")).toBe(false)
    expect(SB.subscribeAllowed("obs:*", "ToolCall")).toBe(false) // not an array
    expect(SB.subscribeAllowed(undefined, "ToolCall")).toBe(false)
  })

  it("permits an exactly-listed obs kind", () => {
    expect(SB.subscribeAllowed(["obs:ToolCall"], "ToolCall")).toBe(true)
    expect(SB.subscribeAllowed(["obs:ToolCall"], "Error")).toBe(false)
  })

  it("permits everything under the obs:* wildcard", () => {
    expect(SB.subscribeAllowed(["obs:*"], "ToolCall")).toBe(true)
    expect(SB.subscribeAllowed(["obs:*"], "JobStatus")).toBe(true)
  })

  it("rejects an empty / non-string kind", () => {
    expect(SB.subscribeAllowed(["obs:*"], "")).toBe(false)
    expect(SB.subscribeAllowed(["obs:*"], null)).toBe(false)
  })
})
