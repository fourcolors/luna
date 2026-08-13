// @vitest-environment jsdom
/**
 * view-mode.test.ts - the plan's view-mode feature, for the CHAT window
 * (PoolEngine + wire.ts's ViewMode). Panel coverage lives in
 * panel-route-binding.test.ts's "Step 3" describe block; the redock/detach
 * payload-plumbing scenarios live in chat-window.test.ts (they drive
 * wiring.ts/threadDrawer.ts, not this file's ViewMode object directly).
 *
 * SOURCE OF TRUTH FOR THE SEAM: ViewMode.seam() reads PoolEngine's OWN
 * _routeLabel/_isConnected/_routeEndpointDisplay - the exact same fields
 * the Step 2 route indicator paints from - never a second, parallel copy.
 *
 * FIXTURE TRAP (seam scenarios): ROUTE_TOKEN_BEARING's endpoint URL is
 * deliberately credential-shaped (query string + fragment), even though a
 * real client.toml endpoint would not normally carry one - it exists to
 * prove the seam redacts WHATEVER it is given, not just well-formed inputs.
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

const ROUTE_STABLE = { key: 'stable', label: 'Stable Prod', url: 'ws://stable-host:4753/ui' }

/** Deliberately credential-shaped endpoint (query string + fragment) - the
 *  seam-scenario fixture trap. A real client.toml endpoint would not carry
 *  this, but the redaction seam must strip it regardless of what it is given. */
const ROUTE_TOKEN_BEARING = {
  key: 'secure',
  label: 'Secure Route',
  url: 'ws://secure-host:4753/ui?token=TOK-SUPER-SECRET&x=1#frag',
}

function makeInvokeStub(state: { current: typeof ROUTE_STABLE }) {
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
        return 'RESOLVED-TOK-' + state.current.key
      default:
        return null
    }
  })
}

