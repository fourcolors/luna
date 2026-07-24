// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the 'now' panel
// (frontend/panels/now.js -> frontend-react/src/panels/now/NowPanel.tsx +
// now-mount.tsx). Ports every behavioral assertion from the vanilla suite
// (the live rail of running work + the needs-input answer surface) onto the
// React implementation:
//   - hello capability gate (workflows) replaces the whole panel with a notice
//   - workflow-list renders a row per workflow, sorted waiting -> running -> rest
//   - job-input-request pins an answer card, newest-on-top, surviving a
//     workflow-list re-render
//   - Answer sends job-input-result {requestId, answer} and clears the input;
//     an empty/whitespace-only answer is blocked with a hint instead
//   - Dismiss sends job-input-result {requestId, cancelled:true} and removes
//     the card immediately
//   - job-input-status ok:true/false settles the card ("answered ✓" / the
//     server's message), removed ~2s later
//   - an unanswered request past its own timeoutMs shows "expired", removed
//     ~2s later
//   - load_connection is invoked immediately once ctx.connectWs() is called
//
// Harness note: unlike the vanilla suite's MockWebSocket-over-panel.html
// dance, this drives the panel directly through its own `ctx` prop (the
// exact same seam mountNowPanel/panel.html hand it in production - see
// ../frontend-react/src/panels/panel-ctx.ts) and a minimal in-file
// LunaFrameRegistry (register/dispatch/has - mirrors vendor/moon-ws.js's
// contract byte-for-byte, see moon-ws.js's own createFrameRegistry). That
// keeps this a true unit test of NowPanel's OWN wiring/state/render logic,
// not a re-test of the shared WS transport (which has no bearing on this
// panel's behavior and is exercised elsewhere).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it - see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { NowPanel, NOW_PANEL_TITLE } from '../frontend-react/src/panels/now/NowPanel'
import { isNowPanelType, mountNowPanel } from '../frontend-react/src/panels/now/now-mount'
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from '../frontend-react/src/panels/panel-ctx'

// ── Minimal LunaFrameRegistry (mirrors vendor/moon-ws.js's createFrameRegistry) ──
function createFrameRegistry(): LunaFrameRegistry {
  const handlers: Record<string, (frame: any) => void> = {}
  const registry: LunaFrameRegistry = {
    register(type, fn) {
      handlers[type] = fn
      return registry
    },
    dispatch(frame) {
      if (!frame || typeof (frame as any).type !== 'string') return false
      const fn = handlers[(frame as any).type]
      if (!fn) return false
      fn(frame)
      return true
    },
    has(type) {
      return !!handlers[type]
    },
  }
  return registry
}

// ── Harness ──────────────────────────────────────────────────────────────
let container: HTMLDivElement | null = null
let root: Root | null = null
let currentRegistry: LunaFrameRegistry | null = null
let sentFrames: any[] = []
let closeCalls = 0

function makeCtx(invokeImpl?: (cmd: string, args?: any) => any): { ctx: PanelCtx; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (cmd: string, args?: any) => {
    if (cmd === 'load_connection') return { wsUrl: 'ws://test-host/ui', wsToken: 'test-tok' }
    return invokeImpl ? invokeImpl(cmd, args) : null
  })
  const ctx: PanelCtx = {
    invoke,
    hasTauri: true,
    win: null,
    connectWs(registry) {
      currentRegistry = registry
      // Mirrors panel.html's legacy connectWs path: load_connection is
      // invoked synchronously, right when connectWs() is called.
      invoke('load_connection')
      const client: LunaWsClient = {
        connect: () => null,
        send: (frame) => {
          sentFrames.push(frame)
          return true
        },
        close: () => {
          closeCalls++
        },
        registerCloseHook: () => {},
        socket: () => null,
      }
      return client
    },
  }
  return { ctx, invoke }
}

