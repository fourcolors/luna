// @vitest-environment jsdom
//
// Behavioral tests for the settings.updates panel, React 19 + Astryx
// edition. Ported from the vanilla test/panel-updates.test.ts (which drove
// frontend/panels/settings-updates.js through the still-vanilla
// frontend/panel.html via a bootPanel harness - see git history). Both that
// module and that test are deleted as superseded: UpdatesPanel.tsx
// (frontend-react/src/panels/settings-updates/) owns this panel entirely on
// the REAL shipped host (frontend-react/panel.html - see
// src-tauri/tauri.conf.json's frontendDist), and panel.html's own
// host-level suite (test/panel-window.test.tsx) now boots that real host +
// mountReactPanel directly with 'settings.updates' as its representative
// React-owned system-widget, so nothing still depends on the vanilla file
// (grepped the worktree - see UpdatesPanel.tsx's module doc). This file
// mounts the component directly with React's own createRoot + act,
// mirroring test/panel-voice.test.tsx's approach (no @testing-library
// dependency - this workspace doesn't install one).
//
// #bar-title / document.title / window.__PanelInternals are now owned by
// settings-updates-mount.tsx (mirrors settings-voice-mount.tsx), not by the
// panel component itself, so - same as panel-voice.test.tsx - this file
// doesn't re-assert the mount-level title wiring, only the panel's own
// behavior.
//
// Every behavioral assertion the vanilla suite made is preserved:
//   1/2.  initial render: idle pill, Check button, card+progress+Restart hidden
//   3.    exposes state via the store (getState() equivalent - see the
//         updatesReduce describe block for direct reducer coverage)
//   4.    calls update_state once on mount (replay-on-open)
//   5/6/7. update://available -> card + notes (textContent list, capped at 6,
//         safe against HTML injection - React children are never innerHTML)
//   8/9.  auto-advances "available" into the staged download, once per version
//   10/11/12. update://progress -> bytes/percent, null-total, aria-* on the
//         progressbar track
//   13.   update://ready -> Restart + Later shown, Verified shown, 100%
//   14.   Restart invokes apply_update
//   15.   Check invokes check_for_update
//   16.   full idle -> available -> downloading -> ready sequence over the
//         REAL window.__TAURI__.event.listen bus
//   17.   snapshot replay stamps the ready face + current version
//   18.   update://error shows the error line, Check stays available
//   19.   update://none returns to idle
//   20.   degrades without window.__TAURI__ (no update_state call)
import React, { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRoot } from "react-dom/client"
import { UpdatesPanel } from "../frontend-react/src/panels/settings-updates/UpdatesPanel"
import {
  formatMb,
  initialUpdateState,
  notesLines,
  phaseHasCard,
  phaseShowsProgress,
  progressBytesText,
  progressPercent,
  updatesReduce,
  type UpdateState,
} from "../frontend-react/src/panels/settings-updates/updates-store"
import type { PanelCtx } from "../frontend-react/src/panels/panel-ctx"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ── mount harness ────────────────────────────────────────────────────────

type InvokeImpl = (cmd: string, args?: unknown) => unknown

interface MockEnv {
  ctx: PanelCtx
  invoke: ReturnType<typeof vi.fn>
  fireEvent: (name: string, payload: unknown) => void
}

function makeEnv(opts: { invoke?: InvokeImpl; hasTauri?: boolean } = {}): MockEnv {
  const listenHandlers: Record<string, Array<(ev: unknown) => void>> = {}
  const invoke = vi.fn(async (cmd: string, args?: unknown) => {
    if (!opts.invoke) return null
    const result = opts.invoke(cmd, args)
    if (result instanceof Error) throw result
    return result
  })
  const hasTauri = opts.hasTauri ?? true
  if (hasTauri) {
    // A GLOBAL window.__TAURI__.event.listen bus (not a per-window one) -
    // matches the vanilla module's `subscribe()` and UpdatesPanel.tsx's
    // module doc on why this differs from VoicePanel's ctx.win.listen.
    ;(window as any).__TAURI__ = {
      core: { invoke },
      event: {
        listen: vi.fn(async (event: string, handler: (ev: unknown) => void) => {
          ;(listenHandlers[event] ||= []).push(handler)
          return () => {
            const arr = listenHandlers[event]
            const i = arr ? arr.indexOf(handler) : -1
            if (arr && i >= 0) arr.splice(i, 1)
          }
        }),
      },
    }
  } else {
    delete (window as any).__TAURI__
  }
  const ctx: PanelCtx = {
    invoke: invoke as unknown as PanelCtx["invoke"],
    hasTauri,
    win: null,
    label: "panel-settings-updates",
  }
  function fireEvent(name: string, payload: unknown): void {
    for (const h of listenHandlers[name] || []) h({ payload })
  }
  return { ctx, invoke, fireEvent }
}

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = []

