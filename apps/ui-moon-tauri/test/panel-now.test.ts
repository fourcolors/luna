// @vitest-environment jsdom
//
// Behavioral tests for the 'now' panel module — the live rail of running work
// plus the needs-input answer surface.
//
// Harness is a verbatim copy of panel-skills.test.ts adjusted for type 'now'.
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

function allSent(): any[] {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  return sock.sent.map((s) => JSON.parse(s))
}

// ── Fixture data ──────────────────────────────────────────────────────────
const WF_WAITING = {
  id: 'wf-1', kind: 'job', label: 'Draft Report', source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: 1000, lastStatus: 'waiting', createdAt: 500,
}
const WF_RUNNING = {
  id: 'wf-2', kind: 'job', label: 'Sync Emails', source: null,
  schedule: '0 * * * *', onDemand: false, enabled: true,
  nextRunAt: null, lastRun: 900, lastStatus: 'running', createdAt: 400,
}
const WF_SUCCESS = {
  id: 'wf-3', kind: 'job', label: 'Archive Docs', source: null,
  schedule: '0 0 * * *', onDemand: false, enabled: true,
  nextRunAt: 2000, lastRun: 800, lastStatus: 'success', createdAt: 300,
}
const WF_FAILED = {
  id: 'wf-4', kind: 'job', label: 'Export Data', source: null,
  schedule: null, onDemand: true, enabled: true,
  nextRunAt: null, lastRun: 700, lastStatus: 'failed', createdAt: 200,
}

