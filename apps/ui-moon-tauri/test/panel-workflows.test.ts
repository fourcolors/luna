// @vitest-environment jsdom
//
// Behavioral tests for the 'workflows' panel module (the Workflows gallery).
// Drives the REAL module through the panel.html inline script via the bootPanel
// harness (verbatim copy of the pattern from panel-briefing.test.ts).
//
// Fixtures use the REAL jobs.last_status vocabulary the server sends —
// "fired" | "errored" | "running" | "scheduled" (see jobs-store-types.ts;
// toGalleryItem passes it through raw) — so the status mapping cannot rot
// against fictional statuses.
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
    outerSize: vi.fn(async () => ({ width: 380, height: 480 })),
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

const rowIds = () =>
  Array.from(document.querySelectorAll('.wfs-row')).map((r) => r.getAttribute('data-job-id'))

const byId = (id: string) => document.querySelector(`.wfs-row[data-job-id="${id}"]`) as HTMLElement

// ── Fixture workflows (REAL backend lastStatus vocabulary) ────────────────
// The clock is pinned to NOW with fake timers so relative-time strings are
// deterministic and assertable.
const NOW = 1_718_000_000_000

const WF_WAITING = {
  id: 'job-wait', label: 'Draft Review', kind: 'agent', source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: NOW - 12 * 60 * 1000, lastStatus: 'waiting', createdAt: NOW,
}
// "errored" is what job-ticker actually writes for a failed job.
const WF_ERRORED = {
  id: 'job-err', label: 'Nightly Report', kind: 'cron', source: null,
  schedule: '0 3 * * *', onDemand: false, enabled: true,
  nextRunAt: NOW + 9 * 3600 * 1000, lastRun: NOW - 4 * 3600 * 1000, lastStatus: 'errored', createdAt: NOW,
}
// "fired" is what job-ticker actually writes for a successful run.
const WF_FIRED = {
  id: 'job-ok', label: 'Morning Summary', kind: 'cron', source: null,
  schedule: '0 8 * * *', onDemand: false, enabled: true,
  nextRunAt: NOW + 24 * 3600 * 1000, lastRun: NOW - 2 * 3600 * 1000, lastStatus: 'fired', createdAt: NOW,
}
// lastRun is deliberately OLDER than WF_FIRED's so the running tier is load-
// bearing in the sort test: demote running from rank 1 and job-run falls
// behind job-ok, turning the order assertion red (mutation-test pin).
const WF_RUNNING = {
  id: 'job-run', label: 'Maintainer Sweep', kind: 'workflow', source: null,
  schedule: '0 9 * * 1', onDemand: false, enabled: true,
  nextRunAt: NOW + 2 * 86400 * 1000, lastRun: NOW - 3 * 3600 * 1000, lastStatus: 'running', createdAt: NOW,
}
// Paused job with a stale FAILURE — must NOT rank as needs-attention.
const WF_PAUSED_ERRORED = {
  id: 'job-paused', label: 'Old Sync', kind: 'cron', source: null,
  schedule: '0 0 * * 0', onDemand: false, enabled: false,
  nextRunAt: null, lastRun: NOW - 30 * 86400 * 1000, lastStatus: 'errored', createdAt: NOW,
}
const WF_NEVER_RAN = {
  id: 'job-new', label: 'Fresh Job', kind: 'oneshot', source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: null, lastStatus: null, createdAt: NOW,
}
// Second never-ran row to pin the label tiebreak (same rank, same lastRun).
const WF_NEVER_RAN_B = {
  id: 'job-new-b', label: 'Alpha Job', kind: 'oneshot', source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: null, lastStatus: null, createdAt: NOW,
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
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

// Boot + hello{workflows:true} in one step — most tests start here.
async function bootEnabled(invoke?: (cmd: string, args?: any) => any) {
  const booted = bootPanel({ type: 'workflows', invoke })
  await flushPromises()
  fireFrame({ type: 'hello', capabilities: { workflows: true } })
  return booted
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('workflows panel', () => {

  it('title is "Workflows", Refresh button present, and empty state shows before any frame', () => {
    bootPanel({ type: 'workflows' })
    expect(document.getElementById('bar-title')!.textContent).toBe('Workflows')
    expect(document.getElementById('wfs-refresh-btn')).toBeTruthy()
    expect(document.querySelector('.wfs-empty')!.textContent).toBe('No workflows yet.')
  })

  it('hello without workflows capability: shows the notice and hides the gallery chrome', async () => {
    bootPanel({ type: 'workflows' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    const notice = document.getElementById('wfs-notice') as HTMLElement
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toBe("This server doesn't expose workflows.")
    expect((document.getElementById('wfs-list') as HTMLElement).hidden).toBe(true)
    expect((document.querySelector('.wfs-header') as HTMLElement).hidden).toBe(true)
  })

  it('the capability gate gates DATA, not just chrome: workflow-list after a denial renders nothing', async () => {
    bootPanel({ type: 'workflows' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] })
    expect(document.querySelectorAll('.wfs-row')).toHaveLength(0)
    expect((document.getElementById('wfs-notice') as HTMLElement).hidden).toBe(false)
  })

  it('workflow-list BEFORE any hello is dropped (unknown capability state)', async () => {
    bootPanel({ type: 'workflows' })
    await flushPromises()
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] })
    expect(document.querySelectorAll('.wfs-row')).toHaveLength(0)
  })

  it('a later hello WITH the capability re-enables the view (toggle, not destroy)', async () => {
    bootPanel({ type: 'workflows' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] })
    expect((document.getElementById('wfs-notice') as HTMLElement).hidden).toBe(true)
    expect(rowIds()).toEqual(['job-ok'])
  })

  it('renders the REAL backend vocabulary: fired → green ok, errored → red failed, running → accent', async () => {
    await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED, WF_ERRORED, WF_RUNNING] })

    expect(byId('job-ok').querySelector('.wfs-dot.success')).toBeTruthy()
    expect(byId('job-ok').querySelector('.wfs-meta')!.textContent).toBe('cron · ok 2h ago · next in 1d')

    expect(byId('job-err').querySelector('.wfs-dot.failed')).toBeTruthy()
    expect(byId('job-err').querySelector('.wfs-meta')!.textContent).toBe('cron · failed 4h ago · next in 9h')

    expect(byId('job-run').querySelector('.wfs-dot.running')).toBeTruthy()
    expect(byId('job-run').querySelector('.wfs-meta')!.textContent).toBe('workflow · running 3h ago · next in 2d')
  })

  it('renders badges: schedule chip, paused, on-demand, and never-ran meta', async () => {
    await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED, WF_PAUSED_ERRORED, WF_NEVER_RAN] })

    expect(document.getElementById('wfs-count')!.textContent).toBe('3')
    expect(byId('job-ok').querySelector('.wfs-badge.scheduled')!.textContent).toBe('0 8 * * *')
    expect(byId('job-paused').querySelector('.wfs-badge.paused')!.textContent).toBe('paused')
    expect(byId('job-new').querySelector('.wfs-badge.on-demand')!.textContent).toBe('on-demand')
    expect(byId('job-new').querySelector('.wfs-meta')!.textContent).toBe('oneshot · never ran')
  })

  it('full sort order: attention (waiting/errored) → running → lastRun desc → nulls last → label tiebreak', async () => {
    await bootEnabled()
    fireFrame({
      type: 'workflow-list',
      workflows: [WF_NEVER_RAN, WF_FIRED, WF_RUNNING, WF_ERRORED, WF_NEVER_RAN_B, WF_WAITING],
    })
    // waiting (12m ago) then errored (4h ago) — rank 0, recency within rank;
    // running — rank 1; fired (2h ago) — rank 2 by lastRun desc;
    // the two never-ran rows share rank 2 + lastRun null → label tiebreak
    // ('Alpha Job' < 'Fresh Job').
    expect(rowIds()).toEqual(['job-wait', 'job-err', 'job-run', 'job-ok', 'job-new-b', 'job-new'])
    expect(document.querySelectorAll('.wfs-row.attention')).toHaveLength(2)
  })

  it('a paused job with a stale failure gets NO attention rank and NO amber styling', async () => {
    await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_PAUSED_ERRORED, WF_ERRORED] })
    // The enabled failed job leads; the paused one sorts with the rest.
    expect(rowIds()).toEqual(['job-err', 'job-paused'])
    expect(byId('job-paused').classList.contains('attention')).toBe(false)
    expect(document.querySelectorAll('.wfs-row.attention')).toHaveLength(1)
  })

  it('a second workflow-list frame fully replaces the rendered rows', async () => {
    await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED, WF_ERRORED] })
    expect(document.querySelectorAll('.wfs-row')).toHaveLength(2)

    fireFrame({ type: 'workflow-list', workflows: [WF_NEVER_RAN] })
    expect(rowIds()).toEqual(['job-new'])
    expect(document.getElementById('wfs-count')!.textContent).toBe('1')
  })

  it('empty workflow-list shows the empty state and clears the count', async () => {
    await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] })
    fireFrame({ type: 'workflow-list', workflows: [] })
    expect(document.querySelectorAll('.wfs-row')).toHaveLength(0)
    expect(document.querySelector('.wfs-empty')).toBeTruthy()
    expect(document.getElementById('wfs-count')!.textContent).toBe('')
  })

  it('bounds untrusted frames: caps rows at 500 with a "+N more" footer and clamps long labels', async () => {
    await bootEnabled()
    const many = Array.from({ length: 502 }, (_, i) => ({
      ...WF_FIRED,
      id: 'job-' + i,
      label: i === 0 ? 'x'.repeat(5000) : 'Job ' + i,
    }))
    fireFrame({ type: 'workflow-list', workflows: many })
    expect(document.querySelectorAll('.wfs-row')).toHaveLength(500)
    expect(document.querySelector('.wfs-more')!.textContent).toBe('+2 more not shown')
    const longName = byId('job-0').querySelector('.wfs-name')!.textContent!
    expect(longName.length).toBe(200)
  })

  it('drops rows without a usable string id (boundary validation, incl. oversized ids)', async () => {
    await bootEnabled()
    fireFrame({
      type: 'workflow-list',
      workflows: [
        { ...WF_FIRED, id: { evil: true } },
        { ...WF_ERRORED, id: '' },
        // An unclamped id would become the display name / aria-label /
        // open_widget param when label is empty — oversized ids are rejected.
        { ...WF_FIRED, id: 'x'.repeat(5000), label: '' },
        WF_NEVER_RAN,
        null,
      ],
    })
    expect(rowIds()).toEqual(['job-new'])
  })

  it('coerces non-numeric timestamps: a date-string lastRun never renders "NaN"', async () => {
    await bootEnabled()
    fireFrame({
      type: 'workflow-list',
      workflows: [{ ...WF_FIRED, lastRun: '2020-01-01' as any }],
    })
    const meta = byId('job-ok').querySelector('.wfs-meta')!.textContent!
    expect(meta).not.toContain('NaN')
    expect(meta).toBe('cron · ok · next in 1d')
  })

  it('a re-enable transition re-pulls the catalog (list dropped while gated is not lost)', async () => {
    bootPanel({ type: 'workflows' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] }) // dropped while gated
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    expect(lastSent()).toEqual({ type: 'workflow-refresh' })
  })

  it('socket close flips the header to "disconnected" and reopen clears it (onClose/onOpen wiring)', async () => {
    await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] })
    const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    const count = document.getElementById('wfs-count') as HTMLElement
    sock.fire('close', { code: 1006 })
    expect(count.textContent).toBe('disconnected')
    expect(count.classList.contains('stale')).toBe(true)
    sock.fire('open')
    expect(count.textContent).toBe('1')
    expect(count.classList.contains('stale')).toBe(false)
  })

  it('socket close while the capability is disabled does NOT paint the stale hint', async () => {
    bootPanel({ type: 'workflows' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    sock.fire('close', { code: 1006 })
    expect(document.getElementById('wfs-count')!.textContent).not.toBe('disconnected')
  })

  it('window focus while the capability is disabled sends nothing (guard on the liveness pull)', async () => {
    bootPanel({ type: 'workflows' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    sock.sent.length = 0
    window.dispatchEvent(new Event('focus'))
    expect(sock.sent).toHaveLength(0)
  })

  it('Refresh click sends a workflow-refresh frame', async () => {
    await bootEnabled()
    ;(document.getElementById('wfs-refresh-btn') as HTMLElement).click()
    expect(lastSent()).toEqual({ type: 'workflow-refresh' })
  })

  it('Refresh on a dead socket is NOT a silent no-op: the header shows "disconnected"', async () => {
    await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] })
    const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]!
    sock.readyState = MockWebSocket.CLOSED
    ;(document.getElementById('wfs-refresh-btn') as HTMLElement).click()
    const count = document.getElementById('wfs-count') as HTMLElement
    expect(count.textContent).toBe('disconnected')
    expect(count.classList.contains('stale')).toBe(true)
    // A fresh workflow-list (reconnect replay) clears the stale hint.
    sock.readyState = MockWebSocket.OPEN
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] })
    expect(count.textContent).toBe('1')
    expect(count.classList.contains('stale')).toBe(false)
  })

  it('window focus re-renders and re-pulls the catalog (pull-model liveness)', async () => {
    await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] })
    window.dispatchEvent(new Event('focus'))
    expect(lastSent()).toEqual({ type: 'workflow-refresh' })
  })

  it.each(['Enter', ' '])('clicking / pressing %j on a row opens the flow panel for that job', async (key) => {
    const { invoke } = await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_ERRORED] })
    const row = byId('job-err')
    if (key === 'Enter' || key === ' ') {
      row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    }
    expect(invoke).toHaveBeenCalledWith('open_widget', {
      kind: 'flow',
      params: { jobId: 'job-err' },
    })
  })

  it('clicking a row opens the flow panel via open_widget', async () => {
    const { invoke } = await bootEnabled()
    fireFrame({ type: 'workflow-list', workflows: [WF_FIRED] })
    byId('job-ok').click()
    expect(invoke).toHaveBeenCalledWith('open_widget', {
      kind: 'flow',
      params: { jobId: 'job-ok' },
    })
  })
})

