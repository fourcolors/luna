// @vitest-environment jsdom
//
// moon-threads-permutation-matrix.test.ts - PR 350 state combination verification suite.
// Tests all permutations of:
// - State.threadDrawerOpen (true vs false)
// - State.pinnedThread (set vs null)
// - State.activeThreadId (set vs null)
// - USE_POOL_ENGINE (true vs false)
//
// Plus cold-start stored file thread variations (fileThreadId set vs null).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { evalChatInlineScriptWithBridge, mountChatMessageListBridge } from './helpers/chat-harness'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

function fakeOpenSocket() {
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
  }
}

describe('PR 350 Thread State Combination Matrix', () => {
  let htmlContent: string

  beforeEach(() => {
    window.history.replaceState({}, '', '/')
    htmlContent = fs.readFileSync(path.resolve(__dirname, '../frontend-react/chat.html'), 'utf8')
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

    const mockMe = {
      label: 'chat-test',
      listen: vi.fn(async () => () => {}),
      onMoved: vi.fn(async () => () => {}),
      isMinimized: vi.fn(async () => false),
      scaleFactor: vi.fn(async () => 1),
      outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
      outerSize: vi.fn(async () => ({ width: 560, height: 520 })),
      setPosition: vi.fn(async () => {}),
      startDragging: vi.fn(async () => {}),
    }
    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: () => mockMe,
        Window: { getByLabel: vi.fn(async () => null) },
      },
      event: { listen: vi.fn(async () => () => {}) },
    }

    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'moon-dock.js')

    localStorage.clear()

    vi.stubGlobal('WebSocket', class {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      readyState = 0
      url: string
      onopen: any = null; onclose: any = null; onerror: any = null; onmessage: any = null
      constructor(url: string) { this.url = url }
      send() {}
      close() { this.readyState = 3 }
      addEventListener() {}
      removeEventListener() {}
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__TAURI__
    delete (window as any).__MoonInternals
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    delete (window as any).LunaMarkdown
    delete (window as any).LunaDock
    delete (window as any).__LUNA_POOL_ENGINE
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function initApp(opts: { poolEngine?: boolean } = {}) {
    if (opts.poolEngine) {
      localStorage.setItem('luna_pool_engine', '1')
    } else {
      localStorage.removeItem('luna_pool_engine')
    }

    // THROUGH THE BRIDGED LOADER (stack23 S19j). This file used to eval
    // chat.html's inline script bare, with no module bridge - which worked
    // only while ThreadDrawerEngine was still a chat.html const. It is a
    // module now, so a bare eval leaves it undefined and every assertion
    // here dies on `undefined.requestList`. chat-harness is what wires the
    // module side the way production wires it.
    const mount = mountChatMessageListBridge(document.getElementById('chat-messages'))
    evalChatInlineScriptWithBridge(htmlContent, mount)

    return (window as any).__MoonInternals
  }

  // Define 16 permutations:
  const drawerStates = [false, true]
  const pinnedStates = [null, 'pinned-th-100']
  const activeStates = [null, 'active-th-200']
  const engineStates = [false, true]

  // Matrix loop generating 16 core test cases
  for (const usePoolEngine of engineStates) {
    const engineName = usePoolEngine ? 'PoolEngine' : 'WebSocketEngine'

    for (const drawerOpen of drawerStates) {
      for (const pinnedThread of pinnedStates) {
        for (const activeThreadId of activeStates) {
          const testName = `[${engineName}] drawerOpen=${drawerOpen}, pinned=${pinnedThread ? 'SET' : 'NULL'}, active=${activeThreadId ? 'SET' : 'NULL'}`

          it(testName, async () => {
            const m = initApp({ poolEngine: usePoolEngine })
            const activeEngine = usePoolEngine ? m.PoolEngine : m.WebSocketEngine

            // Setup mocks
            m.State.ws = fakeOpenSocket()
            if (usePoolEngine) {
              m.PoolEngine._isConnected = true
            }
            m.State.threadDrawerOpen = drawerOpen
            m.State.pinnedThread = pinnedThread
            m.State.activeThreadId = activeThreadId
            m.State.skipLastThreadFile = false

            // Stub get_last_thread_id for cold-start cases
            const invokeSpy = vi.fn(async (cmd: string) => {
              if (cmd === 'get_last_thread_id') return 'file-th-300'
              return null
            })
            if ((window as any).__TAURI__) {
              ;(window as any).__TAURI__.core = { invoke: invokeSpy }
            }

            const poolSendSpy = vi.spyOn(m.PoolEngine, 'send').mockImplementation(() => {})
            const wsSendSpy = usePoolEngine
              ? vi.spyOn(m.WebSocketEngine, 'send').mockImplementation((frame) => m.PoolEngine.send(frame))
              : vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

            const sendSpy = usePoolEngine ? poolSendSpy : wsSendSpy

            await activeEngine.syncThread()

            if (pinnedThread) {
              // PINNED THREAD SET: Must ALWAYS subscribe to pinnedThread and NEVER list-threads
              expect(sendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: pinnedThread })
              expect(sendSpy).not.toHaveBeenCalledWith({ type: 'list-threads' })
              expect(m.State.activeThreadId).toBe(pinnedThread)
            } else if (activeThreadId) {
              // FAST PATH (activeThreadId SET, pinned NULL): Must subscribe to activeThreadId
              expect(sendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: activeThreadId })

              if (drawerOpen) {
                // Bug #56 fix: Drawer is open -> requestList() fires -> list-threads sent!
                expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
              } else {
                // Drawer is closed -> list-threads MUST NOT be sent!
                expect(sendSpy).not.toHaveBeenCalledWith({ type: 'list-threads' })
              }
            } else {
              // COLD START (activeThreadId NULL, pinned NULL):
              // Reads fileThreadId ("file-th-300")
              expect(sendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'file-th-300' })
              expect(m.State.activeThreadId).toBe('file-th-300')

              if (drawerOpen) {
                // Bug #56 fix: Cold start with stored file ID + open drawer -> list-threads sent!
                expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
              } else {
                // Drawer is closed -> list-threads MUST NOT be sent!
                expect(sendSpy).not.toHaveBeenCalledWith({ type: 'list-threads' })
              }
            }
          })
        }
      }
    }
  }

  describe('Cold-start subcases: No stored thread ID (fileThreadId === null)', () => {
    for (const usePoolEngine of engineStates) {
      const engineName = usePoolEngine ? 'PoolEngine' : 'WebSocketEngine'

      for (const drawerOpen of drawerStates) {
        it(`[${engineName}] cold start with NO stored thread ID (drawerOpen=${drawerOpen})`, async () => {
          const m = initApp({ poolEngine: usePoolEngine })
          const activeEngine = usePoolEngine ? m.PoolEngine : m.WebSocketEngine

          m.State.ws = fakeOpenSocket()
          if (usePoolEngine) m.PoolEngine._isConnected = true
          m.State.threadDrawerOpen = drawerOpen
          m.State.pinnedThread = null
          m.State.activeThreadId = null
          m.State.skipLastThreadFile = false

          // Return null for get_last_thread_id
          const invokeSpy = vi.fn(async () => null)
          if ((window as any).__TAURI__) {
            ;(window as any).__TAURI__.core = { invoke: invokeSpy }
          }

          const sendSpy = vi.spyOn(activeEngine, 'send').mockImplementation(() => {})

          await activeEngine.syncThread()

          // With NO stored thread ID and NO active ID, syncThread MUST list-threads to bootstrap
          expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
          expect(m.State.threadListAutoSelectPending).toBe(true)
        })
      }
    }
  })

  describe('Server Switch (skipLastThreadFile === true)', () => {
    for (const usePoolEngine of engineStates) {
      const engineName = usePoolEngine ? 'PoolEngine' : 'WebSocketEngine'

      it(`[${engineName}] server switch discards activeThreadId & fileThreadId and lists fresh`, async () => {
        const m = initApp({ poolEngine: usePoolEngine })
        const activeEngine = usePoolEngine ? m.PoolEngine : m.WebSocketEngine

        m.State.ws = fakeOpenSocket()
        m.State.threadDrawerOpen = true
        m.State.pinnedThread = null
        m.State.activeThreadId = 'stale-thread-old-server'
        m.State.skipLastThreadFile = true

        const invokeSpy = vi.fn(async () => 'file-thread-old-server')
        if ((window as any).__TAURI__) {
          ;(window as any).__TAURI__.core = { invoke: invokeSpy }
        }

        const sendSpy = vi.spyOn(activeEngine, 'send').mockImplementation(() => {})

        await activeEngine.syncThread()

        // Server switch must ignore activeThreadId and fileThreadId, and issue list-threads with autoSelect=true
        expect(sendSpy).not.toHaveBeenCalledWith({ type: 'subscribe', threadId: 'stale-thread-old-server' })
        expect(sendSpy).not.toHaveBeenCalledWith({ type: 'subscribe', threadId: 'file-thread-old-server' })
        expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
        expect(m.State.threadListAutoSelectPending).toBe(true)
      })
    }
  })

  describe('Thread List Frame Auto-select vs Data Refresh Safety', () => {
    it('requestList() from open drawer fast-path does NOT set threadListAutoSelectPending', async () => {
      const m = initApp({ poolEngine: false })
      m.State.ws = fakeOpenSocket()
      m.State.activeThreadId = 'my-existing-thread'
      m.State.threadDrawerOpen = true

      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

      await m.WebSocketEngine.syncThread()

      expect(sendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'my-existing-thread' })
      expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
      // Crucial invariant: threadListAutoSelectPending MUST be false so drawer data refresh does not overwrite activeThreadId!
      expect(m.State.threadListAutoSelectPending).toBe(false)
    })
  })
})
