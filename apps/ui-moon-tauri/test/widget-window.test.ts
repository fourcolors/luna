// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * widget-window.test.ts — behavioral tests for widget.html's title-bar
 * contract + the LIVE magnetic drag wired by vendor/moon-dock.js.
 *
 * The dock client now owns a JS drag (data-tauri-drag-region is GONE): a
 * capture-phase pointerdown on a `.title-bar` / `.chat-header` arms a drag,
 * snapshots the window + group + snap candidates asynchronously, then every
 * pointermove computes the snapped target via LunaDeckSnap.computeLiveDrag and
 * setPositions each member window LIVE. pointerup links (set_dock docked:true)
 * if the last move snapped, or detaches a module dragged clear of its cluster.
 *
 * These drive the REAL vendor script + widget.html shell against a mocked
 * __TAURI__ surface. The precise snap math is conformance-tested in
 * dock-live-drag.test.ts / deck-snap.test.ts; here we assert the WIRING:
 * pointerdown arms the drag, pointermove moves the window, pointerup commits.
 */

interface Rect { x: number; y: number; w: number; h: number }

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

describe('widget.html — title bar + live magnetic drag', () => {
  // Fixture geometry: the widget's top-left (528,108) sits within the 30px
  // magnet of the main window's top-right corner tile (520,100): √(8²+8²)=11.3.
  // A pointermove that nudges the lead onto that tile snaps RIGHT · top.
  const MAIN_RECT: Rect = { x: 100, y: 100, w: 420, h: 320 }
  const WIDGET_POS = { x: 528, y: 108 }
  const WIDGET_SIZE = { width: 300, height: 200 }
  const SELF = 'widget-test'

  let setPositionCalls: Array<{ x: number; y: number }>
  let eventHandlers: Record<string, (e: { payload: unknown }) => void>
  let me: {
    label: string
    listen: ReturnType<typeof vi.fn>
    isMinimized: ReturnType<typeof vi.fn>
    scaleFactor: ReturnType<typeof vi.fn>
    outerPosition: ReturnType<typeof vi.fn>
    outerSize: ReturnType<typeof vi.fn>
    setPosition: ReturnType<typeof vi.fn>
  }
  let getByLabel: ReturnType<typeof vi.fn>
  let invoke: ReturnType<typeof vi.fn>

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

  const dispatchGroup = (payload: Record<string, unknown>) => {
    expect(eventHandlers['dock-group']).toBeTypeOf('function')
    // The page filters on the recipient field — stamp it like Rust does.
    eventHandlers['dock-group']({ payload: { for: SELF, ...payload } })
  }

  // Let the async start-snapshot (logicalRect + members + candidateRects, all
  // awaited promises) settle before we drive pointermove/up.
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }

  // Stub pointer-capture on a title-bar handle (jsdom lacks it).
  const stubCapture = (el: Element) => {
    ;(el as any).setPointerCapture = vi.fn()
    ;(el as any).releasePointerCapture = vi.fn()
  }

  // Fire a pointer event with screen coords (jsdom's PointerEvent ignores
  // screenX/screenY in its ctor, so set them explicitly after construction).
  const pointer = (
    type: string,
    opts: { screenX?: number; screenY?: number; button?: number; pointerId?: number } = {},
  ): PointerEvent => {
    const e = new (window as any).MouseEvent(type, { bubbles: true, button: opts.button ?? 0 })
    Object.defineProperties(e, {
      screenX: { value: opts.screenX ?? 0, configurable: true },
      screenY: { value: opts.screenY ?? 0, configurable: true },
      pointerId: { value: opts.pointerId ?? 1, configurable: true },
    })
    return e as PointerEvent
  }

  beforeEach(() => {
    setPositionCalls = []
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
      isMinimized: vi.fn(async () => false),
      scaleFactor: vi.fn(async () => 1),
      outerPosition: vi.fn(async () => ({ ...WIDGET_POS })),
      outerSize: vi.fn(async () => ({ ...WIDGET_SIZE })),
      setPosition: vi.fn(async (p: MockLogicalPosition) => {
        setPositionCalls.push({ x: p.x, y: p.y })
      }),
    }
    const mainWin = {
      outerPosition: vi.fn(async () => ({ x: MAIN_RECT.x, y: MAIN_RECT.y })),
      outerSize: vi.fn(async () => ({ width: MAIN_RECT.w, height: MAIN_RECT.h })),
      scaleFactor: vi.fn(async () => 1),
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
        LogicalPosition: MockLogicalPosition,
      },
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
    document.body.innerHTML = ''
    delete (window as any).__TAURI__
    delete (window as any).LunaDeckSnap
    delete (window as any).LunaWidgetSandbox
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    vi.restoreAllMocks()
  })

  // ── Title-bar contract ──────────────────────────────────────────────────
  // The traffic-light titlebar keeps the dock-critical ids; the JS drag lives
  // on the .title-bar handle (data-tauri-drag-region is gone). Close still
  // closes, and min/zoom are inert-safe in this env.
  it('keeps the dock contract ids and the title-bar drag handle', () => {
    expect(document.getElementById('close-btn')).not.toBeNull()
    expect(document.getElementById('bar-title')).not.toBeNull()
    expect(document.querySelector('.dock-lights')).not.toBeNull()
    // The live drag attaches to .title-bar, not a native drag region.
    expect(document.querySelector('.title-bar')).not.toBeNull()
  })

  it('close light invokes close_widget; min collapses into the moon; zoom never throws', () => {
    ;(document.getElementById('min-btn') as HTMLButtonElement).click()
    ;(document.getElementById('zoom-btn') as HTMLButtonElement).click()
    ;(document.getElementById('close-btn') as HTMLButtonElement).click()
    // Minimize is the global "tuck everything into the moon" gesture, not a
    // per-window OS-dock minimize.
    expect(invoke).toHaveBeenCalledWith('collapse_to_moon')
    expect(invoke).toHaveBeenCalledWith('close_widget', { label: SELF })
  })

  // ── Cross-talk immunity ─────────────────────────────────────────────────
  it('ignores dock-group events addressed to OTHER windows (cross-talk immunity)', () => {
    expect(eventHandlers['dock-group']).toBeTypeOf('function')
    // A third-party event leaking through must not create phantom state.
    eventHandlers['dock-group']({
      payload: { for: 'widget-other', grouped: true, members: ['widget-other', 'widget-x'], outlineSides: ['l'] },
    })
    expect((document.getElementById('outline') as HTMLDivElement).className).toBe('')
  })

  // ── Perimeter outline renders from dock-group state ─────────────────────
  it('perimeter outline renders from dock-group state', () => {
    const outline = document.getElementById('outline') as HTMLDivElement

    dispatchGroup({ grouped: true, members: ['main', SELF], outlineSides: ['r', 't', 'b'] })
    expect(outline.className).toBe('gr gt gb')

    // Interior seams stay unhighlighted: only the listed outer sides render.
    dispatchGroup({ grouped: true, members: ['main', SELF, 'widget-x'], outlineSides: ['t'] })
    expect(outline.className).toBe('gt')

    dispatchGroup({ grouped: false, members: [], outlineSides: [] })
    expect(outline.className).toBe('')
  })

  // ── Live magnetic drag ──────────────────────────────────────────────────
  it('arms a drag on pointerdown over the title bar (.dragging) and ignores buttons', async () => {
    const bar = document.querySelector('.title-bar') as HTMLElement
    const shell = document.querySelector('.widget-shell') as HTMLElement
    stubCapture(bar)

    // A click on a traffic-light button is NOT a grab.
    ;(document.getElementById('close-btn') as HTMLButtonElement).dispatchEvent(
      pointer('pointerdown'),
    )
    expect(shell.classList.contains('dragging')).toBe(false)

    // A pointerdown on the bar itself arms the drag synchronously.
    bar.dispatchEvent(pointer('pointerdown'))
    expect(shell.classList.contains('dragging')).toBe(true)
    expect((bar as any).setPointerCapture).toHaveBeenCalled()
    await flush()
  })

  it('drags the window LIVE on pointermove, snapping flush to the hub (alignment-only — no link)', async () => {
    const bar = document.querySelector('.title-bar') as HTMLElement
    const shell = document.querySelector('.widget-shell') as HTMLElement
    stubCapture(bar)

    // Arm: pointerdown at screen origin → snapshot reads me + candidates (main).
    bar.dispatchEvent(pointer('pointerdown', { screenX: 0, screenY: 0 }))
    await flush()
    expect(invoke).toHaveBeenCalledWith('list_widget_windows')
    expect(getByLabel).toHaveBeenCalledWith('main')

    // Move: nudge the lead (528-8,108-8)=(520,100) exactly onto main's top-right
    // corner tile → computeLiveDrag snaps RIGHT·top to (520,100).
    bar.dispatchEvent(pointer('pointermove', { screenX: -8, screenY: -8 }))
    await flush()
    expect(setPositionCalls).toEqual([{ x: 520, y: 100 }]) // corner-aligned target
    expect(shell.classList.contains('snapping')).toBe(true)

    // Up: the last move snapped, but the candidate is the hub ('main'). The
    // commit explicitly skips anchor === 'main' — the hub is alignment-only, so
    // snapping flush to it glides the window into place but never links a group.
    bar.dispatchEvent(pointer('pointerup'))
    await flush()
    expect(dockArgs()).toHaveLength(0)
  })

  it('snaps + links a SIBLING widget on pointerup (set_dock docked:true)', async () => {
    const bar = document.querySelector('.title-bar') as HTMLElement
    stubCapture(bar)

    // A sibling widget whose top-left sits to our right; its left·top corner
    // tile (838-300,108)=(538,108) is within magnet of our origin (528,108).
    const sibling = {
      outerPosition: vi.fn(async () => ({ x: 838, y: 108 })),
      outerSize: vi.fn(async () => ({ width: 200, height: 200 })),
      scaleFactor: vi.fn(async () => 1),
    }
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'list_widget_windows' ? ['widget-zzz'] : null,
    )
    getByLabel.mockImplementation(async (l: string) => (l === 'widget-zzz' ? sibling : null))

    bar.dispatchEvent(pointer('pointerdown', { screenX: 0, screenY: 0 }))
    await flush()

    // Move onto the sibling's left tile (538,108): dx=+10, dy=0.
    bar.dispatchEvent(pointer('pointermove', { screenX: 10, screenY: 0 }))
    await flush()
    expect(setPositionCalls[setPositionCalls.length - 1]).toEqual({ x: 538, y: 108 })

    bar.dispatchEvent(pointer('pointerup'))
    await flush()
    const last = dockArgs()[dockArgs().length - 1]
    expect(last).toEqual({ docked: true, anchor: 'widget-zzz', edge: 'l', dx: 0, dy: 0 })
  })

  it('a free drag (no candidate in range) follows the raw delta and does NOT link', async () => {
    const bar = document.querySelector('.title-bar') as HTMLElement
    const shell = document.querySelector('.widget-shell') as HTMLElement
    stubCapture(bar)

    // No siblings, and the hub is far: drag the window way out of magnet range.
    me.outerPosition.mockResolvedValue({ x: 2000, y: 1500 })

    bar.dispatchEvent(pointer('pointerdown', { screenX: 0, screenY: 0 }))
    await flush()

    bar.dispatchEvent(pointer('pointermove', { screenX: 80, screenY: 60 }))
    await flush()
    // Free drag: window follows the raw cursor delta (2000+80, 1500+60).
    expect(setPositionCalls[setPositionCalls.length - 1]).toEqual({ x: 2080, y: 1560 })
    expect(shell.classList.contains('snapping')).toBe(false)

    bar.dispatchEvent(pointer('pointerup'))
    await flush()
    // Ungrouped + no snap → nothing committed.
    expect(dockArgs()).toHaveLength(0)
  })

  it('a non-anchor module dragged clear of its cluster detaches on pointerup (docked:false)', async () => {
    const bar = document.querySelector('.title-bar') as HTMLElement
    stubCapture(bar)

    // Rust says we're grouped with a friend (we are NOT the anchor — SELF is a
    // plain widget). Dragging clear of every window detaches us.
    dispatchGroup({ grouped: true, members: [SELF, 'widget-friend'], outlineSides: ['l', 'r', 't', 'b'] })
    me.outerPosition.mockResolvedValue({ x: 2000, y: 1500 })
    // The friend is excluded as a candidate; no other window in range.
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'list_widget_windows' ? ['widget-friend'] : null,
    )
    getByLabel.mockImplementation(async () => null)

    bar.dispatchEvent(pointer('pointerdown', { screenX: 0, screenY: 0 }))
    await flush()

    bar.dispatchEvent(pointer('pointermove', { screenX: 120, screenY: 90 }))
    await flush()

    bar.dispatchEvent(pointer('pointerup'))
    await flush()
    // Dragged clear while grouped → detach.
    const last = dockArgs()[dockArgs().length - 1]
    expect(last.docked).toBe(false)
  })
})
