// @vitest-environment jsdom
/**
 * route-indicator.test.ts - the plan's five indicator scenarios plus the
 * latch, for the CHAT window (PoolEngine), and (below, same describe block)
 * Step 4's verbose form of that same chip. Panel coverage lives in
 * panel-route-binding.test.ts, per this suite's seam split.
 *
 * FIXTURE TRAP (mandatory, from the plan review): every route fixture below
 * uses label != key ('stable' -> 'Stable Prod', 'canary' -> 'Canary Test').
 * A route-indicator implementation that renders routeKey instead of
 * route.label fails EVERY assertion in this file red, by construction.
 * ROUTE_TOKEN_BEARING extends the trap for Step 4: its endpoint URL is
 * deliberately credential-shaped (query string + fragment), proving the
 * verbose form renders describeWsUrl's OUTPUT, never the raw endpoint.
 *
 * SOURCE OF TRUTH: PoolEngine._paintRouteIndicator is called ONLY from real
 * connect()/onConnectionState transitions of THIS window's own socket -
 * never from the hub-event broadcast, never generically from updateStatus.
 * These tests drive that seam directly (pool().connect(), FakeWebSocket,
 * pool().updateStatus() for the latch's "unrelated write" arm) rather than
 * the hub-event wiring, matching this file's stated seam. The redock/detach
 * "verbose renders immediately on arrival" scenarios live in
 * chat-window.test.ts instead, beside Step 3's redock/detach tests - this
 * file's harness never captures windowEventHandlers, that one already does.
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
/** Step 4 fixture: deliberately credential-shaped (query string + fragment) -
 *  a real client.toml endpoint would not carry this, but the verbose form's
 *  redaction must strip it regardless of what it is given. */
const ROUTE_TOKEN_BEARING = {
  key: 'secure',
  label: 'Secure Route',
  url: 'ws://secure-host:4753/ui?token=TOK-SUPER-SECRET&x=1#frag',
}

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


// LIVE-SMOKE FENCE: the HTML `hidden` attribute alone cannot hide this chip -
// it inherits display:flex, and an author display rule defeats the UA
// stylesheet's [hidden]{display:none}. A REAL WKWebView rendered the "hidden"
// chip as a stray red dot. jsdom cannot render that, so the fence asserts the
// stylesheet RULE exists rather than the computed result.
import * as fs from 'node:fs'
import * as path from 'node:path'
describe('hidden-attribute CSS fence (live-smoke finding)', () => {
  it('chat.html carries an explicit #route-indicator[hidden] display:none rule', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../frontend-react/chat.html'), 'utf8')
    const m = html.match(/#route-indicator\[hidden\]\s*\{[^}]*display:\s*none/)
    expect(m, 'the [hidden] override rule must exist - display:flex defeats the hidden attribute without it').not.toBeNull()
  })
})

