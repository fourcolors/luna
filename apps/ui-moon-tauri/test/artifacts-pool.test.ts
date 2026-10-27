// @vitest-environment jsdom
/**
 * artifacts-pool.test.ts - artifact Pin/Unpin against a GENUINELY connected
 * PoolEngine (same #500 class as secret-prompt-pool.test.ts).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM chat-window.test.ts's artifacts suite.
 * That suite already covers Pin sending an artifact-pin frame - but its
 * beforeEach calls the `setWs` helper, which assigns `State.ws` BY HAND with
 * a fake OPEN socket. It fabricates precisely the precondition that
 * production cannot produce: PoolEngine, the default engine since #489, never
 * assigns `State.ws` at all.
 *
 * So the tests were not wrong about behaviour - they were testing a world the
 * shipped app is never in. Here the socket is brought up the way the page
 * actually brings it up (boot -> open -> hello), and nothing is stuffed.
 *
 * BEFORE THE FIX, `pin sends artifact-pin on the default engine` FAILS: the
 * operator clicks Pin, nothing is sent, and the popped-out widget (which
 * renders pinned artifacts only) opens empty - because ArtifactsEngine gated
 * pin/unpin on `State.ws.readyState === WebSocket.OPEN` instead of the
 * engine-aware `isConnected()` predicate that chat.html already provides (and
 * that the engine-swap block patches to delegate to PoolEngine).
 *
 * The guard itself is not removable, and `the guard still holds when the pool
 * is genuinely down` is here to keep anyone from "fixing" this by deleting it:
 * the pin frame carries artifact content, and both engines' send() log the
 * whole frame when not connected.
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

describe('artifacts Pin/Unpin on the default PoolEngine', () => {
  const M = () => (window as any).__MoonInternals

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

  const injectSessionArtifact = () => {
    M().ArtifactsEngine.applySession({
      type: 'artifacts-extracted',
      threadId: 'th-1',
      messageId: 'msg-1',
      messageSeq: 0,
      artifacts: [
        { id: 'msg-1:0', source: 'code-fence', path: null, lang: 'js',
          title: 'Snippet', content: 'console.log(42)' },
      ],
    })
  }

  it('the pool really is connected, and State.ws really is null', async () => {
    // The premise of the whole file, asserted rather than assumed. If either
    // half of this ever changes, the tests below stop meaning what they say.
    await bringUp()
    expect(M().WebSocketEngine.isConnected(), 'the engine reports connected').toBe(true)
    expect(M().State.ws, 'PoolEngine never assigns State.ws').toBeNull()
  })

  it('pin sends artifact-pin on the default engine', async () => {
    await bringUp()
    const sendSpy = vi.spyOn(M().PoolEngine, 'send').mockImplementation(() => {})
    M().ArtifactsEngine.openPanel()
    injectSessionArtifact()

    const sessionList = document.getElementById('artifacts-session-list')!
    const pinBtn = sessionList.querySelector('.artifact-row-btn') as HTMLButtonElement
    expect(pinBtn).not.toBeNull()
    expect(pinBtn.textContent).toBe('Pin')
    pinBtn.click()

    expect(sendSpy, 'the pin must actually reach the wire').toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0]![0]).toMatchObject({
      type: 'artifact-pin',
      id: 'msg-1:0',
      title: 'Snippet',
      content: 'console.log(42)',
      lang: 'js',
    })
  })

  it('unpin sends artifact-unpin on the default engine', async () => {
    await bringUp()
    const sendSpy = vi.spyOn(M().PoolEngine, 'send').mockImplementation(() => {})
    M().ArtifactsEngine.applyPinned([
      { id: 'pin-1', kind: 'code', title: 'My Script', lang: 'python', content: 'print("hi")',
        origin: null, version: 2, pinnedAt: 1, updatedAt: 1 },
    ])
    M().ArtifactsEngine.openPanel()

    const pinnedList = document.getElementById('artifacts-pinned-list')!
    const unpinBtn = pinnedList.querySelector('.artifact-row-btn.danger') as HTMLButtonElement
    expect(unpinBtn).not.toBeNull()
    expect(unpinBtn.textContent).toBe('Unpin')
    unpinBtn.click()

    expect(sendSpy, 'the unpin must actually reach the wire').toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0]![0]).toEqual({ type: 'artifact-unpin', id: 'pin-1' })
  })

  it('the guard still holds when the pool is genuinely down', async () => {
    // Do NOT delete the guard to fix this. The pin frame carries artifact
    // content, and both engines' send() log the whole frame when not
    // connected - which is the entire reason the guard is before send(),
    // not inside it.
    const sock = await bringUp()
    const sendSpy = vi.spyOn(M().PoolEngine, 'send').mockImplementation(() => {})
    M().ArtifactsEngine.openPanel()
    injectSessionArtifact()
    sock.simulateDrop()
    await settle()

    expect(M().WebSocketEngine.isConnected()).toBe(false)
    const sessionList = document.getElementById('artifacts-session-list')!
    const pinBtn = sessionList.querySelector('.artifact-row-btn') as HTMLButtonElement
    pinBtn.click()

    expect(sendSpy, 'a disconnected pin would log the artifact content').not.toHaveBeenCalled()
  })
})
