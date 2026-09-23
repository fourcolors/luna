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
  delete (window as any).__TAURI__
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

  it('awaits begin_redock_drag before startDragging when redock opts are set', async () => {
    document.body.innerHTML =
      '<div class="widget-shell"><div class="title-bar" id="title-bar"><span>Title</span></div></div>'
    const win = { label: 'panel-chat-floater', startDragging: vi.fn().mockResolvedValue(undefined) }
    const resolvers: Array<(v?: unknown) => void> = []
    const invoke = vi.fn().mockImplementation(
      () => new Promise((r) => { resolvers.push(r) }),
    )
    ;(window as any).__TAURI__ = { core: { invoke } }
    loadVendorInto(window, 'moon-dock.js')
    ;(window as any).LunaDock.wire({
      win,
      label: 'panel-chat-floater',
      redock: { owner: 'panel-chat', threadId: 'thr-1', title: 'Hello' },
    })
    document.getElementById('title-bar')!.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
    )
    // Strip metrics are always forwarded (added by the Chrome-tab drag work);
    // they are null when the caller supplies no strip geometry, as here.
    expect(invoke).toHaveBeenCalledWith('begin_redock_drag', {
      ownerLabel: 'panel-chat',
      threadId: 'thr-1',
      title: 'Hello',
      stripHeight: null,
      stripTopInset: null,
      stripWidth: null,
    })
    // Must not start native drag until monitors are armed.
    expect(win.startDragging).not.toHaveBeenCalled()
    resolvers.forEach((r) => r(undefined))
    await Promise.resolve()
    await Promise.resolve()
    expect(win.startDragging).toHaveBeenCalledTimes(1)
  })

  it('does not hijack buttons or non-primary clicks', () => {
    const win = wire()
    pointer(document.getElementById('action')!)
    pointer(document.getElementById('title-bar')!, 2)
    expect(win.startDragging).not.toHaveBeenCalled()
  })

  it('keeps snap and cluster motion on the native side only', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../frontend/vendor/moon-dock.js'),
      'utf8',
    )
    // WinAmp snapping settles natively (the Moved-event watcher in
    // windows.rs); the page itself never enumerates, moves, links, or welds
    // sibling windows, and the old JS snap/cluster engines stay removed.
    expect(source).not.toMatch(/dock_move_cluster|dock-link|dock-geometry-changed|begin_cluster_drag|begin_snap_drag|snapOnRelease|data-weld|deck-snap/)
  })
})
