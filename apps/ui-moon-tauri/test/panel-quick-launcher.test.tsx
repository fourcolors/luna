// @vitest-environment jsdom
//
// Behavioral tests for the Cmd+K LauncherPanel (frontend-react/src/panels/
// launcher/LauncherPanel.tsx + launcher-mount.tsx). Covers:
//   - Registry rows render, and launcher/flow/agents/actions are excluded.
//   - Substring filter narrows rows.
//   - ArrowDown + Enter activates the right row and calls open_widget with kind.
//   - artifact-list frame renders artifact rows; activating one calls
//     open_artifact_widget with { artifactId, title }.
//   - Missing capabilities.artifacts still renders the panels section (does
//     not blank the panel).
//   - Esc calls close_widget.
//
// Harness: real MockWebSocket + real vendor globals (moon-ws.js / moon-
// protocol.js), component rendered directly via createRoot+act — no panel.html
// glue needed. Mirrors settings-apps-panel.test.tsx's approach.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it - see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { LauncherPanel } from '../frontend-react/src/panels/launcher/LauncherPanel'
import {
  isLauncherPanelType,
  mountLauncherPanel,
  LAUNCHER_TITLE,
} from '../frontend-react/src/panels/launcher/launcher-mount'
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from '../frontend-react/src/panels/panel-ctx'

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

// ── Fixture registry (used by tests that fetch widget-registry.json) ──────────
// LauncherPanel fetches /vendor/widget-registry.json via window.fetch. We stub
// fetch to return a synthetic registry so tests don't hit the FS.
const FAKE_REGISTRY = {
  widgets: [
    // Excluded kinds — should NOT appear in the panel list
    { kind: 'launcher', title: 'Launcher', page: 'panel.html?type=launcher', description: 'Quick launcher' },
    { kind: 'flow',    title: 'Flow',     page: 'panel.html?type=flow',     description: 'Flow panel' },
    { kind: 'agents',  title: 'Agents',   page: 'panel.html?type=agents',   description: 'Agents panel' },
    { kind: 'actions', title: 'Actions',  page: 'panel.html?type=actions',  description: 'Actions panel' },
    // Included kinds
    { kind: 'settings', title: 'Settings', page: 'panel.html?type=settings', description: 'Settings hub' },
    { kind: 'now',      title: 'Now',      page: 'panel.html?type=now',      description: 'Now rail' },
    { kind: 'briefing', title: 'Briefing', page: 'panel.html?type=briefing', description: 'Morning briefing' },
    // REGRESSION GUARD: `chat` is the one included kind whose page is NOT
    // panel.html. An earlier cut filtered rows on page.startsWith('panel.html')
    // and silently dropped it - the most useful thing in the palette. Kept LAST
    // so the keyboard-nav test's index math (settings=0, now=1, briefing=2)
    // stays valid.
    { kind: 'chat', title: 'Luna', page: 'chat.html', description: 'The Luna conversation' },
  ],
}

function mockFetch() {
  ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
    json: () => Promise.resolve(FAKE_REGISTRY),
  })
}

// ── Fixtures: artifacts ───────────────────────────────────────────────────────
const ARTIFACT_WIDGET = {
  id: 'widget:my-widget',
  kind: 'widget',
  title: 'My Widget',
  content: '<div/>',
  lang: null,
  origin: null,
  version: 1,
  pinnedAt: 1000,
  updatedAt: 1000,
}

const ARTIFACT_MARKDOWN = {
  id: 'markdown:my-doc',
  kind: 'markdown',
  title: 'My Doc',
  content: '# Hi',
  lang: null,
  origin: null,
  version: 1,
  pinnedAt: 2000,
  updatedAt: 2000,
}

// ── Harness ───────────────────────────────────────────────────────────────────
let container: HTMLDivElement | null = null
let root: Root | null = null

function makeCtx(
  invokeImpl?: (cmd: string, args?: any) => any,
  label: string | null = 'panel-launcher',
): { ctx: PanelCtx; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (cmd: string, args?: any) =>
    invokeImpl ? invokeImpl(cmd, args) : null,
  )
  const ctx: PanelCtx = {
    invoke,
    hasTauri: false,
    win: null,
    label,
    connectWs: (registry: LunaFrameRegistry, opts?: Record<string, unknown>): LunaWsClient => {
      const client = (window as any).LunaWS.createClient(
        Object.assign({ registry, autoPong: true }, opts || {}),
      )
      client.connect('ws://test-host/ui', 'test-tok')
      return client
    },
  }
  return { ctx, invoke }
}

function boot(invokeImpl?: (cmd: string, args?: any) => any) {
  ;(window as any).WebSocket = MockWebSocket
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  mockFetch()

  const { ctx, invoke } = makeCtx(invokeImpl)
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root!.render(<LauncherPanel ctx={ctx} />)
  })
  return { container: container!, invoke, ctx }
}

