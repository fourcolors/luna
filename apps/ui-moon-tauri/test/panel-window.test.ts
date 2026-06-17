// @vitest-environment jsdom
//
// Behavioral tests for panel.html — the SYSTEM widget host (Phase 2). Drives
// the real inline script with the real vendor modules, mocked __TAURI__.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
    outerSize: vi.fn(async () => ({ width: 360, height: 200 })),
    scaleFactor: vi.fn(async () => 1),
  }
  ;(window as any).__TAURI__ = {
    window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
    core: { invoke },
    event: { listen: vi.fn(async () => () => {}) },
  }

  // location.search is read-only in jsdom — the page reads
  // new URLSearchParams(location.search), so stub history state instead.
  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(opts.type))

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'deck-snap.js')
  loadVendorInto(window, 'moon-dock.js')

  // Preload the panel module the way the harness must (jsdom never fetches
  // the loader's injected <script src>); the loader sees it registered and
  // boots it directly. Unknown types stay unregistered → notice path.
  const moduleFile = path.resolve(__dirname, '../frontend/panels', opts.type.replace(/\./g, '-') + '.js')
  if (fs.existsSync(moduleFile)) {
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)
  }

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  // jsdom never loads injected <script src> tags: fire the error event the
  // way a real 404 would, so unknown types reach the notice path.
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
  vi.restoreAllMocks()
})

describe('panel.html system-widget host', () => {
  it('unknown type renders a notice and registers no module', () => {
    bootPanel({ type: 'settings.nope' })
    expect((window as any).__PanelInternals.hasModule).toBe(false)
    expect(document.getElementById('bar-title')!.textContent).toBe('Unknown panel')
    expect(document.querySelector('.notice')!.textContent).toContain('settings.nope')
  })

  // settings.updates is the representative system-widget the panel.html HOST
  // tests ride on. The staged-narrative behaviour of the rebuilt updates panel
  // (Slice B) is covered exhaustively in panel-updates.test.ts; here we only
  // assert host-level concerns (title wiring, the panel renders, commands fire,
  // failures degrade) against the new DOM contract.
  it('settings.updates renders the staged panel with the panel title', () => {
    bootPanel({ type: 'settings.updates' })
    expect(document.getElementById('bar-title')!.textContent).toBe('Updates')
    expect(document.getElementById('check-update-btn')).toBeTruthy()
    // Idle by default: status pill reads "Up to date", card hidden.
    expect(document.getElementById('update-pill')!.textContent).toBe('Up to date')
    expect((document.getElementById('update-card') as HTMLElement).hidden).toBe(true)
  })

  it('Check for updates invokes check_for_update through the host ctx', async () => {
    const { invoke } = bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => (cmd === 'check_for_update' ? null : null),
    })
    document.getElementById('check-update-btn')!.click()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('check_for_update'))
  })

  it('check returning a version moves the pill to "Update found" and shows the card', async () => {
    bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => (cmd === 'check_for_update' ? { version: '9.9.9' } : null),
    })
    document.getElementById('check-update-btn')!.click()
    await vi.waitFor(() =>
      expect(document.getElementById('update-pill')!.textContent).toBe('Update found'))
    expect((document.getElementById('update-card') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('update-card-version')!.textContent).toContain('9.9.9')
  })

  it('check failure paints the error line instead of throwing', async () => {
    bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => {
        if (cmd === 'check_for_update') throw new Error('offline')
        return null
      },
    })
    expect(() => document.getElementById('check-update-btn')!.click()).not.toThrow()
    await vi.waitFor(() =>
      expect((document.getElementById('update-error') as HTMLElement).hidden).toBe(false))
    expect(document.getElementById('update-error')!.textContent).toContain('offline')
  })

  it('Restart to update (at ready) invokes apply_update; failure re-enables it', async () => {
    bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => {
        if (cmd === 'apply_update') throw new Error('sig mismatch')
        return null
      },
    })
    // Drive to the ready face via the exposed test seam.
    const content = document.getElementById('content-area')!
    ;(content as any).__updatesController.onEvent('update://ready', { version: '9.9.9', notes: 'n' })
    const restartBtn = document.getElementById('restart-update-btn') as HTMLButtonElement
    expect(restartBtn.hidden).toBe(false)
    restartBtn.click()
    await vi.waitFor(() =>
      expect((document.getElementById('update-error') as HTMLElement).hidden).toBe(false))
    expect(document.getElementById('update-error')!.textContent).toContain('sig mismatch')
    // Failure path re-enables the button so the user can retry.
    expect(restartBtn.disabled).toBe(false)
  })

  it('✕ closes via close_widget with this window label', async () => {
    const { invoke } = bootPanel({ type: 'settings.updates' })
    document.getElementById('close-btn')!.click()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('close_widget', { label: 'panel-settings-updates' }))
  })

  it('– (minimize) collapses the whole workspace into the moon via collapse_to_moon', async () => {
    // The yellow light no longer drops THIS window to the OS dock; it tucks the
    // entire workspace into the orb (collapse_to_moon), the global gesture.
    const { invoke } = bootPanel({ type: 'settings.updates' })
    document.getElementById('min-btn')!.click()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('collapse_to_moon'))
  })
})
