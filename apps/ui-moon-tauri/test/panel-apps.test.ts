// @vitest-environment jsdom
//
// Behavioral tests for settings.apps panel module.
// Mirrors the panel-skills.test.ts harness: MockWebSocket, loadVendorInto,
// bootPanel, flushPromises, fireFrame, lastSent.
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

  // MockWebSocket must be installed BEFORE vendor files.
  ;(window as any).WebSocket = MockWebSocket

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'deck-snap.js')
  loadVendorInto(window, 'moon-dock.js')

  // Preload the panel module.
  const moduleFile = path.resolve(
    __dirname,
    '../frontend/panels',
    opts.type.replace(/\./g, '-') + '.js',
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

/** Return all frames sent since the WS connected (parsed). */
function allSent(): any[] {
  const sock = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  return sock.sent.map((s) => JSON.parse(s))
}

function lastSent(): any {
  const sent = allSent()
  return sent[sent.length - 1] ?? null
}

// ── Fixture artifacts ─────────────────────────────────────────────────────
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

describe('settings.apps panel', () => {
  // 1. !caps.artifacts → renders the unsupported notice, no list.
  it('hello without artifacts capability: renders unsupported notice, no list', async () => {
    bootPanel({ type: 'settings.apps' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })

    const notice = document.querySelector('.notice')
    expect(notice).toBeTruthy()
    expect(notice!.textContent).toBe("This server doesn't support apps.")
    // The list element should have been removed by el.replaceChildren(notice).
    expect(document.getElementById('apps-list')).toBeNull()
  })

  // 2. artifact-list with mix → only mcp-app + widget rows rendered.
  it('artifact-list: filters to mcp-app + widget, excludes markdown', async () => {
    bootPanel({ type: 'settings.apps' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [MCP_APP, WIDGET, MARKDOWN] })

    const rows = document.querySelectorAll('.app-row')
    expect(rows).toHaveLength(2)

    const texts = Array.from(rows).map((r) => r.textContent ?? '')
    expect(texts.some((t) => t.includes('Pulse Dash'))).toBe(true)
    expect(texts.some((t) => t.includes('Live Feed'))).toBe(true)
    expect(texts.some((t) => t.includes('README'))).toBe(false)

    // Kind badges present.
    const badges = document.querySelectorAll('.app-kind-badge')
    const badgeTexts = Array.from(badges).map((b) => b.textContent)
    expect(badgeTexts).toContain('app')
    expect(badgeTexts).toContain('widget')
  })

  // 3. Open button → ctx.invoke called with the right command + args.
  it('Open button: calls invoke("open_artifact_widget", { artifactId, title })', async () => {
    const invokeImpl = vi.fn(async () => null)
    const { invoke } = bootPanel({ type: 'settings.apps', invoke: invokeImpl })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [MCP_APP] })

    const openBtn = Array.from(document.querySelectorAll('.app-btn')).find(
      (b) => b.textContent === 'Open',
    ) as HTMLElement
    expect(openBtn).toBeTruthy()
    openBtn.click()

    expect(invoke).toHaveBeenCalledWith('open_artifact_widget', {
      artifactId: MCP_APP.id,
      title: MCP_APP.title,
    })
  })

  // 4. Delete button → sends artifact-unpin frame with the artifact id.
  it('Delete button: sends { type:"artifact-unpin", id }', async () => {
    bootPanel({ type: 'settings.apps' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [MCP_APP] })

    const delBtn = Array.from(document.querySelectorAll('.app-btn')).find(
      (b) => b.textContent === 'Delete',
    ) as HTMLElement
    expect(delBtn).toBeTruthy()
    delBtn.click()

    expect(lastSent()).toEqual({ type: 'artifact-unpin', id: MCP_APP.id })
  })

  // 5. Save (new) with title "My Dash" → artifact-pin with id mcp-app:my-dash.
  it('Save (new): sends artifact-pin with correct slugified id', async () => {
    bootPanel({ type: 'settings.apps' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [] })

    const titleInput = document.getElementById('apps-title-input') as HTMLInputElement
    const contentInput = document.getElementById('apps-content-input') as HTMLTextAreaElement
    const kindSelect = document.getElementById('apps-kind-select') as HTMLSelectElement
    const saveBtn = document.getElementById('apps-save-btn') as HTMLButtonElement

    titleInput.value = 'My Dash'
    contentInput.value = '<div>hello</div>'
    kindSelect.value = 'mcp-app'
    saveBtn.click()

    expect(lastSent()).toEqual({
      type: 'artifact-pin',
      id: 'mcp-app:my-dash',
      title: 'My Dash',
      content: '<div>hello</div>',
      kind: 'mcp-app',
    })
  })

  // 6. Save (new) when mcp-app:my-dash already exists → disambiguates to mcp-app:my-dash-2.
  it('Save (new): disambiguates id when slug already exists in list', async () => {
    bootPanel({ type: 'settings.apps' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    // Pre-load a list that already contains mcp-app:my-dash.
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

    const titleInput = document.getElementById('apps-title-input') as HTMLInputElement
    const contentInput = document.getElementById('apps-content-input') as HTMLTextAreaElement
    const kindSelect = document.getElementById('apps-kind-select') as HTMLSelectElement
    const saveBtn = document.getElementById('apps-save-btn') as HTMLButtonElement

    titleInput.value = 'My Dash'
    contentInput.value = '<div>new</div>'
    kindSelect.value = 'mcp-app'
    saveBtn.click()

    expect(lastSent()).toEqual({
      type: 'artifact-pin',
      id: 'mcp-app:my-dash-2',
      title: 'My Dash',
      content: '<div>new</div>',
      kind: 'mcp-app',
    })
  })

  // 7. Edit then Save → sends a SINGLE artifact-edit (store.update) for the id —
  //    NOT unpin+re-pin, which would destroy the version ledger + reset caps.
  it('Edit then Save: sends artifact-edit (content-only) for the same id, never unpin+re-pin', async () => {
    bootPanel({ type: 'settings.apps' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { artifacts: true } })
    fireFrame({ type: 'artifact-list', artifacts: [MCP_APP] })

    // Click Edit on MCP_APP row.
    const editBtn = Array.from(document.querySelectorAll('.app-btn')).find(
      (b) => b.textContent === 'Edit',
    ) as HTMLElement
    expect(editBtn).toBeTruthy()
    editBtn.click()

    // Verify the composer is pre-filled and title/kind are locked (edit =
    // content-only, since store.update preserves title/kind/caps).
    const titleInput = document.getElementById('apps-title-input') as HTMLInputElement
    const contentInput = document.getElementById('apps-content-input') as HTMLTextAreaElement
    expect(titleInput.value).toBe(MCP_APP.title)
    expect(contentInput.value).toBe(MCP_APP.content)
    expect(titleInput.disabled).toBe(true)

    // Mutate the content and save.
    contentInput.value = '<div>updated</div>'
    const saveBtn = document.getElementById('apps-save-btn') as HTMLButtonElement
    saveBtn.click()

    const sent = allSent()
    // Exactly one edit frame, and NO destructive unpin/re-pin during the edit.
    expect(sent[sent.length - 1]).toEqual({
      type: 'artifact-edit',
      id: MCP_APP.id,
      content: '<div>updated</div>',
    })
    expect(sent.some((f) => f.type === 'artifact-unpin')).toBe(false)
    expect(sent.some((f) => f.type === 'artifact-pin')).toBe(false)
  })
})
