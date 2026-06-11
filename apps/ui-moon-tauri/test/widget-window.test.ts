// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * widget-window.test.ts — behavioral tests for widget.html's deck self-snap
 * consumer (widget-system.md Phase 0).
 *
 * The snap path shipped broken: `Window.getByLabel` is ASYNC in the Tauri 2
 * JS API and the original code missed the await — `mainWin` was a Promise
 * (always truthy), `outerPosition()` threw, and the best-effort catch
 * swallowed it, so snap silently never ran on a real build. These tests drive
 * the REAL inline script against a mocked __TAURI__ surface and pin the whole
 * onMoved → settle-debounce → computeSnap → setPosition arc, so a regression
 * of the await (or of the minimize / suppression guards) flips a test red.
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

describe('widget.html — deck self-snap consumer', () => {
  // Fixture geometry: widget left edge (x=540) sits 20 px right of the main
  // window's right edge (100+420=520) with full vertical overlap — inside the
  // 22 px magnet, so computeSnap MUST produce a snap for these rects.
  const MAIN_RECT: Rect = { x: 100, y: 100, w: 420, h: 320 }
  const WIDGET_POS = { x: 540, y: 130 }
  const WIDGET_SIZE = { width: 300, height: 200 }

  let setPositionCalls: Array<{ x: number; y: number }>
  let movedHandler: (() => void) | null
  let me: {
    label: string
    onMoved: ReturnType<typeof vi.fn>
    isMinimized: ReturnType<typeof vi.fn>
    outerPosition: ReturnType<typeof vi.fn>
    outerSize: ReturnType<typeof vi.fn>
    setPosition: ReturnType<typeof vi.fn>
  }
  let getByLabel: ReturnType<typeof vi.fn>

  const expectedSnap = (): SnapResult => {
    const snap = (window as any).LunaDeckSnap.computeSnap(
      MAIN_RECT,
      { x: WIDGET_POS.x, y: WIDGET_POS.y, w: WIDGET_SIZE.width, h: WIDGET_SIZE.height },
      22,
    )
    expect(snap).not.toBeNull() // fixture sanity: rects are snappable
    return snap
  }

  beforeEach(() => {
    vi.useFakeTimers()
    setPositionCalls = []
    movedHandler = null

    const html = fs.readFileSync(
      path.resolve(__dirname, '../frontend/widget.html'),
      'utf8',
    )
    const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

    me = {
      label: 'widget-test',
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
    getByLabel = vi.fn(async (label: string) => (label === 'main' ? mainWin : null))

    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: () => me,
        Window: { getByLabel },
        PhysicalPosition: MockPhysicalPosition,
      },
      // load_connection → null keeps init() on the "Not connected" path:
      // no WebSocket is ever constructed in the test env.
      core: { invoke: vi.fn(async () => null) },
    }

    loadVendorInto(window, 'deck-snap.js')
    loadVendorInto(window, 'widget-sandbox.js')

    // First plain <script> (the src= vendor tags don't match this pattern).
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/)
    expect(scriptMatch).not.toBeNull()
    new Function(scriptMatch![1])()
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

  it('snaps to the main window after movement settles (pins the getByLabel await)', async () => {
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)

    expect(getByLabel).toHaveBeenCalledWith('main')
    const snap = expectedSnap()
    expect(setPositionCalls).toEqual([{ x: snap.x, y: snap.y }])
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

  it('ignores the onMoved echo of its own setPosition (suppression window)', async () => {
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    expect(setPositionCalls).toHaveLength(1)

    // The snap's setPosition fires onMoved again immediately — inside the
    // suppression window it must NOT arm another settle timer.
    movedHandler!()
    await vi.advanceTimersByTimeAsync(300)
    expect(setPositionCalls).toHaveLength(1)

    // A real drag after the window expires snaps again.
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    expect(setPositionCalls).toHaveLength(2)
  })

  it('never snaps a minimized window (tauri#7664 spurious onMoved)', async () => {
    me.isMinimized.mockResolvedValue(true)
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)

    expect(setPositionCalls).toHaveLength(0)
  })

  it('does not move the window when out of magnet range', async () => {
    me.outerPosition.mockResolvedValue({ x: 2000, y: 1500 })
    const far = (window as any).LunaDeckSnap.computeSnap(
      MAIN_RECT,
      { x: 2000, y: 1500, w: WIDGET_SIZE.width, h: WIDGET_SIZE.height },
      22,
    )
    expect(far).toBeNull() // fixture sanity: genuinely out of range

    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)
    expect(setPositionCalls).toHaveLength(0)
  })

  it('survives a missing main window without touching position', async () => {
    getByLabel.mockResolvedValue(null)
    movedHandler!()
    await vi.advanceTimersByTimeAsync(121)

    expect(setPositionCalls).toHaveLength(0)
  })
})
