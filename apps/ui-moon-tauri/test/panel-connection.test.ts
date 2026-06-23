// @vitest-environment jsdom
//
// Behavioral tests for the settings.connection panel module.
// Drives the REAL module through the REAL panel.html inline script,
// following the bootPanel harness in panel-window.test.ts exactly.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/panel.html'), 'utf8')

function bootPanel(opts: { type: string; invoke?: (cmd: string, args?: any) => any }) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  const invoke = vi.fn(async (cmd: string, args?: any) => (opts.invoke ? opts.invoke(cmd, args) : null))
  const me = {
    label: 'panel-' + opts.type.replace(/\./g, '-'),
    listen: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 360, height: 400 })),
    scaleFactor: vi.fn(async () => 1),
  }
  ;(window as any).__TAURI__ = {
    window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
    core: { invoke },
    event: { listen: vi.fn(async () => () => {}) },
  }

  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(opts.type))

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'deck-snap.js')
  loadVendorInto(window, 'moon-dock.js')

  // Preload the panel module (jsdom never fetches the loader's injected <script src>)
  const moduleFile = path.resolve(__dirname, '../frontend/panels', opts.type.replace(/\./g, '-') + '.js')
  if (fs.existsSync(moduleFile)) {
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)
  }

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  // jsdom never loads injected <script src> tags: fire error so unknown types reach notice path.
  const injected = document.head.querySelector('script[src^="panels/"]')
  if (injected) injected.dispatchEvent(new Event('error'))

  return { invoke }
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
  localStorage.clear()
  vi.restoreAllMocks()
})

