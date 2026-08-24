// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Connection settings
// panel (frontend/panels/settings-connection.js -> frontend-react/src/panels/
// settings-connection/SettingsConnectionPanel.tsx + settings-connection-mount.tsx).
// Ports every behavioral assertion from test/panel-connection.test.ts (which
// keeps testing the still-vanilla frontend/panel.html + frontend/panels/
// settings-connection.js - that suite is untouched and stays green) onto the
// React implementation:
//   - renders with the Connection title and every control
//   - load_connection populates the URL/token fields; load_profiles sets the
//     channel select to the active profile
//   - channel change invokes set_active_profile + hub_event('profile-changed'),
//     surfaces an error (and does NOT fire hub_event) on rejection
//   - model select persists/clears luna_model, restores a persisted selection,
//     accepts both the legacy plain-id-string cache shape and the extended
//     {id, label, efforts} shape
//   - effort select show/hide + persist/clear luna_effort, recomputed on
//     every model change
//   - save button invokes save_connection + hub_event('connection-changed'),
//     shows "Saved ✓" without wiping the token field, surfaces save errors
//   - open-wizard button fires hub_event('open-wizard')
//   - C8: channel-select is populated from MoonSession.listRoutes() when
//     available, with the stable/dev fallback and the active-profile-not-in-
//     routes edge case
//
// Elements are queried by data-testid (every control - including the two
// Astryx TextInput fields, see SettingsConnectionPanel.tsx's module doc on
// why TextInput's internal useId() means an explicit `id` prop never reaches
// the real <input>) rather than the vanilla version's getElementById-only
// convention; native <select>/<span> controls also keep a plain `id` for
// parity with the mount-contract test below.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it - see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { PANEL_TITLE, SettingsConnectionPanel } from '../frontend-react/src/panels/settings-connection/SettingsConnectionPanel'
import {
  isSettingsConnectionPanelType,
  mountSettingsConnectionPanel,
} from '../frontend-react/src/panels/settings-connection-mount'
import type { PanelCtx } from '../frontend-react/src/panels/panel-ctx'

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderPanel(ctx: PanelCtx) {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<SettingsConnectionPanel ctx={ctx} />)
  })
  return container
}

function makeCtx(invokeImpl?: (cmd: string, args?: any) => any): { ctx: PanelCtx; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (cmd: string, args?: any) => (invokeImpl ? invokeImpl(cmd, args) : null))
  return { ctx: { invoke }, invoke }
}

