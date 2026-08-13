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
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)
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

    // Step 1a: `profile` always targets the currently-selected channel (here
    // the un-migrated fallback default, 'stable') - see the module comment
    // on the save handler and the dedicated save-target test below.
    expect(invoke).toHaveBeenCalledWith('save_connection', { url: 'ws://newhost:9000/ui', token: 'mytoken', profile: 'stable' })
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

  it('Step 1a INVERSION: once routes are known, a divergent load_profiles activeProfile is never appended nor selected', async () => {
    // Pre-Step-1a this test asserted the OPPOSITE: that a divergent
    // activeProfile ('my-custom') got appended as a dynamic option AND
    // selected (the old C8 race-handling behavior). Step 1a
    // (docs/next/routes-and-view-mode-plan.md) deliberately kills that
    // behavior once client.toml routes exist: the select's value and
    // options must come from list_routes() alone, gated by
    // `channelSelect._routesKnown`, never a moon-connection.json
    // activeProfile that can name a stale or divergent profile. This
    // inversion is deliberate, not a regression - see the React port's
    // parallel test and connectionReducer.ts's routesKnown doc comment.
    // default is deliberately the NON-FIRST route key, so an implementation
    // that ignores it and takes the first option must fail here (review
    // finding: first-or-invalid defaults everywhere else made defaultKey
    // sourcing indistinguishable from options[0]).
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'local',
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
    expect(optValues).toEqual(['prod', 'local'])
    expect(optValues).not.toContain('my-custom')
    expect(sel.value).toBe('local')
  })
})

// ── F1 (opus review): defaultKey must be a real member of the reported
// routes, not taken on faith. A dangling default (Gate 0.1 world (c)) or an
// empty-string default must fall through to the first real option instead of
// blanking the select (jsdom-verified: assigning a non-matching value sets
// selectedIndex -1). The fix relies on addOption's own isDefault flag doing
// nothing when no key matches, letting the browser's natural "select the
// first appended option" default take over - see populateChannelSelect.
describe('settings.connection - Step 1a: F1 defaultKey validation', () => {
  afterEach(() => {
    delete (window as any).MoonSession
  })

  it('a defaultKey not among the reported routes selects the first option, never blanks the select', async () => {
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'ghost-route', // dangling - not in routes below
        routes: [{ key: 'prod', label: 'Production' }, { key: 'local', label: 'Local Dev' }],
      }),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    expect(sel.value).toBe('prod')
    expect(sel.value).not.toBe('')
  })

  it('an empty-string defaultKey also falls through to the first option, never blanks the select', async () => {
    // PURE GUARD, non-discriminating (unlike the React twin): the old vanilla
    // code's truthy check already excluded '', so this case was never broken
    // here. Kept as invariant documentation for twin symmetry.
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: '',
        routes: [{ key: 'prod', label: 'Production' }, { key: 'local', label: 'Local Dev' }],
      }),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }
    bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    expect(sel.value).toBe('prod')
    expect(sel.value).not.toBe('')
  })
})

// ── Step 1a: load_profiles/listRoutes arrival-order convergence ────────────
// The _routesKnown quarantine must produce the SAME final select state
// regardless of which of the two async loads (load_profiles vs
// MoonSession.listRoutes) resolves first - see plan Step 1a's DECIDE on
// severing both legacy paths. Each test controls resolution order explicitly
// via a manually-gated promise per command.
describe('settings.connection - Step 1a: load_profiles/listRoutes arrival order', () => {
  afterEach(() => {
    delete (window as any).MoonSession
  })

  function makeDeferredHarness() {
    let resolveProfiles!: () => void
    let resolveRoutes!: () => void
    const profilesGate = new Promise<void>((resolve) => { resolveProfiles = resolve })
    const routesGate = new Promise<void>((resolve) => { resolveRoutes = resolve })
    ;(window as any).MoonSession = {
      listRoutes: vi.fn(() => routesGate.then(() => ({
        default: 'prod',
        routes: [
          { key: 'prod',  label: 'Production' },
          { key: 'local', label: 'Local Dev'  },
        ],
      }))),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }
    bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_profiles') return profilesGate.then(() => ({ activeProfile: 'my-custom' }))
        return null
      },
    })
    return { resolveProfiles, resolveRoutes }
  }

  it('load_profiles resolving BEFORE listRoutes still ends with routes owning the select', async () => {
    const { resolveProfiles, resolveRoutes } = makeDeferredHarness()
    await flush()

    resolveProfiles()
    await flush()
    resolveRoutes()
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    const optValues = Array.from(sel.options).map((o) => o.value)
    expect(optValues).toEqual(['prod', 'local'])
    expect(optValues).not.toContain('my-custom')
    expect(sel.value).toBe('prod')
  })

  it('listRoutes resolving BEFORE load_profiles already owns the select, and the later load_profiles is inert', async () => {
    const { resolveProfiles, resolveRoutes } = makeDeferredHarness()
    await flush()

    resolveRoutes()
    await flush()
    await flush()
    resolveProfiles()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    const optValues = Array.from(sel.options).map((o) => o.value)
    expect(optValues).toEqual(['prod', 'local'])
    expect(optValues).not.toContain('my-custom')
    expect(sel.value).toBe('prod')
  })
})

