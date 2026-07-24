// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Workflows gallery
// panel (frontend/panels/workflows.js -> frontend-react/src/panels/workflows/
// WorkflowsPanel.tsx + workflows-mount.tsx). This file REPLACES the old
// vanilla-harness test of the same name (the DOM-fixture-driven bootPanel
// pattern that loaded frontend/panel.html + frontend/panels/workflows.js —
// that source file is deleted, nothing else imports it, see the module docs
// on WorkflowsPanel.tsx) — every behavioral assertion below is ported 1:1
// from the deleted suite, driving the REAL component instead of the vanilla
// module through panel.html's inline bootstrap.
//
// Fixtures use the REAL jobs.last_status vocabulary the server sends —
// "fired" | "errored" | "running" | "scheduled" (see jobs-store-types.ts;
// toGalleryItem passes it through raw) — so the status mapping cannot rot
// against fictional statuses.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it — see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { WorkflowsPanel } from "../frontend-react/src/panels/workflows/WorkflowsPanel"
import {
  WORKFLOWS_PANEL_TITLE,
  isWorkflowsPanelType,
  mountWorkflowsPanel,
} from "../frontend-react/src/panels/workflows-mount"
import type { LunaFrameRegistry, PanelCtx } from "../frontend-react/src/panels/panel-ctx"

// ── Real LunaWS.createFrameRegistry() — loaded from the actual vendor file so
// dispatch semantics (unmatched frame types silently dropped, last
// registration wins) stay faithful to what panel.html hands every panel. ──
function loadLunaWs(): { createFrameRegistry: () => LunaFrameRegistry } {
  const src = fs.readFileSync(path.resolve(__dirname, "../frontend/vendor/moon-ws.js"), "utf8")
  const sandbox: any = {}
  new Function("globalThis", src)(sandbox)
  return sandbox.LunaWS
}

// ── Fake ctx.connectWs — the seam WorkflowsPanel actually depends on
// (window.__panelCtx.connectWs), mirroring panel.html's real ctx shape one
// level above the WebSocket itself (no MockWebSocket needed — connectWs is
// already synchronous and hands back a client). ──
interface FakeConn {
  ctx: PanelCtx
  invoke: ReturnType<typeof vi.fn>
  fireFrame: (frame: Record<string, unknown>) => void
  openSocket: () => void
  closeSocket: () => void
  setSendOk: (ok: boolean) => void
  sent: Array<Record<string, unknown>>
  closeFn: ReturnType<typeof vi.fn>
}

function makeConn(invokeImpl?: (cmd: string, args?: any) => any): FakeConn {
  let registry: LunaFrameRegistry | null = null
  let opts: { onOpen?: () => void; onClose?: () => void } | undefined
  let sendOk = true
  const sent: Array<Record<string, unknown>> = []
  const closeFn = vi.fn()

  const connectWs = vi.fn((r: LunaFrameRegistry, o?: any) => {
    registry = r
    opts = o
    return {
      connect: vi.fn(),
      send: (frame: Record<string, unknown>) => {
        if (!sendOk) return false
        sent.push(frame)
        return true
      },
      close: closeFn,
      registerCloseHook: vi.fn(),
      socket: () => null,
    }
  })
  const invoke = vi.fn(async (cmd: string, args?: any) => (invokeImpl ? invokeImpl(cmd, args) : null))

  const ctx = { invoke, connectWs, hasTauri: false, win: null } as unknown as PanelCtx

  return {
    ctx,
    invoke,
    fireFrame: (frame) => {
      if (!registry) throw new Error("connectWs was never called — panel did not wire up")
      registry.dispatch(frame)
    },
    openSocket: () => opts?.onOpen?.(),
    closeSocket: () => opts?.onClose?.(),
    setSendOk: (ok) => {
      sendOk = ok
    },
    sent,
    closeFn,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(): FakeConn {
  const conn = makeConn()
  window.__panelCtx = conn.ctx
  window.LunaWS = loadLunaWs()
  container = document.createElement("div")
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<WorkflowsPanel />)
  })
  return conn
}

/** Boot + hello{workflows:true} in one step — most tests start here. */
function mountEnabled(): FakeConn {
  const conn = mount()
  act(() => conn.fireFrame({ type: "hello", capabilities: { workflows: true } }))
  return conn
}

const rowIds = () =>
  Array.from(document.querySelectorAll(".wfs-row")).map((r) => r.getAttribute("data-job-id"))
const byId = (id: string) => document.querySelector(`.wfs-row[data-job-id="${id}"]`) as HTMLElement

