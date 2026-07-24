// @vitest-environment jsdom
//
// Behavioral tests for the settings.general panel, ported from the vanilla
// LunaPanelTypes['settings.general'] module (see git history of
// apps/ui-moon-tauri/frontend/panels/settings-general.js, now superseded) to
// its React 19 + Astryx replacement,
// apps/ui-moon-tauri/frontend-react/src/panels/settings-general/SettingsGeneralPanel.tsx.
//
// Rendering uses React's own createRoot + act (no testing-library dependency
// - mirrors apps/ui-web/src/studio/vault-panel.test.jsx, itself ported from
// the same real-DOM-driving convention the old panel-window.test.ts harness
// used). Kept as a plain .test.ts (no JSX in this file) so it stays inside
// the root vitest.config.ts `apps/**/*.test.ts` include glob; the component
// under test is authored as .tsx and JSX-transformed on import same as
// every other Astryx panel test in this repo.
//
// Title/registration (the old test's "renders with title 'General'"
// assertion): the vanilla module wired `title: 'General'` into panel.html's
// bar-title itself. That responsibility now belongs to whatever mounts this
// component for a given panel `type` (main-panel.tsx's panel registry), not
// the component - this file instead pins the exported PANEL_TITLE constant
// the registry is expected to consume.
import React, { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRoot, type Root } from "react-dom/client"
import { PANEL_TITLE, SettingsGeneralPanel } from "../frontend-react/src/panels/settings-general/SettingsGeneralPanel"
import type { PanelCtx } from "../frontend-react/src/panels/panel-ctx"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function makeCtx(overrides: Partial<PanelCtx> = {}): PanelCtx & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => null)
  return { invoke, ...overrides } as PanelCtx & { invoke: ReturnType<typeof vi.fn> }
}

const mounted: Array<{ root: Root; container: HTMLElement }> = []

function mount(ctx: PanelCtx): HTMLElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(React.createElement(SettingsGeneralPanel, { ctx }))
  })
  mounted.push({ root, container })
  return container
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  localStorage.clear()
  vi.restoreAllMocks()
})

// ── Element lookups ─────────────────────────────────────────────────────────
// Astryx's Switch spreads unknown props (incl. data-testid) onto its OWN
// outer wrapper div, not the underlying <input type=checkbox> (it mints that
// input's id internally via useId) - so a switch's row is located by
// data-testid, then the real checkbox is found inside it. TextInput and
// Button both spread unknown props directly onto their real <input>/<button>
// element, so those are queried by data-testid directly.
function switchInput(container: HTMLElement, testId: string): HTMLInputElement {
  const row = container.querySelector(`[data-testid="${testId}"]`)
  if (!row) throw new Error(`switch row not found: ${testId}`)
  const input = row.querySelector('input[type="checkbox"]')
  if (!input) throw new Error(`checkbox input not found inside: ${testId}`)
  return input as HTMLInputElement
}

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`element not found: ${testId}`)
  return el as HTMLElement
}

