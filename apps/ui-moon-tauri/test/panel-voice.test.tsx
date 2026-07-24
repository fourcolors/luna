// @vitest-environment jsdom
//
// Behavioral tests for the settings.voice panel, React 19 + Astryx edition.
// Ported from the vanilla test/panel-voice.test.ts (which drove
// frontend/panels/settings-voice.js through the real panel.html inline
// script - see git history). That module and its bootPanel harness are
// gone: VoicePanel.tsx now owns this panel entirely (see
// frontend-react/src/panels/settings-voice/), so this file mounts the real
// component directly with React's own createRoot + act, mirroring
// apps/ui-web/src/studio/vault-panel.test.jsx's approach (no
// @testing-library dependency - this workspace doesn't install one) rather
// than re-simulating an HTML shell that no longer exists for this type.
//
// Every behavioral assertion the vanilla suite made is preserved:
//   1. renders with title "Voice" and every control present
//   2. reads initial mode / speak-replies / silence-hang from localStorage
//   3. mode buttons persist + invoke voice_set_mode
//   4/5. speak-replies checkbox persists both directions
//   6/7. voice picker populates from voice_list_voices and persists a pick;
//        "System default" clears it
//   8/9. silence-hang: live drag never persists; committing does (+ invokes
//        voice_set_config) - covered at the reducer level (voice-store.ts)
//        plus one mounted keyboard-driven commit
//   10. voice_status rejecting -> unavailable notice + every control disabled
//   11/12. model present vs missing -> Download button visibility
//   13/14. Download button success/failure paths
//   15/16/17. voice-model-progress events (progress/done/error)
import React, { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRoot } from "react-dom/client"
import { VoicePanel } from "../frontend-react/src/panels/settings-voice/VoicePanel"
import {
  clampSilenceHang,
  initialVoiceState,
  voiceReduce,
  type VoiceState,
} from "../frontend-react/src/panels/settings-voice/voice-store"
import type { PanelCtx } from "../frontend-react/src/panels/panel-ctx"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ── mount harness ────────────────────────────────────────────────────────

type InvokeImpl = (cmd: string, args?: unknown) => unknown

interface MockCtx {
  ctx: PanelCtx
  invoke: ReturnType<typeof vi.fn>
  fireWinEvent: (event: string, payload: unknown) => void
}

function makeCtx(opts: { invoke?: InvokeImpl; hasTauri?: boolean; withWin?: boolean } = {}): MockCtx {
  const listenHandlers: Record<string, Array<(ev: unknown) => void>> = {}
  const invoke = vi.fn(async (cmd: string, args?: unknown) => {
    if (!opts.invoke) return null
    const result = opts.invoke(cmd, args)
    if (result instanceof Error) throw result
    return result
  })
  const win = {
    listen: vi.fn(async (event: string, handler: (ev: unknown) => void) => {
      ;(listenHandlers[event] ||= []).push(handler)
      return () => {}
    }),
  }
  const ctx: PanelCtx = {
    invoke: invoke as unknown as PanelCtx["invoke"],
    hasTauri: opts.hasTauri ?? true,
    win: opts.withWin === false ? null : win,
  }
  function fireWinEvent(event: string, payload: unknown): void {
    for (const h of listenHandlers[event] || []) h({ payload })
  }
  return { ctx, invoke, fireWinEvent }
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = []

function mount(ctx: PanelCtx): HTMLElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<VoicePanel ctx={ctx} />)
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

// ── DOM query helpers ───────────────────────────────────────────────────

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text))
  if (!btn) throw new Error(`no <button> containing "${text}"`)
  return btn
}

function modeStatus(): string {
  return document.getElementById("voice-model-status")?.textContent ?? ""
}

function unavailableNote(): HTMLElement {
  const el = document.getElementById("voice-unavailable-note")
  if (!el) throw new Error("missing #voice-unavailable-note")
  return el
}

function silenceThumb(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[role="slider"]')
  if (!el) throw new Error("missing slider thumb")
  return el as HTMLElement
}

// ── 1. Initial render ───────────────────────────────────────────────────

