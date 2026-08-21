/**
 * Unit tests for Settings → Connection machine-target helpers + reducer
 * actions (named targets, activate-on-save, detect/url/port).
 *
 * Priority: jax-box is the Connected path. This Mac → 127.0.0.1 is gated off
 * (THIS_MAC_TARGET_ENABLED=false) until jax-box Connected is proven.
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  detectMachineTarget,
  initialConnectionPanelState,
  MACHINE_TARGET_OPTIONS,
  portForChannel,
  reduceConnectionPanel,
  THIS_MAC_TARGET_ENABLED,
  urlForMachineTarget,
  type ConnectionPanelState,
} from "../frontend-react/src/panels/settings-connection/connectionReducer"

describe("portForChannel / urlForMachineTarget / detectMachineTarget", () => {
  it("maps stable→4753 and dev→5753; other names use stable port", () => {
    expect(portForChannel("stable")).toBe(4753)
    expect(portForChannel("dev")).toBe(5753)
    expect(portForChannel("canary")).toBe(4753)
  })

  it("builds jax-box URLs as the Connected default", () => {
    expect(urlForMachineTarget("jax-box", "stable")).toBe("ws://jax-box:4753/ui")
    expect(urlForMachineTarget("jax-box", "dev")).toBe("ws://jax-box:5753/ui")
  })

  it("This Mac is gated: options omit it; urlForMachineTarget never emits loopback", () => {
    expect(THIS_MAC_TARGET_ENABLED).toBe(false)
    expect(MACHINE_TARGET_OPTIONS.map((o) => o.value)).toEqual(["jax-box", "custom"])
    expect(MACHINE_TARGET_OPTIONS.map((o) => o.value)).not.toContain("this-mac")
    // Even if somehow asked, gated path must not emit 127.0.0.1.
    expect(urlForMachineTarget("this-mac", "stable")).toBe("ws://jax-box:4753/ui")
    expect(urlForMachineTarget("this-mac", "stable")).not.toContain("127.0.0.1")
  })

  it("detects jax-box (.local too); loopback maps to custom while This Mac is cut", () => {
    expect(detectMachineTarget("ws://jax-box:4753/ui")).toBe("jax-box")
    expect(detectMachineTarget("ws://jax-box.local:5753/ui")).toBe("jax-box")
    expect(detectMachineTarget("ws://127.0.0.1:4753/ui")).toBe("custom")
    expect(detectMachineTarget("ws://other-host:4753/ui")).toBe("custom")
  })
})

describe("connectionReducer machine-target + activate", () => {
  const base = (): ConnectionPanelState => initialConnectionPanelState()

  it("machine-target-selected jax-box fills the remote default URL", () => {
    let state = reduceConnectionPanel(base(), {
      type: "machine-target-selected",
      target: "jax-box",
    })
    expect(state.machineTarget).toBe("jax-box")
    expect(state.wsUrl).toBe("ws://jax-box:4753/ui")
    expect(state.wsUrl).not.toContain("127.0.0.1")

    state = reduceConnectionPanel(state, { type: "channel-selected", channel: "dev" })
    expect(state.wsUrl).toBe("ws://jax-box:5753/ui")
  })

  it("selecting this-mac while gated coerces to jax-box (no loopback write)", () => {
    const state = reduceConnectionPanel(base(), {
      type: "machine-target-selected",
      target: "this-mac",
    })
    expect(state.machineTarget).toBe("jax-box")
    expect(state.wsUrl).toBe("ws://jax-box:4753/ui")
    expect(state.wsUrl).not.toContain("127.0.0.1")
  })

  it("Custom leaves URL; url-changed flips machineTarget to custom", () => {
    let state = reduceConnectionPanel(base(), {
      type: "machine-target-selected",
      target: "jax-box",
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

  it("connection-loaded detects jax-box from wsUrl", () => {
    const state = reduceConnectionPanel(base(), {
      type: "connection-loaded",
      wsUrl: "ws://jax-box:4753/ui",
      wsToken: "tok",
    })
    expect(state.machineTarget).toBe("jax-box")
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

  it("channel-selected with jax-box recomputes URL; custom keeps typed URL", () => {
    let state = reduceConnectionPanel(base(), {
      type: "machine-target-selected",
      target: "jax-box",
    })
    state = reduceConnectionPanel(state, { type: "channel-selected", channel: "dev" })
    expect(state.wsUrl).toBe("ws://jax-box:5753/ui")

    state = reduceConnectionPanel(state, {
      type: "url-changed",
      value: "ws://keep-me:9/ui",
    })
    state = reduceConnectionPanel(state, { type: "channel-selected", channel: "stable" })
    expect(state.machineTarget).toBe("custom")
    expect(state.wsUrl).toBe("ws://keep-me:9/ui")
  })
})