// ── Registry ↔ module conformance ─────────────────────────────────────────
// A typo in widget-registry.json's `page` (e.g. type=workflow) would ship the
// unknown-panel fallback while every behavioral test stays green — pin the
// contract: every panel.html?type=X entry has a panels/<X with . → ->.js
// module file registering LunaPanelTypes[X].
describe('widget-registry panel conformance', () => {
  const registry = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../frontend/vendor/widget-registry.json'), 'utf8')
  )
  const panelKinds: string[] = registry.widgets
    .map((w: any) => /^panel\.html\?type=([a-z0-9.]+)$/.exec(w.page)?.[1])
    .filter(Boolean)

  it('covers every panel-page registry entry (workflows included)', () => {
    expect(panelKinds).toContain('workflows')
    // Parity: the extraction regex must not silently drop a panel entry it
    // fails to parse (extra query params, unexpected characters) — every
    // panel.html page in the registry must yield a conformance-checked kind.
    const panelPages = registry.widgets.filter((w: any) => String(w.page).startsWith('panel.html'))
    expect(panelKinds).toHaveLength(panelPages.length)
  })

  it.each(panelKinds)('panels/%s module exists and registers its LunaPanelTypes key', (kind) => {
    const file = path.resolve(__dirname, '../frontend/panels', kind.replace(/\./g, '-') + '.js')
    expect(fs.existsSync(file)).toBe(true)
    const sandbox: any = {}
    new Function('globalThis', fs.readFileSync(file, 'utf8'))(sandbox)
    expect(sandbox.LunaPanelTypes?.[kind]).toBeDefined()
    expect(typeof sandbox.LunaPanelTypes[kind].render).toBe('function')
  })
})
