// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Models settings
// panel (frontend/panels/settings-models.js -> frontend-react/src/panels/
// settings-models/SettingsModelsPanel.tsx + settings-models-mount.tsx).
// There is no dedicated vanilla-era test file for this panel to port from
// (panel-general.test.ts covers 'settings.general', a different panel) -
// this suite writes fresh coverage of the vanilla module's documented
// behavior (frontend/panels/settings-models.js's own header comment, still
// readable in git history) directly against the React implementation:
//   - gates on the hello `modelRouting` capability
//   - renders one card per provider, expanding credential-ref/monthly-cap
//     fields only while that provider is enabled, with a gated-provider notice
//   - toggling/editing a provider marks the panel dirty
//   - a model-routing-list frame REFRESHES drafts when clean, but is IGNORED
//     while dirty (unsaved edits survive a server push)
//   - Save posts a model-routing-save frame built from the current drafts
//     (provider kind inferred from the model id) and shows "Saving…"
//   - model-routing-status ok/not-ok flips the status line and, on ok,
//     clears dirty; a mismatched requestId is ignored
//   - Save degrades to "Not connected to a server." when the socket isn't open
//   - the extra Ollama Local/Cloud role-model options only appear once their
//     provider draft is enabled (logic-level: see roleModelOptions in the
//     component, exercised indirectly via reduceModelRouting below)
//
// Astryx's Selector is a custom (non-native) combobox+popover, not a plain
// <select> - its own test suite (Selector.test.tsx) already covers open/
// select/close interaction, so this file doesn't re-drive that popover.
// Instead it asserts the trigger's rendered current-value text and drives
// the "pick a different role model" BEHAVIOR at the reducer level
// (reduceModelRouting's 'set-role-model' case, in logic.test.ts) - the same
// split settings-launcher-panel.test.tsx uses for library-owned widgets.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it - see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { PANEL_TITLE, SettingsModelsPanel } from '../frontend-react/src/panels/settings-models/SettingsModelsPanel'
import {
  isSettingsModelsPanelType,
  mountSettingsModelsPanel,
  SETTINGS_MODELS_PANEL_TYPES,
} from '../frontend-react/src/panels/settings-models-mount'
import type { LunaFrameRegistry, LunaWsClient, PanelCtx } from '../frontend-react/src/panels/panel-ctx'
import { PROVIDERS, ROLES } from '../frontend-react/src/panels/settings-models/logic'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

class FakeWsClient implements LunaWsClient {
  sent: Record<string, unknown>[] = []
  closed = false
  isOpen = true
  sendSucceeds = true
  connect(): unknown {
    return null
  }
  send(frame: Record<string, unknown>): boolean {
    if (!this.sendSucceeds) return false
    this.sent.push(frame)
    return true
  }
  close(): void {
    this.closed = true
  }
  registerCloseHook(): void {}
  socket(): unknown {
    return this.isOpen ? { readyState: 1 } : null
  }
}

interface Harness {
  ctx: PanelCtx
  registry: () => LunaFrameRegistry
  client: FakeWsClient
  invoke: ReturnType<typeof vi.fn>
}

function makeHarness(): Harness {
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  const client = new FakeWsClient()
  let capturedRegistry: LunaFrameRegistry | null = null
  const invoke = vi.fn(async () => null)
  const ctx: PanelCtx = {
    invoke,
    connectWs: (registry) => {
      capturedRegistry = registry
      return client
    },
  }
  return {
    ctx,
    registry: () => {
      if (!capturedRegistry) throw new Error('connectWs was not called yet — render the panel first')
      return capturedRegistry
    },
    client,
    invoke,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderPanel(ctx: PanelCtx): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root!.render(<SettingsModelsPanel ctx={ctx} />)
  })
  return container
}

function enableModelRouting(h: Harness) {
  act(() => {
    h.registry().dispatch({ type: 'hello', capabilities: { modelRouting: true } })
  })
}

function pushList(h: Harness, providers: unknown[] = [], roleBindings: unknown[] = []) {
  act(() => {
    h.registry().dispatch({ type: 'model-routing-list', providers, roleBindings })
  })
}

function inputWithin(testid: string): HTMLInputElement {
  const el = document.querySelector(`[data-testid="${testid}"]`)
  if (!el) throw new Error(`no element with data-testid="${testid}"`)
  return (el.tagName === 'INPUT' ? el : el.querySelector('input')) as HTMLInputElement
}

// React installs a tracked-value setter on controlled <input> DOM nodes in
// development builds; plain `input.value = x` followed by a bare 'input'
// event is invisible to it (React's tracker sees its own last-set value and
// swallows the change) — mirrors testing-library's fireEvent.change, which
// hits the native prototype setter instead so React's change detection
// actually fires onChange.
function typeInto(input: HTMLInputElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  nativeSetter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
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
  document.body.innerHTML = ''
  delete (window as any).LunaWS
  delete (window as any).LunaProtocol
  delete (window as any).__PanelInternals
  vi.restoreAllMocks()
})

