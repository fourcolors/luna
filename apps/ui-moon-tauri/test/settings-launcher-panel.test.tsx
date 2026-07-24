// @vitest-environment jsdom
//
// Behavioral tests for the React 19 + Astryx port of the Settings LAUNCHER
// panel (frontend/panels/settings.js -> frontend-react/src/panels/
// SettingsLauncherPanel.tsx + settings-launcher-mount.tsx). Ports every
// behavioral assertion from test/panel-launcher.test.ts (which keeps testing
// the still-vanilla frontend/panel.html + frontend/panels/settings.js — that
// suite is untouched and stays green) onto the React implementation:
//   - boots with the Settings title
//   - renders the ten settings-launcher rows, in order
//   - every row opens its panel via open_widget with the right kind
//   - Skills and Connectors are ALWAYS visible (no capability gate — v1)
//   - a click degrades to a no-op off-Tauri (invoke rejects) without throwing
//   - both 'settings' and 'settings-launcher' panel.html `type` values mount
//     the same UI (the old dual-LunaPanelTypes-registration behavior, now
//     expressed as dual dispatch in isSettingsLauncherPanelType)
//   - the ambient-widgets section lists Now, Briefing and Workflows
//
// This intentionally does NOT re-assert the vanilla version's invented
// role="menu"/"menuitem" ARIA tree — SideNav/SideNavSection/SideNavItem
// (the real Astryx primitives for "a titled group of nav buttons") use
// nav[role="navigation"] + section role="group" instead, which is the more
// correct pattern for a static list of open-a-window actions. Rows are
// queried by data-testid={kind} (SideNavItem's supported test hook) rather
// than the vanilla data-panel-kind attribute.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Tells React this jsdom environment is a synchronous-act test environment
// (React 19 warns without it — see https://react.dev/warnings/react-dom-test-utils).
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import {
  AMBIENT_WIDGETS,
  SETTINGS_LAUNCHER_TITLE,
  SETTINGS_PANELS,
  SettingsLauncherPanel,
} from '../frontend-react/src/panels/SettingsLauncherPanel'
import {
  isSettingsLauncherPanelType,
  mountSettingsLauncherPanel,
} from '../frontend-react/src/panels/settings-launcher-mount'
import type { PanelCtx } from '../frontend-react/src/panels/panel-ctx'

const EXPECTED_KINDS = SETTINGS_PANELS.map((p) => p.kind)

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderPanel(ctx: PanelCtx) {
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(<SettingsLauncherPanel ctx={ctx} />)
  })
  return container
}

function makeCtx(invokeImpl?: (cmd: string, args?: any) => any): { ctx: PanelCtx; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async (cmd: string, args?: any) => (invokeImpl ? invokeImpl(cmd, args) : null))
  return { ctx: { invoke }, invoke }
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
  vi.restoreAllMocks()
})

describe('SettingsLauncherPanel (React port of panels/settings.js)', () => {
  it('renders the settings launcher rows in order', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    const section = el.querySelector('#launcher-list')!
    expect(section).not.toBeNull()
    const kinds = [...section.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'))
    expect(kinds).toEqual(EXPECTED_KINDS)
  })

  it('every row opens its panel via open_widget with the right kind', () => {
    const { ctx, invoke } = makeCtx()
    renderPanel(ctx)
    for (const kind of EXPECTED_KINDS) {
      const btn = document.querySelector(`[data-testid="${kind}"]`) as HTMLElement
      expect(btn).not.toBeNull()
      act(() => {
        btn.click()
      })
      expect(invoke).toHaveBeenCalledWith('open_widget', { kind })
    }
    // One invoke per click — nothing double-fires.
    expect(invoke.mock.calls.filter((c) => c[0] === 'open_widget')).toHaveLength(EXPECTED_KINDS.length)
  })

  it('Skills and Connectors are ALWAYS visible (no hello-capability gate without a WS connection — v1)', () => {
    const { ctx } = makeCtx()
    renderPanel(ctx)
    const skills = document.querySelector('[data-testid="settings.skills"]') as HTMLElement
    const connectors = document.querySelector('[data-testid="settings.connectors"]') as HTMLElement
    expect(skills).not.toBeNull()
    expect(connectors).not.toBeNull()
    expect(skills.hidden).toBe(false)
    expect(connectors.hidden).toBe(false)
  })

  it('rows are real type="button" elements', () => {
    const { ctx } = makeCtx()
    const el = renderPanel(ctx)
    const buttons = [...el.querySelectorAll('#launcher-list button')] as HTMLButtonElement[]
    expect(buttons).toHaveLength(10)
    expect(buttons.every((b) => b.type === 'button')).toBe(true)
  })

  it('a click degrades to a no-op off-Tauri (invoke rejects) without throwing', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('not in Tauri')
    })
    renderPanel({ invoke })
    const btn = document.querySelector('[data-testid="settings.updates"]') as HTMLElement
    expect(() => {
      act(() => {
        btn.click()
      })
    }).not.toThrow()
    await act(async () => {
      await Promise.resolve() // the rejection is caught inside openWidget()
    })
  })

  it('the ambient-widgets section lists Now, Briefing and Workflows, each opening via open_widget', () => {
    const { ctx, invoke } = makeCtx()
    const el = renderPanel(ctx)
    const section = el.querySelector('#launcher-widgets')!
    const kinds = [...section.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid'))
    expect(kinds).toEqual(AMBIENT_WIDGETS.map((w) => w.kind))

    const workflowsBtn = document.querySelector('[data-testid="workflows"]') as HTMLElement
    act(() => {
      workflowsBtn.click()
    })
    expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'workflows' })
  })
})

describe('isSettingsLauncherPanelType (dual dispatch — replaces the vanilla dual LunaPanelTypes registration)', () => {
  it('routes both the widget KIND ("settings") and the file-name type ("settings-launcher")', () => {
    expect(isSettingsLauncherPanelType('settings')).toBe(true)
    expect(isSettingsLauncherPanelType('settings-launcher')).toBe(true)
    expect(isSettingsLauncherPanelType('settings.general')).toBe(false)
    expect(isSettingsLauncherPanelType('flow')).toBe(false)
  })
})

describe('mountSettingsLauncherPanel (panel.html contract parity)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__PanelInternals
  })

  it('sets the bar title, document title, renders into #content-area, and sets __PanelInternals — matching what panel.html\'s bootModule() sets for vanilla panel types', () => {
    document.body.innerHTML = `
      <div class="widget-shell">
        <div class="title-bar" id="title-bar"><span id="bar-title">Loading…</span></div>
        <div class="content-area" id="content-area"></div>
      </div>
    `
    const { ctx } = makeCtx()
    act(() => {
      mountSettingsLauncherPanel('settings', ctx)
    })

    expect(document.getElementById('bar-title')!.textContent).toBe(SETTINGS_LAUNCHER_TITLE)
    expect(document.title).toBe(`Luna — ${SETTINGS_LAUNCHER_TITLE}`)
    expect(document.querySelectorAll('#content-area [data-testid]').length).toBeGreaterThan(0)
    expect((window as any).__PanelInternals).toEqual({
      type: 'settings',
      hasModule: true,
      resolvedRouteKey: null,
      lastNotice: null,
    })
  })
})