describe("settings.voice panel", () => {
  it("renders every control with title Voice", async () => {
    const { ctx } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: true } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("ready"))

    expect(findButtonByText(container, "Off")).toBeTruthy()
    expect(findButtonByText(container, "Push-to-talk")).toBeTruthy()
    expect(findButtonByText(container, "Hands-free")).toBeTruthy()
    expect(container.querySelector('input[type="checkbox"]')).toBeTruthy()
    expect(document.getElementById("voice-voice-select")).toBeTruthy()
    expect(silenceThumb(container)).toBeTruthy()
  })

  // ── 2. Initial state from localStorage ─────────────────────────────────

  it("reads initial voice mode, speak-replies, silence hang from localStorage", async () => {
    localStorage.setItem("luna_voice_mode", "ptt")
    localStorage.setItem("luna_voice_speak_replies", "0")
    localStorage.setItem("luna_voice_silence_hang_ms", "750")

    const { ctx } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: true } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("ready"))

    expect(findButtonByText(container, "Push-to-talk").getAttribute("aria-pressed")).toBe("true")
    expect(findButtonByText(container, "Off").getAttribute("aria-pressed")).toBe("false")

    const cb = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(cb.checked).toBe(false)

    expect(silenceThumb(container).getAttribute("aria-valuenow")).toBe("750")
  })

  // ── 3. Voice mode segmented control ────────────────────────────────────

  it("clicking a mode button updates localStorage and invokes voice_set_mode", async () => {
    const { ctx, invoke } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: true } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("ready"))

    act(() => {
      findButtonByText(container, "Hands-free").click()
    })

    await vi.waitFor(() => expect(localStorage.getItem("luna_voice_mode")).toBe("auto"))
    expect(invoke).toHaveBeenCalledWith("voice_set_mode", { mode: "auto" })
    expect(findButtonByText(container, "Hands-free").getAttribute("aria-pressed")).toBe("true")
    expect(findButtonByText(container, "Off").getAttribute("aria-pressed")).toBe("false")
  })

  // ── 4/5. Speak replies checkbox ─────────────────────────────────────────

  it("unchecking speak-replies writes luna_voice_speak_replies=0 to localStorage", async () => {
    const { ctx } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: true } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("ready"))

    const cb = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => cb.click())

    expect(localStorage.getItem("luna_voice_speak_replies")).toBe("0")
  })

  it("checking speak-replies writes luna_voice_speak_replies=1 to localStorage", async () => {
    localStorage.setItem("luna_voice_speak_replies", "0")
    const { ctx } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: true } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("ready"))

    const cb = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => cb.click())

    expect(localStorage.getItem("luna_voice_speak_replies")).toBe("1")
  })

  // ── 6/7. Voice picker ────────────────────────────────────────────────────

  it("populates the voice picker from voice_list_voices and persists selection", async () => {
    const { ctx, invoke } = makeCtx({
      invoke: (cmd) => {
        if (cmd === "voice_status") return { modelPresent: true }
        if (cmd === "voice_list_voices") return [{ id: "Samantha", name: "Samantha", quality: "enhanced" }]
        return null
      },
    })
    const container = mount(ctx)

    await vi.waitFor(() => {
      const sel = document.getElementById("voice-voice-select") as HTMLSelectElement
      expect(sel.disabled).toBe(false)
      expect(sel.options.length).toBeGreaterThan(1)
    })

    const sel = document.getElementById("voice-voice-select") as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.value)).toContain("Samantha")
    expect(Array.from(sel.options).find((o) => o.value === "Samantha")!.textContent).toContain("enhanced")

    act(() => {
      sel.value = "Samantha"
      sel.dispatchEvent(new Event("change", { bubbles: true }))
    })

    expect(localStorage.getItem("luna_voice_id")).toBe("Samantha")
    expect(invoke).toHaveBeenCalledWith("voice_set_voice", { id: "Samantha" })
    void container
  })

  it("selecting System default removes luna_voice_id and invokes voice_set_voice with empty id", async () => {
    localStorage.setItem("luna_voice_id", "Samantha")
    const { ctx, invoke } = makeCtx({
      invoke: (cmd) => {
        if (cmd === "voice_status") return { modelPresent: true }
        if (cmd === "voice_list_voices") return [{ id: "Samantha" }]
        return null
      },
    })
    mount(ctx)
    // Wait for the probe to fully settle (not just "an option exists" - a
    // saved-but-unlisted voiceId renders its own placeholder option
    // immediately on mount, before availability resolves, exactly like the
    // vanilla module's reflectSettings() does - so the real signal that the
    // control is interactive is `disabled` flipping false).
    await vi.waitFor(() => {
      const sel = document.getElementById("voice-voice-select") as HTMLSelectElement
      expect(sel.disabled).toBe(false)
      expect(sel.options.length).toBeGreaterThan(1)
    })

    const sel = document.getElementById("voice-voice-select") as HTMLSelectElement
    act(() => {
      sel.value = ""
      sel.dispatchEvent(new Event("change", { bubbles: true }))
    })

    expect(localStorage.getItem("luna_voice_id")).toBeNull()
    expect(invoke).toHaveBeenCalledWith("voice_set_voice", { id: "" })
  })

  // ── 8/9. Silence hang slider ─────────────────────────────────────────────
  // Live-drag-vs-commit semantics are exhaustively covered as pure reducer
  // transitions below ("voiceReduce silence hang"); this is the one
  // mounted, end-to-end check that a real keyboard commit reaches
  // localStorage + ctx.invoke.

  it("committing a silence-hang change (keyboard step) writes localStorage and invokes voice_set_config", async () => {
    const { ctx, invoke } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: true } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("ready"))

    const thumb = silenceThumb(container)
    act(() => {
      thumb.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    })

    expect(localStorage.getItem("luna_voice_silence_hang_ms")).toBe("650")
    expect(invoke).toHaveBeenCalledWith("voice_set_config", { silenceHangMs: 650 })
    expect(thumb.getAttribute("aria-valuenow")).toBe("650")
  })

  // ── 10. voice_status unavailable -> notice shown, controls disabled ─────

  it("shows unavailable notice and disables controls when voice_status rejects", async () => {
    const { ctx } = makeCtx({
      invoke: (cmd) => (cmd === "voice_status" ? new Error("command not found") : null),
    })
    const container = mount(ctx)

    await vi.waitFor(() => expect(unavailableNote().hidden).toBe(false))

    expect(findButtonByText(container, "Off").disabled).toBe(true)
    expect(findButtonByText(container, "Push-to-talk").disabled).toBe(true)
    expect(findButtonByText(container, "Hands-free").disabled).toBe(true)
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true)
    expect((document.getElementById("voice-voice-select") as HTMLSelectElement).disabled).toBe(true)
  })

  it("keeps the unavailable notice hidden while the probe is still in flight", () => {
    const { ctx } = makeCtx({ invoke: () => new Promise(() => {}) as never })
    mount(ctx)
    expect(unavailableNote().hidden).toBe(true)
  })

  // ── 11/12. Model present vs missing ──────────────────────────────────────

  it("hides Download button when model is already present", async () => {
    const { ctx } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: true } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("ready"))

    expect(container.querySelector("#voice-model-download")).toBeNull()
  })

  it("shows Download button and missing text when model is absent", async () => {
    const { ctx } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: false } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("not downloaded"))

    expect(findButtonByText(container, "Download")).toBeTruthy()
  })

  // ── 13/14. Download button path ──────────────────────────────────────────

  it("Download button invokes voice_ensure_model and marks model ready on success", async () => {
    const { ctx, invoke } = makeCtx({
      invoke: (cmd) => {
        if (cmd === "voice_status") return { modelPresent: false }
        if (cmd === "voice_ensure_model") return null
        return null
      },
    })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("not downloaded"))

    await act(async () => {
      findButtonByText(container, "Download").click()
    })

    await vi.waitFor(() => expect(modeStatus()).toContain("ready"))
    expect(invoke).toHaveBeenCalledWith("voice_ensure_model")
    expect(container.querySelector("#voice-model-download")).toBeNull()
  })

  it("Download failure restores the Download button and shows error text", async () => {
    const { ctx } = makeCtx({
      invoke: (cmd) => {
        if (cmd === "voice_status") return { modelPresent: false }
        if (cmd === "voice_ensure_model") return new Error("disk full")
        return null
      },
    })
    const container = mount(ctx)
    await vi.waitFor(() => expect(modeStatus()).toContain("not downloaded"))

    await act(async () => {
      findButtonByText(container, "Download").click()
    })

    await vi.waitFor(() => expect(modeStatus()).toContain("failed"))
    expect(findButtonByText(container, "Download")).toBeTruthy()
    expect(container.querySelector("#voice-model-progress")).toBeNull()
  })

  // ── 15/16/17. voice-model-progress events ───────────────────────────────

  it("voice-model-progress event updates the progress bar and status text", async () => {
    const { ctx, fireWinEvent } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: false } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(findButtonByText(container, "Download")).toBeTruthy())

    act(() => {
      findButtonByText(container, "Download").click()
    })
    await vi.waitFor(() => expect(container.querySelector("#voice-model-progress")).toBeTruthy())

    act(() => {
      fireWinEvent("voice-model-progress", { downloadedBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024 })
    })

    await vi.waitFor(() => expect(modeStatus()).toContain("Downloading"))
    expect(modeStatus()).toContain("50.0")
    expect(modeStatus()).toContain("200.0")
  })

  it("voice-model-progress { done: true } marks the model ready", async () => {
    const { ctx, fireWinEvent } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: false } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(findButtonByText(container, "Download")).toBeTruthy())

    act(() => {
      fireWinEvent("voice-model-progress", { done: true })
    })

    await vi.waitFor(() => expect(modeStatus()).toContain("ready"))
    expect(container.querySelector("#voice-model-download")).toBeNull()
  })

  it("voice-model-progress { error } shows the error and restores the Download button", async () => {
    const { ctx, fireWinEvent } = makeCtx({ invoke: (cmd) => (cmd === "voice_status" ? { modelPresent: false } : null) })
    const container = mount(ctx)
    await vi.waitFor(() => expect(findButtonByText(container, "Download")).toBeTruthy())

    act(() => {
      fireWinEvent("voice-model-progress", { error: "network timeout" })
    })

    await vi.waitFor(() => expect(modeStatus()).toContain("network timeout"))
    expect(findButtonByText(container, "Download")).toBeTruthy()
    expect(container.querySelector("#voice-model-progress")).toBeNull()
  })
})