/** Flush both the microtask queue (promise .then chains) and one macrotask
 *  tick, wrapped in act() so React 19 never warns about state updates
 *  outside act(). Mirrors the vanilla test's setTimeout-based flush(). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function urlInput(): HTMLInputElement {
  return document.querySelector('[data-testid="ws-url-input"]') as HTMLInputElement
}
function tokenInput(): HTMLInputElement {
  return document.querySelector('[data-testid="ws-token-input"]') as HTMLInputElement
}
function channelSelect(): HTMLSelectElement {
  return document.getElementById('channel-select') as HTMLSelectElement
}
function modelSelect(): HTMLSelectElement {
  return document.getElementById('model-select') as HTMLSelectElement
}
function effortSelect(): HTMLSelectElement {
  return document.getElementById('effort-select') as HTMLSelectElement
}
function effortRow(): HTMLElement {
  return document.getElementById('effort-row') as HTMLElement
}
function channelError(): HTMLElement {
  return document.getElementById('channel-error') as HTMLElement
}
function saveStatus(): HTMLElement {
  return document.getElementById('save-connection-status') as HTMLElement
}
function saveBtn(): HTMLButtonElement {
  return document.querySelector('[data-testid="save-connection-btn"]') as HTMLButtonElement
}
function wizardBtn(): HTMLButtonElement {
  return document.querySelector('[data-testid="open-wizard-btn"]') as HTMLButtonElement
}

function selectValue(select: HTMLSelectElement, value: string) {
  select.value = value
  act(() => {
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
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
  delete (window as any).MoonSession
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('SettingsConnectionPanel (React port of panels/settings-connection.js)', () => {
  it('renders the panel with the Connection title and every core control', async () => {
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    expect(PANEL_TITLE).toBe('Connection')
    expect(channelSelect()).toBeTruthy()
    expect(modelSelect()).toBeTruthy()
    expect(urlInput()).toBeTruthy()
    expect(tokenInput()).toBeTruthy()
    expect(saveBtn()).toBeTruthy()
    expect(wizardBtn()).toBeTruthy()
  })

  it('populates url and token inputs from load_connection on render', async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd === 'load_connection') return { wsUrl: 'ws://myhost:4753/ui', wsToken: 'tok123' }
      if (cmd === 'load_profiles') return { activeProfile: 'stable' }
      return null
    })
    renderPanel(ctx)
    await flush()

    expect(urlInput().value).toBe('ws://myhost:4753/ui')
    expect(tokenInput().value).toBe('tok123')
  })

  it('sets channel-select to activeProfile from load_profiles', async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd === 'load_profiles') return { activeProfile: 'dev' }
      return null
    })
    renderPanel(ctx)
    await flush()

    expect(channelSelect().value).toBe('dev')
  })

  it('channel change invokes set_active_profile with { name } and hub_event profile-changed', async () => {
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_profiles') return { activeProfile: 'stable' }
      if (cmd === 'set_active_profile') return { wsUrl: 'ws://dev:4753/ui', wsToken: '' }
      return null
    })
    renderPanel(ctx)
    await flush()

    selectValue(channelSelect(), 'dev')
    await flush()

    expect(invoke).toHaveBeenCalledWith('set_active_profile', { name: 'dev' })
    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
  })

  it('channel change shows error and does NOT fire hub_event when set_active_profile rejects', async () => {
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_profiles') return { activeProfile: 'stable' }
      if (cmd === 'set_active_profile') throw new Error('binary mismatch')
      return null
    })
    renderPanel(ctx)
    await flush()

    selectValue(channelSelect(), 'dev')
    await flush()

    expect(channelError().hidden).toBe(false)
    expect(channelError().textContent).toContain('binary mismatch')
    expect(invoke).not.toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
  })

  it('model select sets luna_model in localStorage when a model is chosen', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify(['claude-3-opus', 'claude-3-haiku']))
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    selectValue(modelSelect(), 'claude-3-opus')

    expect(localStorage.getItem('luna_model')).toBe('claude-3-opus')
  })

  it('model select removes luna_model from localStorage when "Server default" is chosen', async () => {
    localStorage.setItem('luna_model', 'claude-3-opus')
    localStorage.setItem('luna_available_models', JSON.stringify(['claude-3-opus']))
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    selectValue(modelSelect(), '')

    expect(localStorage.getItem('luna_model')).toBeNull()
  })

  it('model select restores persisted luna_model as initial selection', async () => {
    localStorage.setItem('luna_model', 'claude-3-haiku')
    localStorage.setItem('luna_available_models', JSON.stringify(['claude-3-opus', 'claude-3-haiku']))
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    expect(modelSelect().value).toBe('claude-3-haiku')
  })

  it('save button invokes save_connection with { url, token } and hub_event connection-changed', async () => {
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_connection') return { wsUrl: 'ws://127.0.0.1:4753/ui', wsToken: '' }
      return null
    })
    renderPanel(ctx)
    await flush()

    changeInputValue(urlInput(), 'ws://newhost:9000/ui')
    changeInputValue(tokenInput(), 'mytoken')

    act(() => {
      saveBtn().click()
    })
    await flush()

    // Step 1a: `profile` always targets the currently-selected channel (here
    // the un-migrated fallback default, 'stable') - see the module doc on
    // handleSave and the dedicated save-target test below.
    expect(invoke).toHaveBeenCalledWith('save_connection', {
      url: 'ws://newhost:9000/ui',
      token: 'mytoken',
      profile: 'stable',
      activate: false,
    })
    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'connection-changed' })
  })

  it('save button shows Saved ✓ on success and does NOT wipe the token field', async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd === 'save_connection') return null
      return null
    })
    renderPanel(ctx)
    await flush()

    // #588 removed the compiled-in host, so Save needs a real URL now.
    changeInputValue(urlInput(), 'ws://configured-host:4753/ui')
    changeInputValue(tokenInput(), 'keepme')

    act(() => {
      saveBtn().click()
    })
    await flush()

    expect(saveStatus().textContent).toMatch(/^Saved ✓/)
    expect(tokenInput().value).toBe('keepme')
  })

  it('machine-target-select offers server + Custom only; server Save never sends loopback', async () => {
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_connection') return { wsUrl: 'ws://configured-host:4753/ui', wsToken: 't' }
      return null
    })
    renderPanel(ctx)
    await flush()

    const machine = document.querySelector('[data-testid="machine-target-select"]') as HTMLSelectElement
    expect(machine).toBeTruthy()
    const values = Array.from(machine.options).map((o) => o.value)
    expect(values).toEqual(['server', 'custom'])
    expect(values).not.toContain('this-mac')

    act(() => {
      machine.value = 'server'
      machine.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    // The host comes from the loaded connection, not a compiled-in default.
    expect(urlInput().value).toBe('ws://configured-host:4753/ui')
    expect(urlInput().value).not.toContain('127.0.0.1')

    act(() => { saveBtn().click() })
    await flush()
    expect(invoke).toHaveBeenCalledWith('save_connection', {
      url: 'ws://configured-host:4753/ui',
      token: 't',
      profile: 'stable',
      activate: false,
    })
    const saveCall = invoke.mock.calls.find((c: unknown[]) => c[0] === 'save_connection')
    expect(JSON.stringify(saveCall)).not.toContain('127.0.0.1')
  })

  it('activate-on-save checkbox passes activate:true to save_connection', async () => {
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_connection') {
        return { wsUrl: 'ws://jax-box:4753/ui', wsToken: 'tok' }
      }
      return null
    })
    renderPanel(ctx)
    await flush()

    const activate = document.querySelector('[data-testid="activate-on-save"]') as HTMLInputElement
    expect(activate).toBeTruthy()
    expect(activate.checked).toBe(false)
    act(() => {
      activate.click()
    })
    await flush()
    expect(activate.checked).toBe(true)

    act(() => { saveBtn().click() })
    await flush()
    expect(invoke).toHaveBeenCalledWith(
      'save_connection',
      expect.objectContaining({
        url: 'ws://jax-box:4753/ui',
        token: 'tok',
        profile: 'stable',
        activate: true,
      }),
    )
  })

  it('save button shows error on save_connection failure', async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd === 'save_connection') throw new Error('disk full')
      return null
    })
    renderPanel(ctx)
    await flush()

    // Needs a dialable URL to get past the preflight and reach save_connection.
    changeInputValue(urlInput(), 'ws://configured-host:4753/ui')
    act(() => {
      saveBtn().click()
    })
    await flush()

    expect(saveStatus().textContent).toContain('Save failed')
    expect(saveStatus().textContent).toContain('disk full')
    expect(saveBtn().disabled).toBe(false)
  })

  it('open-wizard button fires hub_event open-wizard', async () => {
    const { ctx, invoke } = makeCtx()
    renderPanel(ctx)
    await flush()

    act(() => {
      wizardBtn().click()
    })
    await flush()

    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'open-wizard' })
  })

  // ── New cache shape (extended: {id, label, efforts} objects) ────────────

  it('model select shows label text from new-shape cache (not raw id)', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5 (1M context)', efforts: ['low', 'max'] },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ]))
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    const opts = Array.from(modelSelect().options).map((o) => ({ value: o.value, text: o.textContent }))
    expect(opts.find((o) => o.value === 'claude-fable-5')?.text).toBe('Fable 5 (1M context)')
    expect(opts.find((o) => o.value === 'claude-haiku-4-5')?.text).toBe('Haiku 4.5')
  })

  it('model select back-compat: accepts legacy plain-id string array', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify(['claude-3-opus', 'claude-3-haiku']))
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    const sel = modelSelect()
    expect(sel.options.length).toBeGreaterThanOrEqual(3) // default + 2 models
    expect(Array.from(sel.options).some((o) => o.value === 'claude-3-opus')).toBe(true)
    const opusOpt = Array.from(sel.options).find((o) => o.value === 'claude-3-opus')!
    expect(opusOpt.textContent).toBe('claude-3-opus')
  })

  it('effort select is hidden when selected model has no efforts', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ]))
    localStorage.setItem('luna_model', 'claude-haiku-4-5')
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    expect(effortRow().hidden).toBe(true)
  })

  it('effort select is visible when selected model has efforts', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    expect(effortRow().hidden).toBe(false)
    const sel = effortSelect()
    expect(sel).toBeTruthy()
    const values = Array.from(sel.options).map((o) => o.value)
    expect(values).toContain('low')
    expect(values).toContain('max')
  })

  it('effort select restores persisted luna_effort', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    localStorage.setItem('luna_effort', 'max')
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    expect(effortSelect().value).toBe('max')
  })

  it('effort select change writes luna_effort to localStorage', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    selectValue(effortSelect(), 'low')

    expect(localStorage.getItem('luna_effort')).toBe('low')
  })

  it('effort select change to Default removes luna_effort from localStorage', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    localStorage.setItem('luna_effort', 'max')
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    selectValue(effortSelect(), '')

    expect(localStorage.getItem('luna_effort')).toBeNull()
  })

  it("changing model updates effort select to that model's efforts and hides row when empty", async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    expect(effortRow().hidden).toBe(false)

    selectValue(modelSelect(), 'claude-haiku-4-5')

    expect(effortRow().hidden).toBe(true)
  })

  it('changing to model without saved effort support clears luna_effort', async () => {
    localStorage.setItem('luna_available_models', JSON.stringify([
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
    ]))
    localStorage.setItem('luna_model', 'claude-fable-5')
    localStorage.setItem('luna_effort', 'max')
    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()

    selectValue(modelSelect(), 'claude-haiku-4-5')

    expect(localStorage.getItem('luna_effort')).toBeNull()
  })
})

// ── C8: Channel select route enumeration ──────────────────────────────────
// Verifies that when MoonSession.listRoutes() is available, channel-select
// is populated with N real routes from client.toml instead of the hardcoded
// ['stable','dev'] fallback.
describe('SettingsConnectionPanel - C8 channel select route enumeration', () => {
  it('populates channel-select from MoonSession.listRoutes() when available', async () => {
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'prod',
        routes: [
          { key: 'prod', label: 'Production' },
          { key: 'local', label: 'Local Dev' },
          { key: 'beta', label: 'Beta' },
        ],
      }),
    }

    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()
    await flush()

    const opts = Array.from(channelSelect().options).map((o) => o.value)
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
    }

    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()
    await flush()

    const prodOpt = Array.from(channelSelect().options).find((o) => o.value === 'prod')
    expect(prodOpt?.textContent).toBe('Production Server')
  })

  it('falls back to stable/dev hardcoded options when MoonSession is absent', async () => {
    delete (window as any).MoonSession

    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()
    await flush()

    const opts = Array.from(channelSelect().options).map((o) => o.value)
    expect(opts).toContain('stable')
    expect(opts).toContain('dev')
  })

  it('falls back to hardcoded list when listRoutes() returns null', async () => {
    ;(window as any).MoonSession = { listRoutes: vi.fn().mockResolvedValue(null) }

    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()
    await flush()

    const opts = Array.from(channelSelect().options).map((o) => o.value)
    expect(opts).toContain('stable')
    expect(opts).toContain('dev')
  })

  it('falls back when listRoutes() rejects', async () => {
    ;(window as any).MoonSession = { listRoutes: vi.fn().mockRejectedValue(new Error('Tauri down')) }

    const { ctx } = makeCtx()
    renderPanel(ctx)
    await flush()
    await flush()

    const opts = Array.from(channelSelect().options).map((o) => o.value)
    expect(opts).toContain('stable')
    expect(opts).toContain('dev')
  })

  it('Step 1a INVERSION: once routes are known, a divergent profile-loaded activeProfile is never appended nor selected', async () => {
    // Pre-Step-1a this test asserted the OPPOSITE: that a divergent
    // activeProfile ('my-custom') got appended as a dynamic option AND
    // selected (the old C8 race-handling behavior). Step 1a's reducer
    // quarantine (connectionReducer.ts's routesKnown) deliberately kills
    // that behavior once client.toml routes exist: the selector's value and
    // options must come from list_routes() alone, never a
    // moon-connection.json activeProfile that can name a stale or divergent
    // profile. See docs/next/routes-and-view-mode-plan.md's Step 1a DECIDE
    // on the reducer quarantine ("severing BOTH reducer paths ... not
    // adding alongside them"). This inversion is deliberate, not a
    // regression - see also the BDD scenario "the selector shows the route
    // the socket is on, not the stale profile name".
    // default is deliberately the NON-FIRST route key: an implementation that
    // ignores defaultKey and always selects options[0] must fail here (review
    // finding: every other stub's default was first-or-invalid, so sourcing
    // from defaultKey vs options[0] was otherwise indistinguishable).
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'local',
        routes: [
          { key: 'prod', label: 'Production' },
          { key: 'local', label: 'Local Dev' },
        ],
      }),
    }

    const { ctx } = makeCtx((cmd) => {
      if (cmd === 'load_profiles') return { activeProfile: 'my-custom' }
      return null
    })
    renderPanel(ctx)
    await flush()
    await flush()

    const optValues = Array.from(channelSelect().options).map((o) => o.value)
    expect(optValues).toEqual(['prod', 'local'])
    expect(optValues).not.toContain('my-custom')
    expect(channelSelect().value).toBe('local')
  })
})

// ── F1 (opus review): defaultKey must be a real member of the reported
// routes, not taken on faith. A dangling default (Gate 0.1 world (c)) or an
// empty-string default must fall through to the first real option instead of
// leaving `state.channel` holding a value no option corresponds to.
//
// THE DOM-ONLY VERSION OF THIS TEST IS VACUOUS FOR THE REACT PORT, AND THAT
// IS WORTH RECORDING: `<select value={state.channel}>`'s underlying DOM
// `.value` blanks (selectedIndex -1) when assigned directly, as it does in
// the vanilla module - but React's OWN controlled-select reconciliation does
// NOT assign `.value` naively. It toggles `.selected` per rendered <option>,
// and when none match, none get marked selected, so the browser's native
// "select the first option" default silently takes over. That means
// `channelSelect().value` reads "prod" (the first real option) EVEN WITH THE
// PRE-F1-FIX BUG PRESENT (`defaultKey ?? options[0]`, no membership check) -
// confirmed empirically against this React version. The bug is real at the
// STATE layer (`state.channel` holds the dangling/empty key, not "prod")
// even though the rendered <select> happens to look fine; anything that
// reads `state.channel` directly rather than through the DOM - Save's
// `profile: state.channel` is the real one already in this file - still
// sees the wrong value. So the fence here drives Save (untouched selector)
// and asserts on the `profile` it sends, which is what actually depends on
// the reducer's computed `channel`, not on React's independent DOM masking.
describe('SettingsConnectionPanel - Step 1a: F1 defaultKey validation', () => {
  it('a defaultKey not among the reported routes leaves state.channel on the first option, not the dangling key', async () => {
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'ghost-route', // dangling - not in routes below
        routes: [{ key: 'prod', label: 'Production' }, { key: 'local', label: 'Local Dev' }],
      }),
    }
    const { ctx, invoke } = makeCtx()
    renderPanel(ctx)
    await flush()
    await flush()

    // The rendered select LOOKS fine regardless (see module note above) -
    // the real fence is what Save sends, which reads state.channel directly.
    expect(channelSelect().value).toBe('prod')

    changeInputValue(urlInput(), 'ws://configured-host:4753/ui')
    act(() => { saveBtn().click() })
    await flush()
    expect(invoke).toHaveBeenCalledWith('save_connection', expect.objectContaining({ profile: 'prod' }))
    expect(invoke).not.toHaveBeenCalledWith('save_connection', expect.objectContaining({ profile: 'ghost-route' }))
  })

  it('an empty-string defaultKey also leaves state.channel on the first option, never on ""', async () => {
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: '',
        routes: [{ key: 'prod', label: 'Production' }, { key: 'local', label: 'Local Dev' }],
      }),
    }
    const { ctx, invoke } = makeCtx()
    renderPanel(ctx)
    await flush()
    await flush()

    expect(channelSelect().value).toBe('prod')

    changeInputValue(urlInput(), 'ws://configured-host:4753/ui')
    act(() => { saveBtn().click() })
    await flush()
    expect(invoke).toHaveBeenCalledWith('save_connection', expect.objectContaining({ profile: 'prod' }))
    expect(invoke).not.toHaveBeenCalledWith('save_connection', expect.objectContaining({ profile: '' }))
  })
})

// ── Step 1a: profile-loaded/routes-loaded arrival-order convergence ────────
// The reducer quarantine (connectionReducer.ts's routesKnown) must produce
// the SAME final selector state regardless of which of the two async loads
// (load_profiles vs MoonSession.listRoutes) resolves first - see plan Step
// 1a's DECIDE on severing both reducer paths. Each test below controls
// resolution order explicitly via a manually-gated promise per command.
describe('SettingsConnectionPanel - Step 1a: profile-loaded/routes-loaded arrival order', () => {
  function makeDeferredCtx() {
    let resolveProfiles!: () => void
    let resolveRoutes!: () => void
    const profilesGate = new Promise<void>((resolve) => { resolveProfiles = resolve })
    const routesGate = new Promise<void>((resolve) => { resolveRoutes = resolve })
    ;(window as any).MoonSession = {
      listRoutes: vi.fn(() => routesGate.then(() => ({
        default: 'prod',
        routes: [
          { key: 'prod', label: 'Production' },
          { key: 'local', label: 'Local Dev' },
        ],
      }))),
    }
    const { ctx } = makeCtx((cmd) => {
      if (cmd === 'load_profiles') return profilesGate.then(() => ({ activeProfile: 'my-custom' }))
      return null
    })
    return { ctx, resolveProfiles, resolveRoutes }
  }

  it('profile-loaded resolving BEFORE routes-loaded still ends with routes owning the selector', async () => {
    const { ctx, resolveProfiles, resolveRoutes } = makeDeferredCtx()
    renderPanel(ctx)
    await flush()

    resolveProfiles()
    await flush()
    resolveRoutes()
    await flush()
    await flush()

    const optValues = Array.from(channelSelect().options).map((o) => o.value)
    expect(optValues).toEqual(['prod', 'local'])
    expect(optValues).not.toContain('my-custom')
    expect(channelSelect().value).toBe('prod')
  })

  it('routes-loaded resolving BEFORE profile-loaded already owns the selector, and the later profile-loaded is inert', async () => {
    const { ctx, resolveProfiles, resolveRoutes } = makeDeferredCtx()
    renderPanel(ctx)
    await flush()

    resolveRoutes()
    await flush()
    await flush()
    resolveProfiles()
    await flush()

    const optValues = Array.from(channelSelect().options).map((o) => o.value)
    expect(optValues).toEqual(['prod', 'local'])
    expect(optValues).not.toContain('my-custom')
    expect(channelSelect().value).toBe('prod')
  })
})

// ── Step 1a: the guarded route switch ───────────────────────────────────────
// docs/next/routes-and-view-mode-plan.md's Step 1a: once client.toml routes
// are known, handleChannelChange becomes a guarded dual write
// (set_active_profile then MoonSession.setDefaultRoute, in that order) with
// two refusal guards ahead of it, instead of the bare set_active_profile
// call the un-migrated-world tests above still exercise.
describe('SettingsConnectionPanel - Step 1a: the guarded route switch', () => {
  function stubRoutes(routes: Array<{ key: string; label: string }>, defaultKey: string) {
    return {
      listRoutes: vi.fn().mockResolvedValue({ default: defaultKey, routes }),
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
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
      if (cmd === 'resolve_route_token') return 'TOK-CANARY-RESOLVED'
      if (cmd === 'set_active_profile') {
        callOrder.push('set_active_profile:canary')
        return { wsUrl: 'ws://canary:4753/ui', wsToken: 'TOK-CANARY' }
      }
      return null
    })
    renderPanel(ctx)
    await flush()
    await flush()

    selectValue(channelSelect(), 'canary')
    await flush()
    await flush()

    expect(callOrder).toEqual(['set_active_profile:canary', 'setDefaultRoute:canary'])
    expect(invoke).toHaveBeenCalledWith('set_active_profile', { name: 'canary' })
    expect(setDefaultRoute).toHaveBeenCalledWith('canary')
    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
    expect(channelError().hidden).toBe(true)
  })

  it('setDefaultRoute resolving false refuses the switch visibly and fires no hub_event (the named trap: it never rejects)', async () => {
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute: vi.fn().mockResolvedValue(false),
    }
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
      if (cmd === 'resolve_route_token') return 'TOK-CANARY-RESOLVED'
      if (cmd === 'set_active_profile') return { wsUrl: 'ws://canary:4753/ui', wsToken: 'TOK-CANARY' }
      return null
    })
    renderPanel(ctx)
    await flush()
    await flush()

    selectValue(channelSelect(), 'canary')
    await flush()
    await flush()

    expect(channelError().hidden).toBe(false)
    expect(channelError().textContent).toContain('canary')
    expect(invoke).not.toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
    // F2(b): this is NOT the pairing case - the selector must revert to the
    // PREVIOUS channel, since the switch did not happen (the two stores are
    // intentionally left half-moved: activeProfile advanced, default did not).
    expect(channelSelect().value).toBe('stable')
  })

  it('a non-route-key value is refused as defense in depth (unreachable via rendered options once quarantined - stale DOM/race only)', async () => {
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }], 'stable'),
      setDefaultRoute: vi.fn().mockResolvedValue(true),
    }
    const { ctx, invoke } = makeCtx()
    renderPanel(ctx)
    await flush()
    await flush()

    // Once routesKnown, channelOptions is EXACTLY the route keys
    // (connectionReducer.ts), so a real user can never select a
    // non-route-key value - this appends a stale option by hand to reach
    // GUARD 1 at all, simulating leftover DOM from before quarantine or a
    // race, which is the only way this branch is reachable.
    const sel = channelSelect()
    const staleOpt = document.createElement('option')
    staleOpt.value = 'not-a-route'
    sel.appendChild(staleOpt)

    selectValue(sel, 'not-a-route')
    await flush()
    await flush()

    expect(channelError().hidden).toBe(false)
    expect(channelError().textContent).toContain('not-a-route')
    expect(invoke).not.toHaveBeenCalledWith('load_route', { routeKey: 'not-a-route' })
    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'not-a-route' })
    // F2(b): reverted to the previous (initial default) channel.
    expect(channelSelect().value).toBe('stable')
  })

  it('a legacy-sentinel route with no matching profile token is refused, naming the route, without ever calling setDefaultRoute', async () => {
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
      if (cmd === 'resolve_route_token') {
        throw new Error('not-paired: route "canary" has no token paired in moon-connection.json')
      }
      return null
    })
    renderPanel(ctx)
    await flush()
    await flush()

    // A stale value in the token field, to prove the F2(a) clear is real.
    changeInputValue(tokenInput(), 'stale-stable-token')

    selectValue(channelSelect(), 'canary')
    await flush()
    await flush()

    expect(channelSelect().value).toBe('canary') // refused selections stay selected (the pairing UX)
    expect(channelError().hidden).toBe(false)
    expect(channelError().textContent).toContain('canary')
    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'canary' })
    expect(setDefaultRoute).not.toHaveBeenCalled()
    // F2(a): the fields show the TARGET route's real endpoint and an EMPTY
    // token - never 'stable's stale creds displayed under 'canary's name.
    expect(urlInput().value).toBe('ws://canary:4753/ui')
    expect(tokenInput().value).toBe('')
  })

  it('#F1: a missing moon-connection.json store (not just an unpaired profile) still fires the pairing prompt, not the revert', async () => {
    // The exact message shape connection.rs's resolve_route_token now emits
    // for an ABSENT store (F1, opus review on plan Step 1b) - distinct from
    // the "no matching profile token" wording the other not-paired tests use.
    // Before the fix this path returned "store-read:" (a RETRYABLE class),
    // which never reaches this branch at all and instead reverts the
    // selector; this pins that the whole-store-missing case is durable and
    // pairing-prompted, exactly like the no-matching-profile case.
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
      if (cmd === 'resolve_route_token') {
        throw new Error('not-paired: route "canary" has no credential store yet - pair it to create one')
      }
      return null
    })
    renderPanel(ctx)
    await flush()
    await flush()

    selectValue(channelSelect(), 'canary')
    await flush()
    await flush()

    expect(channelSelect().value).toBe('canary') // pairing UX: refused selections stay selected, NOT reverted
    expect(channelError().hidden).toBe(false)
    expect(channelError().textContent).toContain('canary')
    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'canary' })
    expect(setDefaultRoute).not.toHaveBeenCalled()
    expect(urlInput().value).toBe('ws://canary:4753/ui')
    expect(tokenInput().value).toBe('')
  })

  it('#F4: a BARE STRING rejection from resolve_route_token (real Tauri Err(String) shape, not an Error wrapper) still routes to the pairing prompt', async () => {
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
      if (cmd === 'resolve_route_token') {
        // eslint-disable-next-line no-throw-literal
        throw 'not-paired: route "canary" has no token paired in moon-connection.json'
      }
      return null
    })
    renderPanel(ctx)
    await flush()
    await flush()

    selectValue(channelSelect(), 'canary')
    await flush()
    await flush()

    expect(channelSelect().value).toBe('canary') // pairing UX: refused selections stay selected
    expect(channelError().hidden).toBe(false)
    expect(channelError().textContent).toContain('canary')
    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'canary' })
    expect(setDefaultRoute).not.toHaveBeenCalled()
    expect(urlInput().value).toBe('ws://canary:4753/ui')
    expect(tokenInput().value).toBe('')
  })

  it('a non-"not-paired:" resolve_route_token error (e.g. route-missing) reverts the selector, unlike the pairing case', async () => {
    const setDefaultRoute = vi.fn().mockResolvedValue(true)
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute,
    }
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
      if (cmd === 'resolve_route_token') {
        throw new Error('route-missing: no route named "canary"')
      }
      return null
    })
    renderPanel(ctx)
    await flush()
    await flush()

    selectValue(channelSelect(), 'canary')
    await flush()
    await flush()

    // F2(b), not F2(a): this is NOT the pairing case, so the selector
    // REVERTS - unlike a "not-paired:" refusal, which keeps the selection.
    expect(channelSelect().value).toBe('stable')
    expect(channelError().hidden).toBe(false)
    expect(channelError().textContent).toContain('route-missing:')
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
    const { ctx, invoke } = makeCtx((cmd, args) => {
      if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
      if (cmd === 'resolve_route_token') {
        const p = profiles[args.routeKey]
        if (p && p.wsToken) return p.wsToken
        throw new Error(`not-paired: route "${args.routeKey}" has no token paired in moon-connection.json`)
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
    })
    renderPanel(ctx)
    await flush()
    await flush()

    // First attempt: unpaired -> refused, but selection sticks (this is the
    // pairing UX contract: refusal never reverts the selector).
    selectValue(channelSelect(), 'canary')
    await flush()
    await flush()
    expect(channelSelect().value).toBe('canary')
    expect(channelError().hidden).toBe(false)
    // F2(a): the fields already show the honest pairing state - canary's
    // real endpoint, empty token - before the operator types anything.
    expect(urlInput().value).toBe('ws://canary:4753/ui')
    expect(tokenInput().value).toBe('')

    // Pair it: Save always targets the currently-selected (canary) channel.
    changeInputValue(tokenInput(), 'TOK-CANARY-PAIRED')
    act(() => { saveBtn().click() })
    await flush()
    // Save sends exactly the route's real endpoint + the pasted token under
    // profile: canary - the pairing instruction the plan (F2) requires.
    expect(invoke).toHaveBeenCalledWith('save_connection', {
      url: 'ws://canary:4753/ui',
      token: 'TOK-CANARY-PAIRED',
      profile: 'canary',
      activate: false,
    })

    // Retry the switch (re-dispatching 'change' on the already-selected
    // value is deliberate - real code paths that re-trigger a switch, e.g.
    // a retry button, would do the same): now resolvable, so it succeeds.
    selectValue(channelSelect(), 'canary')
    await flush()
    await flush()

    expect(channelError().hidden).toBe(true)
    expect(setDefaultRoute).toHaveBeenCalledWith('canary')
    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'profile-changed' })
  })

  it('save-target: the currently-selected route key always reaches save_connection as `profile`', async () => {
    ;(window as any).MoonSession = {
      ...stubRoutes([{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }], 'stable'),
      setDefaultRoute: vi.fn().mockResolvedValue(true),
    }
    const { ctx, invoke } = makeCtx((cmd) => {
      if (cmd === 'load_route') return { key: 'canary', endpoints: ['ws://canary:4753/ui'] }
      if (cmd === 'resolve_route_token') return 'TOK-CANARY-RESOLVED'
      if (cmd === 'set_active_profile') return { wsUrl: 'ws://canary:4753/ui', wsToken: 'TOK-CANARY' }
      return null
    })
    renderPanel(ctx)
    await flush()
    await flush()

    selectValue(channelSelect(), 'canary')
    await flush()
    await flush()
    expect(channelSelect().value).toBe('canary')

    changeInputValue(tokenInput(), 'sometoken')
    act(() => { saveBtn().click() })
    await flush()

    expect(invoke).toHaveBeenCalledWith('save_connection', expect.objectContaining({ profile: 'canary' }))
  })

  it('F3: the selector is disabled while routes are still being discovered, and a change event driven in that window performs no writes', async () => {
    let resolveRoutes!: (v: unknown) => void
    const routesGate = new Promise((resolve) => { resolveRoutes = resolve })
    ;(window as any).MoonSession = {
      listRoutes: vi.fn(() => routesGate.then(() => ({
        default: 'stable',
        routes: [{ key: 'stable', label: 'Stable' }, { key: 'canary', label: 'Canary' }],
      }))),
    }
    const { ctx, invoke } = makeCtx()
    renderPanel(ctx)
    await flush()

    // Still "unknown" - the selector is disabled, and a driven change performs no writes.
    expect(channelSelect().disabled).toBe(true)
    selectValue(channelSelect(), 'dev')
    await flush()

    expect(invoke).not.toHaveBeenCalledWith('set_active_profile', { name: 'dev' })
    expect(channelError().hidden).toBe(false)
    expect(channelError().textContent).toContain('discovering')

    resolveRoutes(undefined)
    await flush()
    await flush()

    expect(channelSelect().disabled).toBe(false)
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
    const { ctx, invoke } = makeCtx((cmd, args) => {
      if (cmd === 'load_route') {
        return { key: args.routeKey, endpoints: ['ws://' + args.routeKey + ':4753/ui'] }
      }
      if (cmd === 'resolve_route_token') return 'TOK-RESOLVED-' + args.routeKey
      if (cmd === 'set_active_profile') {
        return gate.then(() => ({ wsUrl: 'ws://' + args.name + ':4753/ui', wsToken: 'TOK-' + args.name }))
      }
      return null
    })
    renderPanel(ctx)
    await flush()
    await flush()

    // Fire A, let it reach the gated set_active_profile await.
    selectValue(channelSelect(), 'a-target')
    await flush()

    // Fire B (a DIFFERENT target) BEFORE A's gate resolves - a real user
    // cannot do this (the selector disables itself while a switch is
    // in-flight), so this is the programmatic driver the disabling exists
    // to require.
    selectValue(channelSelect(), 'b-target')
    await flush()

    // Release the SHARED gate - A's continuation is queued first (it
    // awaited first) and must find itself superseded; B's runs second and
    // must be the only one to reach setDefaultRoute.
    resolveSetActiveProfile({})
    await flush()
    await flush()

    expect(setDefaultRoute).toHaveBeenCalledTimes(1)
    expect(setDefaultRoute).toHaveBeenCalledWith('b-target')
    expect(channelSelect().value).toBe('b-target')
    // set_active_profile itself WAS invoked for both attempts - neither
    // could know it would be superseded before making that call. The
    // invariant F4 guards is that only the LATEST-STARTED attempt's writes
    // past that point are ever allowed to land (never an interleave of
    // writes from two DIFFERENT targets).
    expect(invoke).toHaveBeenCalledWith('set_active_profile', { name: 'a-target' })
    expect(invoke).toHaveBeenCalledWith('set_active_profile', { name: 'b-target' })
    expect(channelSelect().disabled).toBe(false)
  })
})

describe('isSettingsConnectionPanelType', () => {
  it('routes the "settings.connection" panel.html type and nothing else', () => {
    expect(isSettingsConnectionPanelType('settings.connection')).toBe(true)
    expect(isSettingsConnectionPanelType('settings.general')).toBe(false)
    expect(isSettingsConnectionPanelType('flow')).toBe(false)
  })
})

describe('mountSettingsConnectionPanel (panel.html contract parity)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__PanelInternals
  })

  it("sets the bar title, document title, renders into #content-area, and sets __PanelInternals - matching what panel.html's bootModule() sets for vanilla panel types", async () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const { ctx } = makeCtx()
    act(() => {
      mountSettingsConnectionPanel('settings.connection', ctx)
    })
    await flush()

    expect(document.getElementById('bar-title')!.textContent).toBe(PANEL_TITLE)
    expect(document.title).toBe(`Luna - ${PANEL_TITLE}`)
    expect(document.querySelectorAll('#content-area [data-testid]').length).toBeGreaterThan(0)
    expect((window as any).__PanelInternals).toEqual({
      type: 'settings.connection',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