describe('View mode (plan Step 3) - chat window', () => {
  const internals = () => (window as any).__MoonInternals
  const pool = () => internals().PoolEngine
  const viewMode = () => internals().ViewMode
  const indicator = () => document.getElementById('route-indicator')!

  let invokeState: { current: typeof ROUTE_STABLE }

  /** One full window boot: mounts fresh DOM, installs a fresh __TAURI__ mock
   *  and vendor set, and runs bootChat() for real. Call more than once in a
   *  single test to simulate a second window (Scenario 2/3) or a
   *  close-then-reopen (Scenario 4) - each call is a genuinely fresh
   *  createWire() closure, exactly like a real new window boot. */
  function bootWindow(route: typeof ROUTE_STABLE, invoke?: ReturnType<typeof vi.fn>) {
    window.history.replaceState({}, '', '/')
    mountChatDomFromHtml(readChatHtml())
    invokeState = { current: route }
    const invokeFn = invoke ?? makeInvokeStub(invokeState)
    ;(window as any).__TAURI__ = {
      core: { invoke: invokeFn },
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
    FakeWebSocket.reset()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    evalChatInlineScriptWithBridge()
    return invokeFn
  }

  beforeEach(() => {
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

  const bringUp = async () => {
    await settle()
    const sock = FakeWebSocket.latest()
    expect(sock, 'a socket should have been dialed').toBeTruthy()
    sock!.simulateOpen()
    sock!.simulateMessage({ type: 'hello', protocolVersion: 2, capabilities: {} })
    await settle()
    return sock!
  }

  it('Scenario 1: enabling verbose on the production route flips enabled, leaves the route untouched, and reconnects nothing', async () => {
    bootWindow(ROUTE_STABLE)
    await bringUp()
    expect(indicator().textContent).toBe('Stable Prod')

    const socketCountBefore = FakeWebSocket.instances.length
    expect(viewMode().isEnabled()).toBe(false)

    viewMode().enable()

    expect(viewMode().isEnabled()).toBe(true)
    // The ROUTE is untouched: same label, still connected - the chip's
    // TEXT does change (Step 4 renders the verbose form the instant
    // viewMode flips, via the same _paintRouteIndicator writer), which is
    // exactly the point of this step; route-indicator.test.ts's "verbose
    // form" describe block pins the exact string. Here, assert only what
    // "untouched" actually means: still the SAME route, still connected,
    // no new socket.
    expect(indicator().textContent).toContain('Stable Prod')
    expect(indicator().className).toContain('connected')
    // No reconnection occurred: not one extra socket was constructed.
    expect(FakeWebSocket.instances.length).toBe(socketCountBefore)
  })

  it('Scenario 2: verbose is per window - enabling it in window A never touches window B', async () => {
    // Window A: connect, enable verbose, capture ITS OWN ViewMode reference
    // before booting B overwrites window.ViewMode / window.__MoonInternals.
    bootWindow(ROUTE_STABLE)
    await bringUp()
    const windowAViewMode = viewMode()
    windowAViewMode.enable()
    expect(windowAViewMode.isEnabled()).toBe(true)

    // Window B: a second, independent boot - a genuinely fresh createWire()
    // closure, exactly like opening a second real window.
    bootWindow(ROUTE_STABLE)
    await bringUp()
    const windowBViewMode = viewMode()

    expect(windowBViewMode.isEnabled(), 'a fresh window must not inherit another window\'s verbose flag').toBe(false)
    expect(windowAViewMode.isEnabled(), 'window A must be unaffected by window B booting').toBe(true)
  })

  it('Scenario 3: a window opened AFTER another window went verbose is not verbose (catches read-at-boot storage implementations)', async () => {
    bootWindow(ROUTE_STABLE)
    await bringUp()
    viewMode().enable()
    expect(viewMode().isEnabled()).toBe(true)

    // A brand new window boots AFTER the above - this is the case a
    // read-at-boot localStorage implementation would fail (it would read
    // the flag window A just wrote and boot verbose too).
    bootWindow(ROUTE_STABLE)
    await bringUp()

    expect(viewMode().isEnabled()).toBe(false)
  })

  it('Scenario 4: view mode does not survive a window reopen, and never touches any storage', async () => {
    const invoke = bootWindow(ROUTE_STABLE)
    await bringUp()
    viewMode().enable()
    expect(viewMode().isEnabled()).toBe(true)

    // TEST-HYGIENE (plan-mandated): do NOT clear storage between the two
    // boots below. Neighbouring suites clear localStorage per-test in their
    // OWN beforeEach; a mid-test clear here would let a localStorage
    // implementation pass this fence by accident. bootWindow() deliberately
    // does not call localStorage.clear() either.
    bootWindow(ROUTE_STABLE, invoke)
    await bringUp()

    expect(viewMode().isEnabled(), 'reopening must not resurrect the prior window\'s verbose flag').toBe(false)

    // No view-mode key exists in ANY of the three named stores.
    const viewModeKeyPattern = /view.?mode/i
    const localStorageKeys = Object.keys(localStorage)
    expect(
      localStorageKeys.some((k) => viewModeKeyPattern.test(k)),
      `localStorage must carry no view-mode key; saw keys: ${JSON.stringify(localStorageKeys)}`,
    ).toBe(false)
    // ViewMode never calls invoke at all (enable/disable/toggle are pure JS
    // state flips) - assert no call, across BOTH boots, ever carried a
    // view-mode-shaped argument (covers client.toml/moon-session.json,
    // written only through Tauri commands).
    const viewModeInvokeCalls = invoke.mock.calls.filter(([, args]: [string, Record<string, unknown> | undefined]) =>
      args && Object.keys(args).some((k) => viewModeKeyPattern.test(k)))
    expect(viewModeInvokeCalls, 'no Tauri command was ever called with a view-mode-shaped argument').toEqual([])
  })

  it('Seam: endpointDisplay is redacted even for a deliberately credential-shaped fixture URL', async () => {
    bootWindow(ROUTE_TOKEN_BEARING)
    await bringUp()

    const seam = viewMode().seam()
    expect(seam.endpointDisplay).toBeTruthy()
    expect(seam.endpointDisplay).not.toContain('?')
    expect(seam.endpointDisplay).not.toContain('#')
    expect(seam.endpointDisplay).not.toContain('TOK-SUPER-SECRET')
    expect(seam.endpointDisplay).toContain('secure-host:4753/ui')
  })

  it('Seam: the returned object exposes no property containing the raw URL or the resolved token', async () => {
    bootWindow(ROUTE_TOKEN_BEARING)
    await bringUp()

    const seam = viewMode().seam()
    const resolvedToken = 'RESOLVED-TOK-' + ROUTE_TOKEN_BEARING.key
    for (const [key, value] of Object.entries(seam)) {
      if (typeof value !== 'string') continue
      expect(value, `seam.${key} must not contain the raw endpoint URL`).not.toContain(ROUTE_TOKEN_BEARING.url)
      expect(value, `seam.${key} must not contain '?' (the raw URL's query string)`).not.toContain('?')
      expect(value, `seam.${key} must not contain the resolved token`).not.toContain(resolvedToken)
    }
    // Enumerate the keys themselves: no raw-URL-shaped or token-shaped field
    // exists on the object AT ALL - a consumer cannot reach past redaction
    // by finding some OTHER property this test forgot to check.
    expect(Object.keys(seam).sort()).toEqual(['connectionState', 'enabled', 'endpointDisplay', 'routeLabel'])
  })

  it('Seam: toggling flips only enabled - routeLabel/connectionState/endpointDisplay are untouched', async () => {
    bootWindow(ROUTE_TOKEN_BEARING)
    await bringUp()

    const before = viewMode().seam()
    expect(before.enabled).toBe(false)

    viewMode().toggle()

    const after = viewMode().seam()
    expect(after.enabled).toBe(true)
    expect(after.routeLabel).toBe(before.routeLabel)
    expect(after.connectionState).toBe(before.connectionState)
    expect(after.endpointDisplay).toBe(before.endpointDisplay)

    // And back - toggle is a real flip, not a one-way enable.
    viewMode().toggle()
    expect(viewMode().seam().enabled).toBe(false)
  })

  it('Toggle affordance: clicking the route indicator chip toggles view mode', async () => {
    bootWindow(ROUTE_STABLE)
    await bringUp()
    expect(viewMode().isEnabled()).toBe(false)
    expect(indicator().getAttribute('role')).toBe('button')
    expect(indicator().getAttribute('tabindex')).toBe('0')

    indicator().dispatchEvent(new Event('click', { bubbles: true }))
    expect(viewMode().isEnabled()).toBe(true)

    indicator().dispatchEvent(new Event('click', { bubbles: true }))
    expect(viewMode().isEnabled()).toBe(false)
  })

  // F1 (opus review on plan Step 3): role="button" alone does not make
  // Enter/Space activate a <span> - only a real <button> synthesizes click
  // from keys, and a span never does (WCAG 2.1.1).
  it('Keyboard affordance: Enter toggles view mode', async () => {
    bootWindow(ROUTE_STABLE)
    await bringUp()
    expect(viewMode().isEnabled()).toBe(false)

    indicator().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(viewMode().isEnabled()).toBe(true)
  })

  it('Keyboard affordance: Space toggles view mode and prevents the page-scroll default', async () => {
    bootWindow(ROUTE_STABLE)
    await bringUp()
    expect(viewMode().isEnabled()).toBe(false)

    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    indicator().dispatchEvent(event)

    expect(viewMode().isEnabled()).toBe(true)
    expect(event.defaultPrevented).toBe(true)
  })
})
