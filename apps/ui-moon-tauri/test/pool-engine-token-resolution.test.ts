// @vitest-environment jsdom
/**
 * pool-engine-token-resolution.test.ts - regression fence for issue #528,
 * extended for Step 1b (docs/next/routes-and-view-mode-plan.md, closes #529).
 *
 * PoolEngine is the default chat engine (wire.ts's USE_POOL_ENGINE). Its
 * connect() resolves the boot route via MoonSession.resolveBootRoute(null)
 * and used to take bootRoute.token_ref VERBATIM as the bearer. For migrated
 * users, client.toml routes carry token_ref = "legacy" (the migration
 * sentinel written by client_config.rs / read back by connection.rs), so the
 * adapter (LunaWsAdapter#resolveToken) dialed ?token=legacy literally.
 *
 * Step 1b retires the 1b0 stand-in that substituted State.wsToken for the
 * sentinel (only correct because connect() always resolves panelId=null,
 * the same route State.wsToken happened to be resolved for - wrong the
 * moment a real panelId is passed). Token resolution now happens in ONE
 * place: connection.rs's resolve_route_token, keyed by the route actually
 * being connected, invoked directly as `resolve_route_token`. Its error
 * taxonomy's stable prefixes decide the refusal shape here:
 *   - "store-read:" is RETRYABLE (client.toml/moon-connection.json could not
 *     be read THIS attempt) - PoolEngine schedules its existing top-level
 *     backoff instead of a terminal refusal, and the NEXT connect() attempt
 *     re-resolves fresh and can recover. This is the #529 fix: a transient
 *     read failure used to look identical to a permanent one.
 *   - every other cause (route-missing, not-paired, unresolvable-scheme,
 *     route-config-invalid) is a durable refusal - see the honest-teardown
 *     test below, unchanged in spirit from the #528 fix.
 *
 * A refusal that arrives while an OLDER connection is still live must tear
 * that connection down rather than leave a zombie half connection: send()
 * gates on `this._adapter && this._isConnected`, so leaving either set after
 * a refused reconnect would let a typed message still go out over the stale
 * adapter while the reply came back on a superseded gen and got silently
 * dropped by the frame-dispatch gate, hanging the turn at "thinking" under a
 * "disconnected" pill.
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

// Constructed, not literal: CI's secret scan (HARD GATE) bans 40-hex source
// literals, and a realistic-length fixture token IS one. Runtime value is
// 'real-resolved-token-' + 48 hex chars, same shape as before.
const REAL_TOKEN = 'real-resolved-token-' + '0123456789abcdef'.repeat(3)

/** Scripted __TAURI__.core.invoke covering the boot-time command sequence:
 *  migrate_legacy_connection (loadConnectionAndConnect's Step 0), load_connection
 *  (also loadConnectionAndConnect), get_panel_route / list_routes / load_route
 *  (MoonSession.resolveBootRoute, called from inside PoolEngine.connect()),
 *  and resolve_route_token (Step 1b - the SOLE source of the dialed token;
 *  load_route's own token_ref field is inert for PoolEngine post-Step-1b,
 *  kept "legacy" here only for structural parity with real Rust output). */
function makeInvokeStub(opts: {
  loadConnection: unknown
  /**
   * A resolved literal token (success), or `{ err }` to simulate
   * resolve_route_token rejecting with that message (its prefix decides
   * the refusal class - see the module doc). `bare: true` rejects with the
   * BARE STRING itself (F4, opus review) rather than an `Error` wrapper -
   * real Tauri `Err(String)` rejections surface as a plain string, not an
   * `Error` instance, and `e instanceof Error ? e.message : String(e)`
   * must handle both shapes identically.
   */
  resolveToken: string | { err: string; bare?: boolean }
}) {
  return vi.fn(async (cmd: string, _args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'migrate_legacy_connection':
        return null
      case 'load_connection':
        return opts.loadConnection
      case 'get_panel_route':
        return null
      case 'list_routes':
        return { default: 'stable', routes: [{ key: 'stable', label: 'stable' }] }
      case 'load_route':
        return {
          key: 'stable',
          label: 'stable',
          endpoints: ['ws://migrated.host:4753/ui'],
          token_ref: 'legacy',
          transport: 'luna-ws',
        }
      case 'resolve_route_token':
        if (typeof opts.resolveToken === 'string') return opts.resolveToken
        if (opts.resolveToken.bare) throw opts.resolveToken.err // eslint-disable-line no-throw-literal
        throw new Error(opts.resolveToken.err)
      default:
        return null
    }
  })
}

