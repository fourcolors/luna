// @vitest-environment jsdom
//
// Behavioral tests for the 'flow' panel module (per-job run inspector).
// Follows the same bootPanel harness pattern as panel-skills.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── MockWebSocket ─────────────────────────────────────────────────────────────
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

// ── Harness ───────────────────────────────────────────────────────────────────
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/panel.html'), 'utf8')

function bootPanel(opts: {
  type: string
  jobId?: string
  invoke?: (cmd: string, args?: any) => any
}) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  const invoke = vi.fn(async (cmd: string, args?: any) => {
    if (cmd === 'load_connection') return { wsUrl: 'ws://test-host/ui', wsToken: 'test-tok' }
    return opts.invoke ? opts.invoke(cmd, args) : null
  })
  const me = {
    label: 'panel-flow',
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

  // Build the URL query — include jobId if provided.
  var search = '?type=' + encodeURIComponent(opts.type)
  if (opts.jobId !== undefined) search += '&jobId=' + encodeURIComponent(opts.jobId)
  window.history.replaceState({}, '', '/panel.html' + search)

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

function sentFrames(): any[] {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  return sock.sent.map((s) => JSON.parse(s))
}

// ── Test fixtures ─────────────────────────────────────────────────────────────
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
  error: 'Something blew up during execution and the details are very long indeed to test truncation behavior here',
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

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('flow panel', () => {
  it('no jobId → shows "No job selected." notice, no WS connection attempt', async () => {
    // Do NOT pass jobId so the URL has no jobId param.
    bootPanel({ type: 'flow' })
    await flushPromises()
    expect(document.querySelector('.notice')!.textContent).toBe('No job selected.')
    // No WebSocket opened because render() returned early.
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('hello without workflows capability → replaces content with notice', async () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    expect(document.querySelector('.notice')!.textContent).toBe(
      "This server doesn't expose workflows."
    )
    expect(document.getElementById('flow-runs-list')).toBeNull()
  })

  it('hello with workflows capability → sends workflow-runs-request for this jobId', async () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    const frames = sentFrames()
    const req = frames.find((f) => f.type === 'workflow-runs-request')
    expect(req).toBeDefined()
    expect(req.jobId).toBe(JOB_ID)
  })

  it('workflow-runs frame for this job → renders run rows', async () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-runs', jobId: JOB_ID, runs: [RUN_SUCCESS, RUN_FAILED] })
    const rows = document.querySelectorAll('.flow-run-row')
    expect(rows).toHaveLength(2)
  })

  it('run rows render correct status classes: success, failed, running, waiting', async () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({
      type: 'workflow-runs',
      jobId: JOB_ID,
      runs: [RUN_SUCCESS, RUN_FAILED, RUN_RUNNING, RUN_WAITING],
    })
    const statusEls = document.querySelectorAll('.flow-run-status')
    const classes = Array.from(statusEls).map((el) => el.className)
    expect(classes.some((c) => c.includes('success'))).toBe(true)
    expect(classes.some((c) => c.includes('failed'))).toBe(true)
    expect(classes.some((c) => c.includes('running'))).toBe(true)
    expect(classes.some((c) => c.includes('waiting'))).toBe(true)
  })

  it('waiting run dot has amber class (deck needs-input color)', async () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-runs', jobId: JOB_ID, runs: [RUN_WAITING] })
    const dots = document.querySelectorAll('.flow-run-dot.waiting')
    expect(dots).toHaveLength(1)
    // The status label also uses waiting class.
    const statusEls = document.querySelectorAll('.flow-run-status.waiting')
    expect(statusEls).toHaveLength(1)
  })

  it('error line is rendered and truncated to 120 chars', async () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-runs', jobId: JOB_ID, runs: [RUN_FAILED] })
    const errEl = document.querySelector('.flow-run-err') as HTMLElement
    expect(errEl).toBeTruthy()
    expect(errEl.textContent!.length).toBeLessThanOrEqual(120)
    // Should start with the original error text
    expect(errEl.textContent!.startsWith('Something blew up')).toBe(true)
  })

  it('workflow-runs for a DIFFERENT jobId is ignored', async () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    // Fire runs for a different job — must not update our list.
    fireFrame({ type: 'workflow-runs', jobId: 'other-job', runs: [RUN_SUCCESS, RUN_FAILED] })
    const rows = document.querySelectorAll('.flow-run-row')
    // No rows — our job's runs list is still empty.
    expect(rows).toHaveLength(0)
    // Empty-state placeholder should be visible.
    expect(document.querySelector('.flow-empty')).toBeTruthy()
  })

  it('Refresh button re-sends workflow-runs-request', async () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    // First request on hello.
    const btn = document.getElementById('flow-refresh-btn') as HTMLButtonElement
    expect(btn).toBeTruthy()
    btn.click()
    const frames = sentFrames()
    const reqs = frames.filter((f) => f.type === 'workflow-runs-request')
    // Should have two: one from hello, one from the refresh click.
    expect(reqs.length).toBeGreaterThanOrEqual(2)
    reqs.forEach((r) => expect(r.jobId).toBe(JOB_ID))
  })

  it('workflow-list broadcast updates subtitle with job name and schedule chip', async () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    expect(document.getElementById('flow-subtitle')!.hidden).toBe(true)

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

    const subtitle = document.getElementById('flow-subtitle')!
    expect(subtitle.hidden).toBe(false)
    expect(subtitle.textContent).toContain('Nightly Digest')
    // scheduled badge
    const badge = subtitle.querySelector('.flow-badge.scheduled')
    expect(badge).toBeTruthy()
    expect(badge!.textContent).toContain('scheduled')
  })

  it('title bar shows "Run history"', () => {
    bootPanel({ type: 'flow', jobId: JOB_ID })
    expect(document.getElementById('bar-title')!.textContent).toBe('Run history')
  })
})
