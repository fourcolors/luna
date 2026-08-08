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

    evalChatInlineScriptWithBridge()
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

    // DELTA 2 OF S18b, NOW SETTLED. This test previously pinned the opposite:
    // PoolEngine armed hooks only on 'ready', so a connection that never
    // established never wiped. WebSocketEngine fires its hooks from the raw
    // close handler with no arming condition, so it DOES wipe there.
    //
    // A secret typed while a connection was still coming up is exactly as
    // sensitive as one typed against a live socket, so the conservative
    // behavior wins: PoolEngine now arms at connect-attempt start. The
    // exactly-once guard survives - it just covers the whole attempt rather
    // than only the established part.
    it('fires hooks even for a socket that never reached ready (the conservative side)', async () => {
      const order: string[] = []
      internals().WebSocketEngine.registerCloseHook(() => order.push('mine'))
      await settle()
      FakeWebSocket.latest()!.simulateOpen() // no hello -> never 'ready'
      await settle()
      FakeWebSocket.latest()!.simulateDrop()
      await settle()
      expect(order).toEqual(['mine'])
    })

    it('still fires exactly once per attempt, not once per recovery tick', async () => {
      // The arming guard's original job. A recovering→down sequence must not
      // re-run a wipe policy several times.
      let runs = 0
      internals().WebSocketEngine.registerCloseHook(() => {
        runs += 1
      })
      const sock = await bringUp()
      sock.simulateDrop()
      await settle(10, 500)
      expect(runs).toBe(1)
    })
  })

  describe('reconnect', () => {
    // DELTA 1 OF S18b, NOW SETTLED. This test previously refused to assert
    // timing at all, because the adapter ran on its own defaults (base 500ms,
    // cap 15s) and pinning those would have pinned a schedule nobody chose.
    //
    // PoolEngine now passes a custom adapter factory with Moon's contract
    // constants, so the ladder is the SAME one ws-contract pins for
    // WebSocketEngine - plus a bounded jitter that is deliberately kept, since
    // an un-jittered ladder is the weaker behavior (every client reconnects in
    // lockstep after a server restart). Hence an ENVELOPE assertion, which is
    // precise, not loose: each delay must sit in [ladder, ladder + 200).
    it('reconnect delays follow Moon\'s ladder within the jitter envelope', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      const sock = await bringUp()
      setTimeoutSpy.mockClear()
      sock.simulateDrop()
      await settle(12, 2000)

      // A GLOBAL setTimeout spy sees EVERY timer the page arms, not just
      // reconnect ones - the adapter's 10s handshake watchdog and MoonBar's
      // 14s quip rotation both showed up while writing this. Classifying every
      // delay is therefore hopeless. The assertion is instead TWO-SIDED and
      // targeted at the thing that actually changed: the first rung must be
      // Moon's 1000ms base (plus jitter), and the adapter's own 500ms default
      // base must NOT appear. That proves the custom factory's constants took
      // effect without depending on which unrelated timers happen to fire.
      const JITTER_MS = 200
      const delays = setTimeoutSpy.mock.calls
        .map((c) => c[1])
        .filter((d): d is number => typeof d === 'number')

      const onMoonBase = delays.some((d) => d >= 1000 && d < 1000 + JITTER_MS)
      const onAdapterDefaultBase = delays.some((d) => d >= 500 && d < 500 + JITTER_MS)

      expect(
        onMoonBase,
        `expected a first reconnect delay in [1000, ${1000 + JITTER_MS}) - saw ${JSON.stringify(delays)}`,
      ).toBe(true)
      expect(
        onAdapterDefaultBase,
        `the adapter's own 500ms default base must not appear - saw ${JSON.stringify(delays)}`,
      ).toBe(false)
    })

    it('a drop after connect leaves the engine reporting disconnected', async () => {
      const sock = await bringUp()
      expect(pool().isConnected()).toBe(true)
      sock.simulateDrop()
      await settle()
      expect(pool().isConnected()).toBe(false)
    })
  })

  // ── COVERAGE PARITY WITH ws-contract.test.ts ──────────────────────────────
  //
  // ws-contract (CI hard gate 5) proves these properties for WebSocketEngine.
  // S18b promotes PoolEngine to default, and promoting an engine with LESS
  // coverage than the one it replaces is a regression no test would report.
  // These are the same scenarios restated against PoolEngine's model: its own
  // `_gen` counter rather than State.connGen, an adapter rather than State.ws,
  // and gated dispatch rather than a raw message listener.
  describe('coverage parity with the legacy engine contract', () => {
    it('a superseded connection cannot resurrect state (gen gating)', async () => {
      const sock0 = await bringUp()
      expect(internals().State.serverSupportsArtifacts).toBe(false)

      // A second connect() supersedes the first without sock0 closing first.
      void pool().connect()
      await settle()

      // A late frame on the now-superseded socket must be ignored.
      sock0.injectServerMessage({ type: 'hello', capabilities: { artifacts: true } })
      await settle()
      expect(
        internals().State.serverSupportsArtifacts,
        'a frame from a superseded connection must not be applied',
      ).toBe(false)
    })

    it('a thread-snapshot for a non-active thread is dropped (cross-thread bleed guard)', async () => {
      const sock = await bringUp()
      internals().State.activeThreadId = 'thread-current'
      const resetSpy = vi.spyOn(internals().ChatState, 'reset')

      sock.injectServerMessage({ type: 'thread-snapshot', threadId: 'thread-stale', messages: [] })
      await settle()
      expect(resetSpy, 'a stale thread snapshot must not reset the viewed transcript').not.toHaveBeenCalled()

      sock.injectServerMessage({ type: 'thread-snapshot', threadId: 'thread-current', messages: [] })
      await settle()
      expect(resetSpy).toHaveBeenCalledTimes(1)
    })

    it('a live frame is applied exactly once, not per subscriber', async () => {
      const sock = await bringUp()
      const resetSpy = vi.spyOn(internals().ChatState, 'reset')
      internals().State.activeThreadId = 'thr-1'

      sock.injectServerMessage({ type: 'thread-snapshot', threadId: 'thr-1', messages: [] })
      await settle()
      // Double delivery is the failure this guards: the adapter exposes BOTH
      // subscribeFrames and openSession, and consuming both would dispatch
      // every post-hello frame twice (luna-ws.ts says so explicitly).
      expect(resetSpy).toHaveBeenCalledTimes(1)
    })

    // RESUBSCRIBE-ON-RECONNECT, now genuinely pinned.
    //
    // This scenario was previously left unpinned because every attempt saw an
    // EMPTY sent-frame list while `send()` was demonstrably called with the
    // right frame. The cause was not the engine: FakeWebSocket carried the
    // readyState constants only as STATICS, while the DOM also puts them on
    // WebSocket.prototype - so LunaWsAdapter.sendFrame's
    // `this.#ws.readyState === this.#ws.OPEN` compared `1 === undefined` and
    // SILENTLY DROPPED every frame. The fake now mirrors the DOM, and the
    // engine turns out to have been correct all along.
    //
    // Worth keeping in view: without that fix this suite could only ever have
    // "passed" by asserting nothing about sends.
    it('re-subscribes the active thread on the connection that replaces a dropped one', async () => {
      internals().State.activeThreadId = 'thread-abc'
      const sock0 = await bringUp()
      expect(
        sock0.getSentMessages(),
        'the first connection should subscribe to the active thread',
      ).toContainEqual({ type: 'subscribe', threadId: 'thread-abc' })

      sock0.simulateDrop()

      // Complete the handshake on the FIRST replacement socket the adapter
      // mints. Advancing in one jump instead lets it create several and time
      // each out, leaving `latest()` on a dead one.
      let sock1: ReturnType<typeof FakeWebSocket.latest> = null
      for (let i = 0; i < 40 && !sock1; i++) {
        await vi.advanceTimersByTimeAsync(200)
        const candidate = FakeWebSocket.latest()
        if (candidate && candidate !== sock0) sock1 = candidate
      }
      expect(sock1, 'the adapter should have minted a replacement socket').toBeTruthy()
      sock1!.simulateOpen()
      sock1!.simulateMessage({ type: 'hello', protocolVersion: 2, capabilities: {} })
      await settle()

      expect(internals().State.activeThreadId, 'a drop must not move the user off their thread').toBe('thread-abc')
      expect(
        sock1!.getSentMessages(),
        'the replacement connection must re-subscribe, or chat goes silent after every drop',
      ).toContainEqual({ type: 'subscribe', threadId: 'thread-abc' })
    })

    it('a flap sequence leaks no timers', async () => {
      await bringUp()
      const timersBeforeFlap = vi.getTimerCount()
      for (let i = 0; i < 4; i++) {
        FakeWebSocket.latest()!.simulateDrop()
        await settle(4, 2000)
        const s = FakeWebSocket.latest()
        s?.simulateOpen()
        s?.simulateMessage({ type: 'hello', protocolVersion: 2, capabilities: {} })
        await settle()
      }
      await settle(6, 4000)
      // Asserting the DELTA, not a literal count: chat.html arms unrelated
      // boot timers (update poll, UI heartbeat, MoonBar's quip rotation) that
      // this scenario is not about - the same reasoning ws-contract records.
      expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBeforeFlap)
    })
  })
})