describe('PoolEngine token resolution against a migrated route (#528, #529)', () => {
  const internals = () => (window as any).__MoonInternals
  const pool = () => internals().PoolEngine

  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    mountChatDomFromHtml(readChatHtml())
    ;(window as any).__TAURI__ = {
      core: { invoke: vi.fn(async () => null) }, // overridden per-test below
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
    // Deliberately NOT setting luna_pool_engine: PoolEngine is now the true
    // default engine (USE_POOL_ENGINE), and this fence must exercise that
    // real default path, not an opt-in flag.
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

  it('a migrated route dials the token resolve_route_token resolved, never the sentinel', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: REAL_TOKEN,
    })
    evalChatInlineScriptWithBridge()
    await settle()

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1)
    const urls = FakeWebSocket.instances.map((s) => s.url)
    expect(urls.some((u) => u.includes('token=legacy')), `saw: ${JSON.stringify(urls)}`).toBe(false)
    expect(
      urls.some((u) => u.includes('token=' + REAL_TOKEN)),
      `saw: ${JSON.stringify(urls)}`,
    ).toBe(true)
  })

  it('an unpaired route (resolve_route_token rejects "not-paired:") refuses to dial', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: { err: 'not-paired: route "stable" has no token paired in moon-connection.json' },
    })
    evalChatInlineScriptWithBridge()
    await settle()

    const urls = FakeWebSocket.instances.map((s) => s.url)
    expect(urls.some((u) => u.includes('token=legacy')), `saw: ${JSON.stringify(urls)}`).toBe(false)
    expect(FakeWebSocket.instances.length, `saw: ${JSON.stringify(urls)}`).toBe(0)
    expect(pool().isConnected()).toBe(false)
    const pill = document.getElementById('connection-status')!
    expect(pill.className).toBe('disconnected')
    expect(pill.textContent).toBe('Route not paired')
  })

  it('#F4: a BARE STRING rejection (real Tauri Err(String) shape, not an Error wrapper) still routes to the not-paired branch', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: { err: 'not-paired: route "stable" has no token paired in moon-connection.json', bare: true },
    })
    evalChatInlineScriptWithBridge()
    await settle()

    expect(FakeWebSocket.instances.length).toBe(0)
    expect(pool().isConnected()).toBe(false)
    const pill = document.getElementById('connection-status')!
    expect(pill.className).toBe('disconnected')
    expect(pill.textContent).toBe('Route not paired')
  })

  it('a real literal token resolve_route_token returns passes through unchanged', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: 'literal-token-abc123',
    })
    evalChatInlineScriptWithBridge()
    await settle()

    const urls = FakeWebSocket.instances.map((s) => s.url)
    expect(urls.some((u) => u.includes('token=literal-token-abc123')), `saw: ${JSON.stringify(urls)}`).toBe(true)
    expect(urls.some((u) => u.includes('token=legacy')), `saw: ${JSON.stringify(urls)}`).toBe(false)
  })

  it('a non-retryable, non-pairing refusal (e.g. route-missing) surfaces a generic status, not "Route not paired"', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: { err: 'route-missing: no route named "stable"' },
    })
    evalChatInlineScriptWithBridge()
    await settle()

    expect(FakeWebSocket.instances.length).toBe(0)
    expect(pool().isConnected()).toBe(false)
    const pill = document.getElementById('connection-status')!
    expect(pill.className).toBe('disconnected')
    expect(pill.textContent).toBe('Route unavailable')
    expect(pill.textContent).not.toBe('Route not paired')
  })

  it('#529: a "store-read:" failure schedules an automatic retry, and the NEXT attempt can recover', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: { err: 'store-read: client.toml not found under /tmp/.luna' },
    })
    evalChatInlineScriptWithBridge()
    await settle()

    // First attempt: refused, but as a RETRYABLE condition - "connecting",
    // not the terminal "disconnected" the durable refusal classes show.
    expect(FakeWebSocket.instances.length, 'a store-read failure must not dial').toBe(0)
    expect(pool().isConnected()).toBe(false)
    const pill = document.getElementById('connection-status')!
    expect(pill.className, 'a retryable failure is NOT the terminal disconnected state').toBe('connecting')
    expect(pill.textContent).toBe('Reconnecting…')

    // The store becomes readable before the scheduled retry fires - this is
    // the #529 headline: the OLD code had no such recovery path at all,
    // because it never distinguished transient from durable failures.
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: REAL_TOKEN,
    })

    // _scheduleRetry's first delay is 1000ms * 2^0 - advance well past it.
    await vi.advanceTimersByTimeAsync(1100)
    await settle()

    expect(
      FakeWebSocket.instances.length,
      'the scheduled retry must actually re-invoke connect(), which re-resolves fresh',
    ).toBeGreaterThanOrEqual(1)
    const urls = FakeWebSocket.instances.map((s) => s.url)
    expect(urls.some((u) => u.includes('token=' + REAL_TOKEN)), `saw: ${JSON.stringify(urls)}`).toBe(true)
  })

  it('#F5: a pending top-level retry from a prior failed attempt is cleared by a fresh connect(), so it never fires a stale reconnect afterward', async () => {
    // First attempt: a transient store-read failure schedules a top-level
    // retry (same setup as the #529 test above).
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: { err: 'store-read: client.toml not found under /tmp/.luna' },
    })
    evalChatInlineScriptWithBridge()
    await settle()

    expect(FakeWebSocket.instances.length, 'a store-read failure must not dial').toBe(0)
    expect(pool()._retryTimer, 'the failed attempt must have scheduled a retry').not.toBeNull()

    // Before that retry fires, simulate the exact production scenario: the
    // user pairs the route in Settings, firing hub_event('profile-changed')
    // -> loadConnectionAndConnect() -> connect() (that listener isn't exposed
    // to tests - see the identical comment on the F2 test above - so calling
    // connect() directly reaches the same guard with the same inputs a real
    // re-pair produces).
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: REAL_TOKEN,
    })
    void pool().connect()
    await settle()

    expect(
      pool()._retryTimer,
      'F5: connect() must clear a retry timer inherited from the prior failed attempt',
    ).toBeNull()

    const postPairSocket = FakeWebSocket.latest()
    expect(postPairSocket, 'the user-driven reconnect must have dialed a fresh socket').toBeTruthy()
    postPairSocket!.simulateOpen()
    postPairSocket!.simulateMessage({ type: 'hello', protocolVersion: 2, capabilities: {} })
    await settle()

    expect(pool().isConnected(), 'the user-driven reconnect must succeed').toBe(true)
    const postPairSocketCount = FakeWebSocket.instances.length
    const postPairConnectedSocket = FakeWebSocket.latest()

    // Advance well past when the OLD retry (scheduled by the first, failed
    // attempt) would have fired. Without the F5 fix, this fires a second,
    // stale connect() that tears down the connection the user's pairing just
    // established.
    await vi.advanceTimersByTimeAsync(1100)
    await settle()

    expect(
      FakeWebSocket.instances.length,
      'the stale retry must never fire a second, superseding connect()',
    ).toBe(postPairSocketCount)
    expect(pool().isConnected(), 'the connection the user just paired must still be standing').toBe(true)
    expect(FakeWebSocket.latest(), 'no replacement socket should have been dialed').toBe(postPairConnectedSocket)
  })

  it('a refusal while already connected tears the OLD adapter down instead of leaving a zombie connection', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: REAL_TOKEN,
    })
    evalChatInlineScriptWithBridge()
    await settle()

    const sock0 = FakeWebSocket.latest()
    expect(sock0, 'boot should have created a socket').toBeTruthy()
    sock0!.simulateOpen()
    sock0!.simulateMessage({ type: 'hello', protocolVersion: 2, capabilities: {} })
    await settle()
    expect(pool().isConnected()).toBe(true)

    // Register the close-hook seam BEFORE the refusal, the same seam
    // pool-engine-contract.test.ts's close-hook tests use: registerCloseHook
    // is called on WebSocketEngine (wire.ts's delegate swap) but is routed to
    // PoolEngine's own _closeHooks array, which _fireDisconnect walks.
    const closeHookSpy = vi.fn()
    internals().WebSocketEngine.registerCloseHook(closeHookSpy)

    const preRefusalSentCount = sock0!.getSentMessages().length
    const preRefusalSocketCount = FakeWebSocket.instances.length
    // Seed a nonzero backoff counter so the reset-to-0 assertion below
    // actually exercises the line added for this rework, rather than
    // coincidentally reading a value that was already 0.
    internals().State.reconnectAttempts = 3

    // Drive the same scenario production hits when the user re-pairs the
    // route in Settings: a fresh resolve_route_token call comes back
    // "not-paired:" (no profile to resolve it against). In production this
    // reaches PoolEngine.connect() through loadConnectionAndConnect(),
    // re-entered by the hub-event ('profile-changed'/'connection-changed')
    // listener in wiring.ts - that listener is internal wiring, not exposed
    // on window.__MoonInternals, so there is no test hook to trigger it from
    // here. Calling connect() directly reaches the exact same guard with the
    // exact same inputs a real re-pair would produce.
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      resolveToken: { err: 'not-paired: route "stable" has no token paired in moon-connection.json' },
    })
    void pool().connect()
    await settle()

    expect(pool().isConnected(), 'refusal must not leave the engine claiming connected').toBe(false)
    expect(
      (window as any).__poolEngineState.connected,
      'observability must mirror the refusal, not the stale prior state',
    ).toBe(false)

    // No replacement socket, and the sentinel never reaches the wire.
    expect(FakeWebSocket.instances.length, 'refusal must not open a replacement socket').toBe(preRefusalSocketCount)
    expect(
      FakeWebSocket.instances.some((s) => s.url.includes('token=legacy')),
      'the sentinel must never reach the wire',
    ).toBe(false)

    // THE ZOMBIE-CONNECTION CHECK. Before this rework, _isConnected and
    // this._adapter were left set from the prior successful connect, so
    // send() would still transmit on sock0 while every reply came back on a
    // superseded gen and was silently dropped by the frame-dispatch gate -
    // a permanent "thinking" hang under a "disconnected" pill. A message
    // sent through the engine after refusal must not reach the old socket.
    pool().send({ type: 'user-message', threadId: 'thread-zombie-check', text: 'should not send' })
    await settle()
    expect(
      sock0!.getSentMessages().length,
      'a refused connect() must not leave the OLD adapter reachable from send()',
    ).toBe(preRefusalSentCount)

    expect(
      closeHookSpy,
      'the close-hook seam must fire on refusal, same as any other disconnect',
    ).toHaveBeenCalledTimes(1)
    expect(
      internals().State.reconnectAttempts,
      'a durable (not-paired) refusal must not leave a stale backoff counter behind',
    ).toBe(0)

    // The status pill is the ONLY thing telling the user why nothing works;
    // every other assertion here would still pass if updateStatus were
    // deleted from the refusal path (review finding, non-blocking gap).
    const pill = document.getElementById('connection-status')!
    expect(pill.className, 'refusal must surface as disconnected').toBe('disconnected')
    expect(pill.textContent, 'refusal must name its reason').toBe('Route not paired')
  })

  // ── F2 (opus review): the FALLBACK branches never reach the Rust resolver
  // ──────────────────────────────────────────────────────────────────────
  // When MoonSession.resolveBootRoute(null) itself returns null (no
  // client.toml, or a failure resolveBootRoute's own try/catch swallows),
  // PoolEngine takes tokenRef straight from State.wsToken - the ONLY path
  // in connect() that never calls resolve_route_token at all. State.wsToken
  // comes from load_connection (loadConnectionAndConnect, before connect()
  // runs), and connection.rs's load_connection_in returns ITS tokenRef
  // VERBATIM when its own resolution fails - so State.wsToken can
  // legitimately be the raw "legacy" sentinel or an unresolved
  // env:/file:/op:// ref here. This restores the never-token=legacy
  // assertion to load-bearing: without the value-based guard, this exact
  // scenario dials the sentinel straight onto the wire (the #528 bug class,
  // reached through the fallback door instead of the resolver door).
  describe('F2: the fallback branch (resolveBootRoute -> null) also guards against a raw sentinel/scheme value', () => {
    it('a raw "legacy" sentinel in State.wsToken never dials, and reports "Route not paired"', async () => {
      ;(window as any).__TAURI__.core.invoke = vi.fn(async (cmd: string) => {
        switch (cmd) {
          case 'migrate_legacy_connection':
            return null
          case 'load_connection':
            return { wsUrl: 'ws://migrated.host:4753/ui', wsToken: 'legacy' }
          case 'get_panel_route':
            return null
          case 'list_routes':
            // Forces MoonSession.resolveBootRoute to return null (its own
            // try/catch swallows this) - the fallback branch, not the
            // Rust-resolver branch.
            throw new Error('list_routes unavailable')
          default:
            return null
        }
      })
      evalChatInlineScriptWithBridge()
      await settle()

      const urls = FakeWebSocket.instances.map((s) => s.url)
      expect(urls.some((u) => u.includes('token=legacy')), `saw: ${JSON.stringify(urls)}`).toBe(false)
      expect(FakeWebSocket.instances.length, 'a raw sentinel reaching the fallback branch must never dial').toBe(0)
      expect(pool().isConnected()).toBe(false)
      const pill = document.getElementById('connection-status')!
      expect(pill.className).toBe('disconnected')
      expect(pill.textContent).toBe('Route not paired')
    })

    it('a raw scheme ref (env:/file:/op://) in State.wsToken never dials, and reports "Route unavailable"', async () => {
      ;(window as any).__TAURI__.core.invoke = vi.fn(async (cmd: string) => {
        switch (cmd) {
          case 'migrate_legacy_connection':
            return null
          case 'load_connection':
            return { wsUrl: 'ws://migrated.host:4753/ui', wsToken: 'env:LUNA_WS_TOKEN' }
          case 'get_panel_route':
            return null
          case 'list_routes':
            throw new Error('list_routes unavailable')
          default:
            return null
        }
      })
      evalChatInlineScriptWithBridge()
      await settle()

      const urls = FakeWebSocket.instances.map((s) => s.url)
      expect(urls.some((u) => u.includes('token=env:')), `saw: ${JSON.stringify(urls)}`).toBe(false)
      expect(FakeWebSocket.instances.length, 'a raw scheme ref reaching the fallback branch must never dial').toBe(0)
      expect(pool().isConnected()).toBe(false)
      const pill = document.getElementById('connection-status')!
      expect(pill.className).toBe('disconnected')
      expect(pill.textContent).toBe('Route unavailable')
    })
  })
})