// ── Fixture workflows (REAL backend lastStatus vocabulary) ─────────────────
// The clock is pinned to NOW with fake timers so relative-time strings are
// deterministic and assertable.
const NOW = 1_718_000_000_000

const WF_WAITING = {
  id: "job-wait", label: "Draft Review", kind: "agent", source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: NOW - 12 * 60 * 1000, lastStatus: "waiting", createdAt: NOW,
}
const WF_ERRORED = {
  id: "job-err", label: "Nightly Report", kind: "cron", source: null,
  schedule: "0 3 * * *", onDemand: false, enabled: true,
  nextRunAt: NOW + 9 * 3600 * 1000, lastRun: NOW - 4 * 3600 * 1000, lastStatus: "errored", createdAt: NOW,
}
const WF_FIRED = {
  id: "job-ok", label: "Morning Summary", kind: "cron", source: null,
  schedule: "0 8 * * *", onDemand: false, enabled: true,
  nextRunAt: NOW + 24 * 3600 * 1000, lastRun: NOW - 2 * 3600 * 1000, lastStatus: "fired", createdAt: NOW,
}
const WF_RUNNING = {
  id: "job-run", label: "Maintainer Sweep", kind: "workflow", source: null,
  schedule: "0 9 * * 1", onDemand: false, enabled: true,
  nextRunAt: NOW + 2 * 86400 * 1000, lastRun: NOW - 3 * 3600 * 1000, lastStatus: "running", createdAt: NOW,
}
const WF_PAUSED_ERRORED = {
  id: "job-paused", label: "Old Sync", kind: "cron", source: null,
  schedule: "0 0 * * 0", onDemand: false, enabled: false,
  nextRunAt: null, lastRun: NOW - 30 * 86400 * 1000, lastStatus: "errored", createdAt: NOW,
}
const WF_NEVER_RAN = {
  id: "job-new", label: "Fresh Job", kind: "oneshot", source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: null, lastStatus: null, createdAt: NOW,
}
const WF_NEVER_RAN_B = {
  id: "job-new-b", label: "Alpha Job", kind: "oneshot", source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: null, lastStatus: null, createdAt: NOW,
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] })
})

afterEach(() => {
  vi.useRealTimers()
  if (root && container) {
    act(() => root!.unmount())
  }
  if (container) container.remove()
  container = null
  root = null
  delete (window as any).__panelCtx
  delete (window as any).LunaWS
  vi.restoreAllMocks()
})

