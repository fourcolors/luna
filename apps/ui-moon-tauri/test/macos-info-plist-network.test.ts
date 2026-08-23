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

  it("keeps the ts.net carve-out and declares NO per-host exception", () => {
    // #588 removed the hardcoded host; the operator configures their own, so
    // baking per-host ATS exceptions in is both useless and a hostname leak.
    // NSAllowsLocalNetworking already covers unqualified / .local / LAN hosts.
    expect(plist).toContain("<key>ts.net</key>")
    expect(plist).toMatch(
      /ts\.net<\/key>\s*<dict>\s*<key>NSExceptionAllowsInsecureHTTPLoads<\/key>\s*<true\/>/,
    )
    // Exactly one exception domain => exactly one insecure-loads grant.
    expect(plist.match(/NSExceptionAllowsInsecureHTTPLoads/g) ?? []).toHaveLength(1)
  })

  it("ships no personal hostname in any user-visible plist string", () => {
    // NSLocalNetworkUsageDescription is rendered verbatim in the macOS Local
    // Network prompt — the most visible place a leaked hostname can land.
    expect(plist).not.toMatch(/jax-box/i)
    expect(plist).not.toMatch(/luna-server/i)
  })

  it("does not force wss / does not enable blanket arbitrary loads", () => {
    expect(plist).not.toContain("NSAllowsArbitraryLoads</key>")
    expect(plist).not.toContain("NSAllowsArbitraryLoadsInWebContent")
  })

  it("tauri CSP connect-src allows ws/wss and explicit ipc: for boot invokes", () => {
    const csp = conf.app.security.csp
    expect(csp).toMatch(/connect-src[^;]*\bws:/)
    expect(csp).toMatch(/connect-src[^;]*\bwss:/)
    // Without ipc:, a hung/blocked Tauri invoke never reaches new WebSocket
    // (Round-3: Disconnected + waking up + zero SYN while luna_ws_url=jax-box).
    expect(csp).toMatch(/connect-src[^;]*\bipc:/)
    expect(csp).toMatch(/connect-src[^;]*http:\/\/ipc\.localhost/)
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
    // Host-agnostic: #588 removed the default, so the gate names no host at
    // all. What must survive is the never-retarget-localhost rule, which is
    // the invariant the whole page exists to protect.
    expect(rebuildDoc).toMatch(/ws:\/\/<your-host>:4753\/ui/)
    expect(rebuildDoc).toContain("Do not retarget localhost")
    expect(rebuildDoc).not.toMatch(/jax-box/i)
  })
})
