// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Apps settings panel
// (frontend/panels/settings-apps.js -> frontend-react/src/panels/
// SettingsAppsPanel.tsx + settings-apps-mount.tsx). Ports every behavioral
// assertion from test/panel-apps.test.ts (retired alongside the vanilla
// module — see that suite's own history) onto the React implementation:
//   - hello without artifacts capability -> unsupported notice, no list
//   - artifact-list filters to mcp-app + widget, excludes markdown
//   - Open sends invoke('open_artifact_widget', { artifactId, title })
//   - Delete sends { type: 'artifact-unpin', id }
//   - Save (create) sends artifact-pin with a slugified id, disambiguating
//     on collision
//   - Edit then Save sends a SINGLE artifact-edit (content-only) for the
//     same id, never unpin+re-pin
//
// Harness: same MockWebSocket + real-vendor-globals approach panel-apps.test.ts
// used (frontend/vendor/moon-ws.js / moon-protocol.js are real, unconverted
// vendor globals — the panel module is React now, the wire protocol isn't),
// styled after settings-launcher-panel.test.tsx's direct-component
// createRoot+act render (no panel.html glue needed to exercise the
// component's own behavior).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it — see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { SettingsAppsPanel } from '../frontend-react/src/panels/SettingsAppsPanel'
import {
  isSettingsAppsPanelType,
  mountSettingsAppsPanel,
  SETTINGS_APPS_TITLE,
} from '../frontend-react/src/panels/settings-apps-mount'
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from '../frontend-react/src/panels/panel-ctx'

// ── MockWebSocket (ported verbatim from panel-apps.test.ts) ────────────────
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

function allSent(): any[] {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  return sock.sent.map((s) => JSON.parse(s))
}

function lastSent(): any {
  const sent = allSent()
  return sent[sent.length - 1] ?? null
}

/** Simulate typing into a real controlled <input>/<textarea> the way a user
 *  would — React 16+ tracks the native value setter, so a plain `.value =`
 *  assignment is invisible to it; going through the prototype setter before
 *  dispatching 'input' is the standard no-testing-library workaround. */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function selectKind(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function findButton(root: HTMLElement, label: string): HTMLElement {
  const btn = [...root.querySelectorAll('.app-btn')].find((b) => b.textContent?.trim() === label)
  if (!btn) throw new Error(`button "${label}" not found`)
  return btn as HTMLElement
}

// ── Fixture artifacts (ported verbatim from panel-apps.test.ts) ────────────
const MCP_APP = {
  id: 'mcp-app:pulse-dash',
  kind: 'mcp-app',
  title: 'Pulse Dash',
  content: '<div>pulse</div>',
  lang: null,
  origin: null,
  version: 1,
  pinnedAt: 1000,
  updatedAt: 1000,
}

const WIDGET = {
  id: 'widget:live-feed',
  kind: 'widget',
  title: 'Live Feed',
  content: '<div>feed</div>',
  lang: null,
  origin: null,
  version: 3,
  pinnedAt: 2000,
  updatedAt: 2000,
}

const MARKDOWN = {
  id: 'markdown:readme',
  kind: 'markdown',
  title: 'README',
  content: '# readme',
  lang: null,
  origin: null,
  version: 1,
  pinnedAt: 500,
  updatedAt: 500,
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function makeCtx(invokeImpl?: (cmd: string, args?: any) => any): { ctx: PanelCtx; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (cmd: string, args?: any) => (invokeImpl ? invokeImpl(cmd, args) : null))
  const ctx: PanelCtx = {
    invoke,
    connectWs: (registry: LunaFrameRegistry, opts?: Record<string, unknown>): LunaWsClient => {
      const client = (window as any).LunaWS.createClient(Object.assign({ registry, autoPong: true }, opts || {}))
      client.connect('ws://test-host/ui', 'test-tok')
      return client
    },
  }
  return { ctx, invoke }
}

/** Boot: install the MockWebSocket + real vendor globals, then render the
 *  panel. Mirrors panel-apps.test.ts's bootPanel(), minus the panel.html
 *  glue this component doesn't need. */
function boot(invokeImpl?: (cmd: string, args?: any) => any) {
  ;(window as any).WebSocket = MockWebSocket
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')

  const { ctx, invoke } = makeCtx(invokeImpl)
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root!.render(<SettingsAppsPanel ctx={ctx} />)
  })
  return { container: container!, invoke }
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
  delete (window as any).LunaWS
  delete (window as any).LunaProtocol
  delete (window as any).WebSocket
  MockWebSocket.instances = []
  vi.restoreAllMocks()
})