const INPUT_REQ_1 = {
  type: 'job-input-request',
  requestId: 'req-1',
  runId: 42,
  jobId: 'wf-1',
  jobName: 'Draft Report',
  prompt: 'Which draft should I finalize?',
  timeoutMs: 30000,
}
const INPUT_REQ_2 = {
  type: 'job-input-request',
  requestId: 'req-2',
  runId: 43,
  jobId: 'wf-1',
  jobName: 'Draft Report',
  prompt: 'What tone should I use?',
  timeoutMs: 30000,
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

describe('now panel', () => {
  // 1. Capability gate — no workflows capability → notice replaces content
  it('hello without workflows capability: replaces content with notice', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    const notice = document.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toBe("This server doesn't expose workflows.")
    // Rail and cards containers must be gone
    expect(document.getElementById('now-rail')).toBeNull()
    expect(document.getElementById('now-cards')).toBeNull()
  })

  // 2. Capability gate — workflows capability present → rail remains
  it('hello with workflows capability: rail container stays visible', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    expect(document.getElementById('now-rail')).toBeTruthy()
    expect(document.querySelector('.notice')).toBeNull()
  })

  // 3. workflow-list renders rows
  it('workflow-list: renders a row for each workflow', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_SUCCESS, WF_FAILED] })
    const rows = document.querySelectorAll('.now-wf-row')
    expect(rows).toHaveLength(2)
  })

  // 4. Waiting-first sort
  it('workflow-list: waiting rows appear before running then the rest', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_SUCCESS, WF_RUNNING, WF_WAITING, WF_FAILED] })
    const rows = document.querySelectorAll('.now-wf-row')
    expect(rows).toHaveLength(4)
    // First row: waiting
    expect(rows[0].querySelector('.now-status-dot')!.classList.contains('waiting')).toBe(true)
    // Second row: running
    expect(rows[1].querySelector('.now-status-dot')!.classList.contains('running')).toBe(true)
    // Remaining rows are success/failed (order by recency — WF_SUCCESS lastRun=800 > WF_FAILED lastRun=700)
    expect(rows[2].querySelector('.now-wf-name')!.textContent).toBe('Archive Docs')
    expect(rows[3].querySelector('.now-wf-name')!.textContent).toBe('Export Data')
  })

  // 5. job-input-request renders an answer card
  it('job-input-request: renders an answer card with jobName and prompt', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    const card = document.querySelector('.now-answer-card')
    expect(card).toBeTruthy()
    expect(card!.querySelector('.now-answer-card-job')!.textContent).toBe('Draft Report')
    expect(card!.querySelector('.now-answer-card-prompt')!.textContent).toBe('Which draft should I finalize?')
    expect(card!.querySelector('.now-answer-input')).toBeTruthy()
    expect(card!.querySelector('button[class*="primary"]')).toBeTruthy()
  })

  // 6. Answer flow — exact frame shape, input cleared
  it('answer: sends job-input-result with requestId+answer and clears input', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    const input = document.querySelector('.now-answer-input') as HTMLInputElement
    input.value = 'The second draft please'
    const answerBtn = document.querySelector('.now-answer-card button.panel-btn.primary') as HTMLButtonElement
    answerBtn.click()
    const sent = lastSent()
    expect(sent).toEqual({ type: 'job-input-result', requestId: 'req-1', answer: 'The second draft please' })
    // Input must be wiped
    expect(input.value).toBe('')
  })

  // 7. Empty answer is blocked with a status hint
  it('answer: blocks empty submit and shows hint', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    const input = document.querySelector('.now-answer-input') as HTMLInputElement
    input.value = '   ' // whitespace only
    const answerBtn = document.querySelector('.now-answer-card button.panel-btn.primary') as HTMLButtonElement
    const sentBefore = allSent().length
    answerBtn.click()
    // Nothing should have been sent
    expect(allSent().length).toBe(sentBefore)
    // Hint should be visible
    const hint = document.querySelector('.now-card-hint')
    expect(hint).toBeTruthy()
    expect((hint as HTMLElement).hidden).toBe(false)
    expect(hint!.textContent).toContain('Please type an answer')
  })

  // 8. Dismiss sends job-input-result with cancelled:true
  it('dismiss: sends job-input-result with cancelled:true and removes card', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    const dismissBtn = document.querySelector('.now-answer-card .panel-btn:not(.primary)') as HTMLButtonElement
    dismissBtn.click()
    const sent = lastSent()
    expect(sent).toEqual({ type: 'job-input-result', requestId: 'req-1', cancelled: true })
    // Card should be removed immediately
    expect(document.querySelector('.now-answer-card')).toBeNull()
  })

  // 9. job-input-status ok:true clears card with 'answered ✓'
  it('job-input-status ok:true: shows "answered ✓" then card is cleared', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    // Install fake timers AFTER flushPromises so the load_connection .then() already ran
    vi.useFakeTimers()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    fireFrame({ type: 'job-input-status', requestId: 'req-1', ok: true, message: '' })
    const settled = document.querySelector('.now-card-settled')
    expect(settled).toBeTruthy()
    expect(settled!.textContent).toContain('answered ✓')
    // After 2s the card should vanish
    vi.advanceTimersByTime(2100)
    expect(document.querySelector('.now-answer-card')).toBeNull()
    vi.useRealTimers()
  })

  // 10. job-input-status ok:false (already answered) shows message
  it('job-input-status ok:false: shows server message (e.g. already answered)', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    vi.useFakeTimers()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    fireFrame({ type: 'job-input-status', requestId: 'req-1', ok: false, message: 'already answered' })
    const settled = document.querySelector('.now-card-settled')
    expect(settled).toBeTruthy()
    expect(settled!.textContent).toContain('already answered')
    vi.advanceTimersByTime(2100)
    expect(document.querySelector('.now-answer-card')).toBeNull()
    vi.useRealTimers()
  })

  // 11. Timeout expiry auto-removes the card with 'expired' note
  it('timeout: auto-removes card with "expired" note after timeoutMs', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    vi.useFakeTimers()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ ...INPUT_REQ_1, timeoutMs: 5000 })
    // Card is present
    expect(document.querySelector('.now-answer-card')).toBeTruthy()
    // Advance past timeout
    vi.advanceTimersByTime(5001)
    // Expired note appears
    const timeout = document.querySelector('.now-card-timeout')
    expect(timeout).toBeTruthy()
    expect(timeout!.textContent).toBe('expired')
    // Advance past the 2s cleanup delay
    vi.advanceTimersByTime(2100)
    expect(document.querySelector('.now-answer-card')).toBeNull()
    vi.useRealTimers()
  })

  // 12. Multiple concurrent requests stack (newest on top)
  it('stacking: multiple concurrent requests stack newest-on-top', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    fireFrame(INPUT_REQ_2)
    const cards = document.querySelectorAll('.now-answer-card')
    expect(cards).toHaveLength(2)
    // Newest (req-2) is first child = on top
    expect(cards[0].getAttribute('data-request-id')).toBe('req-2')
    expect(cards[1].getAttribute('data-request-id')).toBe('req-1')
  })

  // 13. Card state survives a workflow-list re-render
  it('card state survives a workflow-list re-render', async () => {
    bootPanel({ type: 'now' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    // Verify card is present
    expect(document.querySelector('.now-answer-card')).toBeTruthy()
    // Re-render via workflow-list
    fireFrame({ type: 'workflow-list', workflows: [WF_SUCCESS] })
    // Card must still be present
    const card = document.querySelector('.now-answer-card')
    expect(card).toBeTruthy()
    expect(card!.getAttribute('data-request-id')).toBe('req-1')
    // Rail is also updated
    expect(document.querySelector('.now-wf-row')).toBeTruthy()
  })

  // 14. load_connection is invoked to obtain WS credentials
  it('load_connection is invoked to get WS credentials', () => {
    const { invoke } = bootPanel({ type: 'now' })
    expect(invoke).toHaveBeenCalledWith('load_connection')
  })
})
