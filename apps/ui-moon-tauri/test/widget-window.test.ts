// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * widget-window.test.ts — behavioral tests for widget.html's snap + dock
 * groups (widget-system.md Phase 0.5, operator-feedback round 3).
 *
 * The snap path once shipped broken (missing await on the async
 * Window.getByLabel — silently dead on real Tauri), so these tests drive the
 * REAL inline script against a mocked __TAURI__ surface: settle-snap, the
 * set_dock/grab_dock reporting, and the event-driven pin + perimeter outline
 * (state comes from Rust's dock-group events, never local guesses).
 */

interface Rect { x: number; y: number; w: number; h: number }
interface SnapResult { x: number; y: number; edge: string }

class MockPhysicalPosition {
  constructor(public x: number, public y: number) {}
}

function loadVendorInto(target: unknown, file: string) {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../frontend/vendor', file),
    'utf8',
  )
  // The vendor IIFEs attach to `globalThis` — rebind it to the jsdom window.
  new Function('globalThis', src)(target)
}

describe('widget.html — snap + dock groups', () => {
  // Fixture geometry: widget left edge (x=540) sits 20 px right of the main
  // window's right edge (100+420=520) with full vertical overlap — inside the
  // 22 px magnet, so computeSnap MUST produce a snap for these rects.
  const MAIN_RECT: Rect = { x: 100, y: 100, w: 420, h: 320 }
  const WIDGET_POS = { x: 540, y: 130 }
  const WIDGET_SIZE = { width: 300, height: 200 }
  const SELF = 'widget-test'

  let setPositionCalls: Array<{ x: number; y: number }>
  let movedHandler: (() => void) | null
  let eventHandlers: Record<string, (e: { payload: unknown }) => void>
  let me: {
    label: string
    onMoved: ReturnType<typeof vi.fn>
    isMinimized: ReturnType<typeof vi.fn>
    outerPosition: ReturnType<typeof vi.fn>
    outerSize: ReturnType<typeof vi.fn>
    setPosition: ReturnType<typeof vi.fn>
  }
  let getByLabel: ReturnType<typeof vi.fn>
  let invoke: ReturnType<typeof vi.fn>

  const expectedSnap = (): SnapResult => {
    const snap = (window as any).LunaDeckSnap.computeSnap(
      MAIN_RECT,
      { x: WIDGET_POS.x, y: WIDGET_POS.y, w: WIDGET_SIZE.width, h: WIDGET_SIZE.height },
      22,
    )
    expect(snap).not.toBeNull() // fixture sanity: rects are snappable
    return snap
  }

  interface DockArgs { docked: boolean; anchor: string | null; edge: string | null }
  const dockArgs = (): DockArgs[] =>
    invoke.mock.calls
      .filter((c: unknown[]) => c[0] === 'set_dock')
      .map((c: unknown[]) => c[1] as DockArgs)
  const grabCalls = (): number =>
    invoke.mock.calls.filter((c: unknown[]) => c[0] === 'grab_dock').length

  const dispatchGroup = (payload: unknown) => {
    expect(eventHandlers['dock-group']).toBeTypeOf('function')
    eventHandlers['dock-group']({ payload })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    setPositionCalls = []
    movedHandler = null
    eventHandlers = {}

    const html = fs.readFileSync(
      path.resolve(__dirname, '../frontend/widget.html'),
      'utf8',
    )
    const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

    me = {
      label: SELF,
      onMoved: vi.fn((cb: () => void) => {
        movedHandler = cb
        return Promise.resolve(() => {})
      }),
      isMinimized: vi.fn(async () => false),
      outerPosition: vi.fn(async () => ({ ...WIDGET_POS })),
      outerSize: vi.fn(async () => ({ ...WIDGET_SIZE })),
      setPosition: vi.fn(async (p: MockPhysicalPosition) => {
        setPositionCalls.push({ x: p.x, y: p.y })
      }),
    }
    const mainWin = {
      outerPosition: vi.fn(async () => ({ x: MAIN_RECT.x, y: MAIN_RECT.y })),
      outerSize: vi.fn(async () => ({ width: MAIN_RECT.w, height: MAIN_RECT.h })),
    }
    getByLabel = vi.fn(async (l: string) => (l === 'main' ? mainWin : null))
    invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'list_widget_windows') return []
      return null
    })

    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: () => me,
        Window: { getByLabel },
        PhysicalPosition: MockPhysicalPosition,
      },
      // load_connection → null keeps init() on the "Not connected" path:
      // no WebSocket is ever constructed in the test env.
      core: { invoke },
      event: {
        listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
          eventHandlers[name] = cb
          return () => {}
        }),
      },
    }

    loadVendorInto(window, 'deck-snap.js')
    loadVendorInto(window, 'widget-sandbox.js')

    // Select the page script by CONTENT, not position — an added inline
    // config stub or a type= attribute on the main tag must fail loudly
    // here, not silently execute the wrong script.
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .filter((s) => s.includes('wireDeckSnap'))
    expect(inlineScripts).toHaveLength(1)
    new Function(inlineScripts[0])()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    delete (window as any).__TAURI__
    delete (window as any).LunaDeckSnap
    delete (window as any).LunaWidgetSandbox
    vi.restoreAllMocks()
  })

  it('wires onMoved on boot', () => {
    expect(me.onMoved).toHaveBeenCalledTimes(1)
    expect(movedHandler).toBeTypeOf('function')
  })

  it('snaps to the hub after settle and reports the link (pins the getByLabel await)', async () => {
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)

    expect(getByLabel).toHaveBeenCalledWith('main')
    const snap = expectedSnap()
    expect(setPositionCalls).toEqual([{ x: snap.x, y: snap.y }])
    // Fixture geometry: the widget sits just right of main → edge "r".
    expect(dockArgs()).toEqual([{ docked: true, anchor: 'main', edge: 'r' }])
  })

  it('debounces a burst of moves into a single snap', async () => {
    movedHandler!()
    await vi.advanceTimersByTimeAsync(20)
    movedHandler!()
    await vi.advanceTimersByTimeAsync(20)
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)

    expect(setPositionCalls).toHaveLength(1)
  })

  it('never snaps a minimized window (tauri#7664 spurious onMoved)', async () => {
    me.isMinimized.mockResolvedValue(true)
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)

    expect(setPositionCalls).toHaveLength(0)
  })

  it('settling out of range while ungrouped reports nothing', async () => {
    me.outerPosition.mockResolvedValue({ x: 2000, y: 1500 })
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    expect(dockArgs()).toHaveLength(0)
    expect(setPositionCalls).toHaveLength(0)
  })

  it('group members are never snap candidates (no self-re-snap "random movements")', async () => {
    // Rust says: we are grouped with main.
    dispatchGroup({ grouped: true, members: ['main', SELF], outlineSides: ['r', 't', 'b'] })

    // The group-drag echo: we settle at the snap target, flush on main.
    const snap = expectedSnap()
    me.outerPosition.mockResolvedValue({ x: snap.x, y: snap.y })
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)

    // main is in our group → excluded → nothing sent, nothing moved.
    expect(dockArgs()).toHaveLength(0)
    expect(setPositionCalls).toHaveLength(0)
  })

  it('pin and perimeter outline render from dock-group state', () => {
    const pin = document.getElementById('pin-btn') as HTMLButtonElement
    const outline = document.getElementById('outline') as HTMLDivElement
    expect(pin.hidden).toBe(true)

    dispatchGroup({ grouped: true, members: ['main', SELF], outlineSides: ['r', 't', 'b'] })
    expect(pin.hidden).toBe(false)
    expect(outline.className).toBe('gr gt gb')

    // Interior seams stay unhighlighted: only the listed outer sides render.
    dispatchGroup({ grouped: true, members: ['main', SELF, 'widget-x'], outlineSides: ['t'] })
    expect(outline.className).toBe('gt')

    dispatchGroup({ grouped: false, members: [], outlineSides: [] })
    expect(pin.hidden).toBe(true)
    expect(outline.className).toBe('')
  })

  it('the pin leaves the group — and only the pin (no drag-detach)', async () => {
    dispatchGroup({ grouped: true, members: ['main', SELF], outlineSides: ['r'] })

    // Dragging far away while grouped sends NOTHING — groups are sticky.
    me.outerPosition.mockResolvedValue({ x: 2000, y: 1500 })
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    expect(dockArgs()).toHaveLength(0)

    const pin = document.getElementById('pin-btn') as HTMLButtonElement
    pin.click()
    expect(dockArgs()).toEqual([{ docked: false, anchor: null, edge: null }])
  })

  it('prefers the nearest anchor — widgets snap to sibling widgets', async () => {
    // A sibling widget 10px right of us (vs main 20px to our left).
    const sibling = {
      outerPosition: vi.fn(async () => ({ x: 850, y: 130 })),
      outerSize: vi.fn(async () => ({ width: 200, height: 200 })),
    }
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'list_widget_windows' ? ['widget-zzz'] : null,
    )
    getByLabel.mockImplementation(async (l: string) =>
      l === 'main'
        ? {
            outerPosition: vi.fn(async () => ({ x: MAIN_RECT.x, y: MAIN_RECT.y })),
            outerSize: vi.fn(async () => ({ width: MAIN_RECT.w, height: MAIN_RECT.h })),
          }
        : l === 'widget-zzz'
          ? sibling
          : null,
    )

    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    const calls = dockArgs()
    // Our right edge (840) is 10px from the sibling's left edge (850) — closer
    // than main's right edge (520) is to our left (540, 20px). Sibling wins.
    expect(calls[calls.length - 1]).toEqual({ docked: true, anchor: 'widget-zzz', edge: 'l' })
  })

  it('a grouped widget can still link an OUTSIDER (group merge by drag)', async () => {
    dispatchGroup({ grouped: true, members: [SELF, 'widget-friend'], outlineSides: ['l', 'r', 't', 'b'] })
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    // main is NOT in our group → still a valid anchor.
    expect(dockArgs()).toEqual([{ docked: true, anchor: 'main', edge: 'r' }])
  })

  it('grabbing the title bar fires grab_dock before the native drag', () => {
    // The script's document-level listener accumulates across per-test
    // re-evals (the document persists in jsdom), so assert deltas.
    const bar = document.getElementById('title-bar') as HTMLDivElement
    const before = grabCalls()
    bar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    const afterBar = grabCalls()
    expect(afterBar).toBeGreaterThan(before)

    // pointerdown elsewhere (content area) does not re-root.
    const content = document.getElementById('content-area') as HTMLDivElement
    content.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(grabCalls()).toBe(afterBar)
  })
})
