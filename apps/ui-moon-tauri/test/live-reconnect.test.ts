// @vitest-environment jsdom
/**
 * live-reconnect.test.ts - the S18/S20a hands-on gate, made repeatable.
 *
 * SKIPPED unless LUNA_LIVE_WS is set, so it never runs in CI or a normal
 * `vitest run`. It needs a real chat-server listening, which the suite cannot
 * assume.
 *
 * WHY IT EXISTS. S20a moved boot ownership into the module and changed WHEN
 * the socket opens relative to construction; S20d then deleted chat.html's
 * script entirely. The jsdom suite proves the ORDER with a FakeWebSocket, but
 * a fake socket cannot tell you the real ladder still reconnects to a real
 * server after a real restart. That was written down as an owed human check.
 * It turned out not to need hands: it needs a server, a kill, and a wait.
 *
 * WHAT IT DOES NOT COVER. This runs in jsdom against Node's WebSocket, NOT in
 * a WKWebView. It verifies the boot ordering and the reconnect ladder against
 * a live server; it does not verify WKWebView-specific socket behaviour. The
 * gate is narrowed, not eliminated.
 *
 * To run it:
 *
 *   # 1. a server on an ISOLATED data dir - never point this at ~/.luna
 *   LUNA_HOME=/tmp/luna-live LUNA_DISABLE_VECTORLITE=1 LUNA_WAKE_ENABLED=0 \
 *     LUNA_SCHEDULER_V2_ENABLED=0 LUNA_UI_WS_HOST=127.0.0.1 \
 *     bun apps/server/src/chat-server.ts
 *
 *   # 2. the gate
 *   LUNA_LIVE_WS=ws://127.0.0.1:4753/ui LUNA_LIVE_TOKEN=<token> \
 *     npx vitest run apps/ui-moon-tauri/test/live-reconnect.test.ts
 *
 *   # 3. while it waits, kill the server and start it again
 *
 * A NOTE ON THE ISOLATED LUNA_HOME, learned the hard way: restarting against a
 * real ~/.luna failed to boot ("no such module: vectorlite") and the test then
 * reported "did not reconnect" - a FALSE POSITIVE with no server to reconnect
 * to. Always confirm the server actually came back before believing this test.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import * as LunaTransport from '@luna/ui-transport/browser'
import {
  evalChatInlineScriptWithBridge, loadVendorInto, mountChatDomFromHtml, readChatHtml,
} from './helpers/chat-harness'

const LIVE = !!process.env.LUNA_LIVE_WS
const d = LIVE ? describe : describe.skip

d('LIVE: real socket against a real chat-server', () => {
  beforeAll(() => {
    const html = readChatHtml()
    mountChatDomFromHtml(html)
    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: () => ({
          label: 'live', listen: vi.fn(async () => () => {}), onMoved: vi.fn(async () => () => {}),
          isMinimized: vi.fn(async () => false), scaleFactor: vi.fn(async () => 1),
          outerPosition: vi.fn(async () => ({ x: 0, y: 0 })), outerSize: vi.fn(async () => ({ width: 560, height: 520 })),
          setPosition: vi.fn(async () => {}),
        }),
        Window: { getByLabel: vi.fn(async () => null) },
      },
      event: { listen: vi.fn(async () => () => {}) },
    }
    for (const f of ['moon-protocol.js','moon-ws.js','moon-markdown.js','moon-dock.js','pool-engine.js']) {
      loadVendorInto(window, f)
    }
    ;(window as any).LunaTransport = LunaTransport
    localStorage.clear()
    localStorage.setItem('luna_pool_engine', '1')            // the DEFAULT engine
    localStorage.setItem('luna_ws_url', process.env.LUNA_LIVE_WS!)
    localStorage.setItem('luna_ws_token', process.env.LUNA_LIVE_TOKEN || '')
    evalChatInlineScriptWithBridge()
  })

  const M = () => (window as any).__MoonInternals
  const wait = async (pred: () => boolean, ms = 25000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (pred()) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    return false
  }

  it('connects to the real server', async () => {
    const ok = await wait(() => M().WebSocketEngine.isConnected())
    console.log('LIVE connected:', ok, 'status:', document.getElementById('connection-status')?.textContent)
    expect(ok).toBe(true)
  }, 40000)

  it('reconnects after the server is restarted', async () => {
    expect(M().WebSocketEngine.isConnected()).toBe(true)
    console.log('LIVE >>> now restart the server')
    const dropped = await wait(() => !M().WebSocketEngine.isConnected(), 40000)
    console.log('LIVE saw the drop:', dropped)
    expect(dropped).toBe(true)
    const back = await wait(() => M().WebSocketEngine.isConnected(), 60000)
    console.log('LIVE reconnected:', back, 'status:', document.getElementById('connection-status')?.textContent)
    expect(back).toBe(true)
  }, 120000)
})