describe('SettingsModelsPanel — hello capability gate', () => {
  it('shows the unsupported notice and no controls before hello arrives', () => {
    const h = makeHarness()
    const el = renderPanel(h.ctx)
    expect(el.querySelector('[data-testid="settings-models-unsupported"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="settings-models-root"]')).toBeNull()
  })

  it('shows the unsupported notice when hello omits modelRouting (old server)', () => {
    const h = makeHarness()
    const el = renderPanel(h.ctx)
    act(() => {
      h.registry().dispatch({ type: 'hello', capabilities: {} })
    })
    expect(el.querySelector('[data-testid="settings-models-unsupported"]')).not.toBeNull()
  })

  it('renders the full settings surface once hello advertises modelRouting', () => {
    const h = makeHarness()
    const el = renderPanel(h.ctx)
    enableModelRouting(h)
    expect(el.querySelector('[data-testid="settings-models-unsupported"]')).toBeNull()
    expect(el.querySelector('[data-testid="settings-models-root"]')).not.toBeNull()
    for (const p of PROVIDERS) {
      expect(el.querySelector(`[data-testid="provider-card-${p.kind}"]`)).not.toBeNull()
    }
    for (const role of ROLES) {
      expect(el.querySelector(`[data-testid="role-row-${role}"]`)).not.toBeNull()
    }
  })
})

describe('SettingsModelsPanel — provider cards', () => {
  it('hides credential/cap fields until a provider is enabled, and shows them once toggled on', () => {
    const h = makeHarness()
    renderPanel(h.ctx)
    enableModelRouting(h)

    expect(document.querySelector('[data-testid="provider-anthropic-credential"]')).toBeNull()
    expect(document.querySelector('[data-testid="provider-anthropic-cap"]')).toBeNull()

    const toggle = inputWithin('provider-anthropic-toggle')
    act(() => {
      toggle.click()
    })

    expect(document.querySelector('[data-testid="provider-anthropic-credential"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="provider-anthropic-cap"]')).not.toBeNull()
  })

  it('shows the gated-provider notice only for gated providers, and only while enabled', () => {
    const h = makeHarness()
    renderPanel(h.ctx)
    enableModelRouting(h)

    const anthropicCard = document.querySelector('[data-testid="provider-card-anthropic"]')!
    act(() => {
      inputWithin('provider-anthropic-toggle').click()
    })
    expect(anthropicCard.textContent).not.toContain('routes via LiteLLM gateway')

    const openaiCard = document.querySelector('[data-testid="provider-card-openai"]')!
    expect(openaiCard.textContent).not.toContain('routes via LiteLLM gateway')
    act(() => {
      inputWithin('provider-openai-toggle').click()
    })
    expect(openaiCard.textContent).toContain('routes via LiteLLM gateway')
  })

  it('typing a credential ref and a monthly cap updates the draft (surfaced through Save\'s payload)', () => {
    const h = makeHarness()
    renderPanel(h.ctx)
    enableModelRouting(h)
    act(() => {
      inputWithin('provider-anthropic-toggle').click()
    })

    act(() => {
      typeInto(inputWithin('provider-anthropic-credential'), 'env:ANTHROPIC_API_KEY')
    })

    act(() => {
      typeInto(inputWithin('provider-anthropic-cap'), '50')
    })

    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="save-models-btn"]')!.click()
    })
    const saved = h.client.sent.find((f) => f.type === 'model-routing-save') as any
    const anthropic = saved.providers.find((p: any) => p.kind === 'anthropic')
    expect(anthropic.enabled).toBe(true)
    expect(anthropic.credentialRef).toBe('env:ANTHROPIC_API_KEY')
    expect(anthropic.monthlyCapUsd).toBe(50)
  })
})

describe('SettingsModelsPanel — server push vs. unsaved drafts', () => {
  it('a model-routing-list frame seeds the drafts when the panel is clean', () => {
    const h = makeHarness()
    const el = renderPanel(h.ctx)
    enableModelRouting(h)
    pushList(h, [{ kind: 'anthropic', enabled: true, credentialRef: 'env:X' }], [])

    expect(inputWithin('provider-anthropic-toggle').checked).toBe(true)
    expect(inputWithin('provider-anthropic-credential').value).toBe('env:X')
    void el
  })

  it('a later model-routing-list frame does NOT clobber unsaved edits (isDirty)', () => {
    const h = makeHarness()
    renderPanel(h.ctx)
    enableModelRouting(h)
    pushList(h, [{ kind: 'anthropic', enabled: false }], [])

    // User edits — enables anthropic and sets a credential ref (dirty).
    act(() => {
      inputWithin('provider-anthropic-toggle').click()
    })
    act(() => {
      typeInto(inputWithin('provider-anthropic-credential'), 'env:UNSAVED')
    })

    // Server pushes a fresh (different) list while the user has unsaved edits.
    pushList(h, [{ kind: 'anthropic', enabled: false }], [])

    expect(inputWithin('provider-anthropic-toggle').checked).toBe(true)
    expect(inputWithin('provider-anthropic-credential').value).toBe('env:UNSAVED')
  })
})

