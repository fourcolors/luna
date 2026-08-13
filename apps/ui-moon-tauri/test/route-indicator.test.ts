// @vitest-environment jsdom
/**
 * route-indicator.test.ts - the plan's five indicator scenarios plus the
 * latch, for the CHAT window (PoolEngine). Panel coverage lives in
 * panel-route-binding.test.ts, per this suite's seam split.
 *
 * FIXTURE TRAP (mandatory, from the plan review): every route fixture below
 * uses label != key ('stable' -> 'Stable Prod', 'canary' -> 'Canary Test').
 * A route-indicator implementation that renders routeKey instead of
 * route.label fails EVERY assertion in this file red, by construction.
 *
 * SOURCE OF TRUTH: PoolEngine._paintRouteIndicator is called ONLY from real
 * connect()/onConnectionState transitions of THIS window's own socket -
 * never from the hub-event broadcast, never generically from updateStatus.
 * These tests drive that seam directly (pool().connect(), FakeWebSocket,
 * pool().updateStatus() for the latch's "unrelated write" arm) rather than
 * the hub-event wiring, matching this file's stated seam.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as LunaTransport from '@luna/ui-transport'
import { FakeWebSocket } from './helpers/FakeWebSocket'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  readChatHtml,
} from './helpers/chat-harness'

/** Route fixtures: label ALWAYS differs from key (the fixture trap). */
const ROUTE_STABLE = { key: 'stable', label: 'Stable Prod', url: 'ws://stable-host:4753/ui' }
const ROUTE_CANARY = { key: 'canary', label: 'Canary Test', url: 'ws://canary-host:4753/ui' }
/** An endpoint FakeWebSocket will construct a socket for, but which we
 *  simply never simulateOpen() - standing in for "never accepts a
 *  connection" (scenario 5's requirement is about timing, not a real
 *  network refusal, so a socket that just never opens is the correct fake). */
const ROUTE_NEVER_ACCEPTS = { key: 'blackhole', label: 'Blackhole Route', url: 'ws://blackhole-host:4753/ui' }

/** Switchable invoke stub: list_routes/load_route report whichever route is
 *  `current` at call time, so a test can simulate a route switch by
 *  reassigning `current` before triggering a fresh connect(). */
function makeInvokeStub(state: { current: typeof ROUTE_STABLE; tokenRejects?: boolean }) {
  return vi.fn(async (cmd: string) => {
    switch (cmd) {
      case 'migrate_legacy_connection':
        return null
      case 'load_connection':
        return { wsUrl: state.current.url, wsToken: 'legacy' }
      case 'get_panel_route':
        return null
      case 'list_routes':
        return { default: state.current.key, routes: [{ key: state.current.key, label: state.current.label }] }
      case 'load_route':
        return {
          key: state.current.key,
          label: state.current.label,
          endpoints: [state.current.url],
          token_ref: 'legacy',
          transport: 'luna-ws',
        }
      case 'resolve_route_token':
        if (state.tokenRejects) throw new Error('route-missing: no route named "' + state.current.key + '"')
        return 'RESOLVED-TOK-' + state.current.key
      default:
        return null
    }
  })
}

