// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Briefing panel
// ("While you were away" workflow digest - frontend/panels/briefing.js ->
// frontend-react/src/panels/briefing/BriefingPanel.tsx + briefing-mount.tsx).
// Ports every behavioral assertion from the deleted vanilla-harness
// test/panel-briefing.test.ts (grouping/sorting, relative-time formatting,
// the hello capability gate, the Open button's open_widget call, and the
// Refresh button's workflow-refresh send) onto the React implementation.
//
// Follows the settings-launcher-panel.test.tsx pattern (createRoot + act,
// no testing-library - see that file's doc for why) rather than the older
// bootPanel-over-frontend/panel.html harness: BriefingPanel receives its
// `ctx` as a prop (see src/panels/panel-ctx.ts), so a fake PanelCtx +
// a tiny in-test LunaWS.createFrameRegistry() stand-in exercise the exact
// same registry.register/dispatch contract panel.html's real connectWs uses,
// without needing to boot the whole vanilla page around it.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it - see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { BriefingPanel, BRIEFING_PANEL_TITLE } from '../frontend-react/src/panels/briefing/BriefingPanel'
import { isBriefingPanelType, mountBriefingPanel } from '../frontend-react/src/panels/briefing-mount'
import type { PanelCtx, LunaFrameRegistry, LunaWsClient } from '../frontend-react/src/panels/panel-ctx'

// ── Mock LunaWS.createFrameRegistry() (vendor/moon-ws.js's real contract) ──
function createMockFrameRegistry(): LunaFrameRegistry & { fire: (frame: any) => boolean } {
  const handlers: Record<string, (frame: any) => void> = {}
  return {
    register(type: string, fn: (frame: any) => void) {
      handlers[type] = fn
      return this
    },
    dispatch(frame: any) {
      if (!frame || typeof frame.type !== 'string') return false
      const fn = handlers[frame.type]
      if (!fn) return false
      fn(frame)
      return true
    },
    fire(frame: any) {
      return this.dispatch(frame)
    },
    has(type: string) {
      return !!handlers[type]
    },
  }
}

// ── ctx + registry harness ──────────────────────────────────────────────────
function makeCtx(invokeImpl?: (cmd: string, args?: any) => any) {
  const invoke = vi.fn(async (cmd: string, args?: any) => (invokeImpl ? invokeImpl(cmd, args) : null))
  const sent: any[] = []
  let activeRegistry: (LunaFrameRegistry & { fire: (frame: any) => boolean }) | null = null
  const client: LunaWsClient = {
    connect: vi.fn(),
    send: (frame: Record<string, unknown>) => {
      sent.push(frame)
      return true
    },
    close: vi.fn(),
    registerCloseHook: vi.fn(),
    socket: () => null,
  }
  const connectWs = vi.fn((registry: LunaFrameRegistry, _opts?: unknown) => {
    activeRegistry = registry as LunaFrameRegistry & { fire: (frame: any) => boolean }
    return client
  })
  const ctx: PanelCtx = { invoke, connectWs }
  return {
    ctx,
    invoke,
    connectWs,
    sent,
    fire: (frame: any) => act(() => {
      if (!activeRegistry) throw new Error('connectWs was never called - no active registry to fire into')
      activeRegistry.fire(frame)
    }),
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderPanel(ctx: PanelCtx) {
  ;(window as any).LunaWS = { createFrameRegistry: createMockFrameRegistry }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<BriefingPanel ctx={ctx} />)
  })
  return container
}

afterEach(() => {
  if (root && container) {
    act(() => {
      root!.unmount()
    })
  }
  if (container) container.remove()
  container = null
  root = null
  delete (window as any).LunaWS
  delete (window as any).__PanelInternals
  vi.restoreAllMocks()
})

// ── Fixture workflows (verbatim from the vanilla suite) ─────────────────────
const NOW = 1_718_000_000_000 // fixed epoch (ms) for relative-time tests