beforeEach(() => {
  // Reset the registry fetch mock before each test
  vi.clearAllMocks()
})

afterEach(() => {
  if (root && container) {
    act(() => {
      root!.unmount()
    })
  }
  if (container) container.remove()
  container = null
  root = null
  delete (window as any).LunaWS
  delete (window as any).LunaProtocol
  delete (window as any).WebSocket
  delete (globalThis as any).fetch
  MockWebSocket.instances = []
  vi.restoreAllMocks()
})

// ── Helper: flush pending microtasks (fetch promise resolution) ───────────────
async function flushFetch() {
  // Drain the WHOLE fetch().then(json).then(setState) chain inside act().
  // One `await Promise.resolve()` only advances a single microtask tick, but
  // the chain needs several; leaving it partially drained lets the setState
  // land OUTSIDE act(), which schedules React concurrent work that can outlive
  // the jsdom environment and surface as an "Uncaught ReferenceError: window is
  // not defined" attributed to whatever file runs next. Ticking generously is
  // free (these are microtasks, not timers) and makes the drain deterministic.
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

describe('LauncherPanel: registry rows', () => {
  it('renders included panel rows and excludes launcher/flow/agents/actions', async () => {
    const { container } = boot()
    await flushFetch()

    // Verify excluded kinds are absent
    expect(container.querySelector('[data-testid="launcher-row-launcher"]')).toBeNull()
    expect(container.querySelector('[data-testid="launcher-row-flow"]')).toBeNull()
    expect(container.querySelector('[data-testid="launcher-row-agents"]')).toBeNull()
    expect(container.querySelector('[data-testid="launcher-row-actions"]')).toBeNull()

    // Verify included kinds are present
    expect(container.querySelector('[data-testid="launcher-row-settings"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="launcher-row-now"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="launcher-row-briefing"]')).toBeTruthy()

    // `chat` must survive: its page is chat.html, not panel.html. Filtering by
    // page shape instead of by kind would drop it.
    expect(container.querySelector('[data-testid="launcher-row-chat"]')).toBeTruthy()
  })

  it('shows section label "Panels" for registry rows', async () => {
    const { container } = boot()
    await flushFetch()

    const labels = Array.from(container.querySelectorAll('.launcher-section-label')).map(
      (el) => el.textContent,
    )
    expect(labels).toContain('Panels')
  })
})

describe('LauncherPanel: substring filter', () => {
  it('narrows rows to those matching the query', async () => {
    const { container } = boot()
    await flushFetch()

    const input = container.querySelector('[data-testid="launcher-search"]') as HTMLInputElement
    expect(input).toBeTruthy()

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value',
      )!.set!
      setter.call(input, 'Now')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    // Only "now" row should appear
    expect(container.querySelector('[data-testid="launcher-row-now"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="launcher-row-settings"]')).toBeNull()
  })

  it('shows "No matches" when nothing matches the query', async () => {
    const { container } = boot()
    await flushFetch()

    const input = container.querySelector('[data-testid="launcher-search"]') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value',
      )!.set!
      setter.call(input, 'xyzzy-no-match')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.querySelector('[data-testid="launcher-empty"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="launcher-empty"]')!.textContent).toBe(
      'No matches',
    )
  })
})

describe('LauncherPanel: keyboard navigation and activation', () => {
  it('ArrowDown + Enter activates the highlighted row and calls open_widget with kind', async () => {
    const { container, invoke } = boot()
    await flushFetch()

    const input = container.querySelector('[data-testid="launcher-search"]') as HTMLInputElement

    // ArrowDown moves highlight from index 0 to 1
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    // The second row (index 1) should be active. With our fake registry
    // (excluded first 4, included: settings=0, now=1, briefing=2)
    // After one ArrowDown: highlight index = 1 → "now"
    expect(container.querySelector('[data-testid="launcher-row-now"]')!.className).toContain(
      'launcher-row--active',
    )

    // Enter should activate the highlighted row
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'now' })
    // Activation MUST also dismiss. A launcher left open behind the window it
    // just opened is a zombie: lifecycle.rs's expand_out_of_moon re-shows every
    // hidden dock window, so it would keep resurfacing.
    expect(invoke).toHaveBeenCalledWith('close_widget', { label: 'panel-launcher' })
  })

  it('clicking a row activates it and calls open_widget with the correct kind', async () => {
    const { container, invoke } = boot()
    await flushFetch()

    const row = container.querySelector('[data-testid="launcher-row-briefing"]') as HTMLElement
    expect(row).toBeTruthy()
    act(() => {
      row.click()
    })

    expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'briefing' })
    expect(invoke).toHaveBeenCalledWith('close_widget', { label: 'panel-launcher' })
  })
})

