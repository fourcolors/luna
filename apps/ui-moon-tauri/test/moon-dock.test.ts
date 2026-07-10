// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

function pointer(target: Element, button = 0) {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button }))
}

function wire(label = 'widget-a') {
  document.body.innerHTML =
    '<div class="widget-shell"><div class="title-bar" id="title-bar">' +
      '<button id="action">Action</button><span>Title</span>' +
    '</div></div>'
  const win = { label, startDragging: vi.fn().mockResolvedValue(undefined) }
  loadVendorInto(window, 'moon-dock.js')
  ;(window as any).LunaDock.wire({ win, label })
  return win
}

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-anchor')
  delete (window as any).LunaDock
  vi.restoreAllMocks()
})

describe('Moon independent native windows', () => {
  it('stamps the chat accent without creating dock state', () => {
    wire('panel-chat')
    expect(document.documentElement.getAttribute('data-anchor')).toBe('true')
  })

  it('hands a title-bar gesture directly to the native window drag', () => {
    const win = wire()
    const event = new MouseEvent('pointerdown', { bubbles: true, button: 0, cancelable: true })
    document.getElementById('title-bar')!.dispatchEvent(event)
    expect(win.startDragging).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not hijack buttons or non-primary clicks', () => {
    const win = wire()
    pointer(document.getElementById('action')!)
    pointer(document.getElementById('title-bar')!, 2)
    expect(win.startDragging).not.toHaveBeenCalled()
  })

  it('does not enumerate, move, link, or weld sibling windows', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../frontend/vendor/moon-dock.js'),
      'utf8',
    )
    expect(source).not.toMatch(/dock_move_cluster|dock-link|dock-geometry-changed|begin_cluster_drag|snapOnRelease|data-weld/)
  })
})
