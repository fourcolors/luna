// @vitest-environment jsdom
//
// Behavioral tests for the 'briefing' panel module ("While you were away").
// Drives the REAL module through the panel.html inline script via the bootPanel
// harness (verbatim copy of the pattern from panel-skills.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

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

// ── Harness ───────────────────────────────────────────────────────────────
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/panel.html'), 'utf8')

function bootPanel(opts: {
  type: string
  invoke?: (cmd: string, args?: any) => any
}) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  const invoke = vi.fn(async (cmd: string, args?: any) => {
    if (cmd === 'load_connection') return { wsUrl: 'ws://test-host/ui', wsToken: 'test-tok' }
    return opts.invoke ? opts.invoke(cmd, args) : null
  })
  const me = {
    label: 'panel-' + opts.type.replace(/\./g, '-'),
    listen: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 360, height: 480 })),
    scaleFactor: vi.fn(async () => 1),
  }
  ;(window as any).__TAURI__ = {
    window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
    core: { invoke },
    event: { listen: vi.fn(async () => () => {}) },
  }

  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(opts.type))

  // MockWebSocket must be installed BEFORE vendor files.
  ;(window as any).WebSocket = MockWebSocket

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'moon-dock.js')

  const moduleFile = path.resolve(
    __dirname,
    '../frontend/panels',
    opts.type.replace(/\./g, '-') + '.js'
  )
  if (fs.existsSync(moduleFile)) {
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)
  }

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  const injected = document.head.querySelector('script[src^="panels/"]')
  if (injected) injected.dispatchEvent(new Event('error'))

  return { invoke }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function fireFrame(frame: object) {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  sock.fire('message', { data: JSON.stringify(frame) })
}

function lastSent(): any {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  const raw = sock.sent[sock.sent.length - 1]
  return raw ? JSON.parse(raw) : null
}

// ── Fixture workflows ─────────────────────────────────────────────────────
const NOW = 1_718_000_000_000 // fixed epoch (ms) for relative-time tests

// "Needs attention" — waiting
const WF_WAITING = {
  id: 'job-wait', label: 'Draft Review', kind: 'agent', source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: NOW - 30 * 60 * 1000, lastStatus: 'waiting', createdAt: NOW,
}
// "Needs attention" — failed
const WF_FAILED = {
  id: 'job-fail', label: 'Nightly Report', kind: 'agent', source: null,
  schedule: '0 3 * * *', onDemand: false, enabled: true,
  nextRunAt: NOW + 86400_000, lastRun: NOW - 3 * 3600 * 1000, lastStatus: 'failed', createdAt: NOW,
}
// "Ran recently" — success, ran 2h ago
const WF_SUCCESS_2H = {
  id: 'job-ok-2h', label: 'Morning Summary', kind: 'agent', source: null,
  schedule: '0 8 * * *', onDemand: false, enabled: true,
  nextRunAt: NOW + 86400_000, lastRun: NOW - 2 * 3600 * 1000, lastStatus: 'success', createdAt: NOW,
}
// "Ran recently" — cancelled, ran 5h ago (appears after 2h one)
const WF_CANCELLED_5H = {
  id: 'job-cancel', label: 'Sync Files', kind: 'agent', source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: NOW - 5 * 3600 * 1000, lastStatus: 'cancelled', createdAt: NOW,
}
// "Scheduled next" — has a schedule + nextRunAt
const WF_SCHEDULED = {
  id: 'job-sched', label: 'Weekly Digest', kind: 'agent', source: null,
  schedule: '0 9 * * 1', onDemand: false, enabled: true,
  nextRunAt: NOW + 2 * 86400_000, lastRun: null, lastStatus: null, createdAt: NOW,
}

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as any).__TAURI__
  delete (window as any).__PanelInternals
  delete (window as any).LunaPanelTypes
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).LunaDock
  delete (window as any).WebSocket
  MockWebSocket.instances = []
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────

