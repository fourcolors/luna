// @vitest-environment jsdom
//
// Phase 2 C7 — per-panel route binding tests.
//
// Tests the three route-resolution decisions in connectWs:
//   A. Panel-specific route present → use it (wsUrl from route.endpoints[0],
//      token from load_connection); __PanelInternals.resolvedRouteKey populated.
//   B. No panel route / no client.toml (MoonSession returns null) → legacy
//      load_connection path unchanged; no error surfaced.
//   C. Route resolution succeeds but load_connection rejects (Tauri present) →
//      showNotice called with 'Panel connection failed: <reason>'.
//   D. Off-Tauri (no __TAURI__) → silent; no notice.
//
// Approach: register a minimal stub panel type that calls ctx.connectWs(…), then
// boot panel.html's inline script and flush microtasks. Assert on __PanelInternals
// and the DOM .notice element.
//
// Ported to boot frontend-react/panel.html (React 19 + Astryx edition)
// instead of frontend/panel.html: src-tauri/tauri.conf.json's frontendDist
// now points at frontend-react/dist (see vite.config.ts's doc comment), so
// frontend/panel.html is no longer what ships - this suite must exercise the
// real boot file. The ctx/connectWs waterfall under test is byte-for-byte
// identical between the two files (see panel-ctx.ts's module doc on why that
// stays vanilla - no parallel connection/transport logic to keep in sync),
// so every behavioral assertion below is unchanged from the pre-port
// suite; only the html fixture path moved. The stub panel type this suite
// registers (`stub.ws`) is never React-owned, so it always takes the
// still-vanilla bootModule() path panel.html's inline script has always had.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { FakeWebSocket } from './helpers/FakeWebSocket'

// ── File fixtures ─────────────────────────────────────────────────────────────

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend-react/panel.html'), 'utf8')

// ── Route fixtures ────────────────────────────────────────────────────────────

const ROUTE_LOCAL = {
  label: 'Local',
  key: 'local',
  endpoints: ['ws://127.0.0.1:4753/ui'],
  token_ref: 'env:LUNA_WS_TOKEN',
  transport: 'websocket',
}

// Step 2 (route indicator) fixture: label deliberately, obviously distinct
// from key (the fixture trap) - a key-rendering implementation shows
// 'canary-route', a label-rendering one shows 'Canary Backup'.
const ROUTE_CANARY = {
  label: 'Canary Backup',
  key: 'canary-route',
  endpoints: ['ws://canary-host:4753/ui'],
  token_ref: 'env:LUNA_WS_TOKEN',
  transport: 'websocket',
}

// ── Boot harness ──────────────────────────────────────────────────────────────

/**
 * Boot panel.html's inline script with a minimal stub panel that calls
 * ctx.connectWs() on render, so we can observe the route-resolution path.
 *
 * @param opts.invoke   Tauri invoke stub. Pass null to skip Tauri entirely.
 * @param opts.moonSession  Override for window.MoonSession after vendors load.
 * @param opts.onVendorsLoaded  Called after vendor scripts load but before the
 *   inline script runs — use to spy on window.LunaWS.createClient.
 */
