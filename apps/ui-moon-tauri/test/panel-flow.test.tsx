// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the 'flow' panel (the
// per-job run inspector, PRD Part C W3): frontend/panels/flow.js ->
// frontend-react/src/panels/FlowPanel.tsx + flow-mount.tsx. Ports every
// behavioral assertion the deleted vanilla suite (test/panel-flow.test.ts)
// pinned against frontend/panel.html + frontend/panels/flow.js onto the
// React implementation, following the same render-directly-with-createRoot
// + real-vendor-WS pattern as test/panel-agents.test.tsx (a WS-backed panel
// with an equivalent hello-gate / per-id-scoped-frame shape): mount the
// component with a fake PanelCtx instead of booting all of panel.html's
// inline vanilla script, but load the REAL frontend/vendor/moon-ws.js +
// moon-protocol.js so frame registry dispatch / autoPong stay honest about
// actual wire behavior instead of a re-described test double.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it - see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { FlowPanel } from '../frontend-react/src/panels/FlowPanel'
import { FLOW_PANEL_TITLE, isFlowPanelType, mountFlowPanel } from '../frontend-react/src/panels/flow-mount'
import type { PanelCtx } from '../frontend-react/src/panels/panel-ctx'

// ── MockWebSocket ─────────────────────────────────────────────────────────
class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  url: string
  readyState = MockWebSocket.OPEN
  sent: string[] = []
  closed = false
  private listeners: Record<string, ((evt: any) => void)[]> = {}
  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  addEventListener(type: string, fn: (evt: any) => void) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
  }
  fire(type: string, evt: any = {}) {
    for (const fn of this.listeners[type] || []) fn(evt)
  }
}

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

function fireFrame(frame: object) {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  act(() => {
    sock.fire('message', { data: JSON.stringify(frame) })
  })
}

function lastSent(): any {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  const raw = sock.sent[sock.sent.length - 1]
  return raw ? JSON.parse(raw) : null
}

function allSent(): any[] {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  return sock.sent.map((s) => JSON.parse(s))
}

// ── Harness ───────────────────────────────────────────────────────────────
let container: HTMLDivElement | null = null
let root: Root | null = null

/**
 * ctx.connectWs here is a deliberately thin stand-in for panel.html's real
 * connectWs (MoonSession route resolution + load_connection + LunaWS client
 * construction - see panel.html): it builds the exact same LunaWS client
 * over the exact same registry contract and connects it straight away,
 * synchronously. That keeps this suite about FlowPanel's OWN behavior
 * (frame handling -> store dispatch -> render), not a second copy of
 * panel.html's connection-bootstrap plumbing (covered elsewhere).
 */
function makeCtx(): PanelCtx {
  return {
    invoke: vi.fn(async () => null),
    hasTauri: false,
    win: null,
    connectWs: (registry, opts) => {
      const client = (window as any).LunaWS.createClient({ registry, ...(opts || {}) })
      client.connect('ws://test-host/ui', 'test-tok')
      return client
    },
  }
}

function bootPanel(jobId: string | null) {
  ;(window as any).WebSocket = MockWebSocket
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')

  const ctx = makeCtx()
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root!.render(<FlowPanel ctx={ctx} jobId={jobId} />)
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
  delete (window as any).WebSocket
  delete (window as any).LunaWS
  delete (window as any).LunaProtocol
  MockWebSocket.instances = []
  vi.restoreAllMocks()
})

// ── Test fixtures ─────────────────────────────────────────────────────────
const JOB_ID = 'job-nightly-digest'

const RUN_SUCCESS: any = {
  id: 1,
  startedAt: Date.now() - 120_000,
  finishedAt: Date.now() - 60_000,
  status: 'success',
  attempt: 1,
  error: null,
}
const RUN_FAILED: any = {
  id: 2,
  startedAt: Date.now() - 300_000,
  finishedAt: Date.now() - 250_000,
  status: 'failed',
  attempt: 2,
  error:
    'Something blew up during execution and the details are very long indeed to test truncation behavior here',
}
const RUN_RUNNING: any = {
  id: 3,
  startedAt: Date.now() - 10_000,
  finishedAt: null,
  status: 'running',
  attempt: 1,
  error: null,
}
const RUN_WAITING: any = {
  id: 4,
  startedAt: Date.now() - 5_000,
  finishedAt: null,
  status: 'waiting',
  attempt: 1,
  error: null,
}

