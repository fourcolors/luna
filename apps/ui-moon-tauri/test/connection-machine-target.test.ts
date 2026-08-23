/**
 * Unit tests for Settings → Connection machine-target helpers + reducer
 * actions (named targets, activate-on-save, detect/url/port).
 *
 * #588 removed the installer's hardcoded host and made it prompt instead, so
 * there is no baked-in remote default left to assert. "server" now means the
 * host learned from the persisted connection.
 *
 * The never-loopback invariant is UNCHANGED and every assertion that guarded
 * it is preserved below: This Mac stays gated (THIS_MAC_TARGET_ENABLED=false)
 * and no gated path may emit 127.0.0.1. A loopback "Connected" is exempt from
 * Local Network TCC and the bound-plist/ATS machinery, so it would falsely
 * certify a broken bundle — see docs/macos-local-rebuild.md.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  detectMachineTarget,
  initialConnectionPanelState,
  isDialableWsUrl,
  isLoopbackWsUrl,
  MACHINE_TARGET_OPTIONS,
  needsServerSetup,
  portForChannel,
  reduceConnectionPanel,
  THIS_MAC_TARGET_ENABLED,
  urlForChannelFrom,
  urlForMachineTarget,
  type ConnectionPanelState,
} from "../frontend-react/src/panels/settings-connection/connectionReducer"

const SERVER = "ws://example-host:4753/ui"

describe("portForChannel / urlForMachineTarget / detectMachineTarget", () => {
  it("maps stable→4753 and dev→5753; other names use stable port", () => {
    expect(portForChannel("stable")).toBe(4753)
    expect(portForChannel("dev")).toBe(5753)
    expect(portForChannel("canary")).toBe(4753)
  })

  it("builds the configured server's URL per channel, keeping the host", () => {
    expect(urlForMachineTarget("server", "stable", SERVER)).toBe("ws://example-host:4753/ui")
    expect(urlForMachineTarget("server", "dev", SERVER)).toBe("ws://example-host:5753/ui")
  })

  it("has NO hardcoded default: with nothing configured it yields empty", () => {
    expect(urlForMachineTarget("server", "stable")).toBe("")
    expect(urlForMachineTarget("server", "stable", "")).toBe("")
    expect(urlForChannelFrom("", "stable")).toBe("")
  })

  it("This Mac is gated: options omit it; no gated path emits loopback", () => {
    expect(THIS_MAC_TARGET_ENABLED).toBe(false)
    expect(MACHINE_TARGET_OPTIONS.map((o) => o.value)).toEqual(["server", "custom"])
    expect(MACHINE_TARGET_OPTIONS.map((o) => o.value)).not.toContain("this-mac")
    // Even if somehow asked, gated path must not emit 127.0.0.1.
    expect(urlForMachineTarget("this-mac", "stable", SERVER)).toBe("ws://example-host:4753/ui")
    expect(urlForMachineTarget("this-mac", "stable", SERVER)).not.toContain("127.0.0.1")
    // ...and with nothing configured it must still not invent loopback.
    expect(urlForMachineTarget("this-mac", "stable")).toBe("")
    expect(urlForMachineTarget("this-mac", "stable")).not.toContain("127.0.0.1")
  })

  it("detects the configured server by host; loopback maps to custom while This Mac is cut", () => {
    expect(detectMachineTarget("ws://example-host:4753/ui", SERVER)).toBe("server")
    expect(detectMachineTarget("ws://example-host:5753/ui", SERVER)).toBe("server")
    expect(detectMachineTarget("ws://127.0.0.1:4753/ui", SERVER)).toBe("custom")
    expect(detectMachineTarget("ws://localhost:4753/ui", SERVER)).toBe("custom")
    expect(detectMachineTarget("ws://other-host:4753/ui", SERVER)).toBe("custom")
  })

  it("preflight accepts only well-formed ws/wss", () => {
    expect(isDialableWsUrl("ws://h:4753/ui")).toBe(true)
    expect(isDialableWsUrl("wss://h.example.com/ui")).toBe(true)
    expect(isDialableWsUrl("http://h:4753/ui")).toBe(false)
    expect(isDialableWsUrl("example-host:4753")).toBe(false)
    expect(isDialableWsUrl("")).toBe(false)
    expect(isDialableWsUrl("   ")).toBe(false)
    expect(isDialableWsUrl("ws://")).toBe(false)
  })

  it("recognises every loopback spelling (none may become the server)", () => {
    expect(isLoopbackWsUrl("ws://127.0.0.1:4753/ui")).toBe(true)
    expect(isLoopbackWsUrl("ws://localhost:4753/ui")).toBe(true)
    expect(isLoopbackWsUrl("ws://[::1]:4753/ui")).toBe(true)
    expect(isLoopbackWsUrl("ws://example-host:4753/ui")).toBe(false)
  })

  it("needsServerSetup is true until a real non-loopback host exists", () => {
    expect(needsServerSetup("", "")).toBe(true)
    // The boot fallback must NOT count as configured.
    expect(needsServerSetup("", "ws://127.0.0.1:4753/ui")).toBe(true)
    expect(needsServerSetup("", "http://nope")).toBe(true)
    expect(needsServerSetup(SERVER, "")).toBe(false)
    expect(needsServerSetup("", SERVER)).toBe(false)
  })
})

describe("connectionReducer machine-target + activate", () => {
  const base = (): ConnectionPanelState => initialConnectionPanelState()
  const configured = (): ConnectionPanelState =>
    reduceConnectionPanel(base(), {
      type: "connection-loaded",
      wsUrl: SERVER,
      wsToken: "tok",
    })

  it("machine-target-selected server fills the configured URL", () => {
    let state = reduceConnectionPanel(configured(), {
      type: "machine-target-selected",
      target: "server",
    })
    expect(state.machineTarget).toBe("server")
    expect(state.wsUrl).toBe("ws://example-host:4753/ui")
    expect(state.wsUrl).not.toContain("127.0.0.1")

    state = reduceConnectionPanel(state, { type: "channel-selected", channel: "dev" })
    expect(state.wsUrl).toBe("ws://example-host:5753/ui")
  })

  it("selecting this-mac while gated coerces to server (no loopback write)", () => {
    const state = reduceConnectionPanel(configured(), {
      type: "machine-target-selected",
      target: "this-mac",
    })
    expect(state.machineTarget).toBe("server")
    expect(state.wsUrl).toBe("ws://example-host:4753/ui")
    expect(state.wsUrl).not.toContain("127.0.0.1")
  })

  it("with nothing configured, selecting a named target writes no URL at all", () => {
    const state = reduceConnectionPanel(base(), {
      type: "machine-target-selected",
      target: "server",
    })
    expect(state.wsUrl).toBe("")
    expect(needsServerSetup(state.serverUrl, state.wsUrl)).toBe(true)
  })

  it("a loopback connection-loaded never becomes the remembered server", () => {
    const state = reduceConnectionPanel(base(), {
      type: "connection-loaded",
      wsUrl: "ws://127.0.0.1:4753/ui",
      wsToken: "tok",
    })
    expect(state.serverUrl).toBe("")
    expect(state.machineTarget).toBe("custom")
    expect(needsServerSetup(state.serverUrl, state.wsUrl)).toBe(true)
  })

  it("Custom leaves URL; url-changed flips machineTarget to custom", () => {
    let state = reduceConnectionPanel(configured(), {
      type: "machine-target-selected",
      target: "server",
    })
    const beforeCustom = state.wsUrl
    state = reduceConnectionPanel(state, {
      type: "machine-target-selected",
      target: "custom",
    })
    expect(state.machineTarget).toBe("custom")
    expect(state.wsUrl).toBe(beforeCustom)

    state = reduceConnectionPanel(state, {
      type: "url-changed",
      value: "ws://custom-box:4753/ui",
    })
    expect(state.machineTarget).toBe("custom")
    expect(state.wsUrl).toBe("ws://custom-box:4753/ui")
  })

  it("connection-loaded learns the server from wsUrl", () => {
    const state = configured()
    expect(state.serverUrl).toBe(SERVER)
    expect(state.machineTarget).toBe("server")
    expect(state.wsToken).toBe("tok")
  })

  it("activate-on-save-changed toggles the flag (default false)", () => {
    expect(base().activateOnSave).toBe(false)
    const on = reduceConnectionPanel(base(), {
      type: "activate-on-save-changed",
      value: true,
    })
    expect(on.activateOnSave).toBe(true)
    const off = reduceConnectionPanel(on, {
      type: "activate-on-save-changed",
      value: false,
    })
    expect(off.activateOnSave).toBe(false)
  })

  it("channel-selected with server recomputes URL; custom keeps typed URL", () => {
    let state = reduceConnectionPanel(configured(), {
      type: "machine-target-selected",
      target: "server",
    })
    state = reduceConnectionPanel(state, { type: "channel-selected", channel: "dev" })
    expect(state.wsUrl).toBe("ws://example-host:5753/ui")

    state = reduceConnectionPanel(state, {
      type: "url-changed",
      value: "ws://keep-me:9/ui",
    })
    state = reduceConnectionPanel(state, { type: "channel-selected", channel: "stable" })
    expect(state.machineTarget).toBe("custom")
    expect(state.wsUrl).toBe("ws://keep-me:9/ui")
  })
})

/**
 * Regression guard for the boot-path hole an audit found in this PR's first
 * revision. hubEngines' legacy-token migration called
 * `persistConnection(pickBootWsUrl(loadedUrl), legacyToken)`, and
 * pickBootWsUrl's last resort is ws://127.0.0.1:4753/ui. So when
 * load_connection returned nothing (or timed out - that throw is caught and
 * leaves loadedUrl null) and no luna_ws_url cache existed, Moon persisted
 * LOOPBACK into moon-connection.json with no user action at all.
 *
 * Removing the compiled-in host made that state common rather than rare,
 * which is exactly why the guard belongs with this change. These assert the
 * predicate the guard is built from; the guard itself lives at
 * hub/hubEngines.ts and refuses the write unless both hold.
 */
describe("legacy-token migration must never persist the boot fallback", () => {
  const migrationAllowed = (url: string) =>
    isDialableWsUrl(url) && !isLoopbackWsUrl(url)

  it("refuses pickBootWsUrl's loopback last resort", () => {
    expect(migrationAllowed("ws://127.0.0.1:4753/ui")).toBe(false)
    expect(migrationAllowed("ws://localhost:4753/ui")).toBe(false)
    expect(migrationAllowed("ws://[::1]:4753/ui")).toBe(false)
  })

  it("refuses an empty or malformed URL rather than writing a guess", () => {
    expect(migrationAllowed("")).toBe(false)
    expect(migrationAllowed("   ")).toBe(false)
    expect(migrationAllowed("http://configured-host:4753/ui")).toBe(false)
  })

  it("still migrates onto a real configured server", () => {
    expect(migrationAllowed("ws://configured-host:4753/ui")).toBe(true)
    expect(migrationAllowed("wss://configured-host.example.com/ui")).toBe(true)
  })
})