function bootPanel(opts: {
  type?: string
  invoke?: ((cmd: string, args?: any) => any) | null
  moonSession?: {
    resolveBootRoute?: (panelId: string | null) => Promise<any>
    setPanelRoute?: (panelId: string, routeKey: string) => Promise<boolean>
    listRoutes?: () => Promise<any>
    setDefaultRoute?: (routeKey: string) => Promise<boolean>
  } | null
  onVendorsLoaded?: () => void
}) {
  const type = opts.type || 'stub.ws'
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  // Install Tauri mock (or leave __TAURI__ absent for off-Tauri tests)
  const invoke = opts.invoke !== null && opts.invoke !== undefined
    ? vi.fn(async (cmd: string, args?: any) => opts.invoke!(cmd, args))
    : null

  // Window-targeted event handlers captured from getCurrentWindow().listen -
  // Step 1c Part 2's hub-event listener (mirrors chat-window.test.ts's
  // windowEventHandlers pattern) so a test can drive it directly.
  const windowEventHandlers: Record<string, (e: { payload: any }) => void> = {}
  const me = {
    label: 'panel-' + type.replace(/\./g, '-'),
    listen: vi.fn(async (name: string, cb: (e: { payload: any }) => void) => {
      windowEventHandlers[name] = cb
      return () => {}
    }),
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 360, height: 400 })),
    scaleFactor: vi.fn(async () => 1),
  }

  if (invoke !== null) {
    ;(window as any).__TAURI__ = {
      window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
      core: { invoke },
      event: { listen: vi.fn(async () => () => {}) },
    }
  }

  // Set location so params parse correctly
  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(type))

  // Load vendor modules (moon-session.js is now loaded by the <script src> tag
  // in panel.html — we load it here manually since jsdom doesn't fetch scripts).
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')   // sets window.LunaWS with real impl
  loadVendorInto(window, 'moon-dock.js')
  loadVendorInto(window, 'moon-session.js')

  // Hook: spy on LunaWS.createClient AFTER vendors loaded but BEFORE inline runs.
  // Tests that need to intercept connect() calls do so here.
  if (opts.onVendorsLoaded) opts.onVendorsLoaded()

  // Override MoonSession if requested (must be done BEFORE the inline script runs)
  if (opts.moonSession !== undefined) {
    if (opts.moonSession === null) {
      delete (window as any).MoonSession
    } else {
      ;(window as any).MoonSession = {
        resolveBootRoute: vi.fn(async () => null),
        setPanelRoute: vi.fn(async () => false),
        listRoutes: vi.fn(async () => null),
        setDefaultRoute: vi.fn(async () => false),
        ...opts.moonSession,
      }
    }
  }

  // Register a stub panel type that calls ctx.connectWs() when rendered.
  ;(window as any).LunaPanelTypes = {
    [type]: {
      title: 'Stub WS Panel',
      render: function (_area: any, ctx: any) {
        // Store the client reference for inspection; ignore registry shape.
        ;(window as any).__stubClient = ctx.connectWs({})
      },
    },
  }

  // Execute the inline script (the one that contains LunaPanelTypes check)
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  return { invoke, windowEventHandlers }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as any).__TAURI__
  delete (window as any).__PanelInternals
  delete (window as any).__stubClient
  delete (window as any).LunaPanelTypes
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).LunaDock
  delete (window as any).MoonSession
  vi.restoreAllMocks()
})

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('C7 — panel route binding', () => {

  // ── A: panel-specific route → use endpoints[0] as wsUrl ──────────────────

  it('A: panel route present → connects with route endpoint, token from resolve_route_token (Step 1c Part 1 inversion)', async () => {
    let connectSpy = vi.fn()
    let resolveTokenArgs: any = null

    // INVERSION (plan Step 1c): this used to pin the URL/token split -
    // route's endpoint but a panel-id-BLIND load_connection token, always
    // keyed off cfg.default. load_connection's stub below returns a
    // DELIBERATELY DIFFERENT token from resolve_route_token's, so an
    // implementation that still reads load_connection on this branch fails
    // the assertion below instead of coincidentally passing.
    bootPanel({
      invoke: (cmd, args) => {
        if (cmd === 'load_connection') return { wsUrl: 'ws://legacy:4753/ui', wsToken: 'legacy-tok' }
        if (cmd === 'resolve_route_token') {
          resolveTokenArgs = args
          return 'RESOLVED-FOR-LOCAL'
        }
        return null
      },
      moonSession: {
        resolveBootRoute: async () => ROUTE_LOCAL,
      },
      // Spy on LunaWS.createClient AFTER vendors load so the spy survives
      // the loadVendorInto(window, 'moon-ws.js') call inside bootPanel.
      onVendorsLoaded: () => {
        connectSpy = vi.fn()
        ;(window as any).LunaWS = { createClient: () => ({ connect: connectSpy }) }
      },
    })

    await flush()

    // Must use the route's endpoint AND the token resolve_route_token
    // resolved for THIS route key - not load_connection's.
    expect(connectSpy).toHaveBeenCalledWith('ws://127.0.0.1:4753/ui', 'RESOLVED-FOR-LOCAL')
    expect(resolveTokenArgs).toEqual({ routeKey: 'local' })
    // resolvedRouteKey must be populated on __PanelInternals
    expect((window as any).__PanelInternals.resolvedRouteKey).toBe('local')
    // No error notice
    expect(document.querySelector('.notice')).toBeNull()
  })

  it('A: resolveBootRoute receives the window label as panelId', async () => {
    const resolveBootRoute = vi.fn(async () => null)
    bootPanel({
      invoke: () => null,
      moonSession: { resolveBootRoute },
      onVendorsLoaded: () => {
        ;(window as any).LunaWS = { createClient: () => ({ connect: vi.fn() }) }
      },
    })

    await flush()

    // The window label in the test harness is 'panel-stub-ws'
    expect(resolveBootRoute).toHaveBeenCalledWith('panel-stub-ws')
  })

  // ── B: no client.toml / MoonSession returns null → legacy path unchanged ──

  it('B: no client.toml (MoonSession returns null) → legacy load_connection path', async () => {
    let connectSpy = vi.fn()

    bootPanel({
      invoke: (cmd) => {
        if (cmd === 'load_connection') return { wsUrl: 'ws://legacy:4753/ui', wsToken: 'tok' }
        return null
      },
      moonSession: {
        resolveBootRoute: async () => null,  // no client.toml / un-migrated
      },
      // Spy AFTER vendors load so the spy survives the moon-ws.js overwrite.
      onVendorsLoaded: () => {
        connectSpy = vi.fn()
        ;(window as any).LunaWS = { createClient: () => ({ connect: connectSpy }) }
      },
    })

    await flush()

    // Must fall through to the legacy URL
    expect(connectSpy).toHaveBeenCalledWith('ws://legacy:4753/ui', 'tok')
    // resolvedRouteKey stays null (legacy path)
    expect((window as any).__PanelInternals.resolvedRouteKey).toBeNull()
    // No error notice
    expect(document.querySelector('.notice')).toBeNull()
  })

  // ── C: route resolved but resolve_route_token rejects → surface error ─────
  // Step 1c Part 1/3b: every notice below is a FIXED reason, never e.message
  // or the raw exception - see docs/next/routes-and-view-mode-plan.md, "The
  // security invariant, which is not deferrable".

  it('C: route resolved but resolve_route_token rejects "not-paired:" → fixed reason naming the route, no socket, no token anywhere in the DOM', async () => {
    let connectSpy = vi.fn()
    bootPanel({
      invoke: (cmd) => {
        if (cmd === 'resolve_route_token') {
          throw new Error('not-paired: route "local" has no token paired in moon-connection.json')
        }
        return null
      },
      moonSession: {
        resolveBootRoute: async () => ROUTE_LOCAL,
      },
      onVendorsLoaded: () => {
        connectSpy = vi.fn()
        ;(window as any).LunaWS = { createClient: () => ({ connect: connectSpy }) }
      },
    })

    await flush()

    // Refused durably - no socket attempt at all.
    expect(connectSpy).not.toHaveBeenCalled()
    const notice = document.querySelector('.notice')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('Panel connection failed:')
    expect(notice!.textContent).toContain('local') // names the route
    // e.message is NEVER rendered raw - the fixed reason replaces it.
    expect(notice!.textContent).not.toContain('has no token paired')
    // No token (or a URL carrying one) anywhere in the rendered DOM.
    expect(document.body.textContent).not.toContain('token=')
    expect((window as any).__PanelInternals.lastNotice).toContain('local')
  })

  it('C: route resolved but resolve_route_token rejects with a non-not-paired reason → fixed reason + describeWsUrl(endpoint), e.message never rendered', async () => {
    bootPanel({
      invoke: (cmd) => {
        if (cmd === 'resolve_route_token') {
          throw new Error('store-read: moon-connection.json not found or unreadable')
        }
        return null
      },
      moonSession: {
        resolveBootRoute: async () => ROUTE_LOCAL,
      },
      onVendorsLoaded: () => {
        ;(window as any).LunaWS = { createClient: () => ({ connect: vi.fn() }) }
      },
    })

    await flush()

    const notice = document.querySelector('.notice')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('Panel connection failed:')
    // e.message is NEVER rendered raw.
    expect(notice!.textContent).not.toContain('moon-connection.json not found or unreadable')
    // describeWsUrl(endpoint) - a url adds value here (which endpoint failed).
    expect(notice!.textContent).toContain('ws://127.0.0.1:4753/ui')
  })

  it('C: legacy load_connection rejects with Tauri present → fixed reason, e.message never rendered', async () => {
    bootPanel({
      invoke: (cmd) => {
        if (cmd === 'load_connection') throw new Error('not configured')
        return null
      },
      moonSession: {
        resolveBootRoute: async () => null,  // no route → legacy path
      },
      onVendorsLoaded: () => {
        ;(window as any).LunaWS = { createClient: () => ({ connect: vi.fn() }) }
      },
    })

    await flush()

    const notice = document.querySelector('.notice')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('Panel connection failed:')
    // e.message is NEVER rendered raw - no url is in scope on this branch
    // either (load_connection itself rejected, so there is no creds.wsUrl).
    expect(notice!.textContent).not.toContain('not configured')
  })

  // ── D: off-Tauri (no __TAURI__) → silent, no notice ─────────────────────

  it('D: off-Tauri → connectWs is a no-op (no connect called, no notice)', async () => {
    let connectSpy = vi.fn()

    // No invoke (Tauri absent) — MoonSession.resolveBootRoute returns null
    // because __TAURI__ is absent (the real moon-session.js degrades).
    bootPanel({
      invoke: null,  // no __TAURI__ installed
      // Spy AFTER vendors load — with no Tauri, connect should never be called.
      onVendorsLoaded: () => {
        connectSpy = vi.fn()
        ;(window as any).LunaWS = { createClient: () => ({ connect: connectSpy }) }
      },
    })

    await flush()

    // connect must not have been called (no URL to connect to off-Tauri)
    expect(connectSpy).not.toHaveBeenCalled()
    // No error notice surfaced
    expect(document.querySelector('.notice')).toBeNull()
  })

  // ── E: child/settings panels without explicit route → default (documented C8) ──

  it('E: child panel with no explicit route binding uses default (C8 follow-up documented), token from resolve_route_token', async () => {
    let connectSpy = vi.fn()

    // A child panel is just another panel window — same code path. Without a
    // set_panel_route call for this panelId, resolveBootRoute falls back to the
    // default route. Here MoonSession returns the default route directly.
    // load_connection's stub returns a DIFFERENT token from resolve_route_token's
    // (same inversion rationale as test A) so a wrong-source implementation fails.
    bootPanel({
      invoke: (cmd, args) => {
        if (cmd === 'load_connection') return { wsUrl: 'ws://legacy/ui', wsToken: 'child-tok' }
        if (cmd === 'resolve_route_token' && args?.routeKey === 'default') return 'RESOLVED-FOR-DEFAULT'
        return null
      },
      moonSession: {
        resolveBootRoute: async () => ({
          ...ROUTE_LOCAL,
          key: 'default',
          endpoints: ['ws://default.host/ui'],
        }),
      },
      // Spy AFTER vendors load so the spy survives the moon-ws.js overwrite.
      onVendorsLoaded: () => {
        connectSpy = vi.fn()
        ;(window as any).LunaWS = { createClient: () => ({ connect: connectSpy }) }
      },
    })

    await flush()

    // Child uses the default route endpoint and its resolved token (not the
    // legacy URL, not load_connection's token).
    expect(connectSpy).toHaveBeenCalledWith('ws://default.host/ui', 'RESOLVED-FOR-DEFAULT')
    expect((window as any).__PanelInternals.resolvedRouteKey).toBe('default')
  })

})

