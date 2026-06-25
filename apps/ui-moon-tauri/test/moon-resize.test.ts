// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

beforeEach(() => {
  document.body.innerHTML = '<div class="widget-shell"><div class="content-area"></div></div>'
  delete (window as any).LunaResize
  delete (window as any).__TAURI__
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('moon-resize.js', () => {
  it('injects resize layer inside widget-shell', () => {
    loadVendorInto(window, 'moon-resize.js')
    const shell = document.querySelector('.widget-shell')!
    const layer = shell.querySelector('#resize-layer')
    expect(layer).not.toBeNull()
    expect(layer!.querySelectorAll('.resize-hit').length).toBe(8)
  })

  it('resizes via setSize, coalesced to one update per animation frame', async () => {
    // Native resize-drag is unimplemented on macOS (tao no-op), so the emulated
    // pointermove → setPosition/setSize loop is the only path. It is rAF-coalesced:
    // pointermove just stashes coords; flushResize does the IPC once per frame.
    const setSize = vi.fn().mockResolvedValue(undefined)
    const setPosition = vi.fn().mockResolvedValue(undefined)
    class LogicalSize {
      constructor(public w: number, public h: number) {}
    }
    class LogicalPosition {
      constructor(public x: number, public y: number) {}
    }
    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: () => ({
          scaleFactor: async () => 1,
          outerPosition: async () => ({ x: 100, y: 200 }),
          outerSize: async () => ({ width: 360, height: 440 }),
          setSize,
          setPosition,
        }),
        LogicalSize,
        LogicalPosition,
      },
    }
    const micro = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve() }
    // flushResize runs in a requestAnimationFrame (a macrotask) — drain one frame.
    const frame = async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); await micro() }

    loadVendorInto(window, 'moon-resize.js')
    const se = document.querySelector('.resize-se') as HTMLElement

    // onDown awaits scaleFactor + outerPosition + outerSize before setting `active`.
    se.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, screenX: 10, screenY: 20 }))
    await micro()
    // pointermove stashes coords + arms one rAF; the setSize happens in flushResize.
    se.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, screenX: 30, screenY: 50 }))
    await frame()
    se.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))

    expect(setSize).toHaveBeenCalled()
    const arg = setSize.mock.calls[0][0] as InstanceType<typeof LogicalSize>
    expect(arg.w).toBe(380) // 360 + (30-10) cursor dx
    expect(arg.h).toBe(470) // 440 + (50-20) cursor dy
    // SE grip changes size only — origin stays put, so no setPosition.
    expect(setPosition).not.toHaveBeenCalled()
  })

  it('native resize resets on luna-resize-ended even without a pointerup', async () => {
    // On macOS the gesture is handed to Rust (begin_native_resize). When the
    // mouse is released OUTSIDE the window the webview gets no pointerup/blur, so
    // the only reliable teardown signal is Rust's `luna-resize-ended` event.
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
    let releaseResize: (() => void) | null = null
    const invoke = vi.fn().mockResolvedValue(undefined)
    const unlisten = vi.fn()
    const listen = vi.fn((name: string, cb: () => void) => {
      if (name === 'luna-resize-ended') releaseResize = cb
      return Promise.resolve(unlisten)
    })
    ;(window as any).__TAURI__ = {
      core: { invoke },
      event: { listen },
      window: { getCurrentWindow: () => ({ listen }) },
    }
    const micro = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve() }

    loadVendorInto(window, 'moon-resize.js')
    const se = document.querySelector('.resize-se') as HTMLElement
    se.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, screenX: 10, screenY: 20 }))
    await micro()

    expect(invoke).toHaveBeenCalledWith('begin_native_resize', { direction: 'se' })
    expect((window as any).__LUNA_NATIVE_RESIZING__).toBe(true)
    expect(document.documentElement.style.cursor).toBe('nwse-resize')

    // Simulate Rust's teardown emit — no pointerup is dispatched.
    expect(releaseResize).toBeTypeOf('function')
    releaseResize!()
    await micro()

    expect((window as any).__LUNA_NATIVE_RESIZING__).toBe(false)
    expect(document.documentElement.style.cursor).toBe('')
    expect(unlisten).toHaveBeenCalled()
  })
})