describe("settings.general panel (React/Astryx)", () => {
  it("PANEL_TITLE is 'General' (consumed by the panel-type registry for bar-title/document.title)", () => {
    expect(PANEL_TITLE).toBe("General")
  })

  // ── Initial render ────────────────────────────────────────────────────────

  it("renders all four controls", () => {
    const container = mount(makeCtx())
    expect(switchInput(container, "always-on-top-row")).toBeTruthy()
    expect(switchInput(container, "close-on-blur-row")).toBeTruthy()
    expect(byTestId(container, "shortcut-input")).toBeTruthy()
    expect(byTestId(container, "record-shortcut-btn")).toBeTruthy()
    expect(byTestId(container, "fresh-thread-btn")).toBeTruthy()
  })

  it("always-on-top defaults to UNCHECKED when localStorage is empty", () => {
    // Panels/screens no longer float by default - they only stay on top once
    // the user has explicitly enabled the setting (luna_always_on_top === 'true').
    const container = mount(makeCtx())
    expect(switchInput(container, "always-on-top-row").checked).toBe(false)
  })

  it("close-on-blur defaults to unchecked when localStorage is empty", () => {
    const container = mount(makeCtx())
    expect(switchInput(container, "close-on-blur-row").checked).toBe(false)
  })

  it("shortcut input shows default ⌥Space when localStorage is empty", () => {
    const container = mount(makeCtx())
    const input = byTestId(container, "shortcut-input") as HTMLInputElement
    expect(input.value).toBe("⌥Space")
  })

  it("restores saved values from localStorage on render", () => {
    localStorage.setItem("luna_always_on_top", "false")
    localStorage.setItem("luna_close_on_blur", "true")
    localStorage.setItem("luna_global_shortcut", "⌘K")
    const container = mount(makeCtx())
    expect(switchInput(container, "always-on-top-row").checked).toBe(false)
    expect(switchInput(container, "close-on-blur-row").checked).toBe(true)
    expect((byTestId(container, "shortcut-input") as HTMLInputElement).value).toBe("⌘K")
  })

  // ── Always on Top switch ────────────────────────────────────────────────────

  it("toggling always-on-top writes luna_always_on_top to localStorage", () => {
    const container = mount(makeCtx())
    const input = switchInput(container, "always-on-top-row")
    // Default is unchecked (false); check it to float.
    act(() => {
      input.click()
    })
    expect(localStorage.getItem("luna_always_on_top")).toBe("true")
    expect(input.checked).toBe(true)
    // Un-check it.
    act(() => {
      input.click()
    })
    expect(localStorage.getItem("luna_always_on_top")).toBe("false")
    expect(input.checked).toBe(false)
  })

  // ── Close on blur switch ────────────────────────────────────────────────────

  it("toggling close-on-blur writes luna_close_on_blur to localStorage", () => {
    const container = mount(makeCtx())
    const input = switchInput(container, "close-on-blur-row")
    act(() => {
      input.click()
    })
    expect(localStorage.getItem("luna_close_on_blur")).toBe("true")
    act(() => {
      input.click()
    })
    expect(localStorage.getItem("luna_close_on_blur")).toBe("false")
  })

  // ── Shortcut recorder ─────────────────────────────────────────────────────

  it("Record button toggles to Cancel and sets recording placeholder", () => {
    const container = mount(makeCtx())
    const btn = byTestId(container, "record-shortcut-btn") as HTMLButtonElement
    const input = byTestId(container, "shortcut-input") as HTMLInputElement
    act(() => {
      btn.click()
    })
    expect(btn.textContent).toBe("Cancel")
    expect(input.value).toBe("Press keys...")
    expect(input.dataset.recording).toBe("true")
  })

  it("clicking Cancel while recording restores the saved shortcut and exits recording mode", () => {
    localStorage.setItem("luna_global_shortcut", "⌘J")
    const container = mount(makeCtx())
    const btn = byTestId(container, "record-shortcut-btn") as HTMLButtonElement
    const input = byTestId(container, "shortcut-input") as HTMLInputElement
    act(() => {
      btn.click() // start recording
    })
    act(() => {
      btn.click() // cancel
    })
    expect(btn.textContent).toBe("Record")
    expect(input.value).toBe("⌘J")
    expect(input.dataset.recording).toBe("false")
  })

  it("keydown while recording writes luna_global_shortcut and exits recording mode", () => {
    const container = mount(makeCtx())
    const btn = byTestId(container, "record-shortcut-btn") as HTMLButtonElement
    const input = byTestId(container, "shortcut-input") as HTMLInputElement
    act(() => {
      btn.click() // enter recording mode
    })
    act(() => {
      // Simulate Alt+Space keydown
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", altKey: true, bubbles: true, cancelable: true }),
      )
    })
    expect(input.value).toBe("⌥Space")
    expect(localStorage.getItem("luna_global_shortcut")).toBe("⌥Space")
    expect(btn.textContent).toBe("Record")
    expect(input.dataset.recording).toBe("false")
  })

  it("modifier-only keydown while recording does NOT save or exit recording mode", () => {
    const container = mount(makeCtx())
    const btn = byTestId(container, "record-shortcut-btn") as HTMLButtonElement
    const input = byTestId(container, "shortcut-input") as HTMLInputElement
    act(() => {
      btn.click()
    })
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Alt", altKey: true, bubbles: true, cancelable: true }),
      )
    })
    // Still recording - no shortcut saved, placeholder still shows.
    expect(input.value).toBe("Press keys...")
    expect(localStorage.getItem("luna_global_shortcut")).toBeNull()
    expect(btn.textContent).toBe("Cancel")
  })

  it("keydown outside recording mode does not modify the shortcut", () => {
    localStorage.setItem("luna_global_shortcut", "⌥Space")
    const container = mount(makeCtx())
    const input = byTestId(container, "shortcut-input") as HTMLInputElement
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
      )
    })
    expect(input.value).toBe("⌥Space")
    expect(localStorage.getItem("luna_global_shortcut")).toBe("⌥Space")
  })

  it("records correct modifier-prefix order: Ctrl Alt Shift Meta", () => {
    const container = mount(makeCtx())
    const btn = byTestId(container, "record-shortcut-btn") as HTMLButtonElement
    act(() => {
      btn.click()
    })
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "p",
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      )
    })
    expect(localStorage.getItem("luna_global_shortcut")).toBe("⌃⌥⇧⌘P")
  })

  // ── Fresh thread button ───────────────────────────────────────────────────

  it("clicking fresh-thread-btn invokes hub_event with name fresh-thread", async () => {
    const ctx = makeCtx()
    const container = mount(ctx)
    act(() => {
      byTestId(container, "fresh-thread-btn").click()
    })
    await vi.waitFor(() => expect(ctx.invoke).toHaveBeenCalledWith("hub_event", { name: "fresh-thread" }))
  })

  it("fresh-thread-btn swallows invoke errors (fire-and-forget)", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "hub_event") throw new Error("hub gone")
      return null
    })
    const container = mount({ invoke } as PanelCtx)
    expect(() => {
      act(() => {
        byTestId(container, "fresh-thread-btn").click()
      })
    }).not.toThrow()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
  })
})