// ── Step 1c Part 2: hub_event fan-out reaches non-chat panels ────────────────
// Rust now fans profile-changed/connection-changed out to every open window
// (windows.rs's hub_event_targets), not just main+panel-chat. Chat windows
// already reacted via wiring.ts's guarded listener; this is the previously-
// missing half - a non-chat panel (this suite's stub.ws type) must react the
// same way: tear the existing socket down and re-run the connect waterfall.
describe('Step 1c Part 2 — non-chat panel hub-event listener', () => {
  beforeEach(() => {
    FakeWebSocket.reset()
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('profile-changed addressed to THIS window tears the old socket down and reconnects with a freshly-resolved token', async () => {
    let resolveTokenCallCount = 0

    // Deliberately do NOT override LunaWS.createClient here - the REAL
    // vendor implementation is what actually tears the old socket down
    // (moon-ws.js's connect() calls the prior ws.close() internally), so
    // this fence drives the real client against FakeWebSocket to observe it.
    const { windowEventHandlers } = bootPanel({
      invoke: (cmd) => {
        if (cmd === 'resolve_route_token') {
          resolveTokenCallCount++
          return resolveTokenCallCount === 1 ? 'FIRST-TOKEN' : 'SECOND-TOKEN'
        }
        return null
      },
      moonSession: {
        resolveBootRoute: async () => ROUTE_LOCAL,
      },
    })

    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)
    const firstSocket = FakeWebSocket.instances[0]!
    expect(firstSocket.url).toContain('token=FIRST-TOKEN')

    expect(windowEventHandlers['hub-event']).toBeTypeOf('function')
    windowEventHandlers['hub-event']({ payload: { for: 'panel-stub-ws', name: 'profile-changed' } })
    await flush()

    // The OLD socket was torn down cleanly (moon-ws.js's own connect()
    // teardown)...
    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED)
    // ...and exactly ONE new socket was dialed, with the freshly-resolved
    // token - not a cached one.
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1]!.url).toContain('token=SECOND-TOKEN')
  })

  it('connection-changed addressed to THIS window also reconnects (not just profile-changed)', async () => {
    let resolveTokenCallCount = 0
    const { windowEventHandlers } = bootPanel({
      invoke: (cmd) => {
        if (cmd === 'resolve_route_token') {
          resolveTokenCallCount++
          return resolveTokenCallCount === 1 ? 'FIRST-TOKEN' : 'SECOND-TOKEN'
        }
        return null
      },
      moonSession: { resolveBootRoute: async () => ROUTE_LOCAL },
    })
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)

    windowEventHandlers['hub-event']({ payload: { for: 'panel-stub-ws', name: 'connection-changed' } })
    await flush()

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1]!.url).toContain('token=SECOND-TOKEN')
  })

  it('hub-events addressed to OTHER windows are ignored (for-discipline)', async () => {
    const { windowEventHandlers } = bootPanel({
      invoke: (cmd) => (cmd === 'resolve_route_token' ? 'TOK' : null),
      moonSession: { resolveBootRoute: async () => ROUTE_LOCAL },
    })
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)

    windowEventHandlers['hub-event']({ payload: { for: 'some-other-window', name: 'profile-changed' } })
    await flush()

    expect(FakeWebSocket.instances).toHaveLength(1) // unchanged - not addressed to this window
  })

  it('an unrelated hub-event name (fresh-thread) addressed to this window is ignored (only profile-changed/connection-changed reconnect)', async () => {
    const { windowEventHandlers } = bootPanel({
      invoke: (cmd) => (cmd === 'resolve_route_token' ? 'TOK' : null),
      moonSession: { resolveBootRoute: async () => ROUTE_LOCAL },
    })
    await flush()
    expect(FakeWebSocket.instances).toHaveLength(1)

    windowEventHandlers['hub-event']({ payload: { for: 'panel-stub-ws', name: 'fresh-thread' } })
    await flush()

    expect(FakeWebSocket.instances).toHaveLength(1) // fresh-thread is chat-owned, not a panel concern
  })

  // ── F1 (opus review, blocker): the waterfall generation guard ────────────
  // moon-ws's own socket-level gen protects the SOCKET, not the WATERFALL.
  // Settings fires connection-changed on every save, and the hub-event
  // listener re-runs the waterfall on every one - two overlapping runs race
  // their two awaits (resolveBootRoute, resolve_route_token). Without a
  // waterfall-level guard, the OLDER run's invokes resolving LAST wins,
  // because ITS client.connect() call is what bumps moon-ws's gen when it
  // finally fires - the socket layer cannot protect against that.
  it('F1: an OLDER waterfall run whose resolve_route_token resolves LAST must never win over a newer, already-completed run', async () => {
    let resolveTokenCallCount = 0
    let releaseA: ((token: string) => void) | null = null

    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'resolve_route_token') {
        resolveTokenCallCount++
        if (resolveTokenCallCount === 1) {
          // Waterfall A (the initial boot-time run) - gated until the test
          // explicitly releases it, simulating it resolving LAST.
          return new Promise<string>((resolve) => {
            releaseA = resolve
          })
        }
        return 'TOKEN-B'
      }
      return null
    })

    const { windowEventHandlers } = bootPanel({
      invoke,
      moonSession: { resolveBootRoute: async () => ROUTE_LOCAL },
    })

    // Waterfall A started automatically inside bootPanel (connectWs() runs
    // the waterfall once at construction); its resolve_route_token call is
    // now gated on releaseA, mid-flight.
    await flush()
    expect(resolveTokenCallCount).toBe(1)
    expect(FakeWebSocket.instances).toHaveLength(0)

    // Fire the hub-event to start waterfall B WHILE A is still pending -
    // the exact overlap Settings' every-save connection-changed produces.
    expect(windowEventHandlers['hub-event']).toBeTypeOf('function')
    windowEventHandlers['hub-event']({ payload: { for: 'panel-stub-ws', name: 'profile-changed' } })
    await flush()
    await flush()

    // B completed FULLY before A does: exactly one socket, B's token.
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.url).toContain('token=TOKEN-B')

    // NOW release A - the OLDER run's invoke resolves LAST.
    expect(releaseA).toBeTypeOf('function')
    releaseA!('TOKEN-A')
    await flush()
    await flush()

    // A must never have dialed: still exactly one socket, still B's token -
    // never a second, stale connect() call landing the panel back on A.
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.url).toContain('token=TOKEN-B')
    expect(FakeWebSocket.instances.some((s) => s.url.includes('token=TOKEN-A'))).toBe(false)
  })
})

