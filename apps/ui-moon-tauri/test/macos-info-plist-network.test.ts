/**
 * Pins the macOS Info.plist keys that let WKWebView dial cleartext
 * ws://jax-box:4753/ui (and sibling Tailscale / .local endpoints).
 *
 * Proven off-Mac (this sandbox): the shipped 0.0.66 Info.plist had only
 * NSMicrophoneUsageDescription — no Local Network purpose string and no
 * ATS carve-out. On-Mac evidence (2026-08-17): Terminal TCP + WS upgrade
 * to jax-box:4753 succeeded, but the running app's WebKit.Networking
 * process opened no TCP to jax-box while the UI stayed on Disconnected /
 * "waking up…". CSP already allows `ws:`/`wss:` (asserted below).
 *
 * Still requires a live Mac: first launch after this build must show the
 * Local Network grant prompt (or Settings → Privacy → Local Network for
 * Luna Moon); granting it is outside what this file can prove.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import * as path from "node:path"

const root = path.resolve(__dirname, "..")
const plist = readFileSync(path.join(root, "src-tauri", "Info.plist"), "utf8")
const conf = JSON.parse(
  readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
) as { app: { security: { csp: string } } }

describe("macOS Info.plist — Local Network + cleartext WS carve-out", () => {
  it("declares NSLocalNetworkUsageDescription so macOS can prompt", () => {
    expect(plist).toContain("<key>NSLocalNetworkUsageDescription</key>")
    expect(plist).toMatch(
      /NSLocalNetworkUsageDescription<\/key>\s*<string>[^<]*Luna[^<]*<\/string>/,
    )
  })

  it("keeps the existing mic purpose string (regression)", () => {
    expect(plist).toContain("<key>NSMicrophoneUsageDescription</key>")
  })

  it("enables NSAllowsLocalNetworking under NSAppTransportSecurity", () => {
    expect(plist).toContain("<key>NSAppTransportSecurity</key>")
    expect(plist).toContain("<key>NSAllowsLocalNetworking</key>")
    // true must appear after NSAllowsLocalNetworking before the next key
    expect(plist).toMatch(
      /NSAllowsLocalNetworking<\/key>\s*<true\/>/,
    )
  })

  it("allows insecure loads for jax-box, jax-box.local, and *.ts.net", () => {
    for (const domain of ["jax-box", "jax-box.local", "ts.net"] as const) {
      expect(plist).toContain(`<key>${domain}</key>`)
    }
    // Three insecure-load exceptions (one per domain above).
    const insecure = plist.match(/NSExceptionAllowsInsecureHTTPLoads<\/key>\s*<true\/>/g)
    expect(insecure?.length).toBeGreaterThanOrEqual(3)
    const subdomains = plist.match(/NSIncludesSubdomains<\/key>\s*<true\/>/g)
    expect(subdomains?.length).toBeGreaterThanOrEqual(3)
  })

  it("does not force wss / does not enable blanket arbitrary loads", () => {
    expect(plist).not.toContain("NSAllowsArbitraryLoads</key>")
    expect(plist).not.toContain("NSAllowsArbitraryLoadsInWebContent")
  })

  it("tauri CSP connect-src still allows ws: and wss:", () => {
    const csp = conf.app.security.csp
    expect(csp).toMatch(/connect-src[^;]*\bws:/)
    expect(csp).toMatch(/connect-src[^;]*\bwss:/)
  })
})
