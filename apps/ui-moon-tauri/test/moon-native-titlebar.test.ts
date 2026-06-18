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

  it('syncs position then reveals native controls on title-bar mouseenter (studio)', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-native-titlebar.js')
    invoke.mockClear()
    document.getElementById('title-bar')!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('sync_traffic_light_position', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }))
    expect(invoke).toHaveBeenCalledWith('set_native_controls_visible', { visible: true })
    const syncIdx = invoke.mock.calls.findIndex((c) => c[0] === 'sync_traffic_light_position')
    const showIdx = invoke.mock.calls.findIndex((c) => c[0] === 'set_native_controls_visible' && c[1].visible === true)
    expect(syncIdx).toBeGreaterThanOrEqual(0)
    expect(showIdx).toBeGreaterThan(syncIdx)
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
