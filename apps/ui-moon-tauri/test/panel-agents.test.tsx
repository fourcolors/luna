// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Agents panel
// (frontend/panels/agents.js -> frontend-react/src/panels/agents/AgentsPanel.tsx
// + agents-mount.tsx). Ports every behavioral assertion this file used to
// pin against the vanilla module (WS-backed, thread-scoped, never-subscribe
// security invariant, parent/child tree nesting, per-status blot/badge
// rendering) onto the React implementation, following the same
// render-directly-with-createRoot pattern as
// test/settings-launcher-panel.test.tsx: mount the component with a fake
// PanelCtx instead of booting all of panel.html's inline vanilla script.
//
// AgentsPanel still reads window.LunaWS / window.LunaProtocol directly (the
// same classic-script globals frontend/vendor/moon-ws.js and
// frontend/vendor/moon-protocol.js attach in every Moon page) - loading the
// REAL vendor files (not a mock of them) keeps this suite honest about the
// actual wire behavior (frame registry dispatch, autoPong) instead of
// re-describing it in a test double.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it - see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { AgentsPanel } from '../frontend-react/src/panels/agents/AgentsPanel'
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
 * synchronously, inside the effect that calls it. That keeps this suite
 * about AgentsPanel's OWN behavior (frame handling -> dispatch -> render),
 * not a second copy of panel.html's connection-bootstrap plumbing (which
 * has its own dedicated coverage elsewhere).
 */
function makeCtx(): PanelCtx {
  return {
    invoke: vi.fn(async () => null),
    connectWs: (registry, opts) => {
      const client = (window as any).LunaWS.createClient({ registry, ...(opts || {}) })
      client.connect('ws://test-host/ui', 'test-tok')
      return client
    },
  }
}

function bootPanel(thread?: string) {
  let search = '/panel.html?type=agents'
  if (thread !== undefined) search += '&thread=' + encodeURIComponent(thread)
  window.history.replaceState({}, '', search)

  ;(window as any).WebSocket = MockWebSocket
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')

  const ctx = makeCtx()
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root!.render(<AgentsPanel ctx={ctx} />)
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

// ── Tests ─────────────────────────────────────────────────────────────────

describe('AgentsPanel (React port of panels/agents.js)', () => {
  it('no thread param: shows "No conversation selected." notice, no WS request', () => {
    // Boot WITHOUT a thread param — the URL only has ?type=agents
    const el = bootPanel()

    const notice = el.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('No conversation selected.')

    // No WebSocket was opened (no thread → stops before connectWs)
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('hello without caps.subagents: shows "doesn\'t report subagents" notice', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITHOUT_SUBAGENTS)

    const notice = el.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain("doesn't report subagents")
  })

  it('hello with caps.subagents: sends subagent-tree-request for threadId t1', () => {
    bootPanel('t1')
    fireFrame(HELLO_WITH_SUBAGENTS)

    const sent = lastSent()
    expect(sent).toEqual({ type: 'subagent-tree-request', threadId: 't1' })
  })

  it('SECURITY INVARIANT: the read-only Agents panel NEVER sends a subscribe frame', () => {
    // Sending `subscribe` would register this window as the thread's
    // secret-entry target (server.ts), stealing the chat window's request_secret
    // routing (the one-window-per-thread rule). The panel must stay read-only:
    // it only ever sends subagent-tree-request (+ pong). A future "fix the empty
    // tree by subscribing" mistake regresses the invariant — this pins it.
    bootPanel('t1')
    fireFrame(HELLO_WITH_SUBAGENTS)
    // Feed a tree too, in case any render path were tempted to subscribe.
    fireFrame({ type: 'subagent-tree', threadId: 't1', agents: [] })
    const types = allSent().map((f) => f.type)
    expect(types).not.toContain('subscribe')
    expect(types.every((t) => t === 'subagent-tree-request' || t === 'pong')).toBe(true)
  })

  it('subagent-tree for t1: renders both nodes, child is nested under parent', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUBAGENTS)
    fireFrame({ type: 'subagent-tree', threadId: 't1', agents: [NODE_TOP, NODE_CHILD] })

    const rows = el.querySelectorAll('.agent-row')
    expect(rows.length).toBeGreaterThanOrEqual(2)

    // Parent row shows name and tool activity
    const parentRow = rows[0]!
    expect(parentRow.textContent).toContain('Explore')
    expect(parentRow.textContent).toContain('Grep')
    expect(parentRow.textContent).toContain('2 tools')

    // Child node is nested inside .agent-children under the parent's wrap
    const childWrap = el.querySelector('.agent-children')
    expect(childWrap).toBeTruthy()
    const childRow = childWrap!.querySelector('.agent-row')
    expect(childRow).toBeTruthy()
    expect(childRow!.textContent).toContain('Analyze')
    expect(childRow!.textContent).toContain('done')
  })

  it('subagent-tree for different threadId (t2): ignored - t1 render unchanged', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUBAGENTS)

    // First render the t1 tree
    fireFrame({ type: 'subagent-tree', threadId: 't1', agents: [NODE_TOP] })
    const rowsBefore = el.querySelectorAll('.agent-row').length
    expect(rowsBefore).toBe(1)

    // Now fire a frame for a different thread
    fireFrame({ type: 'subagent-tree', threadId: 't2', agents: [NODE_TOP, NODE_CHILD] })
    // Should still have the same number of rows from t1
    const rowsAfter = el.querySelectorAll('.agent-row').length
    expect(rowsAfter).toBe(1)
    // Content still matches t1's single top-level node
    expect(el.querySelector('.agent-row')!.textContent).toContain('Explore')
  })

  it('status classes differ: running blot has data-status="running", done has "done", error has "error"', () => {
    const nodeRunning: any = { id: 'r', parentId: null, name: 'Running', description: '', status: 'running', tool: 'Bash', toolCount: 1 }
    const nodeDone: any = { id: 'd', parentId: null, name: 'Done', description: '', status: 'done', tool: null, toolCount: 3 }
    const nodeError: any = { id: 'e', parentId: null, name: 'Error', description: '', status: 'error', tool: null, toolCount: 0 }

    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUBAGENTS)
    fireFrame({ type: 'subagent-tree', threadId: 't1', agents: [nodeRunning, nodeDone, nodeError] })

    const blots = el.querySelectorAll('.agent-blot')
    expect(blots.length).toBe(3)

    expect(blots[0]!.getAttribute('data-status')).toBe('running')
    expect(blots[1]!.getAttribute('data-status')).toBe('done')
    expect(blots[2]!.getAttribute('data-status')).toBe('error')

    // Status badges also carry the status class
    const badges = el.querySelectorAll('.agent-status-badge')
    expect(badges[0]!.classList.contains('running')).toBe(true)
    expect(badges[1]!.classList.contains('done')).toBe(true)
    expect(badges[2]!.classList.contains('error')).toBe(true)
  })
})