// ── Helper to flush microtasks (await async event handlers) ──────────────────
function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('settings.connection panel', () => {

  it('renders the panel with correct title and core elements', async () => {
    bootPanel({
      type: 'settings.connection',
      invoke: () => null,
    })
    await flush()
    expect(document.getElementById('bar-title')!.textContent).toBe('Connection')
    expect(document.getElementById('channel-select')).toBeTruthy()
    expect(document.getElementById('model-select')).toBeTruthy()
    expect(document.getElementById('ws-url-input')).toBeTruthy()
    expect(document.getElementById('ws-token-input')).toBeTruthy()
    expect(document.getElementById('save-connection-btn')).toBeTruthy()
    expect(document.getElementById('open-wizard-btn')).toBeTruthy()
  })

  it('populates url and token inputs from load_connection on render', async () => {
    bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_connection') return { wsUrl: 'ws://myhost:4753/ui', wsToken: 'tok123' }
        if (cmd === 'load_profiles') return { activeProfile: 'stable' }
        return null
      },
    })
    await flush()
    expect((document.getElementById('ws-url-input') as HTMLInputElement).value).toBe('ws://myhost:4753/ui')
    expect((document.getElementById('ws-token-input') as HTMLInputElement).value).toBe('tok123')
  })

  it('sets channel-select to activeProfile from load_profiles', async () => {
    bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_profiles') return { activeProfile: 'dev' }
        return null
      },
    })
    await flush()
    const sel = document.getElementById('channel-select') as HTMLSelectElement
    expect(sel.value).toBe('dev')
  })

  it('channel change invokes set_active_profile with { name } and hub_event profile-changed', async () => {
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_profiles') return { activeProfile: 'stable' }
        if (cmd === 'set_active_profile') return { wsUrl: 'ws://dev:4753/ui', wsToken: '' }
        return null
      },
    })
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    sel.value = 'dev'
    sel.dispatchEvent(new Event('change'))
    await flush()

    expect(invoke).toHaveBeenCalledWith('set_active_profile', { name: 'dev' })
    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
  })

  it('channel change shows error and does NOT fire hub_event when set_active_profile rejects', async () => {
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_profiles') return { activeProfile: 'stable' }
        if (cmd === 'set_active_profile') throw new Error('binary mismatch')
        return null
      },
    })
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    sel.value = 'dev'
    sel.dispatchEvent(new Event('change'))
    await flush()

    const errEl = document.getElementById('channel-error')!
    expect(errEl.hidden).toBe(false)
    expect(errEl.textContent).toContain('binary mismatch')
    // hub_event should NOT have been called
    expect(invoke).not.toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
  })

  it('model select sets luna_model in localStorage when a model is chosen', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify(['claude-3-opus', 'claude-3-haiku']))
    bootPanel({
      type: 'settings.connection',
      invoke: () => null,
    })
    await flush()

    const sel = document.getElementById('model-select') as HTMLSelectElement
    sel.value = 'claude-3-opus'
    sel.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_model')).toBe('claude-3-opus')
  })

  it('model select removes luna_model from localStorage when "Server default" is chosen', async () => {
    localStorage.setItem('luna_model', 'claude-3-opus')
    localStorage.setItem('luna_available_models', JSON.stringify(['claude-3-opus']))
    bootPanel({
      type: 'settings.connection',
      invoke: () => null,
    })
    await flush()

    const sel = document.getElementById('model-select') as HTMLSelectElement
    sel.value = ''
    sel.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_model')).toBeNull()
  })

  it('model select restores persisted luna_model as initial selection', async () => {
    localStorage.setItem('luna_model', 'claude-3-haiku')
    localStorage.setItem('luna_available_models', JSON.stringify(['claude-3-opus', 'claude-3-haiku']))
    bootPanel({
      type: 'settings.connection',
      invoke: () => null,
    })
    await flush()

    const sel = document.getElementById('model-select') as HTMLSelectElement
    expect(sel.value).toBe('claude-3-haiku')
  })

  it('save button invokes save_connection with { url, token } and hub_event connection-changed', async () => {
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_connection') return { wsUrl: 'ws://127.0.0.1:4753/ui', wsToken: '' }
        return null
      },
    })
    await flush()

    const urlInput = document.getElementById('ws-url-input') as HTMLInputElement
    const tokenInput = document.getElementById('ws-token-input') as HTMLInputElement
    urlInput.value = 'ws://newhost:9000/ui'
    tokenInput.value = 'mytoken'

    document.getElementById('save-connection-btn')!.click()
    await flush()

    expect(invoke).toHaveBeenCalledWith('save_connection', { url: 'ws://newhost:9000/ui', token: 'mytoken' })
    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'connection-changed' })
  })

  it('save button shows Saved ✓ on success and does NOT wipe the token field', async () => {
    bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'save_connection') return null
        return null
      },
    })
    await flush()

    const tokenInput = document.getElementById('ws-token-input') as HTMLInputElement
    tokenInput.value = 'keepme'

    document.getElementById('save-connection-btn')!.click()
    await flush()

    await vi.waitFor(() =>
      expect(document.getElementById('save-connection-status')!.textContent).toBe('Saved ✓'))
    // Token field must NOT be wiped — engine never clears it on save
    expect(tokenInput.value).toBe('keepme')
  })

  it('save button shows error on save_connection failure', async () => {
    bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'save_connection') throw new Error('disk full')
        return null
      },
    })
    await flush()

    document.getElementById('save-connection-btn')!.click()
    await flush()

    await vi.waitFor(() =>
      expect(document.getElementById('save-connection-status')!.textContent).toContain('Save failed'))
    expect(document.getElementById('save-connection-status')!.textContent).toContain('disk full')
    const btn = document.getElementById('save-connection-btn') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('open-wizard button fires hub_event open-wizard', async () => {
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: () => null,
    })
    await flush()

    document.getElementById('open-wizard-btn')!.click()
    await flush()

    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'open-wizard' })
  })

  // ── New cache shape (extended: {id, label, efforts} objects) ────────────

  it('model select shows label text from new-shape cache (not raw id)', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5 (1M context)', efforts: ['low', 'max'] },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ]))
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const sel = document.getElementById('model-select') as HTMLSelectElement
    const opts = Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent }))
    expect(opts.find((o) => o.value === 'claude-fable-5')?.text).toBe('Fable 5 (1M context)')
    expect(opts.find((o) => o.value === 'claude-haiku-4-5')?.text).toBe('Haiku 4.5')
  })

  it('model select back-compat: accepts legacy plain-id string array', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify(['claude-3-opus', 'claude-3-haiku']))
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const sel = document.getElementById('model-select') as HTMLSelectElement
    expect(sel.options.length).toBeGreaterThanOrEqual(3) // default + 2 models
    expect(Array.from(sel.options).some((o) => o.value === 'claude-3-opus')).toBe(true)
    // Legacy: no label → id is used as text
    const opusOpt = Array.from(sel.options).find((o) => o.value === 'claude-3-opus')!
    expect(opusOpt.textContent).toBe('claude-3-opus')
  })

  it('effort select is hidden when selected model has no efforts', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ]))
    localStorage.setItem('luna_model', 'claude-haiku-4-5')
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const effortRow = document.getElementById('effort-row') as HTMLElement
    expect(effortRow.hidden).toBe(true)
  })

  it('effort select is visible when selected model has efforts', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const effortRow = document.getElementById('effort-row') as HTMLElement
    expect(effortRow.hidden).toBe(false)
    const sel = document.getElementById('effort-select') as HTMLSelectElement
    expect(sel).toBeTruthy()
    const effortValues = Array.from(sel.options).map((o) => o.value)
    expect(effortValues).toContain('low')
    expect(effortValues).toContain('max')
  })

  it('effort select restores persisted luna_effort', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    localStorage.setItem('luna_effort', 'max')
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const sel = document.getElementById('effort-select') as HTMLSelectElement
    expect(sel.value).toBe('max')
  })

  it('effort select change writes luna_effort to localStorage', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const sel = document.getElementById('effort-select') as HTMLSelectElement
    sel.value = 'low'
    sel.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_effort')).toBe('low')
  })

  it('effort select change to Default removes luna_effort from localStorage', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    localStorage.setItem('luna_effort', 'max')
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const sel = document.getElementById('effort-select') as HTMLSelectElement
    sel.value = ''
    sel.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_effort')).toBeNull()
  })

  it('changing model updates effort select to that model\'s efforts and hides row when empty', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const modelSel = document.getElementById('model-select') as HTMLSelectElement
    const effortRow = document.getElementById('effort-row') as HTMLElement
    expect(effortRow.hidden).toBe(false)

    modelSel.value = 'claude-haiku-4-5'
    modelSel.dispatchEvent(new Event('change'))

    expect(effortRow.hidden).toBe(true)
  })

  it('changing to model without saved effort support clears luna_effort', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    localStorage.setItem('luna_effort', 'max')
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const modelSel = document.getElementById('model-select') as HTMLSelectElement
    modelSel.value = 'claude-haiku-4-5'
    modelSel.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_effort')).toBeNull()
  })

})

