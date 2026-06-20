// @vitest-environment jsdom
//
// Focused tests for vendor/moon-dock.js in the EMERGENT welding model: there is
// no dock-group IPC payload anymore — a window enumerates its siblings' rects
// and computes its own weld via LunaDeckSnap. We wire LunaDock against a minimal
// DOM + faked Tauri windows at known positions and assert the resulting weld
// visuals (silhouette shadow, squared corners, data-weld marker). The pure
// geometry that feeds this is covered byte-for-byte in deck-weld.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const DOCK_DOM =
  '<div class="widget-shell">' +
  '  <div class="title-bar" id="title-bar"><span class="bar-title">x</span></div>' +
  '  <div id="seam"></div>' +
  '  <div id="outline"></div>' +
  '</div>'

type Layout = Record<string, [number, number, number, number]> // label → [x,y,w,h]

// A fake Tauri window reporting a fixed logical rect (scaleFactor 1).
function mkWin(label: string, rect: [number, number, number, number], opts?: { visible?: boolean }) {
  const [x, y, w, h] = rect
  let visible = opts?.visible !== false
  return {
    label,
    outerPosition: vi.fn(async () => ({ x, y })),
    outerSize: vi.fn(async () => ({ width: w, height: h })),
    scaleFactor: vi.fn(async () => 1),
    isVisible: vi.fn(async () => visible),
    listen: vi.fn(async () => () => {}),
    onResized: vi.fn(async () => () => {}),
    set visible(v: boolean) { visible = v },
  }
}

// Wire `self` as the current window; `layout` holds every widget window
// (including self) so list_widget_windows + getByLabel resolve real rects.
function wireWith(selfLabel: string, layout: Layout) {
  document.body.innerHTML = DOCK_DOM
  const wins: Record<string, ReturnType<typeof mkWin>> = {}
  for (const [lbl, r] of Object.entries(layout)) wins[lbl] = mkWin(lbl, r)
  const self = wins[selfLabel]
  ;(window as any).__TAURI__ = {
    window: {
      getCurrentWindow: () => self,
      LogicalPosition: class { constructor(public x: number, public y: number) {} },
      Window: { getByLabel: vi.fn(async (l: string) => wins[l] || null) },
    },
    core: { invoke: vi.fn(async (cmd: string) => (cmd === 'list_widget_windows' ? Object.keys(layout) : null)) },
    event: { emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) },
  }
  loadVendorInto(window, 'deck-snap.js')
  loadVendorInto(window, 'moon-dock.js')
  ;(window as any).LunaDock.wire({ win: self, label: selfLabel })
  return self
}

const shell = () => document.querySelector('.widget-shell') as HTMLElement

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-anchor')
  delete (window as any).__TAURI__
  delete (window as any).LunaDock
  delete (window as any).LunaDeckSnap
  vi.restoreAllMocks()
})

describe('moon-dock wire — chat anchor stamp', () => {
  it('stamps html[data-anchor="true"] for the chat window', () => {
    wireWith('panel-chat', { 'panel-chat': [0, 0, 200, 300] })
    expect(document.documentElement.getAttribute('data-anchor')).toBe('true')
  })
  it('does NOT stamp data-anchor for a non-chat window', () => {
    wireWith('widget-a', { 'widget-a': [0, 0, 200, 300] })
    expect(document.documentElement.hasAttribute('data-anchor')).toBe(false)
  })
})

