// @vitest-environment jsdom
//
// Behavioral tests for the Notification Center panel
// (frontend-react/src/panels/notifications/). Follows
// panel-briefing.test.tsx's harness (createRoot + act, no testing-library -
// see that file's doc for why): the panel takes its `ctx` as a prop, so a
// fake PanelCtx is the whole seam.
//
// The panel deliberately has NO WebSocket (see NotificationsPanel.tsx's
// module doc): it reads the hub-written localStorage log and live-updates via
// cross-window `storage` events. These tests drive exactly that contract.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { NotificationsPanel, NOTIFICATIONS_PANEL_TITLE } from "../frontend-react/src/panels/notifications/NotificationsPanel"
import {
  isNotificationsPanelType,
  mountNotificationsPanel,
} from "../frontend-react/src/panels/notifications/notifications-mount"
import {
  NOTIFICATION_LOG_KEY,
  readNotificationLog,
  NOTIFICATION_READ_KEY,
  appendNotification,
  readNotificationWatermark,
} from "../frontend-react/src/notifications/log"
import { entryMeta, entryTitle, relativeTime, sourceLabel } from "../frontend-react/src/panels/notifications/model"
import type { PanelCtx } from "../frontend-react/src/panels/panel-ctx"

let host: HTMLDivElement | null = null
let root: Root | null = null

function fakeCtx(invoke = vi.fn(async () => null)): PanelCtx & { invoke: ReturnType<typeof vi.fn> } {
  return { invoke, hasTauri: false, win: null } as unknown as PanelCtx & { invoke: ReturnType<typeof vi.fn> }
}

function render(ctx: PanelCtx): HTMLDivElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(<NotificationsPanel ctx={ctx} />)
  })
  return host
}

function seed(over: Record<string, unknown> = {}): void {
  appendNotification({
    type: "result-delivered",
    threadId: "thr_abc",
    source: "background-job",
    label: "daily-brief",
    preview: "Brief is ready.",
    ts: 1_700_000_000_000,
    ...over,
  })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  if (host) host.remove()
  root = null
  host = null
  localStorage.clear()
  document.body.innerHTML = ""
  delete (window as any).__PanelInternals
  vi.restoreAllMocks()
})

describe("presentation helpers", () => {
  it("formats relative time in the coarse buckets the rows show", () => {
    const now = 1_000_000_000
    expect(relativeTime(now, now)).toBe("just now")
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago")
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago")
    expect(relativeTime(null, now)).toBeNull()
  })

  it("names known sources and passes unknown ones through unchanged", () => {
    expect(sourceLabel("background-job")).toBe("Background job")
    expect(sourceLabel("suggested-action")).toBe("Suggested action")
    expect(sourceLabel("schedule")).toBe("Schedule")
    // A source this build has never heard of must still be visible.
    expect(sourceLabel("some-future-source")).toBe("some-future-source")
    expect(sourceLabel(null)).toBeNull()
  })

  it("titles a row by its label, falling back to source then a generic", () => {
    expect(entryTitle({ label: "nightly-sync", source: "schedule" })).toBe("nightly-sync")
    expect(entryTitle({ label: null, source: "schedule" })).toBe("Schedule")
    expect(entryTitle({ label: null, source: null })).toBe("Luna finished a task")
  })

  it("does not print the source twice when it already took the title slot", () => {
    const now = 1_000_000_000
    expect(entryMeta({ label: "x", source: "schedule", ts: now }, now)).toBe("Schedule · just now")
    expect(entryMeta({ label: null, source: "schedule", ts: now }, now)).toBe("just now")
  })
})

