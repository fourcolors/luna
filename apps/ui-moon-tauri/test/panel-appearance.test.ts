// @vitest-environment jsdom
//
// Behavioral tests for the settings.appearance panel module.
// Drives the REAL module through the REAL panel.html inline script,
// using the bootPanel harness from panel-window.test.ts.
//
// moon-appearance.js is preloaded via loadVendorInto before the panel module
// so window.LunaAppearance is in place when render() runs (same pattern as
// moon-vendor.test.ts for protocol/ws vendor files).
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
    outerSize: vi.fn(async () => ({ width: 300, height: 440 })),
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
  // Preload moon-appearance.js so LunaAppearance is available during render().
  loadVendorInto(window, 'moon-appearance.js')

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
  delete (window as any).LunaDock
  delete (window as any).LunaAppearance
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('settings.appearance panel', () => {

  // ── Initial render (default state: tide/dark/wash/no-grain) ──────────────

  it('renders with title "Appearance"', () => {
    bootPanel({ type: 'settings.appearance' })
    expect(document.getElementById('bar-title')!.textContent).toBe('Appearance')
  })

  it('renders 3 swatch buttons — tide is active by default', () => {
    bootPanel({ type: 'settings.appearance' })
    const swatches = document.querySelectorAll('.swatch')
    expect(swatches).toHaveLength(3)
    const activeSwatch = document.querySelector('.swatch.active') as HTMLElement
    expect(activeSwatch).not.toBeNull()
    expect(activeSwatch.getAttribute('aria-label')).toBe('tide')
  })

  it('each swatch contains 5 color spans', () => {
    bootPanel({ type: 'settings.appearance' })
    const swatches = document.querySelectorAll('.swatch')
    swatches.forEach((swatch) => {
      expect(swatch.querySelectorAll('span')).toHaveLength(5)
    })
  })

  it('"dark" chip is active by default', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const darkChip = chips.find((c) => c.textContent === 'dark')
    const lightChip = chips.find((c) => c.textContent === 'light')
    expect(darkChip).not.toBeNull()
    expect(darkChip!.classList.contains('on')).toBe(true)
    expect(lightChip!.classList.contains('on')).toBe(false)
  })

  it('"soft wash" chrome chip is active by default', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const washChip = chips.find((c) => c.textContent === 'soft wash')
    const inkChip  = chips.find((c) => c.textContent === 'ink outline')
    expect(washChip).not.toBeNull()
    expect(washChip!.classList.contains('on')).toBe(true)
    expect(inkChip!.classList.contains('on')).toBe(false)
  })

  it('grain toggle is unchecked by default', () => {
    bootPanel({ type: 'settings.appearance' })
    const toggle = document.getElementById('grain-toggle') as HTMLInputElement
    expect(toggle).not.toBeNull()
    expect(toggle.checked).toBe(false)
  })

  // ── Window skin chip-row ──────────────────────────────────────────────────

  it('renders 3 skin chips — studio is active by default', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const studio  = chips.find((c) => c.textContent === 'studio')
    const classic = chips.find((c) => c.textContent === 'classic')
    const aqua    = chips.find((c) => c.textContent === 'aqua')
    expect(studio).not.toBeUndefined()
    expect(classic).not.toBeUndefined()
    expect(aqua).not.toBeUndefined()
    expect(studio!.classList.contains('on')).toBe(true)
    expect(classic!.classList.contains('on')).toBe(false)
  })

  it('clicking the aqua skin chip writes luna_skin=aqua + stamps data-skin', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const aqua = chips.find((c) => c.textContent === 'aqua')!
    aqua.click()
    expect(localStorage.getItem('luna_skin')).toBe('aqua')
    expect(document.documentElement.getAttribute('data-skin')).toBe('aqua')
    expect(aqua.classList.contains('on')).toBe(true)
    expect(chips.find((c) => c.textContent === 'studio')!.classList.contains('on')).toBe(false)
  })

  it('storage event for luna_skin updates the active skin chip', () => {
    bootPanel({ type: 'settings.appearance' })
    localStorage.setItem('luna_skin', 'classic')
    window.dispatchEvent(new StorageEvent('storage', { key: 'luna_skin', newValue: 'classic' }))
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    expect(chips.find((c) => c.textContent === 'classic')!.classList.contains('on')).toBe(true)
    expect(chips.find((c) => c.textContent === 'studio')!.classList.contains('on')).toBe(false)
  })

  // ── Palette swatch click ──────────────────────────────────────────────────

  it('clicking the dawn swatch writes luna_palette=dawn to localStorage', () => {
    bootPanel({ type: 'settings.appearance' })
    const dawnSwatch = document.querySelector('.swatch[aria-label="dawn"]') as HTMLElement
    dawnSwatch.click()
    expect(localStorage.getItem('luna_palette')).toBe('dawn')
  })

  it('clicking the dawn swatch stamps data-palette="dawn" on documentElement', () => {
    bootPanel({ type: 'settings.appearance' })
    const dawnSwatch = document.querySelector('.swatch[aria-label="dawn"]') as HTMLElement
    dawnSwatch.click()
    expect(document.documentElement.getAttribute('data-palette')).toBe('dawn')
  })

  it('clicking a swatch moves the active class to the clicked swatch', () => {
    bootPanel({ type: 'settings.appearance' })
    // Default active is tide; click dawn.
    const dawnSwatch = document.querySelector('.swatch[aria-label="dawn"]') as HTMLElement
    const tideSwatch = document.querySelector('.swatch[aria-label="tide"]') as HTMLElement
    dawnSwatch.click()
    expect(dawnSwatch.classList.contains('active')).toBe(true)
    expect(tideSwatch.classList.contains('active')).toBe(false)
  })

  // ── Theme chip click ──────────────────────────────────────────────────────

  it('clicking "light" chip writes luna_theme=light and stamps data-theme', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const lightChip = chips.find((c) => c.textContent === 'light')!
    lightChip.click()
    expect(localStorage.getItem('luna_theme')).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('clicking "light" moves the "on" class from "dark" to "light"', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const lightChip = chips.find((c) => c.textContent === 'light')!
    const darkChip  = chips.find((c) => c.textContent === 'dark')!
    lightChip.click()
    expect(lightChip.classList.contains('on')).toBe(true)
    expect(darkChip.classList.contains('on')).toBe(false)
  })

  // ── Grain toggle ──────────────────────────────────────────────────────────

  it('checking grain toggle writes luna_grain=true and stamps data-grain="on"', () => {
    bootPanel({ type: 'settings.appearance' })
    const toggle = document.getElementById('grain-toggle') as HTMLInputElement
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    expect(localStorage.getItem('luna_grain')).toBe('true')
    expect(document.documentElement.getAttribute('data-grain')).toBe('on')
  })

  it('unchecking grain toggle writes luna_grain=false and stamps data-grain="off"', () => {
    localStorage.setItem('luna_grain', 'true')
    bootPanel({ type: 'settings.appearance' })
    const toggle = document.getElementById('grain-toggle') as HTMLInputElement
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    expect(localStorage.getItem('luna_grain')).toBe('false')
    expect(document.documentElement.getAttribute('data-grain')).toBe('off')
  })

  // ── Chat font + size chips ───────────────────────────────────────────────

  it('renders 4 font chips with "sans" active by default', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const sans = chips.find((c) => c.textContent === 'sans')
    expect(['sans', 'serif', 'mono', 'hand'].every((t) => chips.some((c) => c.textContent === t))).toBe(true)
    expect(sans!.classList.contains('on')).toBe(true)
  })

  it('renders 4 size chips with "medium" active by default', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const medium = chips.find((c) => c.textContent === 'medium')
    expect(['small', 'medium', 'large', 'x-large'].every((t) => chips.some((c) => c.textContent === t))).toBe(true)
    expect(medium!.classList.contains('on')).toBe(true)
  })

  it('clicking the "serif" font chip writes luna_font=serif and stamps data-font', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const serif = chips.find((c) => c.textContent === 'serif')!
    serif.click()
    expect(localStorage.getItem('luna_font')).toBe('serif')
    expect(document.documentElement.getAttribute('data-font')).toBe('serif')
    expect(serif.classList.contains('on')).toBe(true)
  })

  it('clicking the "x-large" size chip writes luna_fontsize=xlarge and stamps data-fontsize', () => {
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    const xl = chips.find((c) => c.textContent === 'x-large')!
    xl.click()
    expect(localStorage.getItem('luna_fontsize')).toBe('xlarge')
    expect(document.documentElement.getAttribute('data-fontsize')).toBe('xlarge')
    expect(xl.classList.contains('on')).toBe(true)
  })

  it('storage event for luna_font moves the active font chip', () => {
    bootPanel({ type: 'settings.appearance' })
    localStorage.setItem('luna_font', 'mono')
    window.dispatchEvent(new StorageEvent('storage', { key: 'luna_font', newValue: 'mono' }))
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    expect(chips.find((c) => c.textContent === 'mono')!.classList.contains('on')).toBe(true)
    expect(chips.find((c) => c.textContent === 'sans')!.classList.contains('on')).toBe(false)
  })

  it('reflects stored font=hand / fontsize=small on initial render', () => {
    localStorage.setItem('luna_font', 'hand')
    localStorage.setItem('luna_fontsize', 'small')
    bootPanel({ type: 'settings.appearance' })
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    expect(chips.find((c) => c.textContent === 'hand')!.classList.contains('on')).toBe(true)
    expect(chips.find((c) => c.textContent === 'small')!.classList.contains('on')).toBe(true)
  })

  // ── Restores stored values on render ─────────────────────────────────────

  it('reflects stored values (meadow/light/ink/grain) on initial render', () => {
    localStorage.setItem('luna_palette', 'meadow')
    localStorage.setItem('luna_theme', 'light')
    localStorage.setItem('luna_chrome', 'ink')
    localStorage.setItem('luna_grain', 'true')
    bootPanel({ type: 'settings.appearance' })

    const activeSwatch = document.querySelector('.swatch.active') as HTMLElement
    expect(activeSwatch.getAttribute('aria-label')).toBe('meadow')

    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    expect(chips.find((c) => c.textContent === 'light')!.classList.contains('on')).toBe(true)
    expect(chips.find((c) => c.textContent === 'dark')!.classList.contains('on')).toBe(false)
    expect(chips.find((c) => c.textContent === 'ink outline')!.classList.contains('on')).toBe(true)
    expect(chips.find((c) => c.textContent === 'soft wash')!.classList.contains('on')).toBe(false)

    const toggle = document.getElementById('grain-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(true)
  })

  // ── Storage event cross-window sync ──────────────────────────────────────

  it('storage event for luna_palette updates the active swatch', () => {
    bootPanel({ type: 'settings.appearance' })
    // Simulate another window writing meadow to localStorage, then firing a
    // storage event.  We omit storageArea because vitest-setup.ts replaces
    // localStorage with a Map-backed object that doesn't satisfy jsdom's
    // Storage IDL check; the panel handler only reads e.key so this is fine.
    localStorage.setItem('luna_palette', 'meadow')
    window.dispatchEvent(new StorageEvent('storage', { key: 'luna_palette', newValue: 'meadow' }))
    const activeSwatch = document.querySelector('.swatch.active') as HTMLElement
    expect(activeSwatch.getAttribute('aria-label')).toBe('meadow')
  })

  it('storage event for luna_theme updates the active chip', () => {
    bootPanel({ type: 'settings.appearance' })
    localStorage.setItem('luna_theme', 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: 'luna_theme', newValue: 'light' }))
    const chips = [...document.querySelectorAll('.chip')] as HTMLElement[]
    expect(chips.find((c) => c.textContent === 'light')!.classList.contains('on')).toBe(true)
    expect(chips.find((c) => c.textContent === 'dark')!.classList.contains('on')).toBe(false)
  })

  it('storage event for luna_grain updates the grain checkbox', () => {
    bootPanel({ type: 'settings.appearance' })
    localStorage.setItem('luna_grain', 'true')
    window.dispatchEvent(new StorageEvent('storage', { key: 'luna_grain', newValue: 'true' }))
    const toggle = document.getElementById('grain-toggle') as HTMLInputElement
    expect(toggle.checked).toBe(true)
  })

  // ── LunaAppearance unavailable graceful fallback ──────────────────────────

  it('renders a fallback notice when LunaAppearance is not available', () => {
    // Do NOT preload moon-appearance.js — delete it if it was added.
    delete (window as any).LunaAppearance

    const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

    const me = {
      label: 'panel-settings-appearance',
      listen: vi.fn(async () => () => {}),
      onMoved: vi.fn(async () => () => {}),
      outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
      outerSize: vi.fn(async () => ({ width: 300, height: 440 })),
      scaleFactor: vi.fn(async () => 1),
    }
    ;(window as any).__TAURI__ = {
      window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
      core: { invoke: vi.fn(async () => null) },
      event: { listen: vi.fn(async () => () => {}) },
    }

    window.history.replaceState({}, '', '/panel.html?type=settings.appearance')

    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-dock.js')
    // Intentionally do NOT load moon-appearance.js.

    const moduleFile = path.resolve(__dirname, '../frontend/panels/settings-appearance.js')
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)

    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .filter((s) => s.includes('LunaPanelTypes'))
    new Function(inline[0])()

    const injected = document.head.querySelector('script[src^="panels/"]')
    if (injected) injected.dispatchEvent(new Event('error'))

    // Should show a notice, no swatch/chip elements.
    const notice = document.querySelector('.notice')
    expect(notice).not.toBeNull()
    expect(document.querySelectorAll('.swatch')).toHaveLength(0)
  })
})
