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

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('PanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  return { invoke }
}

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as any).__TAURI__
  delete (window as any).__PanelInternals
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

  it('settings.updates renders the check button with the panel title', () => {
    bootPanel({ type: 'settings.updates' })
    expect(document.getElementById('bar-title')!.textContent).toBe('Updates')
    expect(document.getElementById('check-update-btn')).toBeTruthy()
    expect(document.getElementById('update-status')!.textContent).toBe('')
  })

  it('check → up to date when check_for_update returns null', async () => {
    const { invoke } = bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => (cmd === 'check_for_update' ? null : null),
    })
    document.getElementById('check-update-btn')!.click()
    await vi.waitFor(() =>
      expect(document.getElementById('update-status')!.textContent).toBe('Up to date ✓'))
    expect(invoke).toHaveBeenCalledWith('check_for_update')
    expect((document.getElementById('install-update-btn')!.parentElement as HTMLElement).hidden).toBe(true)
  })

  it('check → reveals Update & Restart when a version is available', async () => {
    bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => (cmd === 'check_for_update' ? { version: '9.9.9' } : null),
    })
    document.getElementById('check-update-btn')!.click()
    await vi.waitFor(() =>
      expect(document.getElementById('update-status')!.textContent).toContain('9.9.9'))
    expect((document.getElementById('install-update-btn')!.parentElement as HTMLElement).hidden).toBe(false)
  })

  it('check failure paints the error instead of throwing', async () => {
    bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => {
        if (cmd === 'check_for_update') throw new Error('offline')
        return null
      },
    })
    document.getElementById('check-update-btn')!.click()
    await vi.waitFor(() =>
      expect(document.getElementById('update-status')!.textContent).toContain('Update check failed'))
  })

  it('install failure re-enables the button and reports', async () => {
    bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => {
        if (cmd === 'check_for_update') return { version: '9.9.9' }
        if (cmd === 'install_update') throw new Error('sig mismatch')
        return null
      },
    })
    document.getElementById('check-update-btn')!.click()
    await vi.waitFor(() =>
      expect((document.getElementById('install-update-btn')!.parentElement as HTMLElement).hidden).toBe(false))
    const installBtn = document.getElementById('install-update-btn') as HTMLButtonElement
    installBtn.click()
    await vi.waitFor(() =>
      expect(document.getElementById('update-status')!.textContent).toContain('Install failed'))
    expect(installBtn.disabled).toBe(false)
  })

  it('✕ closes via close_widget with this window label', async () => {
    const { invoke } = bootPanel({ type: 'settings.updates' })
    document.getElementById('close-btn')!.click()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('close_widget', { label: 'panel-settings-updates' }))
  })
})