describe('SettingsModelsPanel — Save flow', () => {
  it('Save posts model-routing-save with a per-role preferenceList and shows "Saving…"', () => {
    const h = makeHarness()
    const el = renderPanel(h.ctx)
    enableModelRouting(h)
    pushList(h, [], [])

    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="save-models-btn"]')!.click()
    })

    expect(h.client.sent).toHaveLength(1)
    const frame = h.client.sent[0] as any
    expect(frame.type).toBe('model-routing-save')
    expect(typeof frame.requestId).toBe('string')
    expect(frame.requestId.length).toBeGreaterThan(0)
    expect(frame.roleBindings).toHaveLength(ROLES.length)
    for (const rb of frame.roleBindings) {
      expect(rb.preferenceList).toHaveLength(1)
      expect(rb.preferenceList[0].provider).toBe('anthropic') // every default role model is a claude-* id
    }
    expect(el.querySelector('[data-testid="save-status"]')?.textContent).toBe('Saving…')
  })

  it('degrades to "Not connected to a server." when the socket is not open, without sending a frame', () => {
    const h = makeHarness()
    h.client.isOpen = false
    const el = renderPanel(h.ctx)
    enableModelRouting(h)
    pushList(h, [], [])

    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="save-models-btn"]')!.click()
    })

    expect(h.client.sent).toHaveLength(0)
    expect(el.querySelector('[data-testid="save-status"]')?.textContent).toBe('Not connected to a server.')
  })

  it('a model-routing-status ok:true ack shows the server message and clears dirty', () => {
    const h = makeHarness()
    const el = renderPanel(h.ctx)
    enableModelRouting(h)
    pushList(h, [], [])
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="save-models-btn"]')!.click()
    })
    const requestId = (h.client.sent[0] as any).requestId

    act(() => {
      h.registry().dispatch({ type: 'model-routing-status', requestId, ok: true, message: 'Saved. Restarting…' })
    })
    expect(el.querySelector('[data-testid="save-status"]')?.textContent).toBe('Saved. Restarting…')

    // Dirty is now clear — a fresh server push is accepted again.
    pushList(h, [{ kind: 'anthropic', enabled: true, credentialRef: 'env:AFTER-SAVE' }], [])
    expect(inputWithin('provider-anthropic-toggle').checked).toBe(true)
    expect(inputWithin('provider-anthropic-credential').value).toBe('env:AFTER-SAVE')
  })

  it('a model-routing-status ok:false ack shows the error message', () => {
    const h = makeHarness()
    const el = renderPanel(h.ctx)
    enableModelRouting(h)
    pushList(h, [], [])
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="save-models-btn"]')!.click()
    })
    const requestId = (h.client.sent[0] as any).requestId

    act(() => {
      h.registry().dispatch({ type: 'model-routing-status', requestId, ok: false, message: 'Invalid credential ref.' })
    })
    expect(el.querySelector('[data-testid="save-status"]')?.textContent).toBe('Invalid credential ref.')
  })

  it('ignores a model-routing-status ack whose requestId does not match the in-flight save', () => {
    const h = makeHarness()
    const el = renderPanel(h.ctx)
    enableModelRouting(h)
    pushList(h, [], [])
    act(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="save-models-btn"]')!.click()
    })

    act(() => {
      h.registry().dispatch({ type: 'model-routing-status', requestId: 'stale_req_id', ok: true, message: 'Should be ignored' })
    })
    expect(el.querySelector('[data-testid="save-status"]')?.textContent).toBe('Saving…')
  })
})

describe('SettingsModelsPanel — WS lifecycle', () => {
  it('closes the WS client on unmount', () => {
    const h = makeHarness()
    renderPanel(h.ctx)
    enableModelRouting(h)
    expect(h.client.closed).toBe(false)
    act(() => {
      root!.unmount()
      root = null
    })
    expect(h.client.closed).toBe(true)
  })
})

describe('isSettingsModelsPanelType', () => {
  it('matches only "settings.models"', () => {
    expect(SETTINGS_MODELS_PANEL_TYPES).toEqual(['settings.models'])
    expect(isSettingsModelsPanelType('settings.models')).toBe(true)
    expect(isSettingsModelsPanelType('settings.general')).toBe(false)
    expect(isSettingsModelsPanelType('settings')).toBe(false)
  })
})

describe('mountSettingsModelsPanel (panel.html contract parity)', () => {
  it('sets the bar title, document title, renders into #content-area, and sets __PanelInternals', () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const h = makeHarness()
    act(() => {
      mountSettingsModelsPanel('settings.models', h.ctx)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(PANEL_TITLE)
    expect(document.title).toBe(`Luna — ${PANEL_TITLE}`)
    expect(document.querySelector('#content-area [data-testid]')).not.toBeNull()
    expect((window as any).__PanelInternals).toEqual({
      type: 'settings.models',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