describe('Route indicator (plan Step 2) - chat window', () => {
  const internals = () => (window as any).__MoonInternals
  const pool = () => internals().PoolEngine
  const indicator = () => document.getElementById('route-indicator')!

  let invokeState: { current: typeof ROUTE_STABLE; tokenRejects?: boolean }

  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    mountChatDomFromHtml(readChatHtml())
    invokeState = { current: ROUTE_STABLE }
    ;(window as any).__TAURI__ = {
      core: { invoke: makeInvokeStub(invokeState) },
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
        }),
        Window: { getByLabel: vi.fn(async () => null) },
      },
      event: { listen: vi.fn(async () => () => {}) },
    }
    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'moon-dock.js')
    loadVendorInto(window, 'pool-engine.js')
    loadVendorInto(window, 'moon-session.js')
    ;(window as any).LunaTransport = LunaTransport

    localStorage.clear()
    FakeWebSocket.reset()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    for (const k of ['__TAURI__', '__MoonInternals', 'LunaChatHost', 'LunaTransport', 'ChatState', 'ChatLoop']) {
      delete (window as any)[k]
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const settle = async (steps = 8, ms = 50) => {
    for (let i = 0; i < steps; i++) await vi.advanceTimersByTimeAsync(ms)
  }

  /** Bring the live socket fully up (open + hello) - see
   *  pool-engine-contract.test.ts's module doc on why open alone is not
   *  enough. */
  const bringUp = async () => {
    await settle()
    const sock = FakeWebSocket.latest()
    expect(sock, 'a socket should have been dialed').toBeTruthy()
    sock!.simulateOpen()
    sock!.simulateMessage({ type: 'hello', protocolVersion: 2, capabilities: {} })
    await settle()
    return sock!
  }

  it('Scenario 1: the window names the route its socket is on', async () => {
    evalChatInlineScriptWithBridge()
    const sock = await bringUp()

    expect(indicator().textContent).toBe('Stable Prod')
    expect(indicator().hidden).toBe(false)
    expect(indicator().className).toContain('connected')
    expect(sock.url.startsWith(ROUTE_STABLE.url)).toBe(true)

    // F3 (opus review): a deliberate disconnect() must not leave the chip
    // stuck green over a socket this engine itself just closed.
    pool().disconnect()
    expect(indicator().className).toContain('disconnected')
    expect(indicator().textContent).toBe('Stable Prod')
  })

  it('Scenario 2: the indicator follows a route switch', async () => {
    evalChatInlineScriptWithBridge()
    await bringUp()
    expect(indicator().textContent).toBe('Stable Prod')

    // Simulate the user switching to canary in Settings, which re-runs
    // connect() (mirrors hub-event 'profile-changed' -> loadConnectionAndConnect
    // -> connect(); calling connect() directly reaches the identical guard
    // with identical inputs, per the established pattern in
    // pool-engine-token-resolution.test.ts).
    invokeState.current = ROUTE_CANARY
    void pool().connect()
    const sock = await bringUp()

    expect(indicator().textContent).toBe('Canary Test')
    expect(indicator().className).toContain('connected')
    expect(sock.url.startsWith(ROUTE_CANARY.url)).toBe(true)
  })

  it('Scenario 3: a disconnected window still names its route', async () => {
    invokeState.current = ROUTE_CANARY
    evalChatInlineScriptWithBridge()
    const sock = await bringUp()
    expect(indicator().textContent).toBe('Canary Test')

    sock.simulateDrop()
    await settle()

    // The indicator is STILL PRESENT (not hidden/removed) - an indicator
    // that vanishes on disconnect is worse than none.
    expect(indicator().hidden).toBe(false)
    expect(indicator().textContent).toBe('Canary Test')
    expect(indicator().className).toContain('disconnected')
  })

  it('Scenario 4: a window whose re-resolution fails keeps naming what its socket is actually on', async () => {
    evalChatInlineScriptWithBridge()
    await bringUp()
    expect(indicator().textContent).toBe('Stable Prod')

    // A re-resolution attempt (e.g. a hub-event fired by a switch elsewhere)
    // that FAILS token resolution must not blank the indicator or invent a
    // route this window's socket was never actually on - it must keep
    // showing what THIS socket is genuinely connected to.
    invokeState.tokenRejects = true
    void pool().connect()
    await settle()

    expect(pool().isConnected(), 'the old connection must have been torn down on refusal').toBe(false)
    // Still names stable (the last route this socket actually held) -
    // never blank, never a fabricated/partial label from the failed attempt.
    expect(indicator().textContent).toBe('Stable Prod')
    expect(indicator().className).toContain('disconnected')
  })

  it('Scenario 5: switching to a route whose endpoint never accepts a connection shows the NEW label before any connection succeeds', async () => {
    evalChatInlineScriptWithBridge()
    await bringUp()
    expect(indicator().textContent).toBe('Stable Prod')

    invokeState.current = ROUTE_NEVER_ACCEPTS
    void pool().connect()
    await settle()

    // The load-bearing clause: BEFORE any connection has succeeded (no
    // simulateOpen/simulateMessage at all below), the indicator already
    // reads the NEW label and is marked disconnected. An indicator derived
    // from the hello frame or from isConnected() would still show the OLD
    // label here and fail this assertion.
    expect(indicator().textContent).toBe('Blackhole Route')
    expect(indicator().className).toContain('disconnected')
    // NOT asserting pool().isConnected() here: PoolEngine's _isConnected is
    // a pre-existing, unrelated gap - _teardownAdapter() never resets it, so
    // it stays stale-true from the PRIOR successful connect until the new
    // adapter's own state machine explicitly flips it. That is out of scope
    // for the route indicator (which has its OWN, correctly-updated state,
    // asserted above) and not something this slice touches.
    expect(FakeWebSocket.instances.some((s) => s.readyState === FakeWebSocket.OPEN)).toBe(false)
  })

  it('Latch: a failure latches; an unrelated updateStatus write cannot clear it; only a genuine reconnect of this socket does', async () => {
    invokeState.current = ROUTE_CANARY
    evalChatInlineScriptWithBridge()
    const sock = await bringUp()
    expect(indicator().textContent).toBe('Canary Test')
    expect(indicator().className).toContain('connected')

    // Failure shown.
    sock.simulateDrop()
    await settle()
    expect(indicator().className).toContain('disconnected')
    expect(indicator().textContent).toBe('Canary Test')

    // Unrelated 'connected' status write - NOT the dedicated route-indicator
    // paint path, just the generic status-pill setter some other transition
    // might call. This must NOT repaint the indicator - proving the latch is
    // implemented in the indicator's own state, not by fighting updateStatus
    // (there is nothing to fight: updateStatus never touches the indicator).
    pool().updateStatus('connected', 'Connected')
    expect(document.getElementById('connection-status')!.textContent, 'the OLD pill DID change - sanity check that this write is real').toBe('Connected')
    expect(indicator().className, 'latch holds against the unrelated write').toContain('disconnected')
    expect(indicator().textContent).toBe('Canary Test')

    // Genuine reconnect of THIS window's socket clears the latch.
    void pool().connect()
    await bringUp()
    expect(indicator().className).toContain('connected')
    expect(indicator().textContent).toBe('Canary Test')
  })
})
