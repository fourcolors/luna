// @vitest-environment jsdom
//
// ws-contract.test.ts — the Moon WS-contract regression harness (task #45 of
// the Moon stability-audit batch, exp_0d6a1fd3ed1b). This is the CI gate the
// self-improve loop flagged as blocking: it exercises frontend-react/chat.html's
// bespoke WebSocketEngine reconnect state machine (scheduleReconnect,
// syncThread's fast-path resubscribe, connGen gating) end-to-end through a
// scriptable FakeWebSocket, instead of unit-testing individual methods in
// isolation (see chat-window.test.ts's syncThread()/onReattachStalled()
// suites for that layer).
//
// The other ~9 WS-related bugs in the batch (#41-43, #46-48: first-message-
// vanish race, cross-thread frame bleed, panels never reconnecting, reconnect
// backoff flap storms, no unsubscribe on thread switch, ...) are meant to add
// scenarios HERE (or in sibling files using the same FakeWebSocket helper)
// rather than hand-rolling their own WebSocket mocks.
//
// Harness setup mirrors chat-window.test.ts's beforeEach (same vendor-load +
// inline-script-selection mechanism) with one swap: FakeWebSocket stands in
// for the "inert" WebSocket stub, so this suite can actually script opens,
// drops, flaps and message delivery instead of leaving the socket dead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeWebSocket } from './helpers/FakeWebSocket'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  readChatHtml,
} from './helpers/chat-harness'

