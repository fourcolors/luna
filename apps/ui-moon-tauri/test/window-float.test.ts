// @vitest-environment jsdom
//
// Behavioral tests for vendor/moon-window-float.js — the panel/widget
// "Always on Top" applier. Panels default to NOT floating; they float only
// when luna_always_on_top === 'true'. The orb (index.html) is governed
// separately and does not load this script.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../frontend/vendor/moon-window-float.js'),
  'utf8',
)

// Run the IIFE in the jsdom window, exactly as the page would via <script src>
// (jsdom never fetches external scripts, so window tests load vendor by hand).
function loadModule() {
  new Function(SRC)()
}

describe('moon-window-float.js — Always on Top applier', () => {
  let setAlwaysOnTop: ReturnType<typeof vi.fn>

  beforeEach(() => {
    localStorage.clear()
    setAlwaysOnTop = vi.fn(async () => {})
    ;(window as any).__TAURI__ = {
      window: { getCurrentWindow: () => ({ setAlwaysOnTop }) },
    }
  })

  it('does NOT float when the setting is unset (default off)', () => {
    loadModule()
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(false)
  })

  it('floats when the setting is explicitly "true"', () => {
    localStorage.setItem('luna_always_on_top', 'true')
    loadModule()
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(true)
  })

  it('does NOT float when the setting is explicitly "false"', () => {
    localStorage.setItem('luna_always_on_top', 'false')
    loadModule()
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(false)
  })

  it('re-floats live when another window enables the setting', () => {
    loadModule()
    setAlwaysOnTop.mockClear()
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'luna_always_on_top', newValue: 'true' }),
    )
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(true)
  })

  it('un-floats live when another window disables the setting', () => {
    localStorage.setItem('luna_always_on_top', 'true')
    loadModule()
    setAlwaysOnTop.mockClear()
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'luna_always_on_top', newValue: 'false' }),
    )
    expect(setAlwaysOnTop).toHaveBeenLastCalledWith(false)
  })

  it('ignores storage events for unrelated keys', () => {
    loadModule()
    setAlwaysOnTop.mockClear()
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'luna_theme', newValue: 'dark' }),
    )
    expect(setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it('does not throw when Tauri is unavailable (jsdom / plain browser)', () => {
    delete (window as any).__TAURI__
    expect(() => loadModule()).not.toThrow()
  })
})
