// @vitest-environment jsdom
//
// Behavioral tests for panels/settings.js — the Settings LAUNCHER
// panel (widget kind 'settings'). Same harness pattern as panel-window.test.ts:
// drive the real panel.html inline script with the real vendor modules and a
// mocked __TAURI__, preloading the module file by hand (jsdom never fetches
// the loader's injected <script src>).
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/panel.html'), 'utf8')

const EXPECTED_KINDS = [
  'settings.general',
  'settings.appearance',
  'settings.connection',
  'settings.voice',
  'settings.models',
  'settings.vault',
  'settings.skills',
  'settings.connectors',
  'settings.apps',
  'settings.updates',
]

function bootLauncher(opts: { invoke?: (cmd: string, args?: any) => any } = {}) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  const invoke = vi.fn(async (cmd: string, args?: any) => (opts.invoke ? opts.invoke(cmd, args) : null))
  const me = {
    label: 'panel-settings',
    listen: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 300, height: 360 })),
    scaleFactor: vi.fn(async () => 1),
  }
  ;(window as any).__TAURI__ = {
    window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
    core: { invoke },
    event: { listen: vi.fn(async () => () => {}) },
  }

  // location.search is read-only in jsdom — stub history state instead.
  window.history.replaceState({}, '', '/panel.html?type=settings')

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'moon-dock.js')

  // Preload the module (the FILE is settings.js; it registers the
  // 'settings' kind, so the loader finds it already registered and boots it).
  const moduleFile = path.resolve(__dirname, '../frontend/panels/settings.js')
  new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

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
  vi.restoreAllMocks()
})

describe('settings-launcher panel (kind "settings")', () => {
  it('boots with the Settings title and renders the settings launcher buttons in order', () => {
    bootLauncher()
    expect((window as any).__PanelInternals.hasModule).toBe(true)
    expect(document.getElementById('bar-title')!.textContent).toBe('Settings')
    const kinds = [...document.querySelectorAll('#launcher-list button[data-panel-kind]')]
      .map((b) => b.getAttribute('data-panel-kind'))
    expect(kinds).toEqual(EXPECTED_KINDS)
  })

  it('every button opens its panel via open_widget with the right kind', () => {
    const { invoke } = bootLauncher()
    for (const kind of EXPECTED_KINDS) {
      const btn = document.querySelector(`button[data-panel-kind="${kind}"]`) as HTMLButtonElement
      expect(btn).not.toBeNull()
      btn.click()
      // opener = this launcher's own label, so the sub-panel docks next to it.
      expect(invoke).toHaveBeenCalledWith('open_widget', { kind, opener: 'panel-settings' })
    }
    // One invoke per click — nothing double-fires.
    expect(invoke.mock.calls.filter((c) => c[0] === 'open_widget')).toHaveLength(EXPECTED_KINDS.length)
  })

  it('Skills and Connectors are ALWAYS visible (no hello-capability gate without a WS connection — v1)', () => {
    bootLauncher()
    const skills = document.querySelector('button[data-panel-kind="settings.skills"]') as HTMLElement
    const connectors = document.querySelector('button[data-panel-kind="settings.connectors"]') as HTMLElement
    expect(skills.hidden).toBe(false)
    expect(connectors.hidden).toBe(false)
  })

  it('buttons are real type="button" menu items (no implicit form submits)', () => {
    bootLauncher()
    const buttons = [...document.querySelectorAll('#launcher-list button')] as HTMLButtonElement[]
    expect(buttons).toHaveLength(10)
    expect(buttons.every((b) => b.type === 'button')).toBe(true)
    expect(buttons.every((b) => b.getAttribute('role') === 'menuitem')).toBe(true)
    expect(document.getElementById('launcher-list')!.getAttribute('role')).toBe('menu')
  })

  it('a click degrades to a no-op off-Tauri (invoke rejects) without throwing', async () => {
    bootLauncher()
    // ctx.invoke reads window.__TAURI__.core at CALL time — drop it.
    delete ((window as any).__TAURI__ as any).core
    const btn = document.querySelector('button[data-panel-kind="settings.updates"]') as HTMLButtonElement
    expect(() => btn.click()).not.toThrow()
    await Promise.resolve() // the rejection is caught inside the module
  })

  it('registers under BOTH the widget kind and the file-name type (loader compatibility)', () => {
    bootLauncher()
    const types = (window as any).LunaPanelTypes
    expect(types['settings']).toBeDefined()
    expect(types['settings-launcher']).toBe(types['settings'])
  })
})