function mount(ctx: PanelCtx): HTMLElement {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<UpdatesPanel ctx={ctx} />)
  })
  mounted.push({ root, container })
  return container
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  delete (window as any).__TAURI__
  vi.restoreAllMocks()
})

// ── DOM query helpers ───────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text))
  if (!btn) throw new Error(`no <button> containing "${text}"`)
  return btn
}

function progressTrack(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[role="progressbar"]')
  if (!el) throw new Error("missing progressbar track")
  return el as HTMLElement
}

describe("settings.updates panel — staged narrative", () => {
  // ── 1/2. Initial render ─────────────────────────────────────────────────

  it("starts idle: pill 'Up to date' and Check button present", () => {
    const { ctx } = makeEnv()
    const container = mount(ctx)
    expect($("update-pill")!.textContent).toBe("Up to date")
    expect(findButtonByText(container, "Check for updates")).toBeTruthy()
  })

  it("starts with card + progress hidden and Restart not shown", () => {
    const { ctx } = makeEnv()
    mount(ctx)
    expect(($("update-card") as HTMLElement).hidden).toBe(true)
    expect(($("update-progress") as HTMLElement).hidden).toBe(true)
    expect(($("restart-update-btn") as HTMLElement).hidden).toBe(true)
  })

  // ── 4. Replay-on-open ────────────────────────────────────────────────────

  it("calls update_state once on mount (replay-on-open)", () => {
    const { ctx, invoke } = makeEnv()
    mount(ctx)
    expect(invoke).toHaveBeenCalledWith("update_state")
  })

  // ── 5/6/7. idle -> available ─────────────────────────────────────────────

  it("update://available shows the card with version + notes", () => {
    const { ctx, fireEvent } = makeEnv()
    mount(ctx)
    act(() => {
      fireEvent("update://available", { version: "0.0.33", notes: "First headline\nSecond line\nThird line" })
    })
    expect(($("update-card") as HTMLElement).hidden).toBe(false)
    expect($("update-card-version")!.textContent).toBe("Version 0.0.33")
    expect($("update-pill")!.textContent).toBe("Update found")
    const items = ($("update-notes") as HTMLElement).querySelectorAll("li")
    expect(items.length).toBe(3)
    expect(items[0].textContent).toBe("First headline")
    expect(items[2].textContent).toBe("Third line")
  })

  it("caps the notes list at 6 lines", () => {
    const { ctx, fireEvent } = makeEnv()
    mount(ctx)
    const notes = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")
    act(() => {
      fireEvent("update://available", { version: "1.2.3", notes })
    })
    expect(($("update-notes") as HTMLElement).querySelectorAll("li").length).toBe(6)
  })

  it("renders notes as plain text (no HTML injection from release notes)", () => {
    const { ctx, fireEvent } = makeEnv()
    mount(ctx)
    act(() => {
      fireEvent("update://available", { version: "9.9.9", notes: "<img src=x onerror=alert(1)>" })
    })
    const li = ($("update-notes") as HTMLElement).querySelector("li")!
    expect(li.textContent).toBe("<img src=x onerror=alert(1)>")
    expect(($("update-notes") as HTMLElement).querySelector("img")).toBeNull()
  })

  // ── 8/9. auto-advance into the staged download ──────────────────────────

  it("auto-advances a manually-discovered update into the staged download (no dead-end)", () => {
    const { ctx, invoke, fireEvent } = makeEnv()
    mount(ctx)
    act(() => {
      fireEvent("update://available", { version: "0.0.33", notes: "n" })
    })
    expect(invoke).toHaveBeenCalledWith("start_update_download")
  })

  it("only kicks start_update_download once per version", () => {
    const { ctx, invoke, fireEvent } = makeEnv()
    mount(ctx)
    const kicks = () => invoke.mock.calls.filter((c: any[]) => c[0] === "start_update_download").length
    act(() => fireEvent("update://available", { version: "0.0.33", notes: "n" }))
    act(() => fireEvent("update://available", { version: "0.0.33", notes: "n" }))
    expect(kicks()).toBe(1)
    act(() => fireEvent("update://available", { version: "0.0.34", notes: "n" }))
    expect(kicks()).toBe(2)
  })

  // ── 10/11/12. available -> downloading ───────────────────────────────────

  it("update://progress shows the progress bar with bytes + percent", () => {
    const { ctx, fireEvent } = makeEnv()
    const container = mount(ctx)
    act(() => fireEvent("update://available", { version: "0.0.33", notes: "notes" }))
    act(() => fireEvent("update://progress", { downloaded: 14 * 1024 * 1024, total: 28 * 1024 * 1024 }))
    expect(($("update-progress") as HTMLElement).hidden).toBe(false)
    expect($("update-pill")!.textContent).toBe("Downloading…")
    expect($("update-percent")!.textContent).toBe("50%")
    expect($("update-bytes")!.textContent).toBe("14.0 / 28.0 MB")
    expect(($("update-verified") as HTMLElement).hidden).toBe(true)
    expect(progressTrack(container).getAttribute("aria-valuenow")).toBe("50")
    expect(progressTrack(container).getAttribute("aria-valuetext")).toBe("14.0 / 28.0 MB")
  })

  it("progress with null total shows downloaded MB only (no percent crash)", () => {
    const { ctx, fireEvent } = makeEnv()
    mount(ctx)
    act(() => fireEvent("update://progress", { downloaded: 3 * 1024 * 1024, total: null }))
    expect($("update-bytes")!.textContent).toBe("3.0 MB")
    expect($("update-percent")!.textContent).toBe("0%")
  })

  // ── 13/14. downloading -> ready ───────────────────────────────────────────

  it("update://ready shows Restart + Later, Signature verified, and 100%", () => {
    const { ctx, fireEvent } = makeEnv()
    mount(ctx)
    act(() => fireEvent("update://available", { version: "0.0.33", notes: "notes" }))
    act(() => fireEvent("update://progress", { downloaded: 28 * 1024 * 1024, total: 28 * 1024 * 1024 }))
    act(() => fireEvent("update://ready", { version: "0.0.33", notes: "notes" }))
    expect($("update-pill")!.textContent).toBe("Ready to update")
    expect(($("restart-update-btn") as HTMLElement).hidden).toBe(false)
    expect(($("later-update-btn") as HTMLElement).hidden).toBe(false)
    expect(($("check-update-btn") as HTMLElement).hidden).toBe(true)
    expect(($("update-verified") as HTMLElement).hidden).toBe(false)
    expect($("update-percent")!.textContent).toBe("100%")
  })

  it("Restart to update invokes apply_update", async () => {
    const { ctx, invoke, fireEvent } = makeEnv()
    const container = mount(ctx)
    act(() => fireEvent("update://ready", { version: "0.0.33", notes: "n" }))
    await act(async () => {
      findButtonByText(container, "Restart to update").click()
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("apply_update"))
  })

  it("Check for updates invokes check_for_update", async () => {
    const { ctx, invoke } = makeEnv()
    const container = mount(ctx)
    await act(async () => {
      findButtonByText(container, "Check for updates").click()
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("check_for_update"))
  })

  // ── 16. Full sequence through the REAL event bus (wiring proof) ─────────

  it("drives idle -> available -> downloading -> ready via window.__TAURI__.event.listen", async () => {
    const { ctx, invoke, fireEvent } = makeEnv()
    const container = mount(ctx)
    expect($("update-pill")!.textContent).toBe("Up to date")

    act(() => fireEvent("update://available", { version: "0.0.40", notes: "Shiny new thing" }))
    expect(($("update-card") as HTMLElement).hidden).toBe(false)
    expect($("update-card-version")!.textContent).toBe("Version 0.0.40")

    act(() => fireEvent("update://progress", { downloaded: 7 * 1024 * 1024, total: 28 * 1024 * 1024 }))
    expect($("update-percent")!.textContent).toBe("25%")

    act(() => fireEvent("update://ready", { version: "0.0.40", notes: "Shiny new thing" }))
    expect(($("restart-update-btn") as HTMLElement).hidden).toBe(false)

    await act(async () => {
      findButtonByText(container, "Restart to update").click()
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("apply_update"))
  })

  // ── 17. Snapshot replay ────────────────────────────────────────────────

  it("a replay-on-open snapshot with phase=ready jumps straight to the ready face", async () => {
    const { ctx } = makeEnv({
      invoke: (cmd) =>
        cmd === "update_state"
          ? {
              phase: "ready",
              version: "2.0.0",
              notes: "a\nb",
              downloaded: 28 * 1024 * 1024,
              total: 28 * 1024 * 1024,
              current: "1.9.0",
            }
          : null,
    })
    mount(ctx)
    await vi.waitFor(() => expect($("update-pill")!.textContent).toBe("Ready to update"))
    expect(($("restart-update-btn") as HTMLElement).hidden).toBe(false)
    expect($("update-card-version")!.textContent).toBe("Version 2.0.0")
    expect(($("update-verified") as HTMLElement).hidden).toBe(false)
    // The replay snapshot also stamps the running build version in the header.
    expect($("update-current")!.textContent).toBe("Current version 1.9.0")
  })

  // ── 18. Error path (never red - just a muted line) ────────────────────

  it("update://error shows the error line and keeps Check available", () => {
    const { ctx, fireEvent } = makeEnv()
    const container = mount(ctx)
    act(() => fireEvent("update://error", { message: "network down" }))
    expect(($("update-error") as HTMLElement).hidden).toBe(false)
    expect($("update-error")!.textContent).toBe("network down")
    expect(findButtonByText(container, "Check for updates").hidden).toBe(false)
  })

  // ── 19. update://none ────────────────────────────────────────────────

  it("update://none returns to the up-to-date pill", () => {
    const { ctx, fireEvent } = makeEnv()
    mount(ctx)
    act(() => fireEvent("update://available", { version: "1.0.0", notes: "x" }))
    act(() => fireEvent("update://none", {}))
    expect($("update-pill")!.textContent).toBe("Up to date")
    expect(($("update-card") as HTMLElement).hidden).toBe(true)
  })

  // ── 20. Degrades without Tauri (jsdom) ──────────────────────────────────

  it("renders without window.__TAURI__ and does not call update_state", () => {
    const { ctx, invoke } = makeEnv({ hasTauri: false })
    mount(ctx)
    expect($("update-pill")!.textContent).toBe("Up to date")
    expect(invoke).not.toHaveBeenCalled()
  })

  it("clicking Check off-Tauri just resets to idle, no invoke call", async () => {
    const { ctx, invoke } = makeEnv({ hasTauri: false })
    const container = mount(ctx)
    await act(async () => {
      findButtonByText(container, "Check for updates").click()
    })
    expect($("update-pill")!.textContent).toBe("Up to date")
    expect(invoke).not.toHaveBeenCalled()
  })
})

// ── updatesReduce: pure reducer unit tests ─────────────────────────────
//
// Direct coverage of the fold logic independent of React/DOM - mirrors
// panel-voice.test.tsx's `voiceReduce` describe block.

describe("updatesReduce and view-projection helpers", () => {
  function state(overrides: Partial<UpdateState> = {}): UpdateState {
    return { ...initialUpdateState, ...overrides }
  }

  it("update://checking clears any previous error message", () => {
    const next = updatesReduce(state({ phase: "error", errorMessage: "boom" }), {
      type: "event",
      name: "update://checking",
      payload: {},
    })
    expect(next.phase).toBe("checking")
    expect(next.errorMessage).toBe("")
  })

  it("update://progress ignores a non-finite total (falls back to null)", () => {
    const next = updatesReduce(state(), {
      type: "event",
      name: "update://progress",
      payload: { downloaded: 1024, total: Number.NaN },
    })
    expect(next.total).toBeNull()
    expect(next.downloaded).toBe(1024)
  })

  it("check-found only applies while phase is checking", () => {
    const checking = updatesReduce(state({ phase: "checking" }), {
      type: "check-found",
      version: "1.0.0",
      notes: null,
    })
    expect(checking.phase).toBe("available")
    expect(checking.version).toBe("1.0.0")

    const idle = state({ phase: "idle" })
    const next = updatesReduce(idle, { type: "check-found", version: "1.0.0", notes: null })
    expect(next).toBe(idle) // events already moved past "checking" - no-op
  })

  it("check-empty and check-failed are also gated on phase === 'checking'", () => {
    const idle = state({ phase: "idle" })
    expect(updatesReduce(idle, { type: "check-empty" })).toBe(idle)
    expect(updatesReduce(idle, { type: "check-failed", message: "x" })).toBe(idle)

    const checking = state({ phase: "checking" })
    expect(updatesReduce(checking, { type: "check-empty" }).phase).toBe("idle")
    const failed = updatesReduce(checking, { type: "check-failed", message: "network down" })
    expect(failed.phase).toBe("error")
    expect(failed.errorMessage).toBe("network down")
  })

  it("restart-failed applies regardless of the current phase", () => {
    const next = updatesReduce(state({ phase: "ready" }), { type: "restart-failed", message: "disk full" })
    expect(next.phase).toBe("error")
    expect(next.errorMessage).toBe("disk full")
  })

  it("snapshot only overwrites fields present on the dto ('in' check, not just truthiness)", () => {
    const seeded = state({ version: "1.0.0", notes: "old notes", total: 100 })
    const next = updatesReduce(seeded, { type: "snapshot", dto: { phase: "checking" } })
    expect(next.phase).toBe("checking")
    expect(next.version).toBe("1.0.0") // untouched - "version" not in dto
    expect(next.notes).toBe("old notes")
    expect(next.total).toBe(100)
  })

  it("snapshot clears total to null only when 'total' is present and null", () => {
    const seeded = state({ total: 100 })
    const next = updatesReduce(seeded, { type: "snapshot", dto: { total: null } })
    expect(next.total).toBeNull()
  })

  it("snapshot ignores an unrecognized phase string", () => {
    const seeded = state({ phase: "idle" })
    const next = updatesReduce(seeded, { type: "snapshot", dto: { phase: "not-a-real-phase" } })
    expect(next.phase).toBe("idle")
  })

  it("returns the same state reference for an unhandled action (no-op dispatch)", () => {
    const s = state()
    // @ts-expect-error - deliberately exercising the reducer's default branch
    const next = updatesReduce(s, { type: "not-a-real-action" })
    expect(next).toBe(s)
  })

  it("notesLines trims, drops blanks, and caps at 6", () => {
    expect(notesLines("  a  \n\n b \n")).toEqual(["a", "b"])
    expect(notesLines(null)).toEqual([])
    const many = Array.from({ length: 9 }, (_, i) => `l${i}`).join("\n")
    expect(notesLines(many)).toHaveLength(6)
  })

  it("formatMb formats to one decimal place", () => {
    expect(formatMb(14 * 1024 * 1024)).toBe("14.0")
    expect(formatMb(1.5 * 1024 * 1024)).toBe("1.5")
  })

  it("progressPercent is 100 at ready regardless of downloaded/total", () => {
    expect(progressPercent(state({ phase: "ready", downloaded: 0, total: null }))).toBe(100)
  })

  it("progressPercent is 0 with no known total (not NaN)", () => {
    expect(progressPercent(state({ phase: "downloading", downloaded: 5, total: null }))).toBe(0)
  })

  it("progressBytesText with a known total during ready shows total/total", () => {
    const s = state({ phase: "ready", downloaded: 10, total: 28 * 1024 * 1024 })
    expect(progressBytesText(s)).toBe(`${formatMb(28 * 1024 * 1024)} / ${formatMb(28 * 1024 * 1024)} MB`)
  })

  it("phaseHasCard / phaseShowsProgress classify every phase correctly", () => {
    expect(phaseHasCard("idle")).toBe(false)
    expect(phaseHasCard("available")).toBe(true)
    expect(phaseHasCard("ready")).toBe(true)
    expect(phaseShowsProgress("available")).toBe(false)
    expect(phaseShowsProgress("downloading")).toBe(true)
    expect(phaseShowsProgress("verifying")).toBe(true)
    expect(phaseShowsProgress("ready")).toBe(true)
  })
})