describe("WorkflowsPanel (React port of panels/workflows.js)", () => {
  it('title is "Workflows", Refresh button present, and empty state shows before any frame', () => {
    mount()
    expect(document.getElementById("wfs-refresh-btn")).toBeTruthy()
    expect(document.querySelector(".wfs-empty")!.textContent).toBe("No workflows yet.")
  })

  it("hello without workflows capability: shows the notice and hides the gallery chrome", () => {
    const conn = mount()
    act(() => conn.fireFrame({ type: "hello", capabilities: {} }))
    const notice = document.getElementById("wfs-notice") as HTMLElement
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toBe("This server doesn't expose workflows.")
    expect((document.getElementById("wfs-list") as HTMLElement).hidden).toBe(true)
    expect((document.querySelector(".wfs-header") as HTMLElement).hidden).toBe(true)
  })

  it("the capability gate gates DATA, not just chrome: workflow-list after a denial renders nothing", () => {
    const conn = mount()
    act(() => conn.fireFrame({ type: "hello", capabilities: {} }))
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] }))
    expect(document.querySelectorAll(".wfs-row")).toHaveLength(0)
    expect((document.getElementById("wfs-notice") as HTMLElement).hidden).toBe(false)
  })

  it("workflow-list BEFORE any hello is dropped (unknown capability state)", () => {
    const conn = mount()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] }))
    expect(document.querySelectorAll(".wfs-row")).toHaveLength(0)
  })

  it("a later hello WITH the capability re-enables the view (toggle, not destroy)", () => {
    const conn = mount()
    act(() => conn.fireFrame({ type: "hello", capabilities: {} }))
    act(() => conn.fireFrame({ type: "hello", capabilities: { workflows: true } }))
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] }))
    expect((document.getElementById("wfs-notice") as HTMLElement).hidden).toBe(true)
    expect(rowIds()).toEqual(["job-ok"])
  })

  it("renders the REAL backend vocabulary: fired → green ok, errored → red failed, running → accent", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED, WF_ERRORED, WF_RUNNING] }))

    expect(byId("job-ok").querySelector(".wfs-dot.success")).toBeTruthy()
    expect(byId("job-ok").querySelector(".wfs-meta")!.textContent).toBe("cron · ok 2h ago · next in 1d")

    expect(byId("job-err").querySelector(".wfs-dot.failed")).toBeTruthy()
    expect(byId("job-err").querySelector(".wfs-meta")!.textContent).toBe("cron · failed 4h ago · next in 9h")

    expect(byId("job-run").querySelector(".wfs-dot.running")).toBeTruthy()
    expect(byId("job-run").querySelector(".wfs-meta")!.textContent).toBe("workflow · running 3h ago · next in 2d")
  })

  it("renders badges: schedule chip, paused, on-demand, and never-ran meta", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED, WF_PAUSED_ERRORED, WF_NEVER_RAN] }))

    expect(document.getElementById("wfs-count")!.textContent).toBe("3")
    expect(byId("job-ok").querySelector(".wfs-badge.scheduled")!.textContent).toBe("0 8 * * *")
    expect(byId("job-paused").querySelector(".wfs-badge.paused")!.textContent).toBe("paused")
    expect(byId("job-new").querySelector(".wfs-badge.on-demand")!.textContent).toBe("on-demand")
    expect(byId("job-new").querySelector(".wfs-meta")!.textContent).toBe("oneshot · never ran")
  })

  it("full sort order: attention (waiting/errored) → running → lastRun desc → nulls last → label tiebreak", () => {
    const conn = mountEnabled()
    act(() =>
      conn.fireFrame({
        type: "workflow-list",
        workflows: [WF_NEVER_RAN, WF_FIRED, WF_RUNNING, WF_ERRORED, WF_NEVER_RAN_B, WF_WAITING],
      }),
    )
    expect(rowIds()).toEqual(["job-wait", "job-err", "job-run", "job-ok", "job-new-b", "job-new"])
    expect(document.querySelectorAll(".wfs-row.attention")).toHaveLength(2)
  })

  it("a paused job with a stale failure gets NO attention rank and NO amber styling", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_PAUSED_ERRORED, WF_ERRORED] }))
    expect(rowIds()).toEqual(["job-err", "job-paused"])
    expect(byId("job-paused").classList.contains("attention")).toBe(false)
    expect(document.querySelectorAll(".wfs-row.attention")).toHaveLength(1)
  })

  it("a second workflow-list frame fully replaces the rendered rows", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED, WF_ERRORED] }))
    expect(document.querySelectorAll(".wfs-row")).toHaveLength(2)

    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_NEVER_RAN] }))
    expect(rowIds()).toEqual(["job-new"])
    expect(document.getElementById("wfs-count")!.textContent).toBe("1")
  })

  it("empty workflow-list shows the empty state and clears the count", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] }))
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [] }))
    expect(document.querySelectorAll(".wfs-row")).toHaveLength(0)
    expect(document.querySelector(".wfs-empty")).toBeTruthy()
    expect(document.getElementById("wfs-count")!.textContent).toBe("")
  })

  it('bounds untrusted frames: caps rows at 500 with a "+N more" footer and clamps long labels', () => {
    const conn = mountEnabled()
    const many = Array.from({ length: 502 }, (_, i) => ({
      ...WF_FIRED,
      id: "job-" + i,
      label: i === 0 ? "x".repeat(5000) : "Job " + i,
    }))
    act(() => conn.fireFrame({ type: "workflow-list", workflows: many }))
    expect(document.querySelectorAll(".wfs-row")).toHaveLength(500)
    expect(document.querySelector(".wfs-more")!.textContent).toBe("+2 more not shown")
    const longName = byId("job-0").querySelector(".wfs-name")!.textContent!
    expect(longName.length).toBe(200)
  })

  it("drops rows without a usable string id (boundary validation, incl. oversized ids)", () => {
    const conn = mountEnabled()
    act(() =>
      conn.fireFrame({
        type: "workflow-list",
        workflows: [
          { ...WF_FIRED, id: { evil: true } },
          { ...WF_ERRORED, id: "" },
          { ...WF_FIRED, id: "x".repeat(5000), label: "" },
          WF_NEVER_RAN,
          null,
        ],
      }),
    )
    expect(rowIds()).toEqual(["job-new"])
  })

  it('coerces non-numeric timestamps: a date-string lastRun never renders "NaN"', () => {
    const conn = mountEnabled()
    act(() =>
      conn.fireFrame({
        type: "workflow-list",
        workflows: [{ ...WF_FIRED, lastRun: "2020-01-01" as any }],
      }),
    )
    const meta = byId("job-ok").querySelector(".wfs-meta")!.textContent!
    expect(meta).not.toContain("NaN")
    expect(meta).toBe("cron · ok · next in 1d")
  })

  it("a re-enable transition re-pulls the catalog (list dropped while gated is not lost)", () => {
    const conn = mount()
    act(() => conn.fireFrame({ type: "hello", capabilities: {} }))
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] })) // dropped while gated
    act(() => conn.fireFrame({ type: "hello", capabilities: { workflows: true } }))
    expect(conn.sent.at(-1)).toEqual({ type: "workflow-refresh" })
  })

  it("socket close flips the header to \"disconnected\" and reopen clears it (onClose/onOpen wiring)", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] }))
    const count = document.getElementById("wfs-count") as HTMLElement
    act(() => conn.closeSocket())
    expect(count.textContent).toBe("disconnected")
    expect(count.classList.contains("stale")).toBe(true)
    act(() => conn.openSocket())
    expect(count.textContent).toBe("1")
    expect(count.classList.contains("stale")).toBe(false)
  })

  it("socket close while the capability is disabled does NOT paint the stale hint", () => {
    const conn = mount()
    act(() => conn.fireFrame({ type: "hello", capabilities: {} }))
    act(() => conn.closeSocket())
    expect(document.getElementById("wfs-count")!.textContent).not.toBe("disconnected")
  })

  it("window focus while the capability is disabled sends nothing (guard on the liveness pull)", () => {
    const conn = mount()
    act(() => conn.fireFrame({ type: "hello", capabilities: {} }))
    conn.sent.length = 0
    act(() => window.dispatchEvent(new Event("focus")))
    expect(conn.sent).toHaveLength(0)
  })

  it("Refresh click sends a workflow-refresh frame", () => {
    const conn = mountEnabled()
    act(() => (document.getElementById("wfs-refresh-btn") as HTMLElement).click())
    expect(conn.sent.at(-1)).toEqual({ type: "workflow-refresh" })
  })

  it('Refresh on a dead socket is NOT a silent no-op: the header shows "disconnected"', () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] }))
    conn.setSendOk(false)
    act(() => (document.getElementById("wfs-refresh-btn") as HTMLElement).click())
    const count = document.getElementById("wfs-count") as HTMLElement
    expect(count.textContent).toBe("disconnected")
    expect(count.classList.contains("stale")).toBe(true)
    // A fresh workflow-list (reconnect replay) clears the stale hint.
    conn.setSendOk(true)
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] }))
    expect(count.textContent).toBe("1")
    expect(count.classList.contains("stale")).toBe(false)
  })

  it("window focus re-renders and re-pulls the catalog (pull-model liveness)", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] }))
    act(() => window.dispatchEvent(new Event("focus")))
    expect(conn.sent.at(-1)).toEqual({ type: "workflow-refresh" })
  })

  it.each(["Enter", " "])("clicking / pressing %j on a row opens the flow panel for that job", (key) => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_ERRORED] }))
    const row = byId("job-err")
    act(() => {
      row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
    })
    expect(conn.invoke).toHaveBeenCalledWith("open_widget", {
      kind: "flow",
      params: { jobId: "job-err" },
    })
  })

  it("clicking a row opens the flow panel via open_widget", () => {
    const conn = mountEnabled()
    act(() => conn.fireFrame({ type: "workflow-list", workflows: [WF_FIRED] }))
    act(() => byId("job-ok").click())
    expect(conn.invoke).toHaveBeenCalledWith("open_widget", {
      kind: "flow",
      params: { jobId: "job-ok" },
    })
  })
})

describe("isWorkflowsPanelType", () => {
  it("routes the 'workflows' panel.html type and nothing else", () => {
    expect(isWorkflowsPanelType("workflows")).toBe(true)
    expect(isWorkflowsPanelType("flow")).toBe(false)
    expect(isWorkflowsPanelType("settings")).toBe(false)
  })
})

describe("mountWorkflowsPanel (panel.html contract parity)", () => {
  afterEach(() => {
    document.body.innerHTML = ""
    delete (window as any).__PanelInternals
  })

  it("sets the bar title, document title, renders into #content-area, and sets __PanelInternals — matching what panel.html's bootModule() sets for vanilla panel types", () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const conn = makeConn()
    window.LunaWS = loadLunaWs()
    act(() => {
      mountWorkflowsPanel("workflows", conn.ctx)
    })

    expect(document.getElementById("bar-title")!.textContent).toBe(WORKFLOWS_PANEL_TITLE)
    expect(document.title).toBe(`Luna — ${WORKFLOWS_PANEL_TITLE}`)
    expect(document.getElementById("wfs-refresh-btn")).toBeTruthy()
    expect((window as any).__PanelInternals).toEqual({
      type: "workflows",
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