// ── voiceReduce: pure reducer unit tests ────────────────────────────────
//
// Covers the live-drag-vs-commit distinction (#8/#9 from the vanilla suite)
// precisely, independent of Astryx Slider's own pointer/keyboard mechanics.

describe("voiceReduce", () => {
  function state(overrides: Partial<VoiceState> = {}): VoiceState {
    return { ...initialVoiceState, ...overrides }
  }

  it("silence-hang-dragged updates only the live display value, not the committed one", () => {
    const next = voiceReduce(state({ silenceHangMs: 600, silenceHangDisplay: 600 }), {
      type: "silence-hang-dragged",
      value: 900,
    })
    expect(next.silenceHangDisplay).toBe(900)
    expect(next.silenceHangMs).toBe(600)
  })

  it("silence-hang-committed clamps and updates both the committed and display values", () => {
    const next = voiceReduce(state({ silenceHangMs: 600, silenceHangDisplay: 900 }), {
      type: "silence-hang-committed",
      value: 5000,
    })
    expect(next.silenceHangMs).toBe(1200)
    expect(next.silenceHangDisplay).toBe(1200)
  })

  it("clampSilenceHang clamps to [300, 1200] and falls back to 600 on NaN", () => {
    expect(clampSilenceHang(100)).toBe(300)
    expect(clampSilenceHang(5000)).toBe(1200)
    expect(clampSilenceHang(750)).toBe(750)
    expect(clampSilenceHang(Number.NaN)).toBe(600)
  })

  it("availability-resolved(false) marks the probe done and sets the unavailable status text", () => {
    const next = voiceReduce(state(), { type: "availability-resolved", available: false })
    expect(next.available).toBe(false)
    expect(next.probeDone).toBe(true)
    expect(next.modelStatusText).toBe("Unavailable in this build")
  })

  it("model-status-applied(true) marks the model ready and clears progress", () => {
    const next = voiceReduce(state({ modelProgress: { downloadedBytes: 1, totalBytes: 2 } }), {
      type: "model-status-applied",
      present: true,
    })
    expect(next.modelStatus).toBe("ready")
    expect(next.modelProgress).toBeNull()
  })

  it("model-download-progress formats MB with one decimal", () => {
    const next = voiceReduce(state(), {
      type: "model-download-progress",
      downloadedBytes: 50 * 1024 * 1024,
      totalBytes: 200 * 1024 * 1024,
    })
    expect(next.modelStatusText).toBe("Downloading… 50.0 / 200.0 MB")
  })

  it("returns the same state reference for an unhandled action (no-op dispatch)", () => {
    const s = state()
    // @ts-expect-error - deliberately exercising the reducer's default branch
    const next = voiceReduce(s, { type: "not-a-real-action" })
    expect(next).toBe(s)
  })
})
