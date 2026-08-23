// @vitest-environment jsdom
/**
 * machine-access-prompt.test.ts - the one-time consent banner for the 0.0.73
 * machine-access default flip.
 *
 * The semantics under test are the PRODUCT decision, so they are pinned
 * explicitly: prompt only while `luna_machine_access` is absent, default
 * stays ON while unanswered, dismiss means "ask again next launch", and an
 * answer applies through the same path as the settings toggle (persist +
 * live state + capability re-announce).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  MACHINE_ACCESS_KEY,
  createMachineAccessPrompt,
  machineAccessUnanswered,
} from "../frontend-react/src/chat/machineAccessPrompt"

const rig = () => {
  document.body.innerHTML = '<div class="chat-input-area"><div class="composer-input-wrap"></div></div>'
  const State = { localShell: { fullAccess: true, enabled: true } }
  const LocalShell = {
    recomputeEnabled: vi.fn(),
    updateUI: vi.fn(),
    sendCapability: vi.fn(),
  }
  const prompt = createMachineAccessPrompt({
    Logger: { warn: vi.fn() },
    State,
    LocalShell,
  })
  return { prompt, State, LocalShell }
}

const banner = () => document.querySelector(".ma-consent")

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ""
})

describe("when the prompt appears", () => {
  it("shows while the key has never been written", () => {
    const { prompt } = rig()
    prompt.maybeShow()
    expect(banner()).not.toBeNull()
  })

  it("never shows once answered - either way, from any surface", () => {
    for (const v of ["on", "off"]) {
      localStorage.setItem(MACHINE_ACCESS_KEY, v)
      const { prompt } = rig()
      prompt.maybeShow()
      expect(banner(), `answered "${v}"`).toBeNull()
    }
  })

  it("degrades silently in a DOM without a composer", () => {
    const { prompt } = rig()
    document.body.innerHTML = ""
    expect(() => prompt.maybeShow()).not.toThrow()
  })

  it("machineAccessUnanswered never prompts on a throwing storage", () => {
    expect(
      machineAccessUnanswered({
        getItem: () => {
          throw new Error("sandboxed")
        },
      }),
    ).toBe(false)
  })
})

describe("answering", () => {
  it("Keep on persists 'on' and re-announces the capability", () => {
    const { prompt, State, LocalShell } = rig()
    prompt.maybeShow()
    ;(banner()!.querySelector('[data-ma="on"]') as HTMLButtonElement).click()
    expect(localStorage.getItem(MACHINE_ACCESS_KEY)).toBe("on")
    expect(State.localShell.fullAccess).toBe(true)
    expect(LocalShell.sendCapability).toHaveBeenCalled()
  })

  it("Turn off persists 'off', flips live state, and re-announces", () => {
    const { prompt, State, LocalShell } = rig()
    prompt.maybeShow()
    ;(banner()!.querySelector('[data-ma="off"]') as HTMLButtonElement).click()
    expect(localStorage.getItem(MACHINE_ACCESS_KEY)).toBe("off")
    expect(State.localShell.fullAccess).toBe(false)
    expect(LocalShell.recomputeEnabled).toHaveBeenCalled()
    expect(LocalShell.updateUI).toHaveBeenCalled()
    expect(LocalShell.sendCapability).toHaveBeenCalled()
  })

  it("an answer starts the banner's leave animation", () => {
    const { prompt } = rig()
    prompt.maybeShow()
    ;(banner()!.querySelector('[data-ma="on"]') as HTMLButtonElement).click()
    // Removal rides the animation; the immediate signal is the leaving class.
    expect(banner()!.classList.contains("leaving")).toBe(true)
  })
})

describe("a stale banner never overwrites a fresher answer", () => {
  it("drops itself instead of applying when the key was written elsewhere", () => {
    const { prompt, State, LocalShell } = rig()
    prompt.maybeShow()
    // The user answers in Settings (or the composer scope menu) while the
    // banner is still mounted...
    localStorage.setItem(MACHINE_ACCESS_KEY, "off")
    State.localShell.fullAccess = false
    // ...then clicks the stale banner. The click must NOT win.
    ;(banner()!.querySelector('[data-ma="on"]') as HTMLButtonElement).click()
    expect(localStorage.getItem(MACHINE_ACCESS_KEY)).toBe("off")
    expect(State.localShell.fullAccess).toBe(false)
    expect(LocalShell.sendCapability).not.toHaveBeenCalled()
    expect(banner()!.classList.contains("leaving")).toBe(true)
  })
})

describe("the cross-window ping", () => {
  it("an answer invokes hub_event machine-access-changed so other windows re-read", () => {
    // The Rust side allowlists this name and fans it out to every open window
    // (windows.rs HUB_EVENT_NAMES + hub_event_targets) - this pins the JS half
    // of that contract, which the first review found completely untested.
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } }
    try {
      const { prompt } = rig()
      prompt.maybeShow()
      ;(banner()!.querySelector('[data-ma="on"]') as HTMLButtonElement).click()
      expect(invoke).toHaveBeenCalledWith("hub_event", { name: "machine-access-changed" })
    } finally {
      delete (window as unknown as { __TAURI__?: unknown }).__TAURI__
    }
  })
})

describe("dismiss means not-now", () => {
  it("writes nothing, so the question returns", () => {
    const { prompt } = rig()
    prompt.maybeShow()
    ;(banner()!.querySelector(".ub-dismiss") as HTMLButtonElement).click()
    expect(localStorage.getItem(MACHINE_ACCESS_KEY)).toBeNull()
    // A fresh session (new prompt instance) shows it again.
    const again = rig()
    again.prompt.maybeShow()
    expect(document.querySelectorAll(".ma-consent").length).toBeGreaterThan(0)
  })

  it("default stays ON while unanswered - consent surfacing, not a gate", () => {
    const { prompt, State, LocalShell } = rig()
    prompt.maybeShow()
    ;(banner()!.querySelector(".ub-dismiss") as HTMLButtonElement).click()
    expect(State.localShell.fullAccess).toBe(true)
    expect(LocalShell.sendCapability).not.toHaveBeenCalled()
  })
})