const WF_WAITING = {
  id: 'job-wait', label: 'Draft Review', kind: 'agent', source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: NOW - 30 * 60 * 1000, lastStatus: 'waiting', createdAt: NOW,
}
const WF_FAILED = {
  id: 'job-fail', label: 'Nightly Report', kind: 'agent', source: null,
  schedule: '0 3 * * *', onDemand: false, enabled: true,
  nextRunAt: NOW + 86400_000, lastRun: NOW - 3 * 3600 * 1000, lastStatus: 'failed', createdAt: NOW,
}
const WF_SUCCESS_2H = {
  id: 'job-ok-2h', label: 'Morning Summary', kind: 'agent', source: null,
  schedule: '0 8 * * *', onDemand: false, enabled: true,
  nextRunAt: NOW + 86400_000, lastRun: NOW - 2 * 3600 * 1000, lastStatus: 'success', createdAt: NOW,
}
const WF_CANCELLED_5H = {
  id: 'job-cancel', label: 'Sync Files', kind: 'agent', source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: NOW - 5 * 3600 * 1000, lastStatus: 'cancelled', createdAt: NOW,
}
const WF_SCHEDULED = {
  id: 'job-sched', label: 'Weekly Digest', kind: 'agent', source: null,
  schedule: '0 9 * * 1', onDemand: false, enabled: true,
  nextRunAt: NOW + 2 * 86400_000, lastRun: null, lastStatus: null, createdAt: NOW,
}

