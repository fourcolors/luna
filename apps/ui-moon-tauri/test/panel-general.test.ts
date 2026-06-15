// @vitest-environment jsdom
//
// Behavioral tests for the settings.general panel module.
// Drives the REAL module through the REAL panel.html inline script,
// using the bootPanel harness from panel-window.test.ts.
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

  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(opts.type))

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'deck-snap.js')
  loadVendorInto(window, 'moon-dock.js')

  const moduleFile = path.resolve(__dirname, '../frontend/panels', opts.type.replace(/\./g, '-') + '.js')
  if (fs.existsSync(moduleFile)) {
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)
  }

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

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

describe('settings.general panel', () => {

  // ── Initial render ────────────────────────────────────────────────────────

  it('renders with title "General" and the four controls', () => {
    bootPanel({ type: 'settings.general' })
    expect(document.getElementById('bar-title')!.textContent).toBe('General')
    expect(document.getElementById('always-on-top-toggle')).toBeTruthy()
    expect(document.getElementById('close-on-blur-toggle')).toBeTruthy()
    expect(document.getElementById('shortcut-input')).toBeTruthy()
    expect(document.getElementById('record-shortcut-btn')).toBeTruthy()
    expect(document.getElementById('fresh-thread-btn')).toBeTruthy()
  })

  it('always-on-top defaults to checked when localStorage is empty', () => {
    bootPanel({ type: 'settings.general' })
    const cb = document.getElementById('always-on-top-toggle') as HTMLInputElement
    expect(cb.checked).toBe(true)
  })

  it('close-on-blur defaults to unchecked when localStorage is empty', () => {
    bootPanel({ type: 'settings.general' })
    const cb = document.getElementById('close-on-blur-toggle') as HTMLInputElement
    expect(cb.checked).toBe(false)
  })

  it('shortcut input shows default ⌥Space when localStorage is empty', () => {
    bootPanel({ type: 'settings.general' })
    const input = document.getElementById('shortcut-input') as HTMLInputElement
    expect(input.value).toBe('⌥Space')
  })

  it('restores saved values from localStorage on render', () => {
    localStorage.setItem('luna_always_on_top', 'false')
    localStorage.setItem('luna_close_on_blur', 'true')
    localStorage.setItem('luna_global_shortcut', '⌘K')
    bootPanel({ type: 'settings.general' })
    expect((document.getElementById('always-on-top-toggle') as HTMLInputElement).checked).toBe(false)
    expect((document.getElementById('close-on-blur-toggle') as HTMLInputElement).checked).toBe(true)
    expect((document.getElementById('shortcut-input') as HTMLInputElement).value).toBe('⌘K')
  })

  // ── Always on Top checkbox ────────────────────────────────────────────────

  it('toggling always-on-top writes luna_always_on_top to localStorage', () => {
    bootPanel({ type: 'settings.general' })
    const cb = document.getElementById('always-on-top-toggle') as HTMLInputElement
    // Default is checked (true); uncheck it.
    cb.checked = false
    cb.dispatchEvent(new Event('change'))
    expect(localStorage.getItem('luna_always_on_top')).toBe('false')
    // Re-check it.
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    expect(localStorage.getItem('luna_always_on_top')).toBe('true')
  })

  // ── Close on blur checkbox ────────────────────────────────────────────────

  it('toggling close-on-blur writes luna_close_on_blur to localStorage', () => {
    bootPanel({ type: 'settings.general' })
    const cb = document.getElementById('close-on-blur-toggle') as HTMLInputElement
    cb.checked = true
    cb.dispatchEvent(new Event('change'))
    expect(localStorage.getItem('luna_close_on_blur')).toBe('true')
    cb.checked = false
    cb.dispatchEvent(new Event('change'))
    expect(localStorage.getItem('luna_close_on_blur')).toBe('false')
  })

  // ── Shortcut recorder ─────────────────────────────────────────────────────

  it('Record button toggles to Cancel and sets recording placeholder', () => {
    bootPanel({ type: 'settings.general' })
    const btn = document.getElementById('record-shortcut-btn') as HTMLButtonElement
    const input = document.getElementById('shortcut-input') as HTMLInputElement
    btn.click()
    expect(btn.textContent).toBe('Cancel')
    expect(input.value).toBe('Press keys...')
    expect(input.classList.contains('recording')).toBe(true)
  })

  it('clicking Cancel while recording restores the saved shortcut and exits recording mode', () => {
    localStorage.setItem('luna_global_shortcut', '⌘J')
    bootPanel({ type: 'settings.general' })
    const btn = document.getElementById('record-shortcut-btn') as HTMLButtonElement
    const input = document.getElementById('shortcut-input') as HTMLInputElement
    btn.click() // start recording
    btn.click() // cancel
    expect(btn.textContent).toBe('Record')
    expect(input.value).toBe('⌘J')
    expect(input.classList.contains('recording')).toBe(false)
  })

  it('keydown while recording writes luna_global_shortcut and exits recording mode', () => {
    bootPanel({ type: 'settings.general' })
    const btn = document.getElementById('record-shortcut-btn') as HTMLButtonElement
    const input = document.getElementById('shortcut-input') as HTMLInputElement
    btn.click() // enter recording mode
    // Simulate Alt+Space keydown
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', altKey: true, bubbles: true, cancelable: true }),
    )
    expect(input.value).toBe('⌥Space')
    expect(localStorage.getItem('luna_global_shortcut')).toBe('⌥Space')
    expect(btn.textContent).toBe('Record')
    expect(input.classList.contains('recording')).toBe(false)
  })

  it('modifier-only keydown while recording does NOT save or exit recording mode', () => {
    bootPanel({ type: 'settings.general' })
    const btn = document.getElementById('record-shortcut-btn') as HTMLButtonElement
    const input = document.getElementById('shortcut-input') as HTMLInputElement
    btn.click()
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true, cancelable: true }),
    )
    // Still recording — no shortcut saved, placeholder still shows
    expect(input.value).toBe('Press keys...')
    expect(localStorage.getItem('luna_global_shortcut')).toBeNull()
    expect(btn.textContent).toBe('Cancel')
  })

  it('keydown outside recording mode does not modify the shortcut', () => {
    localStorage.setItem('luna_global_shortcut', '⌥Space')
    bootPanel({ type: 'settings.general' })
    const input = document.getElementById('shortcut-input') as HTMLInputElement
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }),
    )
    expect(input.value).toBe('⌥Space')
    expect(localStorage.getItem('luna_global_shortcut')).toBe('⌥Space')
  })

  it('records correct modifier-prefix order: Ctrl Alt Shift Meta', () => {
    bootPanel({ type: 'settings.general' })
    const btn = document.getElementById('record-shortcut-btn') as HTMLButtonElement
    btn.click()
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(localStorage.getItem('luna_global_shortcut')).toBe('⌃⌥⇧⌘P')
  })

  // ── Fresh thread button ───────────────────────────────────────────────────

  it('clicking fresh-thread-btn invokes hub_event with name fresh-thread', async () => {
    const { invoke } = bootPanel({ type: 'settings.general' })
    document.getElementById('fresh-thread-btn')!.click()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('hub_event', { name: 'fresh-thread' }),
    )
  })

  it('fresh-thread-btn swallows invoke errors (fire-and-forget)', async () => {
    const { invoke } = bootPanel({
      type: 'settings.general',
      invoke: (cmd) => {
        if (cmd === 'hub_event') throw new Error('hub gone')
        return null
      },
    })
    // Should not throw
    expect(() => document.getElementById('fresh-thread-btn')!.click()).not.toThrow()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
  })
})