// ── C8: Channel select route enumeration ──────────────────────────────────────
// These tests verify that when MoonSession.listRoutes() is available, the
// channel-select is populated with N real routes from client.toml instead of
// the hardcoded ['stable','dev'] fallback.

describe('settings.connection — C8 channel select route enumeration', () => {
  afterEach(() => {
    delete (window as any).MoonSession
  })

  it('populates channel-select from MoonSession.listRoutes() when available', async () => {
    // Inject MoonSession stub before the panel renders.
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'prod',
        routes: [
          { key: 'prod',  label: 'Production' },
          { key: 'local', label: 'Local Dev'  },
          { key: 'beta',  label: 'Beta'       },
        ],
      }),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }

    bootPanel({ type: 'settings.connection', invoke: () => null })
    // Two flushes: sync render + async listRoutes promise.
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    const opts = Array.from(sel.options).map((o) => o.value)

    // After async population the select should contain the 3 real routes.
    expect(opts).toContain('prod')
    expect(opts).toContain('local')
    expect(opts).toContain('beta')
  })

  it('uses label text from listRoutes, not raw key', async () => {
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'prod',
        routes: [{ key: 'prod', label: 'Production Server' }],
      }),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }

    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    const prodOpt = Array.from(sel.options).find((o) => o.value === 'prod')
    expect(prodOpt?.textContent).toBe('Production Server')
  })

  it('falls back to stable/dev hardcoded options when MoonSession is absent', async () => {
    // No MoonSession on window.
    delete (window as any).MoonSession

    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    const opts = Array.from(sel.options).map((o) => o.value)
    expect(opts).toContain('stable')
    expect(opts).toContain('dev')
  })

  it('falls back to hardcoded list when listRoutes() returns null', async () => {
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue(null),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }

    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    const opts = Array.from(sel.options).map((o) => o.value)
    expect(opts).toContain('stable')
    expect(opts).toContain('dev')
  })

  it('falls back when listRoutes() rejects', async () => {
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockRejectedValue(new Error('Tauri down')),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }

    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    const opts = Array.from(sel.options).map((o) => o.value)
    expect(opts).toContain('stable')
    expect(opts).toContain('dev')
  })

  it('active profile NOT in listRoutes keys is still present + selected after enumeration', async () => {
    // C8 race: client.toml route keys can diverge from profile names.
    // load_profiles resolves with activeProfile='my-custom' but listRoutes only
    // returns ['prod', 'local'].  The repopulate clears all options then adds
    // only prod/local — without the fix, value='my-custom' silently no-ops.
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'prod',
        routes: [
          { key: 'prod',  label: 'Production' },
          { key: 'local', label: 'Local Dev'  },
        ],
      }),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }

    bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_profiles') return { activeProfile: 'my-custom' }
        return null
      },
    })
    // Three flushes: sync render, load_profiles microtask, listRoutes microtask.
    await flush()
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    const optValues = Array.from(sel.options).map((o) => o.value)
    // The dynamic option must have been appended.
    expect(optValues).toContain('my-custom')
    // And the select must reflect it as the current selection.
    expect(sel.value).toBe('my-custom')
  })
})
