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

    expect(invoke).toHaveBeenCalledWith('save_connection', { url: 'ws://newhost:9000/ui', token: 'mytoken' })
    expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'connection-changed' })
  })

  it('save button shows Saved ✓ on success and does NOT wipe the token field', async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd === 'save_connection') return null
      return null
    })
    renderPanel(ctx)
    await flush()

    changeInputValue(tokenInput(), 'keepme')

    act(() => {
      saveBtn().click()
    })
    await flush()

    expect(saveStatus().textContent).toBe('Saved ✓')
    expect(tokenInput().value).toBe('keepme')
  })

  it('save button shows error on save_connection failure', async () => {
    const { ctx } = makeCtx((cmd) => {
      if (cmd === 'save_connection') throw new Error('disk full')
      return null
    })
    renderPanel(ctx)
    await flush()

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

  it('active profile NOT in listRoutes keys is still present + selected after enumeration', async () => {
    // C8 race: client.toml route keys can diverge from profile names.
    // load_profiles resolves with activeProfile='my-custom' but listRoutes
    // only returns ['prod', 'local'] - the reducer must append 'my-custom'
    // as a dynamic option rather than silently dropping the selection.
    ;(window as any).MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'prod',
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
    expect(optValues).toContain('my-custom')
    expect(channelSelect().value).toBe('my-custom')
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
