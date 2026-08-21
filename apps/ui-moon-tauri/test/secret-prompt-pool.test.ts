// @vitest-environment jsdom
/**
 * secret-prompt-pool.test.ts - secure secret entry against a GENUINELY
 * connected PoolEngine (#500).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM chat-window.test.ts's secret suite.
 * That suite already covers submit / cancel / the OPEN guard and is green -
 * but every one of its connected cases calls the `setWs` helper first, which
 * assigns `State.ws` BY HAND and additionally flips `PoolEngine._isConnected`
 * and stubs `_adapter`. It fabricates precisely the precondition that
 * production cannot produce: PoolEngine, the default engine since #489, never
 * assigns `State.ws` at all.
 *
 * So the tests were not wrong about behaviour - they were testing a world the
 * shipped app is never in. Here the socket is brought up the way the page
 * actually brings it up (boot -> open -> hello), and nothing is stuffed.
 *
 * BEFORE THE FIX, `secret entry works on the default engine` FAILS: the
 * operator sees "Not connected." while fully connected and no secret-result
 * frame is ever sent, because SecretPromptEngine gates on `State.ws` instead
 * of the engine-aware `isConnected()` predicate that chat.html already
 * provides (and that the engine-swap block patches to delegate to PoolEngine).
 *
 * The guard itself is not removable, and `the guard still holds when the pool
 * is genuinely down` is here to keep anyone from "fixing" this by deleting it:
 * BOTH engines' send() log the WHOLE FRAME when not connected, so an
 * unguarded send puts the secret in the console.
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

describe('secure secret entry on the default PoolEngine (#500)', () => {
  const M = () => (window as any).__MoonInternals
  const input = () => document.getElementById('secret-prompt-input') as HTMLInputElement
  const status = () => document.getElementById('secret-prompt-status') as HTMLElement
  const panel = () => document.getElementById('secret-prompt-panel') as HTMLElement

  beforeEach(() => {
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
    for (const f of ['moon-protocol.js', 'moon-ws.js', 'moon-markdown.js', 'moon-dock.js', 'pool-engine.js', 'moon-session.js']) {
      loadVendorInto(window, f)
    }
    ;(window as any).LunaTransport = LunaTransport

    localStorage.clear()
    // The DEFAULT engine since #489. Set before eval: USE_POOL_ENGINE is
    // computed once at script-eval time.
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

  const settle = async (steps = 5, ms = 50) => {
    for (let i = 0; i < steps; i++) await vi.advanceTimersByTimeAsync(ms)
  }

  /** Bring the pool up the way the page does - no State.ws stuffing. */
  const bringUp = async () => {
    await settle()
    const sock = FakeWebSocket.latest()
    expect(sock, 'boot should have created a socket').toBeTruthy()
    sock!.simulateOpen()
    sock!.simulateMessage({ type: 'hello', protocolVersion: 2, capabilities: {} })
    await settle()
    return sock!
  }

  const showRequest = () =>
    M().handleFrame({
      type: 'secret-request',
      requestId: 'req-1',
      prompt: 'Paste the API key for FooCorp',
      destinationLabel: 'env:FOOCORP_API_KEY',
    })

  it('the pool really is connected, and State.ws really is null', async () => {
    // The premise of the whole file, asserted rather than assumed. If either
    // half of this ever changes, the tests below stop meaning what they say.
    await bringUp()
    expect(M().WebSocketEngine.isConnected(), 'the engine reports connected').toBe(true)
    expect(M().State.ws, 'PoolEngine never assigns State.ws').toBeNull()
  })

  it('secret entry works on the default engine', async () => {
    await bringUp()
    const sendSpy = vi.spyOn(M().PoolEngine, 'send').mockImplementation(() => {})
    showRequest()
    input().value = 'sk-live-12345'
    document.getElementById('secret-prompt-submit')!.click()

    expect(sendSpy, 'the secret must actually reach the wire').toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0]![0]).toEqual({
      type: 'secret-result',
      requestId: 'req-1',
      secret: 'sk-live-12345',
    })
    expect(status().textContent).toBe('Saving…')
    expect(input().value, 'one-shot - the secret is never retained').toBe('')
  })

  it('cancel reaches the server, so the pending request does not dangle', async () => {
    await bringUp()
    const sendSpy = vi.spyOn(M().PoolEngine, 'send').mockImplementation(() => {})
    showRequest()
    input().value = 'half-typed'
    document.getElementById('secret-prompt-cancel')!.click()

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'secret-result',
      requestId: 'req-1',
      cancelled: true,
    })
    expect(input().value).toBe('')
    expect(panel().hidden).toBe(true)
  })

  it('the guard still holds when the pool is genuinely down', async () => {
    // Do NOT delete the guard to fix #500. Both engines' send() log the whole
    // frame when not connected, so an unguarded send leaks the secret to the
    // console - which is the entire reason the guard is before send(), not
    // inside it.
    const sock = await bringUp()
    const sendSpy = vi.spyOn(M().PoolEngine, 'send').mockImplementation(() => {})
    showRequest()
    sock.simulateDrop()
    await settle()

    expect(M().WebSocketEngine.isConnected()).toBe(false)
    input().value = 'sk-secret'
    document.getElementById('secret-prompt-submit')!.click()

    expect(sendSpy, 'a disconnected send would log the secret').not.toHaveBeenCalled()
    expect(status().textContent).toBe('Not connected.')
    // Not wiped: the operator can retry once the reconnect lands.
    expect(input().value).toBe('sk-secret')
  })

  it('a stashed user message flushes once the pool reconnects', async () => {
    // flushPendingUserMessage has the same root cause: it asks the patched
    // predicate AND THEN re-checks the raw socket, so under PoolEngine the
    // second clause is always false and the stash never drains.
    await bringUp()
    const sendSpy = vi.spyOn(M().PoolEngine, 'send').mockImplementation(() => {})
    M().State.activeThreadId = 'thr-1'
    M().State.pendingUserMessage = { threadId: 'thr-1', text: 'queued while offline' }

    // Driven through the real path - the thread-snapshot handler flushes the
    // stash - rather than by calling the private function directly.
    M().handleFrame({ type: 'thread-snapshot', threadId: 'thr-1', messages: [] })

    // The snapshot handler sends other frames too, so look for ours rather
    // than pinning an index.
    const sent = sendSpy.mock.calls.map((c) => c[0] as any)
    expect(
      sent.filter((f) => f?.type === 'user-message'),
      'the stash must drain on a connected pool',
    ).toHaveLength(1)
    expect(sent.find((f) => f?.type === 'user-message')).toMatchObject({
      type: 'user-message',
      threadId: 'thr-1',
      text: 'queued while offline',
    })
  })
})
