// @vitest-environment jsdom
//
// Behavioral tests for settings.skills panel module.
// Drives the REAL module through the REAL panel.html inline script via the
// bootPanel harness (verbatim copy from panel-window.test.ts, adjusted for
// this type). MockWebSocket is installed BEFORE vendor files are loaded.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── MockWebSocket ─────────────────────────────────────────────────────────
// Copied from moon-vendor.test.ts — scriptable transport for WS-backed panels.
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
    // Always resolve load_connection with test credentials so the WS client
    // actually calls new WebSocket() (inside the connectWs .then()).
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

const SKILL_A = { id: 'skill-a', name: 'Alpha', description: 'Does alpha things', enabled: true, source: 'builtin', category: 'writing', tags: [] }
const SKILL_B = { id: 'skill-b', name: 'Beta', description: 'Does beta things', enabled: false, source: 'user', category: 'code', tags: ['js'] }

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

describe('settings.skills panel', () => {
  it('initial render: title is "Skills", key DOM nodes are present', () => {
    bootPanel({ type: 'settings.skills' })
    expect(document.getElementById('bar-title')!.textContent).toBe('Skills')
    expect(document.getElementById('skills-search-input')).toBeTruthy()
    expect(document.getElementById('skills-list')).toBeTruthy()
    expect(document.getElementById('skills-error')).toBeTruthy()
    expect(document.getElementById('skills-count')).toBeTruthy()
    expect(document.getElementById('skills-chips')).toBeTruthy()
  })

  it('initial render: list shows "Not connected" placeholder before WS connects', () => {
    bootPanel({ type: 'settings.skills' })
    const list = document.getElementById('skills-list')!
    expect(list.textContent).toContain('Not connected')
  })

  it('hello without skills capability: replaces content with notice, no list', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: {} })
    expect(document.querySelector('.notice')!.textContent).toBe(
      "This server doesn't list skills."
    )
    expect(document.getElementById('skills-list')).toBeNull()
  })

  it('hello with skills capability: list remains visible (controls stay rendered)', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    // Controls still present — catalog not yet received.
    expect(document.getElementById('skills-list')).toBeTruthy()
    expect(document.querySelector('.notice')).toBeNull()
  })

  it('skill-catalog frame: renders skill rows with correct names and states', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const rows = document.querySelectorAll('.skill-row')
    expect(rows).toHaveLength(2)

    const alphaRow = rows[0]
    expect(alphaRow.textContent).toContain('Alpha')
    // Enabled skill: no 'off' class.
    expect(alphaRow.classList.contains('off')).toBe(false)
    // aria-checked
    expect(alphaRow.getAttribute('aria-checked')).toBe('true')

    const betaRow = rows[1]
    expect(betaRow.textContent).toContain('Beta')
    // Disabled skill: has 'off' class.
    expect(betaRow.classList.contains('off')).toBe(true)
    expect(betaRow.getAttribute('aria-checked')).toBe('false')
  })

  it('skill-catalog frame: count badge reflects enabled/total', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })
    const count = document.getElementById('skills-count')!
    expect(count.textContent).toContain('1/2')
  })

  it('clicking an enabled skill row sends skill-toggle with enabled:false', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const alphaRow = document.querySelectorAll('.skill-row')[0] as HTMLElement
    alphaRow.click()

    const sent = lastSent()
    expect(sent).toEqual({ type: 'skill-toggle', id: 'skill-a', enabled: false })
  })

  it('clicking a disabled skill row sends skill-toggle with enabled:true', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const betaRow = document.querySelectorAll('.skill-row')[1] as HTMLElement
    betaRow.click()

    const sent = lastSent()
    expect(sent).toEqual({ type: 'skill-toggle', id: 'skill-b', enabled: true })
  })

  it('toggle puts the row into pending (aria-busy) until skill-status acks', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const alphaRow = document.querySelectorAll('.skill-row')[0] as HTMLElement
    alphaRow.click()

    // After click: row should be pending.
    const pendingRow = document.querySelectorAll('.skill-row')[0]
    expect(pendingRow.classList.contains('pending')).toBe(true)
    expect(pendingRow.getAttribute('aria-busy')).toBe('true')

    // skill-status ack clears pending and updates enabled state.
    fireFrame({ type: 'skill-status', id: 'skill-a', ok: true, enabled: false })
    const settledRow = document.querySelectorAll('.skill-row')[0]
    expect(settledRow.classList.contains('pending')).toBe(false)
    expect(settledRow.getAttribute('aria-checked')).toBe('false')
  })

  it('skill-status with ok:false shows the error message', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A] })

    const row = document.querySelector('.skill-row') as HTMLElement
    row.click()

    fireFrame({ type: 'skill-status', id: 'skill-a', ok: false, message: 'Server rejected toggle' })

    const errorEl = document.getElementById('skills-error')!
    expect(errorEl.hidden).toBe(false)
    expect(errorEl.textContent).toBe('Server rejected toggle')
  })

  it('search input filters the list by skill name', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    const input = document.getElementById('skills-search-input') as HTMLInputElement
    input.value = 'Beta'
    input.dispatchEvent(new Event('input'))

    const rows = document.querySelectorAll('.skill-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Beta')
  })

  it('category chip filters the list', async () => {
    bootPanel({ type: 'settings.skills' })
    await flushPromises()
    fireFrame({ type: 'hello', capabilities: { skills: true } })
    fireFrame({ type: 'skill-catalog', skills: [SKILL_A, SKILL_B] })

    // chips: 'all', 'code', 'writing', 'built-in', 'yours', 'enabled only'
    const chips = document.querySelectorAll('.skills-chip')
    // Find the 'code' chip
    let codeChip: Element | null = null
    chips.forEach((c) => { if (c.textContent === 'code') codeChip = c })
    expect(codeChip).toBeTruthy()
    ;(codeChip as HTMLElement).click()

    const rows = document.querySelectorAll('.skill-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Beta')
  })

  it('load_connection is invoked to get WS credentials', () => {
    const { invoke } = bootPanel({ type: 'settings.skills' })
    // load_connection should have been called (fire-and-forget from ctx.connectWs).
    expect(invoke).toHaveBeenCalledWith('load_connection')
  })
})
