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
class MockLogicalPosition {
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
    listen: ReturnType<typeof vi.fn>
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

  interface DockArgs {
    docked: boolean
    anchor: string | null
    edge: string | null
    dx: number
    dy: number
  }
  const dockArgs = (): DockArgs[] =>
    invoke.mock.calls
      .filter((c: unknown[]) => c[0] === 'set_dock')
      .map((c: unknown[]) => c[1] as DockArgs)
  const grabCalls = (): number =>
    invoke.mock.calls.filter((c: unknown[]) => c[0] === 'grab_dock').length

  const dispatchGroup = (payload: Record<string, unknown>) => {
    expect(eventHandlers['dock-group']).toBeTypeOf('function')
    // The page filters on the recipient field — stamp it like Rust does.
    eventHandlers['dock-group']({ payload: { for: SELF, ...payload } })
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
      listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
        eventHandlers[name] = cb
        return () => {}
      }),
      onMoved: vi.fn((cb: () => void) => {
        movedHandler = cb
        return Promise.resolve(() => {})
      }),
      isMinimized: vi.fn(async () => false),
      scaleFactor: vi.fn(async () => 1),
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
        LogicalPosition: MockLogicalPosition,
      },
      // load_connection → null keeps init() on the "Not connected" path:
      // no WebSocket is ever constructed in the test env.
      core: { invoke },
      event: { listen: vi.fn(async () => () => {}) },
    }

    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'deck-snap.js')
    loadVendorInto(window, 'moon-dock.js')
    loadVendorInto(window, 'widget-sandbox.js')

    // Select the page script by CONTENT, not position — an added inline
    // config stub or a type= attribute on the main tag must fail loudly
    // here, not silently execute the wrong script.
    const inlineScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .filter((s) => s.includes('LunaDock.wire'))
    expect(inlineScripts).toHaveLength(1)
    new Function(inlineScripts[0])()
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    delete (window as any).__TAURI__
    delete (window as any).LunaDeckSnap
    delete (window as any).LunaWidgetSandbox
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    vi.restoreAllMocks()
  })

  it('wires onMoved on boot', () => {
    expect(me.onMoved).toHaveBeenCalledTimes(1)
    expect(movedHandler).toBeTypeOf('function')
  })

  it('snaps flush to the hub but NEVER links with it (alignment-only — pins the getByLabel await)', async () => {
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)

    expect(getByLabel).toHaveBeenCalledWith('main')
    const snap = expectedSnap()
    expect(setPositionCalls).toEqual([{ x: snap.x, y: snap.y }])
    // The hub is alignment-only: no group, no pin, and dragging widgets can
    // never tow the moon around.
    expect(dockArgs()).toHaveLength(0)
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

  it('a hover-pause while the button is HELD never snaps — the settle waits for the real release', async () => {
    // macOS streams Moved during a drag; pausing 120ms over a neighbor used
    // to link the group under the user's hand ("a bit aggressive"). The
    // settle now polls pointer_button_down and only acts on button-up.
    let held = true
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'pointer_button_down') return held
      if (cmd === 'list_widget_windows') return []
      return null
    })

    movedHandler!()
    await vi.advanceTimersByTimeAsync(121) // settle fires → sees button held
    expect(setPositionCalls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(300) // several re-check polls — still held
    expect(setPositionCalls).toHaveLength(0)

    held = false // the user finally drops
    await vi.advanceTimersByTimeAsync(91)  // next poll sees the release
    const snap = expectedSnap()
    expect(setPositionCalls).toEqual([{ x: snap.x, y: snap.y }])
  })

  it('a new move while held kills the stale re-check chain (no double settles)', async () => {
    let held = true
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'pointer_button_down') return held
      if (cmd === 'list_widget_windows') return []
      return null
    })
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121) // settle → held → re-arm chain
    movedHandler!()                         // user keeps dragging — gen bumps
    held = false
    await vi.advanceTimersByTimeAsync(121) // only the NEW settle may act
    expect(setPositionCalls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(400) // the stale chain must stay dead
    expect(setPositionCalls).toHaveLength(1)
  })

  it('dock math runs in logical px — physical rects are divided by the scale (the live Retina bug)', async () => {
    // Same logical geometry as the base fixture, reported in 2x physical px.
    // The settle must divide by the window scale and snap to LOGICAL coords.
    me.scaleFactor.mockResolvedValue(2)
    me.outerPosition.mockResolvedValue({ x: WIDGET_POS.x * 2, y: WIDGET_POS.y * 2 })
    me.outerSize.mockResolvedValue({ width: WIDGET_SIZE.width * 2, height: WIDGET_SIZE.height * 2 })

    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    const snap = expectedSnap() // logical-space target
    expect(setPositionCalls).toEqual([{ x: snap.x, y: snap.y }])
  })

  it('a grouped member reports a merge with the snap delta and NEVER moves itself', async () => {
    dispatchGroup({ grouped: true, members: [SELF, 'widget-friend'], outlineSides: ['l'] })
    const outsider = {
      outerPosition: vi.fn(async () => ({ x: 850, y: 130 })),
      outerSize: vi.fn(async () => ({ width: 200, height: 200 })),
    }
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'list_widget_windows' ? ['widget-friend', 'widget-out'] : null,
    )
    getByLabel.mockImplementation(async (l: string) => (l === 'widget-out' ? outsider : null))

    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    expect(setPositionCalls).toHaveLength(0) // cluster integrity: no self-move
    const last = dockArgs()[dockArgs().length - 1]
    // Snap target x = outsider.x - width = 550 → dx = 550 - 540 = 10.
    expect(last).toEqual({ docked: true, anchor: 'widget-out', edge: 'l', dx: 10, dy: 0 })
  })

  it('a stale settle aborts when the window moves again mid-flight (generation guard)', async () => {
    // Make candidate enumeration slow, and move the window again meanwhile.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_widget_windows') {
        await new Promise((r) => setTimeout(r, 50))
        return []
      }
      return null
    })
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121) // settle starts, enumeration pending
    movedHandler!() // window moved again — bump the generation
    await vi.advanceTimersByTimeAsync(300) // let everything flush

    // The first (stale) settle must NOT have applied; the second one did.
    expect(setPositionCalls).toHaveLength(1)
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

  it('ignores dock-group events addressed to OTHER windows (cross-talk immunity)', () => {
    const pin = document.getElementById('pin-btn') as HTMLButtonElement
    expect(eventHandlers['dock-group']).toBeTypeOf('function')
    // A third-party event leaking through must not create phantom state.
    eventHandlers['dock-group']({
      payload: { for: 'widget-other', grouped: true, members: ['widget-other', 'widget-x'], outlineSides: ['l'] },
    })
    expect(pin.hidden).toBe(true)
    expect((document.getElementById('outline') as HTMLDivElement).className).toBe('')
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

  // Rust now computes seam placement (main.rs dock_seams) and ships it in the
  // dock-group payload; the page just renders payload.seams. These drive that
  // render path directly — no client geometry, no async fan-out.
  type Seam = { partner: string; edge: 'r' | 'b'; x: number; y: number }
  const groupWithSeams = (seams: Seam[]) =>
    dispatchGroup({ grouped: true, members: [SELF, 'widget-friend'], outlineSides: ['l', 't', 'b'], seams })

  it('renders the seam badges Rust sends, and clears them on ungroup', () => {
    const layer = document.getElementById('dock-links') as HTMLDivElement
    expect(layer).not.toBeNull() // moon-dock created it (no longer in the HTML shell)
    expect(layer.querySelectorAll('.dock-link')).toHaveLength(0)

    groupWithSeams([{ partner: 'widget-friend', edge: 'r', x: 289, y: 100 }])

    const badges = layer.querySelectorAll('.dock-link')
    expect(badges).toHaveLength(1)
    const badge = badges[0] as HTMLButtonElement
    expect(badge.classList.contains('e-r')).toBe(true)
    expect(badge.style.left).toBe('289px')
    expect(badge.style.top).toBe('100px')
    expect(badge.querySelector('svg')).not.toBeNull()

    // Ungrouping clears the layer.
    dispatchGroup({ grouped: false, members: [], outlineSides: [] })
    expect(layer.querySelectorAll('.dock-link')).toHaveLength(0)
  })

  it('tolerates a grouped payload with no seams (older core) — paints nothing', () => {
    dispatchGroup({ grouped: true, members: [SELF, 'widget-friend'], outlineSides: ['l'] })
    expect(document.querySelectorAll('#dock-links .dock-link')).toHaveLength(0)
  })

  it('reuses the badge node across re-renders (no re-pop), repositioning in place', () => {
    groupWithSeams([{ partner: 'widget-friend', edge: 'r', x: 289, y: 100 }])
    const first = document.querySelector('#dock-links .dock-link') as HTMLButtonElement
    expect(first).not.toBeNull()
    expect(first.style.top).toBe('100px')

    // Same partner|edge, moved → the SAME node is repositioned, never torn down
    // and recreated, so the scale-in entrance animation cannot replay.
    groupWithSeams([{ partner: 'widget-friend', edge: 'r', x: 289, y: 120 }])
    const after = document.querySelector('#dock-links .dock-link') as HTMLButtonElement
    expect(after).toBe(first)
    expect(after.style.top).toBe('120px')
  })

  it('clicking a seam badge leaves the group (the pin primitive, at the seam)', () => {
    groupWithSeams([{ partner: 'widget-friend', edge: 'r', x: 289, y: 150 }])
    const badge = document.querySelector('#dock-links .dock-link') as HTMLButtonElement
    expect(badge).not.toBeNull()
    badge.click()
    expect(dockArgs()).toEqual([{ docked: false, anchor: null, edge: null, dx: 0, dy: 0 }])
  })

  it('keeps a right-edge badge clear of the title-bar drag strip', () => {
    // Give the title bar a real measured bottom (jsdom otherwise reports 0).
    const titleBar = document.querySelector('.title-bar') as HTMLElement
    titleBar.getBoundingClientRect = () =>
      ({ bottom: 56, top: 22, left: 0, right: 0, width: 0, height: 34, x: 0, y: 22, toJSON: () => ({}) }) as DOMRect

    // Rust sends a right-edge seam whose center (y=25) lands in the title-bar band.
    groupWithSeams([{ partner: 'widget-friend', edge: 'r', x: 289, y: 25 }])
    const badge = document.querySelector('#dock-links .dock-link') as HTMLButtonElement
    expect(badge).not.toBeNull()
    // Nudged from y=25 down to title-bar bottom (56) + badge radius (11) = 67,
    // so the button never sits over the drag strip.
    expect(badge.style.top).toBe('67px')
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
    expect(dockArgs()).toEqual([{ docked: false, anchor: null, edge: null, dx: 0, dy: 0 }])
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
    expect(calls[calls.length - 1]).toEqual({ docked: true, anchor: 'widget-zzz', edge: 'l', dx: 0, dy: 0 })
  })

  it('a grouped widget can still link an OUTSIDER widget (group merge by drag)', async () => {
    dispatchGroup({ grouped: true, members: [SELF, 'widget-friend'], outlineSides: ['l', 'r', 't', 'b'] })
    const outsider = {
      outerPosition: vi.fn(async () => ({ x: 850, y: 130 })),
      outerSize: vi.fn(async () => ({ width: 200, height: 200 })),
    }
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'list_widget_windows' ? ['widget-friend', 'widget-out'] : null,
    )
    getByLabel.mockImplementation(async (l: string) => (l === 'widget-out' ? outsider : null))

    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    // widget-friend is in our group (excluded); widget-out is not → links.
    const last = dockArgs()[dockArgs().length - 1]
    expect(last.docked).toBe(true)
    expect(last.anchor).toBe('widget-out')
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
