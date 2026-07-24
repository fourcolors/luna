// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the 'actions' panel
// (Suggested Actions): frontend/panels/actions.js -> frontend-react/src/
// panels/actions/ActionsPanel.tsx + actions-mount.tsx. Ports every
// behavioral assertion the deleted vanilla suite (test/panel-actions.test.ts)
// pinned against frontend/panel.html + frontend/panels/actions.js onto the
// React implementation, following the same render-directly-with-createRoot
// + real-vendor-WS pattern as test/panel-flow.test.tsx (a WS-backed panel
// with an equivalent hello-gate / per-thread-scoped-frame shape): mount the
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

import { ActionsPanel } from '../frontend-react/src/panels/actions/ActionsPanel'
import {
  ACTIONS_PANEL_TITLE,
  isActionsPanelType,
  mountActionsPanel,
} from '../frontend-react/src/panels/actions-mount'
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

// ── Harness ───────────────────────────────────────────────────────────────
let container: HTMLDivElement | null = null
let root: Root | null = null

/**
 * ctx.connectWs here is a deliberately thin stand-in for panel.html's real
 * connectWs (MoonSession route resolution + load_connection + LunaWS client
 * construction - see panel.html): it builds the exact same LunaWS client
 * over the exact same registry contract and connects it straight away,
 * synchronously. That keeps this suite about ActionsPanel's OWN behavior
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

function bootPanel(threadId: string) {
  ;(window as any).WebSocket = MockWebSocket
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')

  const ctx = makeCtx()
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root!.render(<ActionsPanel ctx={ctx} threadId={threadId} />)
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

// ── Fixture data (mirrors the deleted test/panel-actions.test.ts) ──────────
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

// ── Tests ─────────────────────────────────────────────────────────────────
describe('ActionsPanel (React port of panels/actions.js)', () => {
  // 1. No thread param -> notice, no WS opened
  it('no threadId: shows "No conversation selected." notice, no WS request', () => {
    const el = bootPanel('')
    const notice = el.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('No conversation selected.')
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  // 2. Capability gate - absent -> notice
  it('hello without suggestedActions capability: shows notice', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITHOUT_SUGGESTED_ACTIONS)

    const notice = el.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain("doesn't support suggested actions")
  })

  // 3. Capability gate - present -> no notice, list container remains
  it('hello with suggestedActions capability: list container stays, no notice', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)

    expect(el.querySelector('.notice')).toBeNull()
    expect(el.querySelector('.actions-list')).toBeTruthy()
  })

  // 4. suggested-action-set renders rows for each action
  it('suggested-action-set: renders a row for each action', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED, ACTION_FAILED],
    })

    expect(el.querySelectorAll('.action-row')).toHaveLength(3)
  })

  // 5. Status badges render correct class and text
  it('rows carry correct status badge class and text', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED],
    })

    const badges = el.querySelectorAll('.action-status-badge')
    expect(badges).toHaveLength(2)
    expect(badges[0].classList.contains('proposed')).toBe(true)
    expect(badges[0].textContent).toContain('proposed')
    expect(badges[1].classList.contains('completed')).toBe(true)
    expect(badges[1].textContent).toContain('completed')
  })

  // 6. Accept/Dismiss buttons only for proposed actions
  it('Accept and Dismiss buttons appear only for proposed actions', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED],
    })

    expect(el.querySelectorAll('.action-btn.accept')).toHaveLength(1)
    expect(el.querySelectorAll('.action-btn.dismiss')).toHaveLength(1)
  })

  // 7. Clicking Accept sends suggested-action-respond with decision 'accept'
  it('Accept click: sends suggested-action-respond with decision accept', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({ type: 'suggested-action-set', threadId: 't1', actions: [ACTION_PROPOSED] })

    const acceptBtn = el.querySelector('.action-btn.accept') as HTMLButtonElement
    expect(acceptBtn).toBeTruthy()
    act(() => {
      acceptBtn.click()
    })

    expect(lastSent()).toEqual({
      type: 'suggested-action-respond',
      threadId: 't1',
      actionId: 'act-1',
      decision: 'accept',
    })
  })

  // 8. Clicking Dismiss sends suggested-action-respond with decision 'dismiss'
  it('Dismiss click: sends suggested-action-respond with decision dismiss', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({ type: 'suggested-action-set', threadId: 't1', actions: [ACTION_PROPOSED] })

    const dismissBtn = el.querySelector('.action-btn.dismiss') as HTMLButtonElement
    expect(dismissBtn).toBeTruthy()
    act(() => {
      dismissBtn.click()
    })

    expect(lastSent()).toEqual({
      type: 'suggested-action-respond',
      threadId: 't1',
      actionId: 'act-1',
      decision: 'dismiss',
    })
  })

  // 9. Optimistic flip on Accept: row status badge changes to 'accepted'
  it('Accept click: optimistically flips status badge to accepted, hides buttons', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({ type: 'suggested-action-set', threadId: 't1', actions: [ACTION_PROPOSED] })

    const acceptBtn = el.querySelector('.action-btn.accept') as HTMLButtonElement
    act(() => {
      acceptBtn.click()
    })

    expect(el.querySelectorAll('.action-btn.accept')).toHaveLength(0)
    expect(el.querySelectorAll('.action-btn.dismiss')).toHaveLength(0)
    const badge = el.querySelector('.action-status-badge')
    expect(badge!.classList.contains('accepted')).toBe(true)
  })

  // 10. suggested-action-set for a different threadId is ignored
  it('suggested-action-set for different threadId: ignored', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({ type: 'suggested-action-set', threadId: 't1', actions: [ACTION_PROPOSED] })
    expect(el.querySelectorAll('.action-row')).toHaveLength(1)

    fireFrame({
      type: 'suggested-action-set',
      threadId: 't2',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED, ACTION_FAILED],
    })

    expect(el.querySelectorAll('.action-row')).toHaveLength(1)
  })

  // 11. suggested-action-update upserts an existing action
  it('suggested-action-update: upserts status of an existing action', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({ type: 'suggested-action-set', threadId: 't1', actions: [ACTION_PROPOSED] })
    expect(el.querySelector('.action-status-badge.proposed')).toBeTruthy()

    fireFrame({
      type: 'suggested-action-update',
      threadId: 't1',
      action: { ...ACTION_PROPOSED, status: 'in_progress' },
    })

    const badge = el.querySelector('.action-status-badge')
    expect(badge!.classList.contains('in_progress')).toBe(true)
    expect(el.querySelectorAll('.action-btn.accept')).toHaveLength(0)
  })

  // 12. suggested-action-update for different threadId: ignored
  it('suggested-action-update for different threadId: ignored', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({ type: 'suggested-action-set', threadId: 't1', actions: [ACTION_PROPOSED] })
    fireFrame({
      type: 'suggested-action-update',
      threadId: 't2',
      action: { ...ACTION_PROPOSED, threadId: 't2', status: 'dismissed' },
    })

    expect(el.querySelector('.action-status-badge.proposed')).toBeTruthy()
  })

  // 13. Rationale appears when present
  it('renders rationale when present', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({ type: 'suggested-action-set', threadId: 't1', actions: [ACTION_PROPOSED] })

    const rationaleEl = el.querySelector('.action-row-rationale')
    expect(rationaleEl).toBeTruthy()
    expect(rationaleEl!.textContent).toBe('Coverage is low')
  })

  // 14. Action without rationale: no rationale element rendered
  it('does not render rationale element when absent', () => {
    const noRationale = { ...ACTION_COMPLETED, rationale: null }
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({ type: 'suggested-action-set', threadId: 't1', actions: [noRationale] })

    expect(el.querySelector('.action-row-rationale')).toBeNull()
  })

  // 15. Source blot data-source attribute is set correctly
  it('source blot carries data-source attribute from action', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({
      type: 'suggested-action-set',
      threadId: 't1',
      actions: [ACTION_PROPOSED, ACTION_COMPLETED],
    })

    const blots = el.querySelectorAll('.action-blot')
    expect(blots.length).toBe(2)
    expect(blots[0].getAttribute('data-source')).toBe('agent')
    expect(blots[1].getAttribute('data-source')).toBe('dream')
  })

  // 16. A real WS connection is opened once a threadId is present (the
  // credential/route-resolution plumbing itself lives in panel.html's ctx -
  // covered elsewhere; this just confirms ActionsPanel wires into it).
  it('opens a WS connection once a threadId is present', () => {
    bootPanel('t1')
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  // 17. Empty action set renders "no actions" notice
  it('empty action set: renders empty notice', () => {
    const el = bootPanel('t1')
    fireFrame(HELLO_WITH_SUGGESTED_ACTIONS)
    fireFrame({ type: 'suggested-action-set', threadId: 't1', actions: [] })

    const notice = el.querySelector('.actions-notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toContain('No suggested actions')
  })

  // Connection cleanup: unmounting closes the WS client (not asserted by the
  // deleted vanilla suite, which had no unmount lifecycle - React panels do).
  it('unmount closes the WS connection', () => {
    bootPanel('t1')
    const sock = MockWebSocket.instances[0]
    act(() => {
      root!.unmount()
    })
    root = null
    expect(sock.closed).toBe(true)
  })
})

describe('isActionsPanelType', () => {
  it('routes "actions" and nothing else', () => {
    expect(isActionsPanelType('actions')).toBe(true)
    expect(isActionsPanelType('agents')).toBe(false)
    expect(isActionsPanelType('flow')).toBe(false)
  })
})

describe('mountActionsPanel (panel.html contract parity)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__PanelInternals
    window.history.replaceState({}, '', '/panel.html')
  })

  it('title bar shows "Suggested Actions", sets document.title, renders into #content-area, and sets __PanelInternals - matching what panel.html\'s bootModule() sets for vanilla panel types', () => {
    window.history.replaceState({}, '', '/panel.html?type=actions&thread=t1')
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const ctx = makeCtx()
    act(() => {
      mountActionsPanel('actions', ctx)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(ACTIONS_PANEL_TITLE)
    expect(document.title).toBe(`Luna - ${ACTIONS_PANEL_TITLE}`)
    expect(document.querySelector('#content-area .actions-list')).toBeTruthy()
    expect((window as any).__PanelInternals).toEqual({
      type: 'actions',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })

  it('with no thread in the URL, mounts the "No conversation selected." notice into #content-area', () => {
    window.history.replaceState({}, '', '/panel.html?type=actions')
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const ctx = makeCtx()
    act(() => {
      mountActionsPanel('actions', ctx)
    })
    expect(document.querySelector('#content-area .notice')!.textContent).toBe('No conversation selected.')
  })
})