describe('LauncherPanel: artifact rows', () => {
  it('artifact-list frame renders artifact rows (all kinds, including markdown)', async () => {
    const { container } = boot()
    await flushFetch()

    // Send hello with artifacts capability, then artifact-list
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [ARTIFACT_WIDGET, ARTIFACT_MARKDOWN] })

    expect(container.querySelector('[data-testid="launcher-row-widget:my-widget"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="launcher-row-markdown:my-doc"]')).toBeTruthy()
  })

  it('shows "Your apps" section label when artifacts are present', async () => {
    const { container } = boot()
    await flushFetch()

    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [ARTIFACT_WIDGET] })

    const labels = Array.from(container.querySelectorAll('.launcher-section-label')).map(
      (el) => el.textContent,
    )
    expect(labels).toContain('Your apps')
  })

  it('activating an artifact row calls open_artifact_widget with { artifactId, title }', async () => {
    const { container, invoke } = boot()
    await flushFetch()

    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [ARTIFACT_WIDGET] })

    const row = container.querySelector('[data-testid="launcher-row-widget:my-widget"]') as HTMLElement
    expect(row).toBeTruthy()
    act(() => {
      row.click()
    })

    expect(invoke).toHaveBeenCalledWith('open_artifact_widget', {
      artifactId: ARTIFACT_WIDGET.id,
      title: ARTIFACT_WIDGET.title,
    })
  })
})

describe('LauncherPanel: missing capabilities.artifacts', () => {
  it('still renders the panels section when hello has no artifacts capability', async () => {
    const { container } = boot()
    await flushFetch()

    // hello without artifacts
    fireFrame({ type: 'hello', capabilities: {} })

    // Panel rows should still be visible
    expect(container.querySelector('[data-testid="launcher-panel"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="launcher-row-settings"]')).toBeTruthy()

    // No artifacts section
    const labels = Array.from(container.querySelectorAll('.launcher-section-label')).map(
      (el) => el.textContent,
    )
    expect(labels).not.toContain('Your apps')
  })

  it('renders panels section before any WS hello arrives', async () => {
    const { container } = boot()
    await flushFetch()

    // No hello fired — panels should still appear
    expect(container.querySelector('[data-testid="launcher-row-settings"]')).toBeTruthy()
  })
})

describe('LauncherPanel: Esc closes the panel', () => {
  it('Esc calls close_widget with the panel label', async () => {
    const { container, invoke } = boot()
    await flushFetch()

    const input = container.querySelector('[data-testid="launcher-search"]') as HTMLInputElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(invoke).toHaveBeenCalledWith('close_widget', { label: 'panel-launcher' })
  })

  it('window blur calls close_widget (palette must not linger unfocused)', async () => {
    const { invoke } = boot()
    await flushFetch()

    expect(invoke).not.toHaveBeenCalledWith('close_widget', { label: 'panel-launcher' })

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })

    expect(invoke).toHaveBeenCalledWith('close_widget', { label: 'panel-launcher' })
  })

  it('activating an ARTIFACT row opens it and closes the palette', async () => {
    const { container, invoke } = boot()
    await flushFetch()

    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [ARTIFACT_WIDGET] })

    const row = container.querySelector(
      `[data-testid="launcher-row-${ARTIFACT_WIDGET.id}"]`,
    ) as HTMLElement
    expect(row).toBeTruthy()
    act(() => {
      row.click()
    })

    expect(invoke).toHaveBeenCalledWith('open_artifact_widget', {
      artifactId: ARTIFACT_WIDGET.id,
      title: ARTIFACT_WIDGET.title,
    })
    expect(invoke).toHaveBeenCalledWith('close_widget', { label: 'panel-launcher' })
  })
})

describe('isLauncherPanelType', () => {
  it('routes the "launcher" type only', () => {
    expect(isLauncherPanelType('launcher')).toBe(true)
    expect(isLauncherPanelType('settings')).toBe(false)
    expect(isLauncherPanelType('flow')).toBe(false)
    expect(isLauncherPanelType('')).toBe(false)
  })
})

describe('mountLauncherPanel (panel.html contract parity)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__PanelInternals
  })

  it("sets bar title, document title, renders into #content-area, and sets __PanelInternals", async () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    ;(globalThis as any).fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve(FAKE_REGISTRY),
    })

    const ctx: PanelCtx = {
      invoke: vi.fn(async () => null),
      hasTauri: false,
      win: null,
    }
    act(() => {
      mountLauncherPanel('launcher', ctx)
    })
    // Flush the async fetch so the state update from useEffect lands inside
    // the act boundary and doesn't leak into teardown.
    await act(async () => {
      await Promise.resolve()
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(LAUNCHER_TITLE)
    expect(document.title).toBe(`Luna - ${LAUNCHER_TITLE}`)
    expect(document.querySelector('#content-area [data-testid="launcher-panel"]')).toBeTruthy()
    expect((window as any).__PanelInternals).toEqual({
      type: 'launcher',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