function sectionByLabel(root: HTMLElement, label: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll('.bf-section')).find(
    (s) => s.querySelector('.bf-section-label')?.textContent === label,
  ) as HTMLElement | undefined
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('BriefingPanel (React port of panels/briefing.js)', () => {
  it('Refresh button is present on initial render, before any WS frame', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    const refresh = el.querySelector('#bf-refresh-btn')
    expect(refresh).toBeTruthy()
    expect(el.querySelector('.notice')).toBeNull()
  })

  it('connects over ctx.connectWs with autoPong on mount', () => {
    const { ctx, connectWs } = makeCtx()
    renderPanel(ctx)
    expect(connectWs).toHaveBeenCalledTimes(1)
    expect(connectWs.mock.calls[0]![1]).toEqual({ autoPong: true })
  })

  it('hello without workflows capability: replaces content with capability notice, no sections', () => {
    const { ctx, fire } = makeCtx()
    const el = renderPanel(ctx)
    fire({ type: 'hello', capabilities: {} })
    const notice = el.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toBe("This server doesn't expose workflows.")
    expect(el.querySelectorAll('.bf-section')).toHaveLength(0)
  })

  it('hello with workflows capability: no notice, refresh button visible', () => {
    const { ctx, fire } = makeCtx()
    const el = renderPanel(ctx)
    fire({ type: 'hello', capabilities: { workflows: true } })
    expect(el.querySelector('.notice')).toBeNull()
    const refresh = el.querySelector('#bf-refresh-btn')
    expect(refresh).toBeTruthy()
  })

  it('workflow-list: waiting status goes into "Needs attention" section', () => {
    const { ctx, fire } = makeCtx()
    const el = renderPanel(ctx)
    fire({ type: 'hello', capabilities: { workflows: true } })
    fire({ type: 'workflow-list', workflows: [WF_WAITING] })

    const attnSection = sectionByLabel(el, 'Needs attention')
    expect(attnSection).toBeTruthy()
    const rows = attnSection!.querySelectorAll('.bf-row.attention')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('Draft Review')
  })

  it('workflow-list: failed status goes into "Needs attention" section', () => {
    const { ctx, fire } = makeCtx()
    const el = renderPanel(ctx)
    fire({ type: 'hello', capabilities: { workflows: true } })
    fire({ type: 'workflow-list', workflows: [WF_FAILED] })

    const attnSection = sectionByLabel(el, 'Needs attention')
    const rows = attnSection!.querySelectorAll('.bf-row.attention')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('Nightly Report')
  })

  it('workflow-list: success goes to "Ran recently", cancelled goes to "Ran recently", most-recent first', () => {
    const { ctx, fire } = makeCtx()
    const el = renderPanel(ctx)
    fire({ type: 'hello', capabilities: { workflows: true } })
    fire({ type: 'workflow-list', workflows: [WF_SUCCESS_2H, WF_CANCELLED_5H] })

    const recentSection = sectionByLabel(el, 'Ran recently')
    expect(recentSection).toBeTruthy()
    const rows = recentSection!.querySelectorAll('.bf-row')
    expect(rows).toHaveLength(2)
    // most-recent first: 2h ago before 5h ago
    expect(rows[0]!.textContent).toContain('Morning Summary')
    expect(rows[1]!.textContent).toContain('Sync Files')
  })

  it('relative time: lastRun 2h ago renders "2h ago" in "Ran recently" meta', () => {
    vi.setSystemTime(NOW)
    const { ctx, fire } = makeCtx()
    const el = renderPanel(ctx)
    fire({ type: 'hello', capabilities: { workflows: true } })
    fire({ type: 'workflow-list', workflows: [WF_SUCCESS_2H] })

    const recentSection = sectionByLabel(el, 'Ran recently')
    const meta = recentSection!.querySelector('.bf-row-meta')
    expect(meta).toBeTruthy()
    expect(meta!.textContent).toContain('2h ago')
    vi.useRealTimers()
  })

  it('workflow-list: scheduled workflow appears in "Scheduled next" section', () => {
    const { ctx, fire } = makeCtx()
    const el = renderPanel(ctx)
    fire({ type: 'hello', capabilities: { workflows: true } })
    fire({ type: 'workflow-list', workflows: [WF_SCHEDULED] })

    const schedSection = sectionByLabel(el, 'Scheduled next')
    expect(schedSection).toBeTruthy()
    const rows = schedSection!.querySelectorAll('.bf-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.textContent).toContain('Weekly Digest')
  })

  it('attention row Open button calls ctx.invoke("open_widget", { kind: "flow", params: { jobId } })', () => {
    const { ctx, invoke, fire } = makeCtx()
    const el = renderPanel(ctx)
    fire({ type: 'hello', capabilities: { workflows: true } })
    fire({ type: 'workflow-list', workflows: [WF_WAITING] })

    const openBtn = el.querySelector('.bf-open-btn') as HTMLElement
    expect(openBtn).toBeTruthy()
    act(() => {
      openBtn.click()
    })

    const openCall = invoke.mock.calls.find(([cmd]) => cmd === 'open_widget')
    expect(openCall).toBeTruthy()
    expect(openCall![1]).toEqual({ kind: 'flow', params: { jobId: 'job-wait' } })
  })

  it('Refresh button sends { type: "workflow-refresh" } over the WS', () => {
    const { ctx, sent, fire } = makeCtx()
    const el = renderPanel(ctx)
    fire({ type: 'hello', capabilities: { workflows: true } })

    const refreshBtn = el.querySelector('#bf-refresh-btn') as HTMLElement
    expect(refreshBtn).toBeTruthy()
    act(() => {
      refreshBtn.click()
    })

    expect(sent).toContainEqual({ type: 'workflow-refresh' })
  })
})

describe('isBriefingPanelType', () => {
  it('routes the "briefing" panel.html type and nothing else', () => {
    expect(isBriefingPanelType('briefing')).toBe(true)
    expect(isBriefingPanelType('workflows')).toBe(false)
    expect(isBriefingPanelType('flow')).toBe(false)
  })
})

describe('mountBriefingPanel (panel.html contract parity)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__PanelInternals
    delete (window as any).LunaWS
  })

  it('sets the bar title, document title, renders into #content-area, and sets __PanelInternals - matching what panel.html\'s bootModule() sets for vanilla panel types', () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    ;(window as any).LunaWS = { createFrameRegistry: createMockFrameRegistry }
    const { ctx } = makeCtx()
    act(() => {
      mountBriefingPanel('briefing', ctx)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(BRIEFING_PANEL_TITLE)
    expect(document.title).toBe(`Luna - ${BRIEFING_PANEL_TITLE}`)
    expect(document.querySelector('#content-area #bf-refresh-btn')).toBeTruthy()
    expect((window as any).__PanelInternals).toEqual({
      type: 'briefing',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