describe('SettingsAppsPanel (React port of panels/settings-apps.js)', () => {
  it('hello without artifacts capability: renders the unsupported notice, no list', () => {
    const { container } = boot()
    fireFrame({ type: 'hello', capabilities: {} })

    const notice = container.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toBe("This server doesn't support apps.")
    expect(container.querySelector('#apps-list')).toBeNull()
  })

  it('artifact-list: filters to mcp-app + widget, excludes markdown', () => {
    const { container } = boot()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [MCP_APP, WIDGET, MARKDOWN] })

    const rows = container.querySelectorAll('.app-row')
    expect(rows).toHaveLength(2)

    const texts = Array.from(rows).map((r) => r.textContent ?? '')
    expect(texts.some((t) => t.includes('Pulse Dash'))).toBe(true)
    expect(texts.some((t) => t.includes('Live Feed'))).toBe(true)
    expect(texts.some((t) => t.includes('README'))).toBe(false)

    const badges = container.querySelectorAll('.app-kind-badge')
    const badgeTexts = Array.from(badges).map((b) => b.textContent)
    expect(badgeTexts).toContain('app')
    expect(badgeTexts).toContain('widget')
  })

  it('Open button: calls invoke("open_artifact_widget", { artifactId, title })', () => {
    const { container, invoke } = boot()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [MCP_APP] })

    const openBtn = findButton(container, 'Open')
    act(() => {
      openBtn.click()
    })

    expect(invoke).toHaveBeenCalledWith('open_artifact_widget', {
      artifactId: MCP_APP.id,
      title: MCP_APP.title,
    })
  })

  it('Delete button: sends { type: "artifact-unpin", id }', () => {
    const { container } = boot()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [MCP_APP] })

    const delBtn = findButton(container, 'Delete')
    act(() => {
      delBtn.click()
    })

    expect(lastSent()).toEqual({ type: 'artifact-unpin', id: MCP_APP.id })
  })

  it('Save (new): sends artifact-pin with correct slugified id', () => {
    const { container } = boot()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [] })

    const titleInput = container.querySelector('[data-testid="apps-title-input"]') as HTMLInputElement
    const contentInput = container.querySelector('[data-testid="apps-content-input"]') as HTMLTextAreaElement
    const kindSelect = container.querySelector('[data-testid="apps-kind-select"]') as HTMLSelectElement
    const saveBtn = container.querySelector('[data-testid="apps-save-btn"]') as HTMLButtonElement

    typeInto(titleInput, 'My Dash')
    typeInto(contentInput, '<div>hello</div>')
    selectKind(kindSelect, 'mcp-app')
    act(() => {
      saveBtn.click()
    })

    expect(lastSent()).toEqual({
      type: 'artifact-pin',
      id: 'mcp-app:my-dash',
      title: 'My Dash',
      content: '<div>hello</div>',
      kind: 'mcp-app',
    })
  })

  it('Save (new): disambiguates id when slug already exists in list', () => {
    const { container } = boot()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({
      type: 'artifact-list',
      artifacts: [
        {
          id: 'mcp-app:my-dash',
          kind: 'mcp-app',
          title: 'My Dash',
          content: '<div>old</div>',
          lang: null,
          origin: null,
          version: 1,
          pinnedAt: 100,
          updatedAt: 100,
        },
      ],
    })

    const titleInput = container.querySelector('[data-testid="apps-title-input"]') as HTMLInputElement
    const contentInput = container.querySelector('[data-testid="apps-content-input"]') as HTMLTextAreaElement
    const kindSelect = container.querySelector('[data-testid="apps-kind-select"]') as HTMLSelectElement
    const saveBtn = container.querySelector('[data-testid="apps-save-btn"]') as HTMLButtonElement

    typeInto(titleInput, 'My Dash')
    typeInto(contentInput, '<div>new</div>')
    selectKind(kindSelect, 'mcp-app')
    act(() => {
      saveBtn.click()
    })

    expect(lastSent()).toEqual({
      type: 'artifact-pin',
      id: 'mcp-app:my-dash-2',
      title: 'My Dash',
      content: '<div>new</div>',
      kind: 'mcp-app',
    })
  })

  it('Edit then Save: sends a SINGLE artifact-edit (content-only) for the same id, never unpin+re-pin', () => {
    const { container } = boot()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [MCP_APP] })

    const editBtn = findButton(container, 'Edit')
    act(() => {
      editBtn.click()
    })

    const titleInput = container.querySelector('[data-testid="apps-title-input"]') as HTMLInputElement
    const contentInput = container.querySelector('[data-testid="apps-content-input"]') as HTMLTextAreaElement
    expect(titleInput.value).toBe(MCP_APP.title)
    expect(contentInput.value).toBe(MCP_APP.content)
    expect(titleInput.disabled).toBe(true)

    typeInto(contentInput, '<div>updated</div>')
    const saveBtn = container.querySelector('[data-testid="apps-save-btn"]') as HTMLButtonElement
    act(() => {
      saveBtn.click()
    })

    const sent = allSent()
    expect(sent[sent.length - 1]).toEqual({
      type: 'artifact-edit',
      id: MCP_APP.id,
      content: '<div>updated</div>',
    })
    expect(sent.some((f) => f.type === 'artifact-unpin')).toBe(false)
    expect(sent.some((f) => f.type === 'artifact-pin')).toBe(false)
  })
})

describe('isSettingsAppsPanelType', () => {
  it('routes the "settings.apps" panel.html type only', () => {
    expect(isSettingsAppsPanelType('settings.apps')).toBe(true)
    expect(isSettingsAppsPanelType('settings.skills')).toBe(false)
    expect(isSettingsAppsPanelType('flow')).toBe(false)
  })
})

describe('mountSettingsAppsPanel (panel.html contract parity)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__PanelInternals
  })

  it("sets the bar title, document title, renders into #content-area, and sets __PanelInternals — matching what panel.html's bootModule() sets for vanilla panel types", () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const { ctx } = makeCtx()
    act(() => {
      mountSettingsAppsPanel('settings.apps', ctx)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(SETTINGS_APPS_TITLE)
    expect(document.title).toBe(`Luna — ${SETTINGS_APPS_TITLE}`)
    expect(document.querySelector('#content-area [data-testid="settings-apps-panel"]')).toBeTruthy()
    expect((window as any).__PanelInternals).toEqual({
      type: 'settings.apps',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
