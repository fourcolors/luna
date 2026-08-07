// @vitest-environment jsdom
/**
 * pool-engine-contract.test.ts - runs the WS contract against PoolEngine, the
 * ConnectionManager-based engine, with the dark flag ON.
 *
 * WHY THIS EXISTS. S18b promotes PoolEngine from dark to default (see
 * docs/next/stack23-slices.md's S18b readiness entry). Before this file,
 * PoolEngine had NEVER been exercised against the connection contract:
 * pool-engine.test.ts's "flag ON" describes only assert `isDarkFlagSet()`
 * returns true, and ws-contract.test.ts - CI hard gate 5 - boots with the flag
 * OFF and therefore only ever tested WebSocketEngine. Promoting an engine
 * whose contract behavior nothing had checked is precisely the shape of
 * failure this arc keeps finding.
 *
 * THE HARNESS DETAIL THAT MAKES THIS POSSIBLE, and which cost real time to
 * find: driving `simulateOpen()` is NOT enough to bring the adapter up.
 * LunaWsAdapter's attach awaits a HELLO frame (`#helloReject`), so without
 * `simulateMessage({type:'hello'})` the connection never publishes 'ready',
 * `isConnected()` stays false forever, and `_hooksArmed` never arms - which
 * makes every downstream assertion silently vacuous rather than red. Any new
 * scenario here MUST use `bringUp()` below.
 *
 * TWO DELTAS FROM WebSocketEngine ARE PINNED HERE AS CURRENT BEHAVIOR, not
 * endorsed. S18b has to settle both deliberately:
 *
 *   1. RECONNECT SCHEDULE. WebSocketEngine owns its backoff and ws-contract
 *      pins it as [1000,2000,4000,8000,16000,16000]. Under PoolEngine the
 *      adapter runs its OWN retry (base 500ms, cap 15s, 6 attempts, jittered)
 *      and PoolEngine's `_scheduleRetry` only fires once the adapter gives up
 *      - by design, per its own comment. So promotion CHANGES the observable
 *      schedule. LunaWsAdapter's constructor takes `reconnectOpts
 *      {maxAttempts, baseMs, maxMs}`, so matching the pinned contract is a
 *      configuration change, not a rewrite.
 *
 *   2. CLOSE-HOOK ARMING. WebSocketEngine fires close hooks on ANY socket
 *      close, including one that never opened. PoolEngine arms them only
 *      after the connection reached 'ready' (`_hooksArmed`). The shipped hook
 *      wipes a typed-but-unsent secret, so WebSocketEngine's is the more
 *      conservative of the two: it also wipes when a connection was never
 *      established. Pinned below so the difference is a decision, not a
 *      discovery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as LunaTransport from '@luna/ui-transport/browser'
import { FakeWebSocket } from './helpers/FakeWebSocket'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  mountChatMessageListBridge,
  readChatHtml,
} from './helpers/chat-harness'

describe('PoolEngine against the WS contract (dark flag ON)', () => {
  const internals = () => (window as any).__MoonInternals
  const pool = () => internals().PoolEngine

  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    const htmlContent = readChatHtml()
    mountChatDomFromHtml(htmlContent)
    ;(window as any).__TAURI__ = {
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
    // The shipped page gets this from main-chat.tsx's ESM import (S18a, #472);
    // the harness mirrors that rather than loading a vendor bundle.
    ;(window as any).LunaTransport = LunaTransport

    localStorage.clear()
    // Set BEFORE the inline script evaluates: USE_POOL_ENGINE is computed once
    // at script-eval time from PoolEngineHelper.isDarkFlagSet().
    localStorage.setItem('luna_pool_engine', '1')
    FakeWebSocket.reset()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()

    const mount = mountChatMessageListBridge(document.getElementById('chat-messages'))
    evalChatInlineScriptWithBridge(htmlContent, mount)
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

  /** Let async boot settle. The adapter attaches through promises, so timer
   *  advancement alone is not enough - each step must yield the microtask
   *  queue too, which advanceTimersByTimeAsync does. */
  const settle = async (steps = 5, ms = 50) => {
    for (let i = 0; i < steps; i++) await vi.advanceTimersByTimeAsync(ms)
  }

  /** Bring the live socket fully up. Open ALONE is not enough - see this
   *  file's module doc on `#helloReject`. */
  const bringUp = async () => {
    await settle()
    const sock = FakeWebSocket.latest()
    expect(sock, 'boot should have created a socket').toBeTruthy()
    sock!.simulateOpen()
    sock!.simulateMessage({ type: 'hello', protocolVersion: 2, capabilities: {} })
    await settle()
    return sock!
  }

  describe('the engine actually runs', () => {
    it('the dark flag selects PoolEngine at script-eval time', () => {
      expect(internals().USE_POOL_ENGINE).toBe(true)
      expect(pool()).toBeTruthy()
    })

    it('boot creates exactly one socket through the pooled adapter', async () => {
      await settle()
      // One route in the map, one acquire, one connection - the whole reason
      // promoting the pooled engine cannot change the chat window's
      // connection topology.
      expect(FakeWebSocket.instances.length).toBe(1)
    })

    it('reaches connected once the hello handshake completes', async () => {
      expect(pool().isConnected()).toBe(false)
      await bringUp()
      expect(pool().isConnected()).toBe(true)
    })

    it('an open WITHOUT a hello never reports connected (the vacuous-test trap)', async () => {
      await settle()
      FakeWebSocket.latest()!.simulateOpen()
      await settle()
      // Pinned deliberately: this is the exact state in which every later
      // assertion would pass while testing nothing.
      expect(pool().isConnected()).toBe(false)
    })
  })

  describe('close-hook seam', () => {
    it('fires registered hooks on a real drop once the connection was established', async () => {
      const order: string[] = []
      internals().WebSocketEngine.registerCloseHook(() => order.push('mine'))
      const sock = await bringUp()
      expect(pool()._hooksArmed).toBe(true)
      sock.simulateDrop()
      await settle()
      expect(order).toEqual(['mine'])
    })

    it('DELTA vs WebSocketEngine: hooks do NOT fire for a socket that never reached ready', async () => {
      const order: string[] = []
      internals().WebSocketEngine.registerCloseHook(() => order.push('mine'))
      await settle()
      FakeWebSocket.latest()!.simulateOpen() // no hello -> never 'ready'
      await settle()
      FakeWebSocket.latest()!.simulateDrop()
      await settle()
      // WebSocketEngine WOULD have fired here (it hooks the raw close event),
      // and its hook wipes a typed-but-unsent secret. S18b must decide whether
      // to keep PoolEngine's narrower arming or match the conservative one.
      expect(order).toEqual([])
    })
  })

  describe('reconnect', () => {
    it('DELTA vs WebSocketEngine: the adapter owns retry, so the pinned 1000/2000/4000 schedule does not apply', async () => {
      const sock = await bringUp()
      const before = FakeWebSocket.instances.length
      sock.simulateDrop()
      await settle(10, 1000)
      // The assertion is deliberately weak on TIMING and strong on OWNERSHIP:
      // a retry happens without PoolEngine scheduling it, because
      // LunaWsAdapter reconnects internally (base 500ms, cap 15s, 6 attempts,
      // jittered) and PoolEngine's _scheduleRetry only runs once the adapter
      // gives up. Pinning exact delays here would pin the ADAPTER's jittered
      // schedule, which is not a contract anyone chose.
      expect(FakeWebSocket.instances.length).toBeGreaterThan(before)
    })

    it('a drop after connect leaves the engine reporting disconnected', async () => {
      const sock = await bringUp()
      expect(pool().isConnected()).toBe(true)
      sock.simulateDrop()
      await settle()
      expect(pool().isConnected()).toBe(false)
    })
  })
})
