// @vitest-environment jsdom
/**
 * feedback-pool.test.ts - point-at-the-UI feedback against a GENUINELY
 * connected PoolEngine.
 *
 * Same class of bug, same shape of proof, as secret-prompt-pool.test.ts (#500)
 * - FeedbackEngine simply never got the fix. The operator reported the feedback
 * composer saying "not connected" while the app was plainly connected and
 * chatting.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM feedback-picker.test.ts. That suite
 * already covers the picker, submit, the OPEN guard and the ack, and is green -
 * but every one of its connected cases assigns `State.ws` BY HAND, and it boots
 * WITHOUT `luna_pool_engine`, so it runs the LEGACY WebSocketEngine, whose
 * isConnected() does read `State.ws`. It fabricates precisely the precondition
 * production cannot produce: PoolEngine, the default engine since #489, never
 * assigns `State.ws` at all.
 *
 * So those tests were not wrong about behaviour - they were testing a world the
 * shipped app is never in. Here the socket is brought up the way the page
 * actually brings it up (boot -> open -> hello), and nothing is stuffed.
 *
 * BEFORE THE FIX, `feedback submits on the default engine` FAILS: the operator
 * sees "Not connected." while fully connected and no feedback-submit frame is
 * ever sent, because FeedbackEngine gated on `State.ws` instead of the
 * engine-aware `isConnected()` predicate chat.html already provides.
 *
 * The guard itself is not removable, and `the guard still holds when the pool is
 * genuinely down` is here to keep anyone from "fixing" this by deleting it.
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

describe('point-at-the-UI feedback on the default PoolEngine', () => {
  const M = () => (window as any).__MoonInternals
  const btn = () => document.getElementById('feedback-btn') as HTMLButtonElement
  const input = () => document.getElementById('feedback-input') as HTMLTextAreaElement
  const submitBtn = () => document.getElementById('feedback-submit-btn') as HTMLButtonElement
  const status = () => document.getElementById('feedback-status') as HTMLElement

  beforeEach(() => {
    mountChatDomFromHtml(readChatHtml())
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
    try { M()?.FeedbackEngine?.cancelPicker() } catch { /* noop */ }
    ;(document as any).elementFromPoint = undefined
    document.body.innerHTML = ''
    for (const k of ['__TAURI__', '__MoonInternals', 'LunaChatHost', 'LunaTransport', 'ChatState', 'ChatLoop', 'Attachments', 'ComposerConfig']) {
      delete (window as any)[k]
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const settle = async (steps = 5, ms = 50) => {
    for (let i = 0; i < steps; i++) await vi.advanceTimersByTimeAsync(ms)
  }
  const flushMicrotasks = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  /** Bring the pool up the way the page does - no State.ws stuffing.
   *
   *  The hello goes over the real socket (that is what makes isConnected()
   *  genuinely true, which is the whole point of this file). It is then ALSO
   *  replayed through handleFrame, the same way feedback-picker.test.ts
   *  delivers it, because the capability-gated chrome (#feedback-btn) is
   *  painted by the page's hello handler rather than by the pool adapter's
   *  connection bookkeeping. Only the CONNECTIVITY is under test here, and
   *  that half is never stubbed. */
  const bringUp = async (caps: Record<string, unknown> = { feedback: true }) => {
    await settle()
    const sock = FakeWebSocket.latest()
    expect(sock, 'boot should have created a socket').toBeTruthy()
    sock!.simulateOpen()
    sock!.simulateMessage({ type: 'hello', protocolVersion: 2, capabilities: caps })
    await settle()
    M().handleFrame({ type: 'hello', protocolVersion: 2, capabilities: caps, availableModels: [] })
    return sock!
  }

  /** Point the picker at a stable, always-present element and write a note. */
  const composeFeedback = async (note: string) => {
    ;(document as any).elementFromPoint = () => document.getElementById('message-input')!
    btn().click()
    document.body.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }))
    input().value = note
    input().dispatchEvent(new Event('input'))
    submitBtn().click()
    await flushMicrotasks()
  }

  it('the pool really is connected, and State.ws really is null', async () => {
    // The premise of the whole file, asserted rather than assumed. If either
    // half of this ever changes, the test below stops meaning what it says.
    await bringUp()
    expect(M().WebSocketEngine.isConnected(), 'the engine reports connected').toBe(true)
    expect(M().State.ws, 'PoolEngine never assigns State.ws').toBeNull()
  })

  it('feedback submits on the default engine', async () => {
    await bringUp()
    expect(btn().hidden, 'capabilities.feedback should reveal the button').toBe(false)

    const sent: any[] = []
    vi.spyOn(M().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })

    await composeFeedback('the send button is too small')

    const frames = sent.filter((f) => f.type === 'feedback-submit')
    expect(status().textContent, 'the operator must NOT be told they are offline').not.toMatch(/not connected/i)
    expect(frames, 'exactly one feedback-submit frame should reach the server').toHaveLength(1)
    expect(frames[0].note).toBe('the send button is too small')
    expect(frames[0].target.id).toBe('message-input')
  })

  it('the guard still holds when the pool is genuinely down', async () => {
    const sock = await bringUp()
    sock.simulateDrop()
    await settle()
    expect(M().WebSocketEngine.isConnected()).toBe(false)

    const sent: any[] = []
    vi.spyOn(M().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })

    await composeFeedback('this should not be sent')

    expect(sent.filter((f) => f.type === 'feedback-submit')).toHaveLength(0)
    expect(status().textContent).toMatch(/not connected/i)
  })
})
