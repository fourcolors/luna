/**
 * Pins the macOS Info.plist keys AND the signing config that make those keys
 * actually take effect for WKWebView dialing cleartext ws://jax-box:4753/ui.
 *
 * Proven off-Mac (this sandbox): the shipped 0.0.66 Info.plist had only
 * NSMicrophoneUsageDescription — no Local Network purpose string and no
 * ATS carve-out. On-Mac evidence (2026-08-17): Terminal TCP + WS upgrade
 * to jax-box:4753 succeeded, but the running app's WebKit.Networking
 * process opened no TCP to jax-box while the UI stayed on Disconnected /
 * "waking up…". CSP already allows `ws:`/`wss:` (asserted below).
 *
 * Proven on-Mac after #544 keys landed in the bundle (2026-08-18): rebuild
 * still showed codesign Identifier=luna_moon_ui-<hash>, Info.plist=not bound,
 * linker-signed, entitlements=none — Local Network prompt never appeared and
 * still no TCP to jax-box. Root cause: signingIdentity was null, so tauri
 * skipped bundle codesign (or someone copied the cargo Mach-O into Contents/
 * MacOS). macOS ignores ATS + NSLocalNetworkUsageDescription when the plist
 * is not signature-bound. See docs/macos-local-rebuild.md.
 *
 * Still requires a live Mac: `bun run install:macos`, then grant Local Network
 * for the com.luna.moon identity.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import * as path from "node:path"

const root = path.resolve(__dirname, "..")
const plist = readFileSync(path.join(root, "src-tauri", "Info.plist"), "utf8")
const conf = JSON.parse(
  readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
) as {
  identifier: string
  app: { security: { csp: string } }
  bundle: {
    macOS: {
      signingIdentity: string | null
      entitlements: string
      hardenedRuntime: boolean
    }
  }
}
const installScript = readFileSync(
  path.join(root, "scripts", "install-macos-app.sh"),
  "utf8",
)
const rebuildDoc = readFileSync(
  path.join(root, "docs", "macos-local-rebuild.md"),
  "utf8",
)

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

describe("macOS signing — Info.plist must be codesign-bound", () => {
  it("bundle id is com.luna.moon (not the cargo luna_moon_ui-* linker id)", () => {
    expect(conf.identifier).toBe("com.luna.moon")
  })

  it("signingIdentity is ad-hoc '-' so tauri build actually codesigns the .app", () => {
    // null/empty → tauri skips signing → linker-signed Mach-O, Info.plist=not bound
    expect(conf.bundle.macOS.signingIdentity).toBe("-")
  })

  it("hardened runtime + entitlements.plist stay wired for the sign step", () => {
    expect(conf.bundle.macOS.hardenedRuntime).toBe(true)
    expect(conf.bundle.macOS.entitlements).toBe("entitlements.plist")
    expect(existsSync(path.join(root, "src-tauri", "entitlements.plist"))).toBe(true)
  })

  it("install:macos script refuses cargo-binary copies and verifies bound plist", () => {
    expect(installScript).toContain("codesign --force --deep --options runtime")
    expect(installScript).toContain("--identifier \"$EXPECTED_ID\"")
    expect(installScript).toContain("com.luna.moon")
    expect(installScript).toContain("Info.plist=not bound")
    expect(installScript).toContain("linker-signed")
    expect(installScript).toContain("Do NOT copy target/release/luna-moon-ui")
    expect(installScript).toContain("bundle/macos/Luna Moon.app")
  })

  it("macos-local-rebuild.md documents the unbound-plist hole and verify table", () => {
    expect(rebuildDoc).toContain("Info.plist=not bound")
    expect(rebuildDoc).toContain("luna_moon_ui-")
    expect(rebuildDoc).toContain("com.luna.moon")
    expect(rebuildDoc).toContain("bun run install:macos")
    expect(rebuildDoc).toContain("ws://jax-box:4753/ui")
  })
})
