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
  it('shows native controls at boot for studio skin, positioning AFTER the reveal (always-visible native model)', () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    expect(invoke).toHaveBeenCalledWith('set_native_controls_visible', { visible: true })
    expect(invoke).toHaveBeenCalledWith('sync_traffic_light_position', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
    // Reveal must come BEFORE the position sync: un-hiding makes AppKit relayout
    // the buttons to the default corner, so we reposition AFTER, never before.
    const showIdx = invoke.mock.calls.findIndex((c) => c[0] === 'set_native_controls_visible' && c[1].visible === true)
    const syncIdx = invoke.mock.calls.findIndex((c) => c[0] === 'sync_traffic_light_position')
    expect(showIdx).toBeGreaterThanOrEqual(0)
    expect(syncIdx).toBeGreaterThan(showIdx)
  })

  it('hides native controls at boot for classic skin (CSS faux cluster owns the corner)', () => {
    window.localStorage.setItem('luna_skin', 'classic')
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    expect(invoke).toHaveBeenCalledWith('set_native_controls_visible', { visible: false })
    expect(invoke).not.toHaveBeenCalledWith('set_native_controls_visible', { visible: true })
  })

  it('never tucks the lights away — no hover hide/reveal machinery (native windows keep their lights up)', async () => {
    vi.useFakeTimers()
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve() }
    const bar = document.getElementById('title-bar')!
    bar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    bar.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, clientX: 600, clientY: 600 }))
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 600, clientY: 600 }))
    window.dispatchEvent(new Event('blur'))
    vi.advanceTimersByTime(1000)
    await flush()
    expect(invoke).not.toHaveBeenCalledWith('set_native_controls_visible', { visible: false })
    vi.useRealTimers()
  })

  it('re-syncs the light position when the window gains focus (AppKit re-pins its container on focus; a stale layout goes click-dead)', () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    invoke.mockClear()
    window.dispatchEvent(new Event('focus'))
    expect(invoke).toHaveBeenCalledWith('sync_traffic_light_position', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
  })

  it('exports a skin-gated overLights() for the dock drag guard', () => {
    // studio (default skin): native hover-lights are active. jsdom lays out at
    // the origin (title-bar rect all-zero), so the light band is the very
    // top-left: a point inside it returns true, one well clear returns false.
    loadVendorInto(window, 'moon-native-titlebar.js')
    const nt = (window as any).LunaNativeTitlebar
    expect(typeof nt.overLights).toBe('function')
    expect(nt.overLights(4, 0)).toBe(true)
    expect(nt.overLights(600, 600)).toBe(false)

    // classic skin: native lights are hidden (faux DOM buttons own the corner),
    // so overLights must NOT claim the band — else the drag guard would carve a
    // dead zone out of the classic title bar.
    window.localStorage.setItem('luna_skin', 'classic')
    delete (window as any).LunaNativeTitlebar
    loadVendorInto(window, 'moon-native-titlebar.js')
    expect((window as any).LunaNativeTitlebar.overLights(4, 0)).toBe(false)
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