// ── Step 1a: the guarded route switch ───────────────────────────────────────
// docs/next/routes-and-view-mode-plan.md's Step 1a: once client.toml routes
// are known, the channel change handler becomes a guarded dual write
// (set_active_profile then MoonSession.setDefaultRoute, in that order) with
// two refusal guards ahead of it, instead of the bare set_active_profile
// call the un-migrated-world tests above still exercise. Mirrors the React
// port's parallel describe block exactly (same vanilla module, no reducer).
describe('settings.connection - Step 1a: the guarded route switch', () => {
  afterEach(() => {
    delete (window as any).MoonSession
  })

  function stubRoutes(routes: Array<{ key: string; label: string }>, defaultKey: string) {
    return {
      listRoutes: vi.fn().mockResolvedValue({ default: defaultKey, routes }),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }
  }

  it('a guarded switch calls set_active_profile before setDefaultRoute, both with the target key, then hub_event', async () => {
    const callOrder: string[] = []
    const setDefaultRoute = vi.fn(async (key: string) => {
      callOrder.push('setDefaultRoute:' + key)
      return true
    })
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
        if (cmd === 'resolve_route_token') return 'TOK-CANARY-RESOLVED'
        if (cmd === 'set_active_profile') {
          callOrder.push('set_active_profile:canary')
          return { wsUrl: 'ws://canary:4753/ui', wsToken: 'TOK-CANARY' }
        }
        return null
      },
    })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    sel.value = 'canary'
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()

    expect(callOrder).toEqual(['set_active_profile:canary', 'setDefaultRoute:canary'])
    expect(invoke).toHaveBeenCalledWith('set_active_profile', { name: 'canary' })
    expect(setDefaultRoute).toHaveBeenCalledWith('canary')
    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
    expect(document.getElementById('channel-error')!.hidden).toBe(true)
  })

  it('setDefaultRoute resolving false refuses the switch visibly and fires no hub_event (the named trap: it never rejects)', async () => {
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute: vi.fn().mockResolvedValue(false),
    }
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
        if (cmd === 'resolve_route_token') return 'TOK-CANARY-RESOLVED'
        if (cmd === 'set_active_profile') return { wsUrl: 'ws://canary:4753/ui', wsToken: 'TOK-CANARY' }
        return null
      },
    })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    sel.value = 'canary'
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()

    const errEl = document.getElementById('channel-error')!
    expect(errEl.hidden).toBe(false)
    expect(errEl.textContent).toContain('canary')
    expect(invoke).not.toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
    // F2(b): this is NOT the pairing case - the selector must revert to the
    // PREVIOUS channel, since the switch did not happen (the two stores are
    // intentionally left half-moved: activeProfile advanced, default did not).
    expect((document.getElementById('channel-select') as HTMLSelectElement).value).toBe('stable')
  })

  it('a non-route-key value is refused as defense in depth (unreachable via rendered options once quarantined - stale DOM/race only)', async () => {
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }], 'stable'),
      setDefaultRoute: vi.fn().mockResolvedValue(true),
    }
    const { invoke } = bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()
    await flush()

    // Once _routesKnown, the select is rebuilt to hold EXACTLY the route
    // keys, so a real user can never select a non-route-key value. GUARD 1
    // in this vanilla module reads the LIVE `channelSelect.options` (there
    // is no separate reducer state to diverge from, unlike the React port) -
    // so a genuinely appended <option> would trivially satisfy the guard's
    // own membership scan and prove nothing. Overriding `.value` with a
    // full get/set pair (backed by a local variable, not the native slot)
    // is what actually reaches GUARD 1 AND survives the implementation's
    // own revert-on-refusal write (F2b: a getter-only override would throw
    // when the handler tries to assign `.value = previous`): it simulates a
    // value arriving at the handler that does NOT correspond to any current
    // option (a race where the options were rebuilt out from under an
    // in-flight selection), without also making the DOM lie to the guard's
    // own check.
    const sel = document.getElementById('channel-select') as HTMLSelectElement
    let fakeValue = 'not-a-route'
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get: () => fakeValue,
      set: (v: string) => { fakeValue = v },
    })
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()

    const errEl = document.getElementById('channel-error')!
    expect(errEl.hidden).toBe(false)
    expect(errEl.textContent).toContain('not-a-route')
    expect(invoke).not.toHaveBeenCalledWith('load_route', { routeKey: 'not-a-route' })
    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'not-a-route' })
    // F2(b): reverted to the previous (initial default) channel.
    expect(sel.value).toBe('stable')
  })

  it('a legacy-sentinel route with no matching profile token is refused, naming the route, without ever calling setDefaultRoute', async () => {
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
        if (cmd === 'resolve_route_token') {
          throw new Error('not-paired: route "canary" has no token paired in moon-connection.json')
        }
        return null
      },
    })
    await flush()
    await flush()

    // A stale value in the token field, to prove the F2(a) clear is real.
    const tokenInputBefore = document.getElementById('ws-token-input') as HTMLInputElement
    tokenInputBefore.value = 'stale-stable-token'

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    sel.value = 'canary'
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()

    expect(sel.value).toBe('canary') // refused selections stay selected (the pairing UX)
    const errEl = document.getElementById('channel-error')!
    expect(errEl.hidden).toBe(false)
    expect(errEl.textContent).toContain('canary')
    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'canary' })
    // F2(a): the fields show the TARGET route's real endpoint and an EMPTY
    // token - never 'stable's stale creds displayed under 'canary's name.
    const urlInput = document.getElementById('ws-url-input') as HTMLInputElement
    const tokenInput = document.getElementById('ws-token-input') as HTMLInputElement
    expect(urlInput.value).toBe('ws://canary:4753/ui')
    expect(tokenInput.value).toBe('')
    expect(setDefaultRoute).not.toHaveBeenCalled()
  })

  it('#F1: a missing moon-connection.json store (not just an unpaired profile) still fires the pairing prompt, not the revert', async () => {
    // The exact message shape connection.rs's resolve_route_token now emits
    // for an ABSENT store (F1, opus review on plan Step 1b) - distinct from
    // the "no matching profile token" wording the test above uses. Before
    // the fix this path returned "store-read:" (a RETRYABLE class), which
    // never reaches this branch and instead reverts the selector; this pins
    // that the whole-store-missing case is durable and pairing-prompted,
    // exactly like the no-matching-profile case.
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
        if (cmd === 'resolve_route_token') {
          throw new Error('not-paired: route "canary" has no credential store yet - pair it to create one')
        }
        return null
      },
    })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    sel.value = 'canary'
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()

    expect(sel.value).toBe('canary') // pairing UX: refused selections stay selected, NOT reverted
    const errEl = document.getElementById('channel-error')!
    expect(errEl.hidden).toBe(false)
    expect(errEl.textContent).toContain('canary')
    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'canary' })
    const urlInput = document.getElementById('ws-url-input') as HTMLInputElement
    const tokenInput = document.getElementById('ws-token-input') as HTMLInputElement
    expect(urlInput.value).toBe('ws://canary:4753/ui')
    expect(tokenInput.value).toBe('')
    expect(setDefaultRoute).not.toHaveBeenCalled()
  })

  it('#F4: a BARE STRING rejection from resolve_route_token (real Tauri Err(String) shape, not an Error wrapper) still routes to the pairing prompt', async () => {
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
        if (cmd === 'resolve_route_token') {
          // eslint-disable-next-line no-throw-literal
          throw 'not-paired: route "canary" has no token paired in moon-connection.json'
        }
        return null
      },
    })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    sel.value = 'canary'
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()

    expect(sel.value).toBe('canary') // pairing UX: refused selections stay selected
    const errEl = document.getElementById('channel-error')!
    expect(errEl.hidden).toBe(false)
    expect(errEl.textContent).toContain('canary')
    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'canary' })
    const urlInput = document.getElementById('ws-url-input') as HTMLInputElement
    const tokenInput = document.getElementById('ws-token-input') as HTMLInputElement
    expect(urlInput.value).toBe('ws://canary:4753/ui')
    expect(tokenInput.value).toBe('')
    expect(setDefaultRoute).not.toHaveBeenCalled()
  })

  it('a non-"not-paired:" resolve_route_token error (e.g. route-missing) reverts the selector, unlike the pairing case', async () => {
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
        if (cmd === 'resolve_route_token') {
          throw new Error('route-missing: no route named "canary"')
        }
        return null
      },
    })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    sel.value = 'canary'
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()

    // F2(b), not F2(a): this is NOT the pairing case, so the selector
    // REVERTS - unlike a "not-paired:" refusal, which keeps the selection.
    expect(sel.value).toBe('stable')
    const errEl = document.getElementById('channel-error')!
    expect(errEl.hidden).toBe(false)
    expect(errEl.textContent).toContain('route-missing:')
    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'canary' })
    expect(setDefaultRoute).not.toHaveBeenCalled()
  })

  it('pairing: a refused unpaired route stays selected, Save targets it, and a retried switch succeeds once paired', async () => {
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    let profiles: Record<string, { wsUrl: string; wsToken: string }> = {
      stable: { wsUrl: 'ws://stable:4753/ui', wsToken: 'TOK-STABLE' },
    }
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd, args) => {
        if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
        if (cmd === 'resolve_route_token') {
          const p = profiles[args.routeKey]
          if (p && p.wsToken) return p.wsToken
          throw new Error('not-paired: route "' + args.routeKey + '" has no token paired in moon-connection.json')
        }
        if (cmd === 'set_active_profile') {
          const p = profiles[args.name]
          return { wsUrl: p?.wsUrl ?? '', wsToken: p?.wsToken ?? '' }
        }
        if (cmd === 'save_connection') {
          profiles = { ...profiles, [args.profile]: { wsUrl: args.url, wsToken: args.token } }
          return null
        }
        return null
      },
    })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    // First attempt: unpaired -> refused, but selection sticks.
    sel.value = 'canary'
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()
    expect(sel.value).toBe('canary')
    expect(document.getElementById('channel-error')!.hidden).toBe(false)
    // F2(a): the fields already show the honest pairing state - canary's
    // real endpoint, empty token - before the operator types anything.
    expect((document.getElementById('ws-url-input') as HTMLInputElement).value).toBe('ws://canary:4753/ui')
    expect((document.getElementById('ws-token-input') as HTMLInputElement).value).toBe('')

    // Pair it: Save always targets the currently-selected (canary) channel.
    const tokenInput = document.getElementById('ws-token-input') as HTMLInputElement
    tokenInput.value = 'TOK-CANARY-PAIRED'
    document.getElementById('save-connection-btn')!.click()
    await flush()
    // Save sends exactly the route's real endpoint + the pasted token under
    // profile: canary - the pairing instruction the plan (F2) requires.
    expect(invoke).toHaveBeenCalledWith('save_connection', {
      url: 'ws://canary:4753/ui',
      token: 'TOK-CANARY-PAIRED',
      profile: 'canary',
    })

    // Retry the switch (re-dispatching 'change' on the already-selected
    // value is deliberate - a real retry path would do the same): now
    // resolvable, so it succeeds.
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()

    expect(document.getElementById('channel-error')!.hidden).toBe(true)
    expect(setDefaultRoute).toHaveBeenCalledWith('canary')
    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
  })

  it('save-target: the currently-selected route key always reaches save_connection as `profile`', async () => {
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute: vi.fn().mockResolvedValue(true),
    }
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd) => {
        if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
        if (cmd === 'resolve_route_token') return 'TOK-CANARY-RESOLVED'
        if (cmd === 'set_active_profile') return { wsUrl: 'ws://canary:4753/ui', wsToken: 'TOK-CANARY' }
        return null
      },
    })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    sel.value = 'canary'
    sel.dispatchEvent(new Event('change'))
    await flush()
    await flush()
    expect(sel.value).toBe('canary')

    const tokenInput = document.getElementById('ws-token-input') as HTMLInputElement
    tokenInput.value = 'sometoken'
    document.getElementById('save-connection-btn')!.click()
    await flush()

    expect(invoke).toHaveBeenCalledWith('save_connection', expect.objectContaining({ profile: 'canary' }))
  })

  it('F3: the select is disabled while routes are still being discovered, and a change event driven in that window performs no writes', async () => {
    let resolveRoutes!: (v: unknown) => void
    const routesGate = new Promise((resolve) => { resolveRoutes = resolve })
    ;(window as any).MoonSession = {
      listRoutes: vi.fn(() => routesGate.then(() => ({
        default: 'stable',
        routes: [{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }],
      }))),
      resolveBootRoute: vi.fn().mockResolvedValue(null),
    }
    const { invoke } = bootPanel({ type: 'settings.connection', invoke: () => null })
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement
    // Still "unknown" - the select is disabled, and a driven change performs no writes.
    expect(sel.disabled).toBe(true)
    sel.value = 'dev'
    sel.dispatchEvent(new Event('change'))
    await flush()

    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'dev' })
    const errEl = document.getElementById('channel-error')!
    expect(errEl.hidden).toBe(false)
    expect(errEl.textContent).toContain('discovering')

    resolveRoutes(undefined)
    await flush()
    await flush()

    expect(sel.disabled).toBe(false)
  })

  it('F4: a switch superseded by a newer one abandons silently - exactly one setDefaultRoute call, for the newer target only', async () => {
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    ;(window as any).MoonSession = {
      ...stubRoutes(
        [{ key: 'stable', label: 'Stable' }, { key: 'a-target', label: 'A' }, { key: 'b-target', label: 'B' }],
        'stable',
      ),
      setDefaultRoute,
    }
    let resolveSetActiveProfile!: (v: unknown) => void
    const gate = new Promise((resolve) => { resolveSetActiveProfile = resolve })
    const { invoke } = bootPanel({
      type: 'settings.connection',
      invoke: (cmd, args) => {
        if (cmd === 'load_route') {
          return { key: args.routeKey, endpoints: ['ws://' + args.routeKey + ':4753/ui'] }
        }
        if (cmd === 'resolve_route_token') return 'TOK-RESOLVED-' + args.routeKey
        if (cmd === 'set_active_profile') {
          return gate.then(() => ({ wsUrl: 'ws://' + args.name + ':4753/ui', wsToken: 'TOK-' + args.name }))
        }
        return null
      },
    })
    await flush()
    await flush()

    const sel = document.getElementById('channel-select') as HTMLSelectElement

    // Fire A, let it reach the gated set_active_profile await.
    sel.value = 'a-target'
    sel.dispatchEvent(new Event('change'))
    await flush()

    // Fire B (a DIFFERENT target) BEFORE A's gate resolves - a real user
    // cannot do this (the select disables itself while a switch is
    // in-flight), so this is the programmatic driver the disabling exists
    // to require.
    sel.value = 'b-target'
    sel.dispatchEvent(new Event('change'))
    await flush()

    // Release the SHARED gate - A's continuation is queued first (it
    // awaited first) and must find itself superseded; B's runs second and
    // must be the only one to reach setDefaultRoute.
    resolveSetActiveProfile({})
    await flush()
    await flush()

    expect(setDefaultRoute).toHaveBeenCalledTimes(1)
    expect(setDefaultRoute).toHaveBeenCalledWith('b-target')
    expect(sel.value).toBe('b-target')
    // set_active_profile itself WAS invoked for both attempts - neither
    // could know it would be superseded before making that call. The
    // invariant F4 guards is that only the LATEST-STARTED attempt's writes
    // past that point are ever allowed to land (never an interleave of
    // writes from two DIFFERENT targets).
    expect(invoke).toHaveBeenCalledWith('set_active_profile', { name: 'a-target' })
    expect(invoke).toHaveBeenCalledWith('set_active_profile', { name: 'b-target' })
    expect(sel.disabled).toBe(false)
  })
})
