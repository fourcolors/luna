// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

function mountTitleBar() {
  document.body.innerHTML =
  '<div class="widget-shell">' +
    '<div class="title-bar" id="title-bar">' +
      '<div class="bar-start"></div>' +
      '<span class="bar-title">Luna</span>' +
    '</div>' +
  '</div>'
}

beforeEach(() => {
  window.localStorage.clear()
  mountTitleBar()
  delete (window as any).LunaNativeTitlebar
  delete (window as any).__TAURI__
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('moon-native-titlebar.js', () => {
  it('hides native controls at boot for studio skin when Tauri is live', () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    expect(invoke).toHaveBeenCalledWith('set_native_controls_visible', { visible: false })
    expect(invoke).toHaveBeenCalledWith('sync_traffic_light_position', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
  })

  it('reveals native controls then repositions them on title-bar mouseenter (studio)', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    invoke.mockClear()
    document.getElementById('title-bar')!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve() }
    await flush()
    expect(invoke).toHaveBeenCalledWith('set_native_controls_visible', { visible: true })
    expect(invoke).toHaveBeenCalledWith('sync_traffic_light_position', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
    // Reveal must come BEFORE the position sync: un-hiding makes AppKit relayout
    // the buttons to the default corner, so we reposition AFTER, never before.
    const showIdx = invoke.mock.calls.findIndex((c) => c[0] === 'set_native_controls_visible' && c[1].visible === true)
    const syncIdx = invoke.mock.calls.findIndex((c) => c[0] === 'sync_traffic_light_position')
    expect(showIdx).toBeGreaterThanOrEqual(0)
    expect(syncIdx).toBeGreaterThan(showIdx)
  })

  it('keeps native controls up when the pointer leaves toward the cluster (no vanish-on-approach)', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve() }
    const bar = document.getElementById('title-bar')!
    bar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await flush()
    invoke.mockClear()
    // jsdom lays out at the origin (title-bar rect is all-zero), so the light
    // band is the very top-left: clientY ≲ bar.bottom, clientX ≲ left+cluster.
    // Leaving toward it (the pointer is reaching for a light) must NOT hide.
    bar.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, clientX: 4, clientY: 0 }))
    vi.advanceTimersByTime(500)
    await flush()
    expect(invoke).not.toHaveBeenCalledWith('set_native_controls_visible', { visible: false })
    vi.useRealTimers()
  })

  it('re-tucks native controls when the pointer leaves into the content area', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve() }
    const bar = document.getElementById('title-bar')!
    bar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await flush()
    invoke.mockClear()
    // Leaving well away from the cluster → schedule the hide as before.
    bar.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, clientX: 600, clientY: 600 }))
    vi.advanceTimersByTime(300)
    await flush()
    expect(invoke).toHaveBeenCalledWith('set_native_controls_visible', { visible: false })
    vi.useRealTimers()
  })

  it('does not reveal native controls on hover under classic skin', () => {
    window.localStorage.setItem('luna_skin', 'classic')
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    invoke.mockClear()
    document.getElementById('title-bar')!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    expect(invoke).not.toHaveBeenCalledWith('set_native_controls_visible', { visible: true })
  })
})
