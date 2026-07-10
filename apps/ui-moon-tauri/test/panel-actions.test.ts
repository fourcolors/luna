// @vitest-environment jsdom
//
// Behavioral tests for the 'actions' panel module — the Suggested Actions panel.
//
// Harness is a verbatim copy of panel-agents.test.ts adjusted for type 'actions'.
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
  thread?: string
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

  // Set URL params: type + optional thread
  let urlParams = '/panel.html?type=' + encodeURIComponent(opts.type)
  if (opts.thread !== undefined) {
    urlParams += '&thread=' + encodeURIComponent(opts.thread)
  }
  window.history.replaceState({}, '', urlParams)

  // MockWebSocket must be installed BEFORE vendor files so LunaWS.createClient
  // captures the mock constructor via the closure over globalThis.WebSocket.
  ;(window as any).WebSocket = MockWebSocket

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'moon-dock.js')

  // Preload the panel module (jsdom never fetches the <script src> the
  // loader injects; the loader sees it already registered and boots directly).
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

  // Fire error for any dynamically injected <script src> (unknown types).
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
const ACTION_PROPOSED: any = {
  id: 'act-1',
  threadId: 't1',
  actionType: 'task',
  title: 'Write a test suite',
  rationale: 'Coverage is low',
  status: 'proposed',
  source: 'agent',
  createdAt: 1000,
}

const ACTION_COMPLETED: any = {
  id: 'act-2',
  threadId: 't1',
  actionType: 'research',
  title: 'Research best practices',
  rationale: null,
  status: 'completed',
  source: 'dream',
  createdAt: 900,
}

const ACTION_FAILED: any = {
  id: 'act-3',
  threadId: 't1',
  actionType: 'create_skill',
  title: 'Create a new skill',
  rationale: 'Would save time',
  status: 'failed',
  source: 'agent',
  createdAt: 800,
}

const HELLO_WITH_SUGGESTED_ACTIONS = {
  type: 'hello',
  protocolVersion: 2,
  kinds: [],
  capabilities: {
    chat: true,
    streamingDeltas: true,
    localShell: false,
    setup: false,
    turnComplete: true,
    suggestedActions: true,
  },
}