function renderPanel(ctx: PanelCtx) {
  // NowPanel reads window.LunaWS.createFrameRegistry directly (see
  // vendor/moon-ws.js - the classic script every panel.html page loads
  // ahead of the deferred React entry; see ../frontend-react/src/panels/
  // panel-ctx.ts's module doc).
  ;(window as any).LunaWS = { createFrameRegistry }
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root!.render(<NowPanel ctx={ctx} />)
  })
  return container
}

function fireFrame(frame: object) {
  act(() => {
    currentRegistry!.dispatch(frame)
  })
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

function lastSent(): any {
  return sentFrames[sentFrames.length - 1] ?? null
}

// React tracks <input> values through the native value setter to detect
// real user input - assigning `.value` directly is invisible to it, so the
// subsequent onChange never fires (a well-known RTL/act gotcha). Go through
// the native setter, exactly like a real keystroke would.
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)!.set!
function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    nativeInputValueSetter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
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
  currentRegistry = null
  sentFrames = []
  closeCalls = 0
  delete (window as any).__PanelInternals
  delete (window as any).LunaWS
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ── Fixture data ─────────────────────────────────────────────────────────
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

// ── Tests ────────────────────────────────────────────────────────────────

describe('NowPanel (React port of panels/now.js)', () => {
  it('hello without workflows capability: replaces content with notice', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: {} })
    const notice = el.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toBe("This server doesn't expose workflows.")
    expect(el.querySelector('#now-rail')).toBeNull()
    expect(el.querySelector('#now-cards')).toBeNull()
  })

  it('hello with workflows capability: rail container stays visible', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    expect(el.querySelector('#now-rail')).toBeTruthy()
    expect(el.querySelector('.notice')).toBeNull()
  })

  it('workflow-list: renders a row for each workflow', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_SUCCESS, WF_FAILED] })
    expect(el.querySelectorAll('.now-wf-row')).toHaveLength(2)
  })

  it('workflow-list: waiting rows appear before running then the rest', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ type: 'workflow-list', workflows: [WF_SUCCESS, WF_RUNNING, WF_WAITING, WF_FAILED] })
    const rows = el.querySelectorAll('.now-wf-row')
    expect(rows).toHaveLength(4)
    expect(rows[0]!.querySelector('.now-status-dot')!.classList.contains('waiting')).toBe(true)
    expect(rows[1]!.querySelector('.now-status-dot')!.classList.contains('running')).toBe(true)
    // Remaining rows are success/failed (order by recency - WF_SUCCESS lastRun=800 > WF_FAILED lastRun=700).
    expect(rows[2]!.querySelector('.now-wf-name')!.textContent).toBe('Archive Docs')
    expect(rows[3]!.querySelector('.now-wf-name')!.textContent).toBe('Export Data')
  })

  it('job-input-request: renders an answer card with jobName and prompt', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    const card = el.querySelector('.now-answer-card')
    expect(card).toBeTruthy()
    expect(card!.querySelector('.now-answer-card-job')!.textContent).toBe('Draft Report')
    expect(card!.querySelector('.now-answer-card-prompt')!.textContent).toBe('Which draft should I finalize?')
    expect(card!.querySelector('input')).toBeTruthy()
    expect(el.querySelector('.now-answer-btn')).toBeTruthy()
  })

  it('answer: sends job-input-result with requestId+answer and clears the input', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    const input = el.querySelector('.now-answer-card input') as HTMLInputElement
    typeInto(input, 'The second draft please')
    const answerBtn = el.querySelector('.now-answer-btn') as HTMLButtonElement
    act(() => {
      answerBtn.click()
    })
    expect(lastSent()).toEqual({ type: 'job-input-result', requestId: 'req-1', answer: 'The second draft please' })
    expect((el.querySelector('.now-answer-card input') as HTMLInputElement).value).toBe('')
  })

  it('answer: blocks empty submit and shows a hint', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    const input = el.querySelector('.now-answer-card input') as HTMLInputElement
    typeInto(input, '   ') // whitespace only
    const sentBefore = sentFrames.length
    const answerBtn = el.querySelector('.now-answer-btn') as HTMLButtonElement
    act(() => {
      answerBtn.click()
    })
    expect(sentFrames.length).toBe(sentBefore)
    const hint = el.querySelector('.now-card-hint')
    expect(hint).toBeTruthy()
    expect(hint!.textContent).toContain('Please type an answer')
  })

  it('dismiss: sends job-input-result with cancelled:true and removes the card immediately', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    const dismissBtn = el.querySelector('.now-dismiss-btn') as HTMLButtonElement
    act(() => {
      dismissBtn.click()
    })
    expect(lastSent()).toEqual({ type: 'job-input-result', requestId: 'req-1', cancelled: true })
    expect(el.querySelector('.now-answer-card')).toBeNull()
  })

  it('job-input-status ok:true: shows "answered ✓" then the card is cleared ~2s later', async () => {
    vi.useFakeTimers()
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    fireFrame({ type: 'job-input-status', requestId: 'req-1', ok: true, message: '' })
    const settled = el.querySelector('.now-card-settled')
    expect(settled).toBeTruthy()
    expect(settled!.textContent).toContain('answered ✓')
    await advance(2100)
    expect(el.querySelector('.now-answer-card')).toBeNull()
  })

  it('job-input-status ok:false: shows the server message (e.g. already answered)', async () => {
    vi.useFakeTimers()
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    fireFrame({ type: 'job-input-status', requestId: 'req-1', ok: false, message: 'already answered' })
    const settled = el.querySelector('.now-card-settled')
    expect(settled).toBeTruthy()
    expect(settled!.textContent).toContain('already answered')
    await advance(2100)
    expect(el.querySelector('.now-answer-card')).toBeNull()
  })

  it('timeout: auto-removes the card with "expired" after timeoutMs, then ~2s later', async () => {
    vi.useFakeTimers()
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame({ ...INPUT_REQ_1, timeoutMs: 5000 })
    expect(el.querySelector('.now-answer-card')).toBeTruthy()
    await advance(5001)
    const timeout = el.querySelector('.now-card-timeout')
    expect(timeout).toBeTruthy()
    expect(timeout!.textContent).toBe('expired')
    await advance(2100)
    expect(el.querySelector('.now-answer-card')).toBeNull()
  })

  it('stacking: multiple concurrent requests stack newest-on-top', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    fireFrame(INPUT_REQ_2)
    const cards = el.querySelectorAll('.now-answer-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.getAttribute('data-request-id')).toBe('req-2')
    expect(cards[1]!.getAttribute('data-request-id')).toBe('req-1')
  })

  it('card state survives a workflow-list re-render', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    fireFrame({ type: 'hello', capabilities: { workflows: true } })
    fireFrame(INPUT_REQ_1)
    expect(el.querySelector('.now-answer-card')).toBeTruthy()
    fireFrame({ type: 'workflow-list', workflows: [WF_SUCCESS] })
    const card = el.querySelector('.now-answer-card')
    expect(card).toBeTruthy()
    expect(card!.getAttribute('data-request-id')).toBe('req-1')
    expect(el.querySelector('.now-wf-row')).toBeTruthy()
  })

  it('load_connection is invoked immediately once ctx.connectWs() is called', () => {
    const { ctx, invoke } = makeCtx()
    renderPanel(ctx)
    expect(invoke).toHaveBeenCalledWith('load_connection')
  })
})

describe('isNowPanelType', () => {
  it('routes the "now" panel type only', () => {
    expect(isNowPanelType('now')).toBe(true)
    expect(isNowPanelType('flow')).toBe(false)
    expect(isNowPanelType('workflows')).toBe(false)
  })
})

describe('mountNowPanel (panel.html contract parity)', () => {
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
    ;(window as any).LunaWS = { createFrameRegistry }
    const { ctx } = makeCtx()
    act(() => {
      mountNowPanel('now', ctx)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(NOW_PANEL_TITLE)
    expect(document.title).toBe(`Luna - ${NOW_PANEL_TITLE}`)
    expect(document.querySelector('#content-area .now-panel')).toBeTruthy()
    expect((window as any).__PanelInternals).toEqual({
      type: 'now',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