describe('moon-dock — emergent weld visuals', () => {
  it('the chat anchor uses the accent bottom edge piece (bottom free, welded right)', async () => {
    // panel-chat at (0,0,200x300); widget-a CARD-flush on its right (frames
    // overlap by the 44px inset sum: x=200-44=156) → chat's bottom stays a free
    // perimeter side, so it casts the anchor bottom edge.
    wireWith('panel-chat', { 'panel-chat': [0, 0, 200, 300], 'widget-a': [156, 0, 200, 300] })
    await vi.waitFor(() => expect(shell().style.boxShadow).toContain('var(--dk-edge-b-anchor)'))
    expect(shell().getAttribute('data-weld')).toBe('r')
  })

  it('a non-anchor window squares the welded corners and marks the welded edge', async () => {
    // widget-a at (0,300,200x300); widget-b CARD-flush ABOVE → top welded.
    // Vertical face gap = card-inset(22) + card-inset-top(4) = 26, so widget-b
    // sits at y = 300 - (300 - 26)... i.e. its card-bottom (y+300-22) meets
    // widget-a's card-top (300+4=304): y=26.
    wireWith('widget-a', { 'widget-a': [0, 300, 200, 300], 'widget-b': [0, 26, 200, 300] })
    await vi.waitFor(() => expect(shell().getAttribute('data-weld')).toBe('t'))
    expect(shell().style.boxShadow).toContain('var(--dk-edge-b)')
    expect(shell().style.boxShadow).not.toContain('anchor')
    expect(shell().style.borderTopLeftRadius).toBe('0px')
    expect(shell().style.borderBottomLeftRadius).toBe('')
  })

  it('a lone window casts no cluster shadow and squares no corners', async () => {
    const self = wireWith('widget-a', { 'widget-a': [0, 0, 200, 300] })
    await vi.waitFor(() => expect(self.outerPosition).toHaveBeenCalled())
    await vi.waitFor(() => expect((window as any).__TAURI__.core.invoke).toHaveBeenCalled())
    expect(shell().style.boxShadow).toBe('')
    expect(shell().hasAttribute('data-weld')).toBe(false)
    expect(shell().style.borderTopLeftRadius).toBe('')
  })

  it('welds CORNERS only — never mutates the card margin/size (no reshape on dock)', async () => {
    // panel-settings docked CARD-flush right of chat (frames overlap 44px:
    // x=200-44=156) → settings' LEFT is welded.
    wireWith('panel-settings', {
      'panel-chat': [0, 0, 200, 300],
      'panel-settings': [156, 0, 200, 300],
    })
    await vi.waitFor(() => expect(shell().getAttribute('data-weld')).toBe('l'))
    // The welded (left) corners square; the free (right) corners stay rounded.
    expect(shell().style.borderTopLeftRadius).toBe('0px')
    expect(shell().style.borderBottomLeftRadius).toBe('0px')
    expect(shell().style.borderTopRightRadius).toBe('')
    // The card's SHAPE is untouched: no margin collapse, no size recompute.
    // Sticking windows together can no longer resize or reflow the card.
    expect(shell().style.marginLeft).toBe('')
    expect(shell().style.marginRight).toBe('')
    expect(shell().style.width).toBe('')
    expect(shell().style.height).toBe('')
  })

  it('defers boot weld until the window becomes visible (snap-on-open)', async () => {
    document.body.innerHTML = DOCK_DOM
    const wins: Record<string, ReturnType<typeof mkWin>> = {
      'panel-chat': mkWin('panel-chat', [0, 0, 200, 300]),
      'panel-new': mkWin('panel-new', [156, 0, 200, 300], { visible: false }), // card-flush right
    }
    const self = wins['panel-new']
    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: () => self,
        LogicalPosition: class { constructor(public x: number, public y: number) {} },
        Window: { getByLabel: vi.fn(async (l: string) => wins[l] || null) },
      },
      core: { invoke: vi.fn(async (cmd: string) => (cmd === 'list_widget_windows' ? Object.keys(wins) : null)) },
      event: { emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) },
    }
    loadVendorInto(window, 'deck-snap.js')
    loadVendorInto(window, 'moon-dock.js')
    ;(window as any).LunaDock.wire({ win: self, label: 'panel-new' })
    expect(shell().getAttribute('data-weld')).toBe(null)
    self.visible = true
    await vi.waitFor(() => expect(shell().getAttribute('data-weld')).toBe('l'))
  })
})

describe('moon-dock — drag lifecycle state machine', () => {
  function pointer(type: string, target: Element, opts: Record<string, unknown> = {}) {
    // jsdom lacks PointerEvent; a MouseEvent with pointerId carries what the
    // capture-phase handler reads (button, target, pointerId).
    const ev = new MouseEvent(type, { bubbles: true, button: 0, ...opts }) as MouseEvent & { pointerId?: number }
    ev.pointerId = (opts.pointerId as number) ?? 1
    target.dispatchEvent(ev)
    return ev
  }

  it('arms on a title-bar pointerdown (.dragging) and returns to idle on pointerup', () => {
    wireWith('widget-a', { 'widget-a': [0, 0, 200, 300] })
    const bar = document.getElementById('title-bar')!
    // idle → arming: pointerdown on the drag handle adds .dragging synchronously.
    pointer('pointerdown', bar)
    expect(shell().classList.contains('dragging')).toBe(true)
    // arming/dragging → idle: pointerup removes .dragging and detaches.
    pointer('pointerup', bar)
    expect(shell().classList.contains('dragging')).toBe(false)
  })

  it('does NOT arm a drag from a pointerdown on a button (it is a click, not a grab)', () => {
    wireWith('widget-a', { 'widget-a': [0, 0, 200, 300] })
    const bar = document.getElementById('title-bar')!
    const btn = document.createElement('button')
    bar.appendChild(btn)
    pointer('pointerdown', btn)
    expect(shell().classList.contains('dragging')).toBe(false)
  })
})

describe('moon-dock — native single-window drag', () => {
  function pointer(type: string, target: Element, opts: Record<string, unknown> = {}) {
    const ev = new MouseEvent(type, { bubbles: true, button: 0, ...opts }) as MouseEvent & { pointerId?: number }
    ev.pointerId = (opts.pointerId as number) ?? 1
    target.dispatchEvent(ev)
    return ev
  }

  it('a lone window with native support drags via startDragging, skipping the emulated loop', () => {
    const self = wireWith('widget-a', { 'widget-a': [0, 0, 200, 300] })
    // Hand the window the native APIs; the grab handler reads them dynamically.
    const startDragging = vi.fn()
    ;(self as any).startDragging = startDragging
    ;(self as any).onMoved = vi.fn(async () => () => {})
    ;(self as any).setPosition = vi.fn()
    const bar = document.getElementById('title-bar')!
    pointer('pointerdown', bar)
    // Native path taken: the OS drives the drag and .dragging is applied…
    expect(startDragging).toHaveBeenCalledTimes(1)
    expect(shell().classList.contains('dragging')).toBe(true)
    // …and the emulated per-pointermove loop is NOT armed (no setPosition on move).
    pointer('pointermove', bar)
    expect((self as any).setPosition).not.toHaveBeenCalled()
  })
})