describe('briefing panel', () => {

  it('title is "Briefing" and Refresh button is present on initial render', () => {
    bootPanel({ type: 'briefing' })
    expect(document.getElementById('bar-title')!.textContent).toBe('Briefing')
    const btns = Array.from(document.querySelectorAll('.panel-btn'))
    const refresh = btns.find((b) => b.textContent === 'Refresh')
    expect(refresh).toBeTruthy()
  })

  it('hello without workflows capability: replaces content with capability notice, no sections', async () => {
    bootPanel({ type: 'briefing' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    const notice = document.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toBe("This server doesn't expose workflows.")
    expect(document.querySelectorAll('.bf-section')).toHaveLength(0)
  })

  it('hello with workflows capability: no notice, refresh button visible', async () => {
    bootPanel({ type: 'briefing' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    expect(document.querySelector('.notice')).toBeNull()
    const btns = Array.from(document.querySelectorAll('.panel-btn'))
    expect(btns.find((b) => b.textContent === 'Refresh')).toBeTruthy()
  })

  it('workflow-list: waiting status goes into "Needs attention" section', async () => {
    bootPanel({ type: 'briefing' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_WAITING] })

    const sections = document.querySelectorAll('.bf-section')
    expect(sections.length).toBeGreaterThanOrEqual(1)

    const attnSection = Array.from(sections).find(
      (s) => s.querySelector('.bf-section-label')?.textContent === 'Needs attention'
    )
    expect(attnSection).toBeTruthy()

    const rows = attnSection!.querySelectorAll('.bf-row.attention')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Draft Review')
  })

  it('workflow-list: failed status goes into "Needs attention" section', async () => {
    bootPanel({ type: 'briefing' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_FAILED] })

    const attnSection = Array.from(document.querySelectorAll('.bf-section')).find(
      (s) => s.querySelector('.bf-section-label')?.textContent === 'Needs attention'
    )
    const rows = attnSection!.querySelectorAll('.bf-row.attention')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Nightly Report')
  })

  it('workflow-list: success goes to "Ran recently", cancelled goes to "Ran recently"', async () => {
    bootPanel({ type: 'briefing' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_SUCCESS_2H, WF_CANCELLED_5H] })

    const recentSection = Array.from(document.querySelectorAll('.bf-section')).find(
      (s) => s.querySelector('.bf-section-label')?.textContent === 'Ran recently'
    )
    expect(recentSection).toBeTruthy()
    const rows = recentSection!.querySelectorAll('.bf-row')
    expect(rows).toHaveLength(2)
    // most-recent first: 2h ago before 5h ago
    expect(rows[0].textContent).toContain('Morning Summary')
    expect(rows[1].textContent).toContain('Sync Files')
  })

  it('relative time: lastRun 2h ago renders "2h ago" in "Ran recently" meta', async () => {
    vi.setSystemTime(NOW)
    bootPanel({ type: 'briefing' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_SUCCESS_2H] })

    const recentSection = Array.from(document.querySelectorAll('.bf-section')).find(
      (s) => s.querySelector('.bf-section-label')?.textContent === 'Ran recently'
    )
    const meta = recentSection!.querySelector('.bf-row-meta')
    expect(meta).toBeTruthy()
    expect(meta!.textContent).toContain('2h ago')
  })

  it('workflow-list: scheduled workflow appears in "Scheduled next" section', async () => {
    bootPanel({ type: 'briefing' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_SCHEDULED] })

    const schedSection = Array.from(document.querySelectorAll('.bf-section')).find(
      (s) => s.querySelector('.bf-section-label')?.textContent === 'Scheduled next'
    )
    expect(schedSection).toBeTruthy()
    const rows = schedSection!.querySelectorAll('.bf-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Weekly Digest')
  })

  it('attention row Open button calls ctx.invoke("open_widget", { kind: "flow", params: { jobId } })', async () => {
    const invokeFn = vi.fn(async (cmd: string, _args?: any) => {
      if (cmd === 'load_connection') return { wsUrl: 'ws://test-host/ui', wsToken: 'tok' }
      return null
    })
    bootPanel({ type: 'briefing', invoke: invokeFn })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_WAITING] })

    const openBtn = document.querySelector('.bf-open-btn') as HTMLElement
    expect(openBtn).toBeTruthy()
    openBtn.click()

    // The mock invoke is called via ctx.invoke which is the harness spy.
    // Find the open_widget call specifically.
    const calls = invokeFn.mock.calls
    const openCall = calls.find(([cmd]) => cmd === 'open_widget')
    expect(openCall).toBeTruthy()
    // opener = this briefing panel's own label, so the flow panel docks next to it.
    expect(openCall![1]).toEqual({ kind: 'flow', params: { jobId: 'job-wait' }, opener: 'panel-briefing' })
  })

  it('Refresh button sends { type: "workflow-refresh" } over the WS', async () => {
    bootPanel({ type: 'briefing' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })

    const refreshBtn = Array.from(document.querySelectorAll('.panel-btn')).find(
      (b) => b.textContent === 'Refresh'
    ) as HTMLElement
    expect(refreshBtn).toBeTruthy()
    refreshBtn.click()

    const sent = lastSent()
    expect(sent).toEqual({ type: 'workflow-refresh' })
  })

  it('load_connection is invoked to get WS credentials', () => {
    const { invoke } = bootPanel({ type: 'briefing' })
    expect(invoke).toHaveBeenCalledWith('load_connection')
  })

})