// ── Tests ─────────────────────────────────────────────────────────────────
describe('FlowPanel (React port of panels/flow.js)', () => {
  it('no jobId → shows "No job selected." notice, no WS connection attempt', () => {
    const el = bootPanel(null)
    expect(el.querySelector('.notice')!.textContent).toBe('No job selected.')
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('hello without workflows capability → replaces content with notice', () => {
    const el = bootPanel(JOB_ID)
    fireFrame({ type: 'hello', capabilities: {} })
    expect(el.querySelector('.notice')!.textContent).toBe("This server doesn't expose workflows.")
    expect(el.querySelector('#flow-runs-list')).toBeNull()
  })

  it('hello with workflows capability → sends workflow-runs-request for this jobId', () => {
    bootPanel(JOB_ID)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    const sent = lastSent()
    expect(sent).toEqual({ type: 'workflow-runs-request', jobId: JOB_ID })
  })

  it('workflow-runs frame for this job → renders run rows', () => {
    const el = bootPanel(JOB_ID)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-runs', jobId: JOB_ID, runs: [RUN_SUCCESS, RUN_FAILED] })
    const rows = el.querySelectorAll('.flow-run-row')
    expect(rows).toHaveLength(2)
  })

  it('run rows render correct status classes: success, failed, running, waiting', () => {
    const el = bootPanel(JOB_ID)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({
      type: 'workflow-runs',
      jobId: JOB_ID,
      runs: [RUN_SUCCESS, RUN_FAILED, RUN_RUNNING, RUN_WAITING],
    })
    const statusEls = el.querySelectorAll('.flow-run-status')
    const classes = Array.from(statusEls).map((e) => e.className)
    expect(classes.some((c) => c.includes('success'))).toBe(true)
    expect(classes.some((c) => c.includes('failed'))).toBe(true)
    expect(classes.some((c) => c.includes('running'))).toBe(true)
    expect(classes.some((c) => c.includes('waiting'))).toBe(true)
  })

  it('waiting run dot has amber class (deck needs-input color)', () => {
    const el = bootPanel(JOB_ID)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-runs', jobId: JOB_ID, runs: [RUN_WAITING] })
    const dots = el.querySelectorAll('.flow-run-dot.waiting')
    expect(dots).toHaveLength(1)
    const statusEls = el.querySelectorAll('.flow-run-status.waiting')
    expect(statusEls).toHaveLength(1)
  })

  it('error line is rendered and truncated to 120 chars', () => {
    const el = bootPanel(JOB_ID)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-runs', jobId: JOB_ID, runs: [RUN_FAILED] })
    const errEl = el.querySelector('.flow-run-err') as HTMLElement
    expect(errEl).toBeTruthy()
    expect(errEl.textContent!.length).toBeLessThanOrEqual(120)
    expect(errEl.textContent!.startsWith('Something blew up')).toBe(true)
  })

  it('workflow-runs for a DIFFERENT jobId is ignored', () => {
    const el = bootPanel(JOB_ID)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-runs', jobId: 'other-job', runs: [RUN_SUCCESS, RUN_FAILED] })
    const rows = el.querySelectorAll('.flow-run-row')
    expect(rows).toHaveLength(0)
    expect(el.querySelector('.flow-empty')).toBeTruthy()
  })

  it('Refresh button re-sends workflow-runs-request', () => {
    const el = bootPanel(JOB_ID)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    const btn = el.querySelector('#flow-refresh-btn') as HTMLButtonElement
    expect(btn).toBeTruthy()
    act(() => {
      btn.click()
    })
    const reqs = allSent().filter((f) => f.type === 'workflow-runs-request')
    expect(reqs.length).toBeGreaterThanOrEqual(2)
    reqs.forEach((r) => expect(r.jobId).toBe(JOB_ID))
  })

  it('workflow-list broadcast updates subtitle with job name and schedule chip', () => {
    const el = bootPanel(JOB_ID)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    expect((el.querySelector('#flow-subtitle') as HTMLElement).hidden).toBe(true)

    fireFrame({
      type: 'workflow-list',
      workflows: [
        {
          id: JOB_ID,
          kind: 'scheduled',
          label: 'Nightly Digest',
          source: null,
          schedule: '0 3 * * *',
          onDemand: false,
          enabled: true,
          nextRunAt: null,
          lastRun: null,
          lastStatus: null,
          createdAt: Date.now(),
        },
      ],
    })

    const subtitle = el.querySelector('#flow-subtitle') as HTMLElement
    expect(subtitle.hidden).toBe(false)
    expect(subtitle.textContent).toContain('Nightly Digest')
    const badge = subtitle.querySelector('.flow-badge.scheduled')
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toContain('scheduled')
  })
})

describe('isFlowPanelType', () => {
  it('routes "flow" and nothing else', () => {
    expect(isFlowPanelType('flow')).toBe(true)
    expect(isFlowPanelType('workflows')).toBe(false)
    expect(isFlowPanelType('settings')).toBe(false)
  })
})

describe('mountFlowPanel (panel.html contract parity)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__PanelInternals
    window.history.replaceState({}, '', '/panel.html')
  })

  it('title bar shows "Run history", sets document.title, renders into #content-area, and sets __PanelInternals - matching what panel.html\'s bootModule() sets for vanilla panel types', () => {
    window.history.replaceState({}, '', '/panel.html?type=flow&jobId=' + encodeURIComponent(JOB_ID))
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const ctx = makeCtx()
    act(() => {
      mountFlowPanel('flow', ctx)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(FLOW_PANEL_TITLE)
    expect(document.title).toBe(`Luna - ${FLOW_PANEL_TITLE}`)
    expect(document.querySelector('#content-area .flow-job-id')!.textContent).toBe(JOB_ID)
    expect((window as any).__PanelInternals).toEqual({
      type: 'flow',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })

  it('with no jobId in the URL, mounts the "No job selected." notice into #content-area', () => {
    window.history.replaceState({}, '', '/panel.html?type=flow')
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const ctx = makeCtx()
    act(() => {
      mountFlowPanel('flow', ctx)
    })
    expect(document.querySelector('#content-area .notice')!.textContent).toBe('No job selected.')
  })
})
