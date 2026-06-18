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

  it('SE drag calls setSize with grown dimensions', async () => {
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
    loadVendorInto(window, 'moon-resize.js')
    const se = document.querySelector('.resize-se') as HTMLElement
    se.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, screenX: 10, screenY: 20 }))
    se.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, screenX: 30, screenY: 50 }))
    se.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await Promise.resolve()
    expect(setSize).toHaveBeenCalled()
    const arg = setSize.mock.calls[0][0] as InstanceType<typeof LogicalSize>
    expect(arg.w).toBe(380)
    expect(arg.h).toBe(470)
  })
})