describe('Moon WS-contract harness (frontend-react/chat.html WebSocketEngine)', () => {
  let htmlContent: string

  beforeEach(() => {
    window.history.replaceState({}, '', '/')

    // frontend-react/chat.html is what actually ships (src-tauri/tauri.conf.json's
    // `frontendDist`); the superseded frontend/chat.html copy was deleted by the
    // React + Astryx conversion. Same source chat-window.test.ts reads.
    htmlContent = readChatHtml()
    mountChatDomFromHtml(htmlContent)
    // Fail loudly rather than running every scenario against an empty DOM if
    // the shell is ever restructured again.
    expect(document.body.innerHTML.length).toBeGreaterThan(0)

    // No __TAURI__.core — same degraded boot chat-window.test.ts uses, which
    // keeps loadConnectionAndConnect() synchronous (no real await executes),
    // so WebSocketEngine.connect() has already run by the time the inline
    // script finishes evaluating below.
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
          startDragging: vi.fn(async () => {}),
        }),
        Window: { getByLabel: vi.fn(async () => null) },
      },
      event: { listen: vi.fn(async () => () => {}) },
    }

    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'moon-dock.js')

    localStorage.clear()

    FakeWebSocket.reset()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()

    // Mount the React transcript (src/chat/MessageList.tsx) into
    // #chat-messages, then evaluate the inline page script (selected by
    // CONTENT, not position - same guard as chat-window.test.ts, fails
    // loudly if a future edit adds a second <script> block containing
    // 'WebSocketEngine' instead of silently running the wrong one) and
    // patch its ChatState/ChatLoop forward-declarations to the real bridge
    // in the SAME scope (see helpers/chat-harness.ts's module doc).
    evalChatInlineScriptWithBridge()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__TAURI__
    delete (window as any).__MoonInternals
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    delete (window as any).LunaMarkdown
    delete (window as any).LunaDock
    delete (window as any).LunaChatHost
    delete (window as any).ChatState
    delete (window as any).ChatLoop
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const internals = () => (window as any).__MoonInternals

  // ───────────────────────────────────────────────────────────────────────
  // Scenario A: mid-stream drop -> reconnect, with never-opening sockets
  // driving the exponential backoff to its documented 16s ceiling.
  // ───────────────────────────────────────────────────────────────────────
  describe('Scenario: connection never opens / drops mid-stream', () => {
    it('schedules reconnect with exponential backoff and caps at 16s', () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 16000]

      for (const expectedDelay of expectedDelays) {
        const sock = FakeWebSocket.latest()!
        expect(sock).toBeDefined()
        // Never opens — models a slow/never-opening connection, then the
        // network gives up and tears it down (mid-stream drop, not a client
        // close()).
        sock.simulateDrop()
        const lastDelay = setTimeoutSpy.mock.calls.at(-1)![1]
        expect(lastDelay).toBe(expectedDelay)
        vi.advanceTimersByTime(expectedDelay)
      }

      // One fresh FakeWebSocket per reconnect attempt (initial boot socket +
      // one per scheduled retry) — no instance reused across reconnects.
      expect(FakeWebSocket.instances.length).toBe(expectedDelays.length + 1)
    })

    it('a mid-stream drop bumps connGen so the dead socket cannot resurrect state', () => {
      const m = internals()
      const sock0 = FakeWebSocket.latest()!
      sock0.simulateOpen()
      const genAfterOpen = m.State.connGen
      sock0.simulateDrop()
      vi.advanceTimersByTime(1000)
      const sock1 = FakeWebSocket.latest()!
      expect(sock1).not.toBe(sock0)
      expect(m.State.connGen).toBeGreaterThan(genAfterOpen)
      expect(m.State.ws).toBe(sock1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario B: reconnect-and-resubscribe. The in-memory active thread
  // survives a drop and is re-subscribed to on the new socket (chat.html's
  // syncThread() "fast path" — no list-threads round trip needed).
  // ───────────────────────────────────────────────────────────────────────
  describe('Scenario: reconnect resubscribes to the active thread', () => {
    it('re-sends subscribe for the in-memory activeThreadId after a drop+reconnect', () => {
      const m = internals()
      m.State.activeThreadId = 'thread-abc'

      const sock0 = FakeWebSocket.latest()!
      sock0.simulateOpen()
      expect(sock0.getSentMessages()).toContainEqual({ type: 'subscribe', threadId: 'thread-abc' })

      sock0.simulateDrop()
      vi.advanceTimersByTime(1000)

      const sock1 = FakeWebSocket.latest()!
      expect(sock1).not.toBe(sock0)
      sock1.simulateOpen()

      expect(sock1.getSentMessages()).toContainEqual({ type: 'subscribe', threadId: 'thread-abc' })
      // The thread identity itself must be unchanged across the reconnect.
      expect(m.State.activeThreadId).toBe('thread-abc')
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario C: no message loss/duplication across reconnect. A frame that
  // arrives on a SUPERSEDED socket (the connGen race chat.html's own
  // comments describe) must never be applied; the live socket's frame must
  // be applied exactly once.
  // ───────────────────────────────────────────────────────────────────────
  describe('Scenario: message delivery is exactly-once across a reconnect', () => {
    it('drops a late frame from a superseded socket and applies the live socket frame exactly once', () => {
      const m = internals()
      const sock0 = FakeWebSocket.latest()!
      sock0.simulateOpen()
      expect(m.State.serverSupportsArtifacts).toBe(false)

      // A second connect() (e.g. a rapid manual reconnect) supersedes sock0
      // without necessarily going through sock0's own close event first.
      m.WebSocketEngine.connect()
      const sock1 = FakeWebSocket.latest()!
      expect(sock1).not.toBe(sock0)

      // Late frame on the now-superseded sock0 — must be ignored (fix-6 gen
      // gate). This is the "cross-thread frame bleed" / stale-socket race
      // the batch is tracking; the harness pins the expected contract.
      sock0.injectServerMessage({ type: 'hello', capabilities: { artifacts: true } })
      expect(m.State.serverSupportsArtifacts).toBe(false)

      // The live socket's frame IS applied — exactly once.
      sock1.simulateOpen()
      sock1.injectServerMessage({ type: 'hello', capabilities: { artifacts: true } })
      expect(m.State.serverSupportsArtifacts).toBe(true)
    })

    it('a thread-snapshot for a thread that is no longer active is dropped (cross-thread bleed guard)', () => {
      const m = internals()
      m.State.activeThreadId = 'thread-current'
      const sock0 = FakeWebSocket.latest()!
      sock0.simulateOpen()

      const snapshotSpy = vi.spyOn(m.ChatState, 'reset')
      // A snapshot for a DIFFERENT (stale/previously-viewed) thread must not
      // reset the transcript for the thread actually in view.
      sock0.injectServerMessage({ type: 'thread-snapshot', threadId: 'thread-stale', messages: [] })
      expect(snapshotSpy).not.toHaveBeenCalled()

      // The matching thread's snapshot IS applied.
      sock0.injectServerMessage({ type: 'thread-snapshot', threadId: 'thread-current', messages: [] })
      expect(snapshotSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario D: repeated rapid open/close ("flap"). No leaked/stacked
  // timers, and every flap produces a genuinely fresh socket instance.
  // ───────────────────────────────────────────────────────────────────────
  describe('Scenario: rapid open/close flapping', () => {
    it('never leaks stacked reconnect timers across a flap sequence', () => {
      const initialCount = FakeWebSocket.instances.length
      // Baseline, NOT zero: chat.html schedules its own boot-time timers
      // (update-poll / UI heartbeat, unrelated to WebSocketEngine) before any
      // socket activity at all — confirmed by probing vi.getTimerCount()
      // immediately after beforeEach with zero WS interaction. Asserting a
      // literal 0 here would be coupled to that unrelated app machinery, not
      // to the reconnect/subscribe-watchdog timers this scenario is actually
      // about. Assert the DELTA stays flat across the flap instead.
      const timersBeforeFlap = vi.getTimerCount()
      FakeWebSocket.simulateFlap(5, { advance: (ms) => vi.advanceTimersByTime(ms) })

      // Exactly one fresh instance per flap iteration — none skipped, none
      // double-created.
      expect(FakeWebSocket.instances.length).toBe(initialCount + 5)
      // scheduleReconnect always clears its own previous timer before
      // arming a new one, and each flap's open->drop clears the subscribe
      // watchdog in the close handler — so no WS-related timer should be
      // left pending beyond whatever unrelated app timers already existed
      // once the last scheduled advance has run to completion.
      expect(vi.getTimerCount()).toBe(timersBeforeFlap)
    })

    it('documents current behavior: a successful open resets the backoff counter even immediately before the next drop', () => {
      // This is the flap-storm risk the batch is tracking separately: a
      // connection that flaps (opens then instantly drops, over and over)
      // never backs off beyond the FIRST retry delay, because 'open'
      // unconditionally zeroes State.reconnectAttempts. This test pins that
      // as the CURRENT, observed contract so a follow-on flap-storm fix has
      // a concrete failing assertion to flip.
      const m = internals()
      FakeWebSocket.simulateFlap(4, { advance: (ms) => vi.advanceTimersByTime(ms) })
      expect(m.State.reconnectAttempts).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario F: the registerCloseHook seam, driven through a REAL close.
  //
  // WHY HERE AND NOT IN chat-window.test.ts. That suite already pins the
  // shipped hook's BODY, but it does so by reaching into
  // `WebSocketEngine._closeHooks` and calling each entry directly:
  //
  //     for (const hook of hooks) hook()
  //
  // That proves the wipe works when invoked. It cannot prove the ENGINE
  // invokes it. An engine rewrite that dropped the `for (const hook of
  // this._closeHooks)` loop in the close handler would leave that test
  // green while a typed-but-unsent secret survived a socket drop - which is
  // a security property, not a cosmetic one.
  //
  // stack23 S18 is about to rewrite exactly that close handler onto the ESM
  // ConnectionManager, so the seam gets an integration-level pin in the CI
  // hard gate FIRST, driven by a real `close` event through FakeWebSocket.
  // ───────────────────────────────────────────────────────────────────────
  describe('Scenario: close hooks run on a real socket drop (registerCloseHook seam)', () => {
    it('a mid-stream drop invokes every registered close hook, in registration order', () => {
      const m = internals()
      const order: string[] = []
      m.WebSocketEngine.registerCloseHook(() => order.push('first'))
      m.WebSocketEngine.registerCloseHook(() => order.push('second'))

      FakeWebSocket.latest()!.simulateOpen()
      expect(order).toEqual([]) // nothing runs while the socket is healthy
      FakeWebSocket.latest()!.simulateDrop()

      expect(order).toEqual(['first', 'second'])
    })

    it('the SHIPPED secret-wipe hook clears a typed secret through a real drop, not just when called directly', () => {
      const input = document.getElementById('secret-prompt-input') as HTMLInputElement | null
      expect(input, 'chat.html must still carry #secret-prompt-input').toBeTruthy()
      input!.value = 'typed-not-sent'

      FakeWebSocket.latest()!.simulateOpen()
      FakeWebSocket.latest()!.simulateDrop()

      // The end-to-end property: socket drops => no typed secret retained.
      expect(input!.value).toBe('')
    })

    it('a throwing hook does not prevent later hooks from running', () => {
      // Hook isolation matters precisely because the secret wipe may not be
      // the only registered policy: one panel's failing hook must not strand
      // another panel's secret in the DOM.
      const m = internals()
      const order: string[] = []
      m.WebSocketEngine.registerCloseHook(() => {
        order.push('throwing')
        throw new Error('boom')
      })
      m.WebSocketEngine.registerCloseHook(() => order.push('after-throw'))

      FakeWebSocket.latest()!.simulateOpen()
      expect(() => FakeWebSocket.latest()!.simulateDrop()).not.toThrow()

      expect(order).toEqual(['throwing', 'after-throw'])
    })

    it('hooks run on EVERY drop across a reconnect, not only the first', () => {
      // A rewrite that registered the close handler once against the first
      // socket - rather than per-connection - would pass the single-drop
      // tests above and silently stop wiping from the second drop onward.
      const m = internals()
      let runs = 0
      m.WebSocketEngine.registerCloseHook(() => {
        runs += 1
      })

      for (let i = 0; i < 3; i++) {
        const sock = FakeWebSocket.latest()!
        sock.simulateOpen()
        sock.simulateDrop()
        vi.advanceTimersByTime(1000) // let the scheduled reconnect mint the next socket
      }

      expect(runs).toBe(3)
    })
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario: liveness watchdog wiring. These drive REAL inbound frames
  // through the socket 'message' listener - the only place
  // noteInboundActivity runs on this engine - rather than calling
  // handleFrame() or startTurnTimeout() by hand, so they pin the
  // frame→liveness wiring itself: deleting the noteInboundActivity call at
  // the listener, or its re-arm-only guard, fails these.
  // ───────────────────────────────────────────────────────────────────────
  describe('Scenario: the liveness watchdog is fed by real inbound frames', () => {
    it('an inbound {type:"ping"} re-arms an ARMED watchdog: a quiet turn outlives 90s', () => {
      const m = internals()
      const sock = FakeWebSocket.latest()!
      sock.simulateOpen()
      m.WebSocketEngine.startTurnTimeout() // armed at send
      expect(m.State.turnTimeout).not.toBeNull()

      // 60s of silence (below the 90s budget), one REAL heartbeat frame,
      // then 60s more: 120s total. Without the re-arm the watchdog fires at
      // 90s and consumes itself, so a non-null timer here proves the ping
      // actually reached noteInboundActivity through the message listener.
      vi.advanceTimersByTime(60_000)
      sock.injectServerMessage({ type: 'ping', ts: '2026-08-24T00:00:00Z' })
      vi.advanceTimersByTime(60_000)
      expect(m.State.turnTimeout).not.toBeNull()
    })

    it('control: 90s with NO inbound frame fires and consumes the watchdog', () => {
      const m = internals()
      FakeWebSocket.latest()!.simulateOpen()
      m.WebSocketEngine.startTurnTimeout()
      vi.advanceTimersByTime(90_000)
      expect(m.State.turnTimeout).toBeNull()
    })

    it('inbound frames while IDLE never arm the watchdog (re-arm-only, real path)', () => {
      const m = internals()
      const sock = FakeWebSocket.latest()!
      sock.simulateOpen()
      m.WebSocketEngine.clearTurnTimeout()
      expect(m.State.turnTimeout).toBeNull()

      sock.injectServerMessage({ type: 'ping', ts: '2026-08-24T00:00:00Z' })
      sock.injectServerMessage({ type: 'thread-list', threads: [] })
      expect(m.State.turnTimeout).toBeNull()
    })
  })
})
