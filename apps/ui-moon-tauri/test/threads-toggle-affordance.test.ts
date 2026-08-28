// @vitest-environment jsdom
/**
 * threads-toggle-affordance.test.ts - pins the title-bar threads toggle as a
 * real DISCLOSURE control for the drawer it opens.
 *
 * WHY. #552 moved #toggle-threads out of the chat header's right-hand cluster
 * and into the title bar, onto the same side as the drawer it opens. What it
 * did NOT get was any indication that it controls a panel: the button looked
 * byte-identical whether the drawer was open or shut, carried no
 * aria-expanded, and named no controlled element. Operator report: it does not
 * "feel like it actually opens something".
 *
 * The pins below are on _applyWidth rather than the click handler on purpose.
 * _applyWidth is the ONE chokepoint every open/close path funnels through -
 * click, drag-to-zero, restore-on-boot, reclamp-on-resize - so a state update
 * there cannot drift out of sync with the panel. A click-site-only update
 * would pass a click test and still leave the button lit after a drag-to-zero.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  readChatHtml,
} from './helpers/chat-harness'

describe('threads toggle affordance (chat.html)', () => {
  const M = () => (window as any).__MoonInternals
  const eng = () => M().ThreadDrawerEngine
  const btn = () => document.getElementById('toggle-threads') as HTMLButtonElement

  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    mountChatDomFromHtml(readChatHtml())
    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: () => ({
          label: 'chat-test',
          listen: vi.fn(async () => () => {}),
          onMoved: vi.fn(async () => () => {}),
          isMinimized: vi.fn(async () => false),
          scaleFactor: vi.fn(async () => 1),
          outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
          outerSize: vi.fn(async () => ({ width: 560, height: 520 })),
          setPosition: vi.fn(async () => {}),
          startDragging: vi.fn(async () => {}),
        }),
        Window: { getByLabel: vi.fn(async () => null) },
      },
      event: { listen: vi.fn(async () => () => {}) },
    }
    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'moon-dock.js')
    loadVendorInto(window, 'thread-drag-session.js')
    localStorage.clear()
    evalChatInlineScriptWithBridge()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    for (const k of ['__TAURI__', '__MoonInternals', 'LunaChatHost', 'LunaProtocol', 'LunaWS', 'LunaMarkdown', 'LunaDock', 'ChatState', 'ChatLoop']) {
      delete (window as any)[k]
    }
    vi.restoreAllMocks()
  })

  // ── static markup: it must NAME the thing it opens ────────────────────────
  it('declares the drawer it controls', () => {
    // Without aria-controls the button is just a button; with it, the button
    // and the <aside id="thread-drawer"> are one disclosure pair.
    expect(btn().getAttribute('aria-controls')).toBe('thread-drawer')
    expect(document.getElementById('thread-drawer')).toBeTruthy()
  })

  it('ships closed, and says so', () => {
    expect(btn().getAttribute('aria-expanded')).toBe('false')
    expect(btn().classList.contains('is-open')).toBe(false)
  })

  // ── the state pin: open/closed must be visible on the control ─────────────
  it('lights up and reports expanded while the drawer is open', () => {
    eng()._applyWidth(240)
    expect(btn().classList.contains('is-open')).toBe(true)
    expect(btn().getAttribute('aria-expanded')).toBe('true')
  })

  it('goes dark again when the drawer closes', () => {
    eng()._applyWidth(240)
    eng()._applyWidth(0)
    expect(btn().classList.contains('is-open')).toBe(false)
    expect(btn().getAttribute('aria-expanded')).toBe('false')
  })

  it('stays in sync on a drag-to-zero, not just a click', () => {
    // The regression this file exists to prevent: updating state at the click
    // handler alone would leave the button lit after the divider is dragged
    // shut, because that path never goes through the click.
    eng()._applyWidth(240)
    eng()._applyWidth(120) // still open, mid-drag
    expect(btn().classList.contains('is-open')).toBe(true)
    eng()._applyWidth(0)   // dragged shut
    expect(btn().classList.contains('is-open')).toBe(false)
  })

  // ── the label names the NEXT action, not the current state ────────────────
  it('names what the next press will do', () => {
    expect(btn().getAttribute('aria-label')).toBe('Show threads')
    eng()._applyWidth(240)
    expect(btn().getAttribute('aria-label')).toBe('Hide threads')
    expect(btn().getAttribute('title')).toBe('Hide threads')
    eng()._applyWidth(0)
    expect(btn().getAttribute('aria-label')).toBe('Show threads')
  })

  // ── position: flush to the reserved traffic-light footprint ───────────────
  it('is pulled flush against the traffic-light footprint', () => {
    // .bar-start reserves 68px and .title-bar adds a 7px gap, which left the
    // toggle floating ~20px clear of where the native lights actually end.
    // The negative margin is what closes that gap; assert it is still declared
    // so a future stylesheet tidy-up cannot silently un-move the button.
    const css = readChatHtml()
    expect(css).toMatch(/#title-bar\s+#toggle-threads\s*\{\s*margin-left:\s*-14px/)
  })

  // ── visibility follows drawer state (toggle migrates into drawer header) ──
  it('is hidden in the title bar when the drawer is open', () => {
    // When the drawer is open the same icon lives in #thread-drawer-close
    // inside the drawer header. The title-bar copy must be hidden so the user
    // sees ONE toggle, always adjacent to the drawer edge.
    eng()._applyWidth(240)
    expect(btn().hidden).toBe(true)
  })

  it('is visible in the title bar when the drawer is closed', () => {
    // With the drawer shut the in-drawer icon is off-screen, so the
    // title-bar copy must be visible so the user can re-open it.
    eng()._applyWidth(0)
    expect(btn().hidden).toBe(false)
  })

  it('transitions from visible to hidden as the drawer opens, then back', () => {
    expect(btn().hidden).toBe(false)   // initial: closed
    eng()._applyWidth(240)
    expect(btn().hidden).toBe(true)    // open: hidden in title bar
    eng()._applyWidth(0)
    expect(btn().hidden).toBe(false)   // closed again: visible
  })

  // ── drawer close button carries the panel icon, not a ✕ character ─────────
  it('drawer close button uses the panel SVG icon, not a text ✕', () => {
    // The ✕ was replaced with the same panel-left SVG as #toggle-threads so
    // the control reads as the same toggle, just repositioned.
    const html = readChatHtml()
    const drawerClose = html.match(/<button[^>]+id="thread-drawer-close"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? ''
    expect(drawerClose).not.toContain('✕')
    expect(drawerClose).toContain('<svg')
    expect(drawerClose).toContain('M9 3v18')  // the panel-left vertical divider path
  })
})
