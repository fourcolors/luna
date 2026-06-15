// @vitest-environment jsdom
//
// Behavioral tests for the agents panel module.
// Drives the REAL module through the REAL panel.html inline script via the
// bootPanel harness (verbatim from panel-skills.test.ts, adjusted for this
// type). MockWebSocket is installed BEFORE vendor files are loaded.
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
  loadVendorInto(window, 'deck-snap.js')
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

// Flush the micro-task queue (one event-loop tick) so async code like
// ctx.connectWs's load_connection .then() has a chance to run before we
// try to fire frames at the MockWebSocket.
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// Convenience: fire a frame at the latest MockWebSocket instance.
function fireFrame(frame: object) {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  sock.fire('message', { data: JSON.stringify(frame) })
}

// Convenience: get the parsed last frame sent by the panel.
function lastSent(): any {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  const raw = sock.sent[sock.sent.length - 1]
  return raw ? JSON.parse(raw) : null
}

// Convenience: get all frames sent by the panel.
function allSent(): any[] {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  return sock.sent.map((s) => JSON.parse(s))
}

// Sample subagent nodes
const NODE_TOP: any = {
  id: 'agent-1',
  parentId: null,
  name: 'Explore',
  description: 'Searching the codebase',
  status: 'running',
  tool: 'Grep',
  toolCount: 2,
}
const NODE_CHILD: any = {
  id: 'agent-2',
  parentId: 'agent-1',
  name: 'Analyze',
  description: 'Analyzing results',
  status: 'done',
  tool: null,
  toolCount: 0,
}

const HELLO_WITH_SUBAGENTS = {
  type: 'hello',
  protocolVersion: 2,
  kinds: [],
  capabilities: {
    chat: true, streamingDeltas: true, localShell: false, setup: false,
    turnComplete: true, subagents: true,
  },
}

const HELLO_WITHOUT_SUBAGENTS = {
  type: 'hello',
  protocolVersion: 2,
  kinds: [],
  capabilities: {
    chat: true, streamingDeltas: true, localShell: false, setup: false,
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
  delete (window as any).LunaDeckSnap
  delete (window as any).LunaDock
  delete (window as any).WebSocket
  MockWebSocket.instances = []
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────────────

describe('agents panel', () => {
  it('no thread param: shows "No conversation selected." notice, no WS request', async () => {
    // Boot WITHOUT a thread param — the URL only has ?type=agents
    bootPanel({ type: 'agents' })
    await flushPromises()

    // Notice is shown
    const notice = document.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('No conversation selected.')

    // No WebSocket was opened (no thread → stops before connectWs)
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('hello without caps.subagents: shows "doesn\'t report subagents" notice', async () => {
    bootPanel({ type: 'agents', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITHOUT_SUBAGENTS)

    const notice = document.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain("doesn't report subagents")
  })

  it('hello with caps.subagents: sends subagent-tree-request for threadId t1', async () => {
    bootPanel({ type: 'agents', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUBAGENTS)

    const sent = lastSent()
    expect(sent).toEqual({ type: 'subagent-tree-request', threadId: 't1' })
  })

  it('SECURITY INVARIANT: the read-only Agents panel NEVER sends a subscribe frame', async () => {
    // Sending `subscribe` would register this window as the thread's
    // secret-entry target (server.ts), stealing the chat window's request_secret
    // routing (the one-window-per-thread rule). The panel must stay read-only:
    // it only ever sends subagent-tree-request (+ pong). A future "fix the empty
    // tree by subscribing" mistake regresses the invariant — this pins it.
    bootPanel({ type: 'agents', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUBAGENTS)
    // Feed a tree too, in case any render path were tempted to subscribe.
    fireFrame({ type: 'subagent-tree', threadId: 't1', agents: [] })
    await flushPromises()
    const types = allSent().map((f) => f.type)
    expect(types).not.toContain('subscribe')
    expect(types.every((t) => t === 'subagent-tree-request' || t === 'pong')).toBe(true)
  })

  it('subagent-tree for t1: renders both nodes, child is nested under parent', async () => {
    bootPanel({ type: 'agents', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUBAGENTS)
    fireFrame({ type: 'subagent-tree', threadId: 't1', agents: [NODE_TOP, NODE_CHILD] })

    const rows = document.querySelectorAll('.agent-row')
    expect(rows.length).toBeGreaterThanOrEqual(2)

    // Parent row shows name and tool activity
    const parentRow = rows[0]
    expect(parentRow.textContent).toContain('Explore')
    expect(parentRow.textContent).toContain('Grep')
    expect(parentRow.textContent).toContain('2 tools')

    // Child node is nested inside .agent-children under the parent's wrap
    const childWrap = document.querySelector('.agent-children')
    expect(childWrap).toBeTruthy()
    const childRow = childWrap!.querySelector('.agent-row')
    expect(childRow).toBeTruthy()
    expect(childRow!.textContent).toContain('Analyze')
    expect(childRow!.textContent).toContain('done')
  })

  it('subagent-tree for different threadId (t2): ignored — t1 render unchanged', async () => {
    bootPanel({ type: 'agents', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUBAGENTS)

    // First render the t1 tree
    fireFrame({ type: 'subagent-tree', threadId: 't1', agents: [NODE_TOP] })
    const rowsBefore = document.querySelectorAll('.agent-row').length
    expect(rowsBefore).toBe(1)

    // Now fire a frame for a different thread
    fireFrame({ type: 'subagent-tree', threadId: 't2', agents: [NODE_TOP, NODE_CHILD] })
    // Should still have the same number of rows from t1
    const rowsAfter = document.querySelectorAll('.agent-row').length
    expect(rowsAfter).toBe(1)
    // Content still matches t1's single top-level node
    expect(document.querySelector('.agent-row')!.textContent).toContain('Explore')
  })

  it('status classes differ: running blot has data-status="running", done has "done", error has "error"', async () => {
    const nodeRunning: any = { id: 'r', parentId: null, name: 'Running', description: '', status: 'running', tool: 'Bash', toolCount: 1 }
    const nodeDone: any = { id: 'd', parentId: null, name: 'Done', description: '', status: 'done', tool: null, toolCount: 3 }
    const nodeError: any = { id: 'e', parentId: null, name: 'Error', description: '', status: 'error', tool: null, toolCount: 0 }

    bootPanel({ type: 'agents', thread: 't1' })
    await flushPromises()
    fireFrame(HELLO_WITH_SUBAGENTS)
    fireFrame({ type: 'subagent-tree', threadId: 't1', agents: [nodeRunning, nodeDone, nodeError] })

    const blots = document.querySelectorAll('.agent-blot')
    expect(blots.length).toBe(3)

    expect(blots[0].getAttribute('data-status')).toBe('running')
    expect(blots[1].getAttribute('data-status')).toBe('done')
    expect(blots[2].getAttribute('data-status')).toBe('error')

    // Status badges also carry the status class
    const badges = document.querySelectorAll('.agent-status-badge')
    expect(badges[0].classList.contains('running')).toBe(true)
    expect(badges[1].classList.contains('done')).toBe(true)
    expect(badges[2].classList.contains('error')).toBe(true)
  })
})
