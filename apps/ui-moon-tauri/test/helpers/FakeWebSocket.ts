/**
 * FakeWebSocket.ts — a scriptable, deterministic stand-in for the browser
 * WebSocket constructor, built for the Moon (apps/ui-moon-tauri) WS-contract
 * test harness (task #45 of the Moon stability-audit batch).
 *
 * Promoted out of test/moon-vendor.test.ts's inline `MockWebSocket` (which
 * only covered vendor/moon-ws.js's generic createClient()) into a shared,
 * reusable helper so the REST of the WebSocket-related fixes in the batch
 * (#41-43, #46-48: first-message-vanish race, cross-thread frame bleed,
 * panels never reconnecting, reconnect backoff flap storms, no unsubscribe
 * on thread switch, ...) can drive the exact same fake against the code
 * they're touching (frontend/chat.html's WebSocketEngine, vendor/moon-ws.js's
 * createClient, or anything else that does `new WebSocket(url)`).
 *
 * Usage:
 *   vi.stubGlobal('WebSocket', FakeWebSocket)
 *   FakeWebSocket.reset()               // clear instances between tests
 *   engineUnderTest.connect()           // production code does `new WebSocket(...)`
 *   const sock = FakeWebSocket.latest()
 *   sock.simulateOpen()
 *   sock.injectServerMessage({ type: 'hello', protocolVersion: 2 })
 *   sock.simulateDrop()                 // mid-stream close, no client-initiated close()
 *   vi.advanceTimersByTime(1000)        // let scheduleReconnect's timer fire
 *
 * Design notes:
 *  - `close()` mimics the DOM WebSocket contract: send() while CONNECTING
 *    throws (InvalidStateError-equivalent), send() while CLOSING/CLOSED is a
 *    silent no-op (per spec — data is discarded, no exception), and a client
 *    -initiated close() transitions CLOSING->CLOSED before firing 'close'.
 *  - `simulateDrop()` is deliberately distinct from `close()`: a network
 *    drop / server-initiated teardown goes straight from OPEN to CLOSED
 *    without ever visiting CLOSING, and always fires with `wasClean: false`
 *    — this is the shape production reconnect logic (chat.html's
 *    WebSocketEngine.scheduleReconnect) is actually built to react to.
 *  - All instances are tracked on the static `instances` array so test code
 *    (or the FakeWebSocket helpers themselves) can find "the socket the
 *    engine most recently created" after a reconnect — mirroring how the
 *    real WebSocket constructor is called fresh on every connect().
 */

type Listener = (evt: any) => void

export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  /** Every FakeWebSocket ever constructed since the last reset(). */
  static instances: FakeWebSocket[] = []

  readonly url: string
  readonly protocols?: string | string[]
  readyState: number = FakeWebSocket.CONNECTING

  private listeners: Record<string, Listener[]> = {}
  private sentRaw: string[] = []

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    FakeWebSocket.instances.push(this)
  }

  // ── DOM WebSocket surface ────────────────────────────────────────────────

  addEventListener(type: string, fn: Listener): void {
    ;(this.listeners[type] ||= []).push(fn)
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn)
  }

  send(data: string): void {
    if (this.readyState === FakeWebSocket.CONNECTING) {
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': still in CONNECTING state.",
        'InvalidStateError',
      )
    }
    if (this.readyState === FakeWebSocket.CLOSING || this.readyState === FakeWebSocket.CLOSED) {
      // Per spec: data is silently discarded, no throw.
      return
    }
    this.sentRaw.push(data)
  }

  /** Client-initiated close — goes through CLOSING before CLOSED. */
  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSING
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', { code, reason, wasClean: code === 1000 })
  }

  // ── Low-level scripting escape hatch (kept for parity with the inline
  //    MockWebSocket this replaces) ────────────────────────────────────────

  /** Fire an arbitrary event type/payload without any state transition. */
  fire(type: string, evt: any = {}): void {
    this.dispatch(type, evt)
  }

  // ── Contract-shaped scripting API — the surface follow-on WS fixes drive ──

  /** Transition CONNECTING -> OPEN and fire 'open'. No-op if already OPEN. */
  simulateOpen(): void {
    if (this.readyState === FakeWebSocket.OPEN) return
    this.readyState = FakeWebSocket.OPEN
    this.dispatch('open', {})
  }

  /** Fire a 'message' event. Accepts a pre-serialized string or a value to JSON.stringify. */
  simulateMessage(data: unknown): void {
    const payload = typeof data === 'string' ? data : JSON.stringify(data)
    this.dispatch('message', { data: payload })
  }

  /** Alias for simulateMessage with an object — reads better at call sites that inject server frames. */
  injectServerMessage(frame: Record<string, unknown>): void {
    this.simulateMessage(frame)
  }

  /**
   * Mid-stream drop: OPEN -> CLOSED directly (no CLOSING), `wasClean: false`.
   * This is the shape a real network drop / server-killed-connection takes,
   * and is what scheduleReconnect-style production code is written against.
   */
  simulateDrop(code = 1006, reason = 'simulated drop'): void {
    this.readyState = FakeWebSocket.CLOSED
    this.dispatch('close', { code, reason, wasClean: false })
  }

  /** Fire a transport error without necessarily closing (mirrors a real 'error' event, which precedes 'close' but is not itself terminal). */
  simulateError(message = 'simulated transport error'): void {
    this.dispatch('error', { message })
  }

  /** Every frame sent over this socket, JSON-parsed (falls back to the raw string if parsing fails). */
  getSentMessages(): any[] {
    return this.sentRaw.map((raw) => {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    })
  }

  /** The raw (unparsed) strings passed to send(). */
  getRawSent(): string[] {
    return this.sentRaw.slice()
  }

  private dispatch(type: string, evt: any): void {
    for (const fn of (this.listeners[type] || []).slice()) fn(evt)
  }

  // ── Static helpers ───────────────────────────────────────────────────────

  /** Clear the instance registry. Call in beforeEach/afterEach. */
  static reset(): void {
    FakeWebSocket.instances = []
  }

  /** The most recently constructed instance — "the socket the engine under test just opened". */
  static latest(): FakeWebSocket | undefined {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  }

  /**
   * Drive `n` rapid open -> mid-stream-drop cycles ("flap"), advancing the
   * production code's own reconnect timer between each cycle via `advance`
   * so the engine under test has a chance to construct its NEXT socket
   * before the following flap. Throws if no socket exists to flap (i.e. the
   * engine never called `new WebSocket(...)` — connect() was never invoked,
   * or a previous reconnect never fired).
   *
   * `stepMs` defaults to 20_000ms, comfortably clearing chat.html's 16s
   * exponential-backoff ceiling so each flap iteration always lands on a
   * fresh socket instance.
   */
  static simulateFlap(n: number, opts: { advance: (ms: number) => void; stepMs?: number }): void {
    const stepMs = opts.stepMs ?? 20_000
    for (let i = 0; i < n; i++) {
      const sock = FakeWebSocket.latest()
      if (!sock) {
        throw new Error(`FakeWebSocket.simulateFlap: no socket instance to flap on iteration ${i}`)
      }
      sock.simulateOpen()
      sock.simulateDrop()
      opts.advance(stepMs)
    }
  }
}
