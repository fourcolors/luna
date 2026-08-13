// @vitest-environment jsdom
/**
 * pool-engine-token-resolution.test.ts - regression fence for issue #528.
 *
 * PoolEngine is the default chat engine (wire.ts's USE_POOL_ENGINE). Its
 * connect() resolves the boot route via MoonSession.resolveBootRoute(null)
 * and used to take bootRoute.token_ref VERBATIM as the bearer. For migrated
 * users, client.toml routes carry token_ref = "legacy" (the migration
 * sentinel written by client_config.rs / read back by connection.rs), so the
 * adapter (LunaWsAdapter#resolveToken) dialed ?token=legacy literally - even
 * though State.wsToken already held the real resolved token by the time
 * connect() ran (load_connection runs BEFORE connect() in
 * loadConnectionAndConnect, wire.ts).
 *
 * These four cases pin the fix: substitute State.wsToken when it is a valid
 * replacement, refuse to dial when it is not, leave non-sentinel token_refs
 * untouched, and - the case an opus adversarial review caught the first cut
 * of this fix missing - a refusal that arrives while an OLDER connection is
 * still live must tear that connection down rather than leave a zombie half
 * connection: send() gates on `this._adapter && this._isConnected`, so
 * leaving either set after a refused reconnect would let a typed message
 * still go out over the stale adapter while the reply came back on a
 * superseded gen and got silently dropped by the frame-dispatch gate,
 * hanging the turn at "thinking" under a "disconnected" pill.
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

const REAL_TOKEN = 'real-resolved-token-0123456789abcdef0123456789abcdef01234567'

/** Scripted __TAURI__.core.invoke covering the boot-time command sequence:
 *  migrate_legacy_connection (loadConnectionAndConnect's Step 0), load_connection
 *  (also loadConnectionAndConnect), then get_panel_route / list_routes / load_route
 *  (MoonSession.resolveBootRoute, called from inside PoolEngine.connect()). */
function makeInvokeStub(opts: { loadConnection: unknown; tokenRef?: string }) {
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
          token_ref: opts.tokenRef ?? 'legacy',
          transport: 'luna-ws',
        }
      default:
        return null
    }
  })
}

describe('PoolEngine token resolution against a migrated route (#528)', () => {
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

  it('a migrated route dials the resolved token, never the sentinel', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
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

  it('an unresolved sentinel refuses to dial', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      // The Rust resolver returned the sentinel as-is - no profile to resolve it against.
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: 'legacy' },
    })
    evalChatInlineScriptWithBridge()
    await settle()

    const urls = FakeWebSocket.instances.map((s) => s.url)
    expect(urls.some((u) => u.includes('token=legacy')), `saw: ${JSON.stringify(urls)}`).toBe(false)
    expect(FakeWebSocket.instances.length, `saw: ${JSON.stringify(urls)}`).toBe(0)
    expect(pool().isConnected()).toBe(false)
  })

  it('a real literal token_ref passes through unchanged', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
      tokenRef: 'literal-token-abc123',
    })
    evalChatInlineScriptWithBridge()
    await settle()

    const urls = FakeWebSocket.instances.map((s) => s.url)
    expect(urls.some((u) => u.includes('token=literal-token-abc123')), `saw: ${JSON.stringify(urls)}`).toBe(true)
    expect(urls.some((u) => u.includes('token=legacy')), `saw: ${JSON.stringify(urls)}`).toBe(false)
  })

  it('a refusal while already connected tears the OLD adapter down instead of leaving a zombie connection', async () => {
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: REAL_TOKEN },
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
    // route in Settings: a fresh load_connection comes back with the
    // sentinel and no profile to resolve it against. In production this
    // reaches PoolEngine.connect() through loadConnectionAndConnect(),
    // re-entered by the hub-event ('profile-changed'/'connection-changed')
    // listener in wiring.ts - that listener is internal wiring, not exposed
    // on window.__MoonInternals, so there is no test hook to trigger it from
    // here. Setting State.wsToken directly (State IS exposed, and other
    // suites already mutate it - see pool-engine-contract.test.ts) and
    // calling connect() reaches the exact same guard with the exact same
    // inputs a real re-pair would produce; the invoke stub is also updated
    // for documentation parity even though this path does not re-invoke
    // load_connection.
    ;(window as any).__TAURI__.core.invoke = makeInvokeStub({
      loadConnection: { wsUrl: 'ws://migrated.host:4753/ui', wsToken: 'legacy' },
    })
    internals().State.wsToken = 'legacy'
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
      'a refusal must not leave a stale backoff counter behind for the next real attempt',
    ).toBe(0)

    // The status pill is the ONLY thing telling the user why nothing works;
    // every other assertion here would still pass if updateStatus were
    // deleted from the refusal path (review finding, non-blocking gap).
    const pill = document.getElementById('connection-status')!
    expect(pill.className, 'refusal must surface as disconnected').toBe('disconnected')
    expect(pill.textContent, 'refusal must name its reason').toBe('Route not paired')
  })
})
