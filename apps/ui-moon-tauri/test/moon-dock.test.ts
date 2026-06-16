// @vitest-environment jsdom
//
// Focused tests for vendor/moon-dock.js applyGroupState — the skin/weld parts
// of the dock client that the per-page tests (widget-window / chat-window)
// don't both exercise. Here we wire LunaDock directly against a minimal DOM so
// we can control the window LABEL (the anchor gate keys on 'panel-chat') and
// drive the captured `dock-group` handler with arbitrary payloads.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

// The dock elements every widget-page carries (vendor/moon-dock.js requires
// #seam / #outline and a [data-tauri-drag-region] title bar; the
// skin/weld code reads .widget-shell + .title-bar).
const DOCK_DOM =
  '<div class="widget-shell">' +
  '  <div class="title-bar" data-tauri-drag-region id="title-bar">' +
  '    <span class="bar-title" id="bar-title">x</span>' +
  '    <button class="close-btn" id="close-btn"></button>' +
  '  </div>' +
  '  <div id="seam"></div>' +
  '  <div id="outline"></div>' +
  '</div>'

let handlers: Record<string, (e: { payload: unknown }) => void>

function wireWith(label: string) {
  handlers = {}
  document.body.innerHTML = DOCK_DOM
  const win = {
    label,
    listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
      handlers[name] = cb
      return () => {}
    }),
    onMoved: vi.fn(async () => () => {}),
  }
  ;(window as any).__TAURI__ = {
    window: { getCurrentWindow: () => win, Window: { getByLabel: vi.fn(async () => null) } },
    core: { invoke: vi.fn(async () => null) },
  }
  loadVendorInto(window, 'deck-snap.js')
  loadVendorInto(window, 'moon-dock.js')
  ;(window as any).LunaDock.wire({ win, label })
}

function group(label: string, payload: Record<string, unknown>) {
  expect(handlers['dock-group']).toBeTypeOf('function')
  handlers['dock-group']({ payload: { for: label, ...payload } })
}

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
    wireWith('panel-chat')
    expect(document.documentElement.getAttribute('data-anchor')).toBe('true')
  })

  it('does NOT stamp data-anchor for a non-chat window', () => {
    wireWith('widget-a')
    expect(document.documentElement.hasAttribute('data-anchor')).toBe(false)
  })
})

describe('moon-dock applyGroupState — weld shadow + anchor', () => {
  it('the chat anchor window uses the accent bottom edge piece', () => {
    wireWith('panel-chat')
    group('panel-chat', { grouped: true, members: ['panel-chat', 'widget-a'], outlineSides: ['l', 'r', 'b'] })
    const shell = document.querySelector('.widget-shell') as HTMLElement
    expect(shell.style.boxShadow).toContain('var(--dk-edge-b-anchor)')
    expect(shell.style.boxShadow).not.toContain('var(--dk-edge-b),')
  })

  it('a non-anchor window uses the plain bottom edge piece', () => {
    wireWith('widget-a')
    group('widget-a', { grouped: true, members: ['widget-a', 'widget-b'], outlineSides: ['l', 'r', 'b'] })
    const shell = document.querySelector('.widget-shell') as HTMLElement
    expect(shell.style.boxShadow).toContain('var(--dk-edge-b)')
    expect(shell.style.boxShadow).not.toContain('anchor')
  })

  it('squares welded corners and marks welded edges together', () => {
    wireWith('widget-a')
    group('widget-a', {
      grouped: true,
      members: ['widget-a', 'widget-b'],
      outlineSides: ['l', 'r', 'b'],
      weldCorners: ['tl', 'tr'],
    })
    const shell = document.querySelector('.widget-shell') as HTMLElement
    expect(shell.style.borderTopLeftRadius).toBe('0px')
    expect(shell.style.borderBottomLeftRadius).toBe('')
    expect(shell.getAttribute('data-weld')).toBe('t')
  })

  it('ungroup clears the shadow, the weld marker, and the corner radii', () => {
    wireWith('widget-a')
    group('widget-a', {
      grouped: true,
      members: ['widget-a', 'widget-b'],
      outlineSides: ['l', 'r', 'b'],
      weldCorners: ['tl', 'tr'],
    })
    group('widget-a', { grouped: false, members: [], outlineSides: [], weldCorners: [] })
    const shell = document.querySelector('.widget-shell') as HTMLElement
    expect(shell.style.boxShadow).toBe('')
    expect(shell.hasAttribute('data-weld')).toBe(false)
    expect(shell.style.borderTopLeftRadius).toBe('')
  })
})
