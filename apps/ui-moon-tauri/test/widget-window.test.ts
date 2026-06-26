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
 * — coalesced to one animation frame — moves the whole cluster in a single
 * batched `dock_move_cluster` invoke. pointerup emits a frontend `dock-link`
 * event if the last move snapped onto a sibling, or peels a module off cleanly
 * (no link) when dragged clear. Welding is EMERGENT: a window computes its own
 * perimeter/seams from sibling geometry — there is no set_dock invoke and no
 * dock-group payload anymore.
 *
 * These drive the REAL vendor script + widget.html shell against a mocked
 * __TAURI__ surface. The precise snap math is conformance-tested in
 * dock-live-drag.test.ts / deck-snap.test.ts; the weld geometry in
 * deck-weld.test.ts; here we assert the WIRING: pointerdown arms the drag,
 * pointermove moves the window, pointerup links/peels, geometry drives welds.
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
  let globalHandlers: Record<string, (e: { payload: unknown }) => void>
  let emitCalls: Array<{ name: string; payload: unknown }>
  let me: {
    label: string
    listen: ReturnType<typeof vi.fn>
    isMinimized: ReturnType<typeof vi.fn>
    scaleFactor: ReturnType<typeof vi.fn>
    outerPosition: ReturnType<typeof vi.fn>
    outerSize: ReturnType<typeof vi.fn>
    setPosition: ReturnType<typeof vi.fn>
    onResized: ReturnType<typeof vi.fn>
  }
  let getByLabel: ReturnType<typeof vi.fn>
  let invoke: ReturnType<typeof vi.fn>

  interface DockLink {
    for: string
    from: string
    edge: string | null
  }
  // Emergent model: a confirmed link is a frontend-emitted `dock-link` event
  // (not a set_dock invoke). Read them back from the captured event.emit calls.
  const dockLinks = (): DockLink[] =>
    emitCalls.filter((c) => c.name === 'dock-link').map((c) => c.payload as DockLink)

  const broadcasts = (name: string): number =>
    emitCalls.filter((c) => c.name === name).length

  // The live drag now moves the whole cluster in ONE batched invoke
  // (dock_move_cluster) per animation frame instead of N per-window setPosition
  // calls. Read back the latest batch's moves [{label,x,y}].
  const lastClusterMove = (): Array<{ label: string; x: number; y: number }> | null => {
    const calls = invoke.mock.calls.filter((c) => c[0] === 'dock_move_cluster')
    if (!calls.length) return null
    return (calls[calls.length - 1][1] as { moves: Array<{ label: string; x: number; y: number }> }).moves
  }

  // Drive a global `dock-geometry-changed` broadcast (what neighbours emit when
  // they move) → the window recomputes its own weld from current sibling rects.
  const refreshWeld = async () => {
    expect(globalHandlers['dock-geometry-changed']).toBeTypeOf('function')
    globalHandlers['dock-geometry-changed']({ payload: {} })
    await flush()
  }

  // Let the async start-snapshot (logicalRect + members + candidateRects, all
  // awaited promises) settle before we drive pointermove/up.
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
    // The live-drag move is now coalesced into ONE requestAnimationFrame
    // (flushDrag) rather than running synchronously per pointermove, so drain a
    // frame too — then settle the microtasks its (fire-and-forget) invoke queues.
    await new Promise((r) => requestAnimationFrame(() => r(undefined)))
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
    globalHandlers = {}
    emitCalls = []

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
      onResized: vi.fn(async () => () => {}),
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
      event: {
        // Global broadcast bus: capture the dock-geometry-changed subscriber so
        // a test can fire it, and record every emit (dock-link / geometry tick).
        listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
          globalHandlers[name] = cb
          return () => {}
        }),
        emit: vi.fn(async (name: string, payload: unknown) => {
          emitCalls.push({ name, payload })
        }),
      },
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

  // ── Perimeter outline renders from LOCAL sibling geometry ───────────────
  it('a lone widget shows no perimeter outline', async () => {
    // wire() ran refreshWeld on init with list_widget_windows = [] → ungrouped.
    await flush()
    expect((document.getElementById('outline') as HTMLDivElement).className).toBe('')
  })

  it('perimeter outline renders from local sibling geometry on a geometry tick', async () => {
    const outline = document.getElementById('outline') as HTMLDivElement
    // A sibling welds CARD-flush below SELF (528,108,300x200): the vertical card
    // gap is inset_b(22)+inset_t(4)=26, so its frame sits at y=308-26=282 (frames
    // overlap). SELF's bottom card edge is then interior → free sides l, r, t.
    const below = {
      outerPosition: vi.fn(async () => ({ x: 528, y: 282 })),
      outerSize: vi.fn(async () => ({ width: 300, height: 200 })),
      scaleFactor: vi.fn(async () => 1),
    }
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'list_widget_windows' ? ['widget-below'] : null,
    )
    getByLabel.mockImplementation(async (l: string) => (l === 'widget-below' ? below : null))
    await refreshWeld()
    expect(outline.className).toBe('gl gr gt')

    // Sibling out of the picture → ungrouped → outline clears.
    invoke.mockImplementation(async (cmd: string) => (cmd === 'list_widget_windows' ? [] : null))
    await refreshWeld()
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

  it('drags the window LIVE on pointermove; the hub is NOT a magnet (glides freely, no link)', async () => {
    const bar = document.querySelector('.title-bar') as HTMLElement
    stubCapture(bar)

    // Arm: pointerdown at screen origin. The start snapshot enumerates snap
    // candidates via list_widget_windows, but the moon hub ('main') is
    // DELIBERATELY excluded (moon-dock.js: the hub is small + always on screen,
    // so magneting to it mid-drag reads as an "invisible wall" — "Panels snap to
    // other PANELS only"). So the hub is never read as a candidate.
    bar.dispatchEvent(pointer('pointerdown', { screenX: 0, screenY: 0 }))
    await flush()
    expect(invoke).toHaveBeenCalledWith('list_widget_windows')
    expect(getByLabel).not.toHaveBeenCalledWith('main')

    // Move: with no panel candidates (list_widget_windows is [] and the hub is
    // excluded), there is no magnet — the window glides FREELY to the raw
    // pointer delta: SELF frame (528,108) + delta (-52,-8) → (476,100). NB this
    // raw position equals the LEGACY snapped-to-hub target by construction, so
    // the coordinate alone cannot prove "no snap"; the assertion that actually
    // proves it is `getByLabel` not-called-with-'main' above. This line just
    // confirms the live drag moved the window (one batched cluster move).
    bar.dispatchEvent(pointer('pointermove', { screenX: -52, screenY: -8 }))
    await flush()
    expect(lastClusterMove()).toEqual([{ label: SELF, x: 476, y: 100 }])

    // Up: gliding past the hub links nothing — the hub is alignment-only.
    bar.dispatchEvent(pointer('pointerup'))
    await flush()
    expect(dockLinks()).toHaveLength(0)
  })

  it('snaps + emits a dock-link for a SIBLING on pointerup', async () => {
    const bar = document.querySelector('.title-bar') as HTMLElement
    stubCapture(bar)

    // A sibling widget to our right; SELF docks CARD-flush on its LEFT. sibling
    // card-left·top = (860,112); SELF card-right meets it → SELF card-left =
    // 860-256 = 604 → SELF frame = (604-22, 112-4) = (582,108).
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

    // Move onto the sibling's left card tile (582,108): delta from (528,108) = +54.
    bar.dispatchEvent(pointer('pointermove', { screenX: 54, screenY: 0 }))
    await flush()
    expect(lastClusterMove()).toEqual([{ label: SELF, x: 582, y: 108 }])

    bar.dispatchEvent(pointer('pointerup'))
    await flush()
    // The link is now a frontend dock-link event aimed at the anchor's page.
    const links = dockLinks()
    expect(links[links.length - 1]).toEqual({ for: 'widget-zzz', from: SELF, edge: 'l' })
  })

  it('a free drag (no candidate in range) follows the raw delta and does NOT link', async () => {
    const bar = document.querySelector('.title-bar') as HTMLElement
    stubCapture(bar)

    // No siblings, and the hub is far: drag the window way out of magnet range.
    me.outerPosition.mockResolvedValue({ x: 2000, y: 1500 })

    bar.dispatchEvent(pointer('pointerdown', { screenX: 0, screenY: 0 }))
    await flush()

    bar.dispatchEvent(pointer('pointermove', { screenX: 80, screenY: 60 }))
    await flush()
    // Free drag: window follows the raw cursor delta (2000+80, 1500+60).
    expect(lastClusterMove()).toEqual([{ label: SELF, x: 2080, y: 1560 }])

    bar.dispatchEvent(pointer('pointerup'))
    await flush()
    // Ungrouped + no snap → no link emitted.
    expect(dockLinks()).toHaveLength(0)
  })

  it('a non-anchor module welded to a friend peels off cleanly when dragged clear (no link)', async () => {
    const bar = document.querySelector('.title-bar') as HTMLElement
    stubCapture(bar)

    // A friend welds CARD-flush below SELF (frame y=282, a 26px frame overlap) so
    // emergent geometry groups us (SELF is a plain widget, not the anchor). It
    // stays at its spot the whole time.
    const friend = {
      outerPosition: vi.fn(async () => ({ x: 528, y: 282 })),
      outerSize: vi.fn(async () => ({ width: 300, height: 200 })),
      scaleFactor: vi.fn(async () => 1),
    }
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'list_widget_windows' ? ['widget-friend'] : null,
    )
    getByLabel.mockImplementation(async (l: string) => (l === 'widget-friend' ? friend : null))
    await refreshWeld() // now grouped with the friend
    expect((document.getElementById('outline') as HTMLDivElement).className).toBe('gl gr gt')

    bar.dispatchEvent(pointer('pointerdown', { screenX: 0, screenY: 0 }))
    await flush()
    // Drag far past the friend's magnet so the last move does not snap.
    bar.dispatchEvent(pointer('pointermove', { screenX: 600, screenY: 400 }))
    await flush()
    bar.dispatchEvent(pointer('pointerup'))
    await flush()

    // Peeled off clean: no phantom link, and a geometry tick tells the friend to
    // repaint without SELF welded.
    expect(dockLinks()).toHaveLength(0)
    expect(broadcasts('dock-geometry-changed')).toBeGreaterThan(0)
  })
})