const HELLO_WITHOUT_SUGGESTED_ACTIONS = {
  type: 'hello',
  protocolVersion: 2,
  kinds: [],
  capabilities: {
    chat: true,
    streamingDeltas: true,
    localShell: false,
    setup: false,
    turnComplete: true,
  },
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

describe('actions panel', () => {
  // 1. No thread param → notice, no WS opened
  it('no thread param: shows "No conversation selected." notice, no WS request', async () => {
    bootPanel({ type: 'actions' })
    await flushPromises()

    const notice = document.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('No conversation selected.')

    expect(MockWebSocket.instances).toHaveLength(0)
  })

  // 2. Capability gate — absent → notice
  it('hello without suggestedActions capability: shows notice', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITHOUT_SUGGESTED_ACTIONS)

    const notice = document.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain("doesn't support suggested actions")
  })

  // 3. Capability gate — present → no notice, list container remains
  it('hello with suggestedActions capability: list container stays, no notice', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)

    expect(document.querySelector('.notice')).toBeNull()
    expect(document.querySelector('.actions-list')).toBeTruthy()
  })

  // 4. suggested-action-set renders rows for each action
  it('suggested-action-set: renders a row for each action', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED, ACTION_FAILED],
    })

    const rows = document.querySelectorAll('.action-row')
    expect(rows).toHaveLength(3)
  })

  // 5. Status badges render correct class and text
  it('rows carry correct status badge class and text', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED],
    })

    const badges = document.querySelectorAll('.action-status-badge')
    expect(badges).toHaveLength(2)
    expect(badges[0].classList.contains('proposed')).toBe(true)
    expect(badges[0].textContent).toContain('proposed')
    expect(badges[1].classList.contains('completed')).toBe(true)
    expect(badges[1].textContent).toContain('completed')
  })

  // 6. Accept/Dismiss buttons only for proposed actions
  it('Accept and Dismiss buttons appear only for proposed actions', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED],
    })

    const acceptBtns = document.querySelectorAll('.action-btn.accept')
    const dismissBtns = document.querySelectorAll('.action-btn.dismiss')
    // Only the proposed action gets buttons
    expect(acceptBtns).toHaveLength(1)
    expect(dismissBtns).toHaveLength(1)
  })

  // 7. Clicking Accept sends suggested-action-respond with decision 'accept'
  it('Accept click: sends suggested-action-respond with decision accept', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED],
    })

    const acceptBtn = document.querySelector('.action-btn.accept') as HTMLButtonElement
    expect(acceptBtn).toBeTruthy()
    acceptBtn.click()

    const sent = lastSent()
    expect(sent).toEqual({
      type: 'suggested-action-respond',
      threadId: 't1',
      actionId: 'act-1',
      decision: 'accept',
    })
  })

  // 8. Clicking Dismiss sends suggested-action-respond with decision 'dismiss'
  it('Dismiss click: sends suggested-action-respond with decision dismiss', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED],
    })

    const dismissBtn = document.querySelector('.action-btn.dismiss') as HTMLButtonElement
    expect(dismissBtn).toBeTruthy()
    dismissBtn.click()

    const sent = lastSent()
    expect(sent).toEqual({
      type: 'suggested-action-respond',
      threadId: 't1',
      actionId: 'act-1',
      decision: 'dismiss',
    })
  })

  // 9. Optimistic flip on Accept: row status badge changes to 'accepted'
  it('Accept click: optimistically flips status badge to accepted, hides buttons', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED],
    })

    const acceptBtn = document.querySelector('.action-btn.accept') as HTMLButtonElement
    acceptBtn.click()

    // After optimistic flip, no more action buttons for this row
    expect(document.querySelectorAll('.action-btn.accept')).toHaveLength(0)
    expect(document.querySelectorAll('.action-btn.dismiss')).toHaveLength(0)
    // Badge now shows accepted
    const badge = document.querySelector('.action-status-badge')
    expect(badge!.classList.contains('accepted')).toBe(true)
  })

  // 10. suggested-action-set for a different threadId is ignored
  it('suggested-action-set for different threadId: ignored', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)

    // First set for t1
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED],
    })
    const rowsBefore = document.querySelectorAll('.action-row').length
    expect(rowsBefore).toBe(1)

    // Now fire for t2
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't2',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED, ACTION_FAILED],
    })

    // Should still show t1's 1 row
    expect(document.querySelectorAll('.action-row').length).toBe(1)
  })

  // 11. suggested-action-update upserts an existing action
  it('suggested-action-update: upserts status of an existing action', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED],
    })

    // Confirm proposed initially
    expect(document.querySelector('.action-status-badge.proposed')).toBeTruthy()

    // Server sends an update changing status to in_progress
    fireFrame({
      type: 'suggested-action-update',
      threadId: 't1',
      action: { id: 'act-1', threadId: 't1', status: 'in_progress' },
    })

    const badge = document.querySelector('.action-status-badge')
    expect(badge!.classList.contains('in_progress')).toBe(true)
    // No action buttons for in_progress
    expect(document.querySelectorAll('.action-btn.accept')).toHaveLength(0)
  })

  // 12. suggested-action-update for different threadId: ignored
  it('suggested-action-update for different threadId: ignored', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED],
    })

    // Update targets t2 — should be ignored
    fireFrame({
      type: 'suggested-action-update',
      threadId: 't2',
      action: { id: 'act-1', threadId: 't2', status: 'dismissed' },
    })

    // t1's action is still proposed
    expect(document.querySelector('.action-status-badge.proposed')).toBeTruthy()
  })

  // 13. Rationale appears when present
  it('renders rationale when present', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED],
    })

    const rationaleEl = document.querySelector('.action-row-rationale')
    expect(rationaleEl).toBeTruthy()
    expect(rationaleEl!.textContent).toBe('Coverage is low')
  })

  // 14. Action without rationale: no rationale element rendered
  it('does not render rationale element when absent', async () => {
    const noRationale = Object.assign({}, ACTION_COMPLETED, { rationale: null })
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [noRationale],
    })

    expect(document.querySelector('.action-row-rationale')).toBeNull()
  })

  // 15. Source blot data-source attribute is set correctly
  it('source blot carries data-source attribute from action', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED],
    })

    const blots = document.querySelectorAll('.action-blot')
    expect(blots.length).toBe(2)
    expect(blots[0].getAttribute('data-source')).toBe('agent')
    expect(blots[1].getAttribute('data-source')).toBe('dream')
  })

  // 16. load_connection is invoked to obtain WS credentials
  it('load_connection is invoked to get WS credentials', () => {
    const { invoke } = bootPanel({ type: 'actions', thread: 't1' })
    expect(invoke).toHaveBeenCalledWith('load_connection')
  })

  // 17. Empty action set renders "no actions" notice
  it('empty action set: renders empty notice', async () => {
    bootPanel({ type: 'actions', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [],
    })

    const notice = document.querySelector('.actions-notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('No suggested actions')
  })
})