// ── Step 2: the route indicator, panel surface ────────────────────────────
// SOURCE OF TRUTH: this panel window's OWN socket, via onOpen/onClose (raw
// socket state - panels have no hello-frame handshake to gate on, the same
// signal the Workflows panel's own liveness hint already uses). FIXTURE
// TRAP: ROUTE_LOCAL/ROUTE_CANARY's labels are obviously distinct from their
// keys - a key-rendering implementation fails every assertion below red.
describe('Step 2 — route indicator (panel surface)', () => {
  beforeEach(() => {
    FakeWebSocket.reset()
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const indicator = () => document.getElementById('route-indicator')!

  it('Scenario 1: the panel names the route its socket is on', async () => {
    bootPanel({
      invoke: (cmd) => (cmd === 'resolve_route_token' ? 'TOK' : null),
      moonSession: { resolveBootRoute: async () => ROUTE_LOCAL },
    })
    await flush()
    const sock = FakeWebSocket.latest()!
    sock.simulateOpen()
    await flush()

    expect(indicator().hidden).toBe(false)
    expect(indicator().textContent).toBe('Local')
    expect(indicator().className).toContain('connected')
    expect(sock.url.startsWith(ROUTE_LOCAL.endpoints[0])).toBe(true)
  })

  it('Scenario 2: the indicator follows a route switch', async () => {
    let currentRoute: typeof ROUTE_LOCAL = ROUTE_LOCAL
    const { windowEventHandlers } = bootPanel({
      invoke: (cmd) => (cmd === 'resolve_route_token' ? 'TOK' : null),
      moonSession: { resolveBootRoute: async () => currentRoute },
    })
    await flush()
    FakeWebSocket.latest()!.simulateOpen()
    await flush()
    expect(indicator().textContent).toBe('Local')

    currentRoute = ROUTE_CANARY
    windowEventHandlers['hub-event']({ payload: { for: 'panel-stub-ws', name: 'profile-changed' } })
    await flush()
    const sock2 = FakeWebSocket.latest()!
    sock2.simulateOpen()
    await flush()

    expect(indicator().textContent).toBe('Canary Backup')
    expect(indicator().className).toContain('connected')
    expect(sock2.url.startsWith(ROUTE_CANARY.endpoints[0])).toBe(true)
  })

  it('Scenario 3 / latch: a disconnected panel still names its route, and only a genuine reconnect clears the failure', async () => {
    const { windowEventHandlers } = bootPanel({
      invoke: (cmd) => (cmd === 'resolve_route_token' ? 'TOK' : null),
      moonSession: { resolveBootRoute: async () => ROUTE_CANARY },
    })
    await flush()
    const sock = FakeWebSocket.latest()!
    sock.simulateOpen()
    await flush()
    expect(indicator().textContent).toBe('Canary Backup')
    expect(indicator().className).toContain('connected')

    sock.simulateDrop()
    await flush()

    // Present, not vanished - and marked disconnected.
    expect(indicator().hidden).toBe(false)
    expect(indicator().textContent).toBe('Canary Backup')
    expect(indicator().className).toContain('disconnected')

    // A genuine reconnect of THIS panel's socket - the only thing that may
    // clear the failure. Drives the same path the hub-event listener would.
    windowEventHandlers['hub-event']({ payload: { for: 'panel-stub-ws', name: 'profile-changed' } })
    await flush()
    const sock2 = FakeWebSocket.latest()!
    expect(sock2).not.toBe(sock)
    sock2.simulateOpen()
    await flush()

    expect(indicator().textContent).toBe('Canary Backup')
    expect(indicator().className).toContain('connected')
  })

  it('Scenario 5: switching to a route whose endpoint never accepts a connection shows the NEW label before any connection succeeds', async () => {
    let currentRoute: typeof ROUTE_LOCAL = ROUTE_LOCAL
    const { windowEventHandlers } = bootPanel({
      invoke: (cmd) => (cmd === 'resolve_route_token' ? 'TOK' : null),
      moonSession: { resolveBootRoute: async () => currentRoute },
    })
    await flush()
    FakeWebSocket.latest()!.simulateOpen()
    await flush()
    expect(indicator().textContent).toBe('Local')

    currentRoute = ROUTE_CANARY
    windowEventHandlers['hub-event']({ payload: { for: 'panel-stub-ws', name: 'profile-changed' } })
    await flush()

    // The load-bearing clause: BEFORE simulateOpen on the new socket, the
    // indicator already reads the NEW label and is marked disconnected.
    expect(indicator().textContent).toBe('Canary Backup')
    expect(indicator().className).toContain('disconnected')
  })

  // ── F1 (opus review, blocker): the ordering bug the skipped test would
  // have caught. panel.html used to paint the NEW route's label BEFORE
  // resolve_route_token even ran, and its refusal .catch neither repainted
  // nor called client.connect() (the ONLY thing that tears a prior socket
  // down in moon-ws.js) - so a refused re-resolution left the panel
  // GENUINELY still connected to the OLD route while the chip claimed the
  // NEW route, disconnected. Wrong name AND wrong state, and permanent
  // (paintRouteIndicator's currentRouteLabel capture means the OLD socket's
  // eventual onClose would even repaint using the wrong label).
  it('Scenario 4: a re-resolution whose token is refused leaves the OLD socket open and the chip still naming the OLD route - never the failed attempt', async () => {
    const ROUTE_ALPHA = {
      label: 'Alpha Prod',
      key: 'alpha-route',
      endpoints: ['ws://alpha-host:4753/ui'],
      token_ref: 'env:LUNA_WS_TOKEN',
      transport: 'websocket',
    }
    const ROUTE_BETA = {
      label: 'Beta Test',
      key: 'beta-route',
      endpoints: ['ws://beta-host:4753/ui'],
      token_ref: 'env:LUNA_WS_TOKEN',
      transport: 'websocket',
    }

    let currentRoute: typeof ROUTE_ALPHA = ROUTE_ALPHA
    let tokenRejectsForBeta = false
    const { windowEventHandlers } = bootPanel({
      invoke: (cmd, args) => {
        if (cmd === 'resolve_route_token') {
          if (tokenRejectsForBeta && args?.routeKey === ROUTE_BETA.key) {
            throw new Error('not-paired: route "' + ROUTE_BETA.key + '" has no token paired in moon-connection.json')
          }
          return 'TOK'
        }
        return null
      },
      moonSession: { resolveBootRoute: async () => currentRoute },
    })
    await flush()
    const sockA = FakeWebSocket.latest()!
    sockA.simulateOpen()
    await flush()
    expect(indicator().textContent).toBe('Alpha Prod')
    expect(indicator().className).toContain('connected')

    // Re-resolve to Beta, but its token resolution is REFUSED (not-paired).
    currentRoute = ROUTE_BETA
    tokenRejectsForBeta = true
    windowEventHandlers['hub-event']({ payload: { for: 'panel-stub-ws', name: 'profile-changed' } })
    await flush()

    // The A socket is STILL OPEN - client.connect() was never called for
    // the refused Beta attempt, so no teardown ever ran and no second
    // socket was ever dialed.
    expect(sockA.readyState).toBe(FakeWebSocket.OPEN)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(indicator().textContent).toBe('Alpha Prod')
    expect(indicator().className).toContain('connected')
    expect(document.body.textContent).not.toContain('Beta Test')
  })
})