describe('Route indicator (plan Step 2) - chat window', () => {
  const internals = () => (window as any).__MoonInternals
  const pool = () => internals().PoolEngine
  const viewMode = () => internals().ViewMode
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
    for (const k of ['__TAURI__', '__MoonInternals', 'LunaChatHost', 'LunaTransport', 'ChatState', 'ChatLoop', 'ViewMode']) {
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
    // pool().isConnected() USED TO be a known-stale read here: connect()
    // never reset _isConnected at the pre-dial point, so it stayed
    // true from the PRIOR successful connect until the new adapter's own
    // state machine explicitly flipped it - closed by the plan Step 4
    // review's chat-only blocker fix (connect() now sets _isConnected =
    // false at the same point it claims the new route's identity, right
    // before this pre-dial paint). Asserting it here now, where it used to
    // be deliberately skipped, pins that the fix holds beyond just the
    // route indicator's own state.
    expect(pool().isConnected()).toBe(false)
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

  // ── Verbose form (plan Step 4) ────────────────────────────────────────

  describe('Verbose form (plan Step 4)', () => {
    it('KEY TEST: the verbose text is DERIVED from describeWsUrl(fixture) - proving the consumer sits behind the seam, not beside it', async () => {
      invokeState.current = ROUTE_TOKEN_BEARING
      evalChatInlineScriptWithBridge()
      await bringUp()

      viewMode().enable()

      const expectedEndpoint = (window as any).LunaProtocol.describeWsUrl(ROUTE_TOKEN_BEARING.url)
      expect(expectedEndpoint).toBeTruthy()
      expect(indicator().textContent).toContain(expectedEndpoint)
      expect(indicator().textContent).toContain('Secure Route')
      expect(indicator().textContent).toContain('Connected')
    })

    it('toggle on: the verbose form appears, showing endpoint + state alongside the label', async () => {
      evalChatInlineScriptWithBridge()
      await bringUp()
      const baseline = indicator().textContent
      expect(baseline).toBe('Stable Prod')

      viewMode().enable()

      expect(indicator().textContent).not.toBe(baseline)
      expect(indicator().textContent).toContain('Stable Prod')
      expect(indicator().textContent).toContain('stable-host:4753/ui')
      expect(indicator().textContent).toContain('Connected')
    })

    it('toggle off: EXACT Step 2 rendering is restored - equal to the non-verbose baseline, not just missing the verbose bits', async () => {
      evalChatInlineScriptWithBridge()
      await bringUp()
      const baseline = indicator().textContent
      const baselineClass = indicator().className

      viewMode().enable()
      expect(indicator().textContent).not.toBe(baseline)

      viewMode().disable()

      expect(indicator().textContent).toBe(baseline)
      expect(indicator().className).toBe(baselineClass)
    })

    it('verbose form NEVER contains "?", "#", "token", or the fixture credential anywhere in the chip text', async () => {
      invokeState.current = ROUTE_TOKEN_BEARING
      evalChatInlineScriptWithBridge()
      await bringUp()

      viewMode().enable()

      const text = indicator().textContent || ''
      expect(text).not.toContain('?')
      expect(text).not.toContain('#')
      expect(text.toLowerCase()).not.toContain('token')
      expect(text).not.toContain('TOK-SUPER-SECRET')
      expect(text).not.toContain('RESOLVED-TOK-secure')
      expect(text).not.toContain(ROUTE_TOKEN_BEARING.url)
    })

    it('the latch survives verbose mode: a latched failure renders verbose too, and only a genuine reconnect clears it', async () => {
      invokeState.current = ROUTE_CANARY
      evalChatInlineScriptWithBridge()
      const sock = await bringUp()
      viewMode().enable()
      expect(indicator().textContent).toContain('Canary Test')
      expect(indicator().textContent).toContain('Connected')

      sock.simulateDrop()
      await settle()

      // Latched failure, rendered verbose: still names the route, still
      // shows its endpoint, now says Disconnected - never blank, never the
      // plain (non-verbose) form just because the socket dropped.
      expect(indicator().className).toContain('disconnected')
      expect(indicator().textContent).toContain('Canary Test')
      expect(indicator().textContent).toContain('canary-host:4753/ui')
      expect(indicator().textContent).toContain('Disconnected')

      // Unrelated status write still cannot clear it, verbose or not.
      pool().updateStatus('connected', 'Connected')
      expect(indicator().className, 'latch holds against the unrelated write').toContain('disconnected')
      expect(indicator().textContent).toContain('Disconnected')

      // Genuine reconnect clears the latch, verbose form updates in place.
      void pool().connect()
      await bringUp()
      expect(indicator().className).toContain('connected')
      expect(indicator().textContent).toContain('Connected')
      expect(indicator().textContent).toContain('Canary Test')
    })

    // ── Pre-dial window (reviewer-identified gap, mandatory) ──────────────
    //
    // connect()'s pre-dial paint fires BEFORE manager.acquire() ever
    // resolves - the window between "new route claimed, chip painted
    // disconnected" and "adapter acquired". Gate acquire() so it NEVER
    // resolves, reproducing that window indefinitely so a toggle fired
    // DURING it can be observed, not raced.
    function gateConnectionManager() {
      const real = (window as any).LunaTransport
      ;(window as any).LunaTransport = Object.assign({}, real, {
        ConnectionManager: class {
          constructor(_routeMap: unknown, _factory: unknown) {}
          acquire(_routeKey: string) {
            return new Promise(() => {}) // deliberately never resolves
          }
        },
      })
    }

    it('Pre-dial hang + click toggle: verbose mode toggled during a hung switch never claims Connected', async () => {
      evalChatInlineScriptWithBridge()
      await bringUp()
      expect(indicator().textContent).toBe('Stable Prod')

      gateConnectionManager()
      invokeState.current = ROUTE_NEVER_ACCEPTS // 'Blackhole Route' - reused as route B
      void pool().connect()
      await settle()

      // The pre-dial paint fired: chip already reads B's label, disconnected.
      expect(indicator().textContent).toBe('Blackhole Route')
      expect(indicator().className).toContain('disconnected')

      // Toggle verbose WHILE acquire() is still hung.
      viewMode().enable()

      // Must still read disconnected - never "Connected" over a route this
      // window's socket was never actually on.
      expect(indicator().className).toContain('disconnected')
      expect(indicator().textContent).toMatch(/Disconnected$/)
      expect(indicator().textContent).not.toContain('Connected')
    })

    it('Pre-dial hang + redock-applied enable(): the arrival path never claims Connected either', async () => {
      evalChatInlineScriptWithBridge()
      await bringUp()
      expect(indicator().textContent).toBe('Stable Prod')

      gateConnectionManager()
      invokeState.current = ROUTE_NEVER_ACCEPTS
      void pool().connect()
      await settle()

      expect(indicator().textContent).toBe('Blackhole Route')
      expect(indicator().className).toContain('disconnected')

      // wiring.ts's redock-thread listener calls ViewMode.enable() directly
      // (never .toggle()) on a positive viewMode:true payload - drive that
      // exact entry point, not the click handler.
      viewMode().enable()

      expect(indicator().className).toContain('disconnected')
      expect(indicator().textContent).toMatch(/Disconnected$/)
      expect(indicator().textContent).not.toContain('Connected')
    })
  })
})
