/**
 * Unit tests for Settings → Connection machine-target helpers + reducer
 * actions (named targets, activate-on-save, detect/url/port).
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import {
  detectMachineTarget,
  initialConnectionPanelState,
  portForChannel,
  reduceConnectionPanel,
  urlForMachineTarget,
  type ConnectionPanelState,
} from "../frontend-react/src/panels/settings-connection/connectionReducer"

describe("portForChannel / urlForMachineTarget / detectMachineTarget", () => {
  it("maps stable→4753 and dev→5753; other names use stable port", () => {
    expect(portForChannel("stable")).toBe(4753)
    expect(portForChannel("dev")).toBe(5753)
    expect(portForChannel("canary")).toBe(4753)
  })

  it("builds jax-box and This Mac URLs (127.0.0.1, never localhost)", () => {
    expect(urlForMachineTarget("jax-box", "stable")).toBe("ws://jax-box:4753/ui")
    expect(urlForMachineTarget("jax-box", "dev")).toBe("ws://jax-box:5753/ui")
    expect(urlForMachineTarget("this-mac", "stable")).toBe("ws://127.0.0.1:4753/ui")
    expect(urlForMachineTarget("this-mac", "dev")).toBe("ws://127.0.0.1:5753/ui")
    expect(urlForMachineTarget("this-mac", "stable")).not.toContain("localhost")
  })

  it("detects jax-box (.local too), This Mac, and Custom", () => {
    expect(detectMachineTarget("ws://jax-box:4753/ui")).toBe("jax-box")
    expect(detectMachineTarget("ws://jax-box.local:5753/ui")).toBe("jax-box")
    expect(detectMachineTarget("ws://127.0.0.1:4753/ui")).toBe("this-mac")
    expect(detectMachineTarget("ws://other-host:4753/ui")).toBe("custom")
    expect(detectMachineTarget("wss://edge.example/ui")).toBe("custom")
  })
})

describe("connectionReducer machine-target + activate", () => {
  const base = (): ConnectionPanelState => initialConnectionPanelState()

  it("machine-target-selected fills URL for jax-box / This Mac; Custom leaves URL", () => {
    let state = reduceConnectionPanel(base(), {
      type: "machine-target-selected",
      target: "this-mac",
    })
    expect(state.machineTarget).toBe("this-mac")
    expect(state.wsUrl).toBe("ws://127.0.0.1:4753/ui")

    state = reduceConnectionPanel(state, { type: "channel-selected", channel: "dev" })
    expect(state.wsUrl).toBe("ws://127.0.0.1:5753/ui")

    state = reduceConnectionPanel(state, {
      type: "machine-target-selected",
      target: "jax-box",
    })
    expect(state.wsUrl).toBe("ws://jax-box:5753/ui")

    const beforeCustom = state.wsUrl
    state = reduceConnectionPanel(state, {
      type: "machine-target-selected",
      target: "custom",
    })
    expect(state.machineTarget).toBe("custom")
    expect(state.wsUrl).toBe(beforeCustom)
  })

  it("url-changed flips machineTarget to custom", () => {
    let state = reduceConnectionPanel(base(), {
      type: "machine-target-selected",
      target: "jax-box",
    })
    state = reduceConnectionPanel(state, {
      type: "url-changed",
      value: "ws://custom-box:4753/ui",
    })
    expect(state.machineTarget).toBe("custom")
    expect(state.wsUrl).toBe("ws://custom-box:4753/ui")
  })

  it("connection-loaded detects machine target from wsUrl", () => {
    const state = reduceConnectionPanel(base(), {
      type: "connection-loaded",
      wsUrl: "ws://127.0.0.1:4753/ui",
      wsToken: "tok",
    })
    expect(state.machineTarget).toBe("this-mac")
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

  it("channel-selected with named target recomputes URL; custom keeps typed URL", () => {
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