describe("NotificationsPanel", () => {
  it("shows an empty state when nothing has been delivered", () => {
    const el = render(fakeCtx())
    expect(el.querySelectorAll(".nt-row")).toHaveLength(0)
    expect(el.textContent).toContain("Nothing yet")
  })

  it("renders delivered results newest-first with title, preview and meta", () => {
    seed({ ts: 1000, label: "first-job", preview: "one" })
    seed({ ts: 2000, label: "second-job", preview: "two" })
    const el = render(fakeCtx())

    const rows = el.querySelectorAll(".nt-row")
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector(".nt-row-title")!.textContent).toBe("second-job")
    expect(rows[0].querySelector(".nt-row-preview")!.textContent).toBe("two")
    expect(rows[1].querySelector(".nt-row-title")!.textContent).toBe("first-job")
    expect(rows[0].querySelector(".nt-row-meta")!.textContent).toContain("Background job")
  })

  it("marks rows unread against the watermark as it stood at mount", () => {
    seed({ ts: 1000, preview: "old" })
    localStorage.setItem(NOTIFICATION_READ_KEY, "1500")
    seed({ ts: 2000, preview: "new" })

    const el = render(fakeCtx())
    const rows = el.querySelectorAll(".nt-row")
    expect(rows[0].className).toContain("unread") // ts 2000 > watermark 1500
    expect(rows[1].className).not.toContain("unread") // ts 1000 <= 1500
  })

  it("advances the stored watermark on mount so the orb pip clears", () => {
    seed({ ts: 4242 })
    expect(readNotificationWatermark()).toBe(0)
    render(fakeCtx())
    expect(readNotificationWatermark()).toBe(4242)
  })

  it("keeps the unread highlight visible even though the badge was cleared", () => {
    // Regression guard for the obvious wrong implementation: advancing the
    // watermark and then deriving the highlight from it would render every
    // row as already-read the instant the panel opened, so the user could
    // never tell WHICH results were new.
    seed({ ts: 4242 })
    const el = render(fakeCtx())
    expect(readNotificationWatermark()).toBe(4242)
    expect(el.querySelector(".nt-row")!.className).toContain("unread")
  })

  it("opens the delivering thread's chat window when Open is clicked", () => {
    seed({ threadId: "thr_target" })
    const ctx = fakeCtx()
    const el = render(ctx)

    const btn = el.querySelector(".nt-open-btn") as HTMLButtonElement
    expect(btn).not.toBeNull()
    act(() => {
      btn.click()
    })
    expect(ctx.invoke).toHaveBeenCalledWith("open_widget", { kind: "chat", params: { thread: "thr_target" } })
  })

  it("offers no Open button for a delivery with no thread", () => {
    seed({ threadId: "" })
    const el = render(fakeCtx())
    expect(el.querySelectorAll(".nt-row")).toHaveLength(1)
    expect(el.querySelector(".nt-open-btn")).toBeNull()
  })

  it("survives an invoke that rejects (off-Tauri / no such window)", () => {
    seed()
    const ctx = fakeCtx(vi.fn(async () => Promise.reject(new Error("no tauri"))))
    const el = render(ctx)
    expect(() => (el.querySelector(".nt-open-btn") as HTMLButtonElement).click()).not.toThrow()
  })

  it("live-updates when the hub window appends to the log", () => {
    const el = render(fakeCtx())
    expect(el.querySelectorAll(".nt-row")).toHaveLength(0)

    // The hub writes, then this window is told about it - exactly the
    // cross-window path, since a window never gets its own storage event.
    seed({ ts: 5000, preview: "arrived while open" })
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATION_LOG_KEY }))
    })

    const rows = el.querySelectorAll(".nt-row")
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector(".nt-row-preview")!.textContent).toBe("arrived while open")
  })

  it("ignores storage events for unrelated keys", () => {
    const el = render(fakeCtx())
    seed({ preview: "should not appear yet" })
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "luna_always_on_top" }))
    })
    expect(el.querySelectorAll(".nt-row")).toHaveLength(0)
  })

  it("stops listening once unmounted", () => {
    const el = render(fakeCtx())
    act(() => root!.unmount())
    root = null
    seed()
    expect(() =>
      window.dispatchEvent(new StorageEvent("storage", { key: NOTIFICATION_LOG_KEY })),
    ).not.toThrow()
    expect(el.querySelectorAll(".nt-row")).toHaveLength(0)
  })

  it("Clear empties the list without writing the hub's log key", () => {
    seed({ ts: 1000 })
    seed({ ts: 2000, preview: "b" })
    const el = render(fakeCtx())
    expect(el.querySelectorAll(".nt-row")).toHaveLength(2)

    const clear = el.querySelector(".nt-clear-btn") as HTMLButtonElement
    act(() => clear.click())

    expect(el.querySelectorAll(".nt-row")).toHaveLength(0)
    // The panel is NOT the log key's writer - clearing raises its own
    // watermark instead, so the hub's concurrent append cannot resurrect rows.
    const stored = JSON.parse(localStorage.getItem(NOTIFICATION_LOG_KEY) ?? "[]")
    expect(stored).toHaveLength(2)
    expect(readNotificationLog()).toEqual([])
  })

  it("keeps its rows when storage refuses the clear", () => {
    seed({ ts: 1000 })
    const el = render(fakeCtx())
    expect(el.querySelectorAll(".nt-row")).toHaveLength(1)

    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error("quota")
    }
    try {
      const clear = el.querySelector(".nt-clear-btn") as HTMLButtonElement
      act(() => clear.click())
    } finally {
      Storage.prototype.setItem = setItem
    }
    // Rendering an empty list over a log that is still full is the one lie
    // this panel must not tell.
    expect(el.querySelectorAll(".nt-row")).toHaveLength(1)
  })

  it("renders server-supplied text as text, never as markup", () => {
    seed({ label: "<img src=x onerror=alert(1)>", preview: "<script>bad()</script>" })
    const el = render(fakeCtx())
    expect(el.querySelector("img")).toBeNull()
    expect(el.querySelector("script")).toBeNull()
    expect(el.querySelector(".nt-row-title")!.textContent).toBe("<img src=x onerror=alert(1)>")
  })
})

describe("notifications-mount", () => {
  it("claims only the 'notifications' panel type", () => {
    expect(isNotificationsPanelType("notifications")).toBe(true)
    expect(isNotificationsPanelType("briefing")).toBe(false)
  })

  it("owns the same title/__PanelInternals contract every other panel does", () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    act(() => {
      mountNotificationsPanel("notifications", fakeCtx())
    })
    expect(document.getElementById("bar-title")!.textContent).toBe(NOTIFICATIONS_PANEL_TITLE)
    expect(document.title).toBe(`Luna - ${NOTIFICATIONS_PANEL_TITLE}`)
    expect((window as any).__PanelInternals).toMatchObject({ type: "notifications", hasModule: true })
  })
})
