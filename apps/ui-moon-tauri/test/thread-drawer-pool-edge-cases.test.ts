// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

describe('ThreadDrawerEngine & PoolEngine Stress & Edge Case Tests', () => {
  let htmlContent: string
  let mockMe: any

  const setupEnv = (usePoolEngine: boolean = false) => {
    window.history.replaceState({}, '', '/')
    htmlContent = fs.readFileSync(path.resolve(__dirname, '../frontend-react/chat.html'), 'utf8')
    const bodyMatch = htmlContent.match(/<body>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

    mockMe = {
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
    if (usePoolEngine) {
      loadVendorInto(window, 'pool-engine.js')
      localStorage.setItem('luna_pool_engine', '1')
    } else {
      localStorage.removeItem('luna_pool_engine')
    }

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

    const inlineScripts = [...htmlContent.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .filter((s) => s.includes('WebSocketEngine'))
    new Function(inlineScripts[0])()

    return (window as any).__MoonInternals
  }

  afterEach(() => {
    localStorage.removeItem('luna_pool_engine')
  })

  describe('1. Dynamic State Toggling: threadDrawerOpen', () => {
    it('requestList correctly reflects live threadDrawerOpen status changes (Legacy Mode)', () => {
      const m = setupEnv(false)
      m.State.ws = { readyState: 1, send: vi.fn() }
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send')

      // Closed -> no-op
      m.State.threadDrawerOpen = false
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).not.toHaveBeenCalled()

      // Dynamically toggle to Open -> requestList sends
      m.State.threadDrawerOpen = true
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })

      sendSpy.mockClear()

      // Dynamically toggle back to Closed -> no-op
      m.State.threadDrawerOpen = false
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('requestList correctly reflects live threadDrawerOpen status changes (PoolEngine Mode)', () => {
      const m = setupEnv(true)
      expect(m.USE_POOL_ENGINE).toBe(true)
      m.State.ws = null
      m.PoolEngine._isConnected = true

      const sendSpy = vi.spyOn(m.PoolEngine, 'send').mockImplementation(() => {})

      // Closed -> no-op
      m.State.threadDrawerOpen = false
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).not.toHaveBeenCalled()

      // Open -> sends
      m.State.threadDrawerOpen = true
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })

      sendSpy.mockClear()

      // Closed -> no-op
      m.State.threadDrawerOpen = false
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).not.toHaveBeenCalled()
    })
  })

  describe('2. Dynamic State Toggling: Connection Status (isConnected)', () => {
    it('Legacy Mode: requestList respects WebSocketEngine.isConnected() state transitions', () => {
      const m = setupEnv(false)
      m.State.threadDrawerOpen = true
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send')

      // Disconnected (ws null) -> no-op
      m.State.ws = null
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).not.toHaveBeenCalled()

      // Disconnected (readyState CLOSED = 3) -> no-op
      m.State.ws = { readyState: 3, send: vi.fn() }
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).not.toHaveBeenCalled()

      // Connected (readyState OPEN = 1) -> sends
      m.State.ws = { readyState: 1, send: vi.fn() }
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })

      sendSpy.mockClear()

      // Disconnect dynamically -> no-op
      m.State.ws.readyState = 3
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('PoolEngine Mode: requestList respects PoolEngine.isConnected() state transitions', () => {
      const m = setupEnv(true)
      m.State.threadDrawerOpen = true
      const sendSpy = vi.spyOn(m.PoolEngine, 'send').mockImplementation(() => {})

      // Disconnected -> no-op
      m.PoolEngine._isConnected = false
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).not.toHaveBeenCalled()

      // Connected -> sends
      m.PoolEngine._isConnected = true
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })

      sendSpy.mockClear()

      // Disconnect dynamically -> no-op
      m.PoolEngine._isConnected = false
      m.ThreadDrawerEngine.requestList()
      expect(sendSpy).not.toHaveBeenCalled()
    })
  })

  describe('3. PoolEngine.syncThread & WebSocketEngine.syncThread Feature Parity', () => {
    it('Fast-path: both engines request list IF AND ONLY IF drawer is open', async () => {
      // Test PoolEngine
      const mPool = setupEnv(true)
      mPool.PoolEngine._isConnected = true
      mPool.State.activeThreadId = 'thread-1'
      mPool.State.skipLastThreadFile = false
      const poolSendSpy = vi.spyOn(mPool.PoolEngine, 'send').mockImplementation(() => {})

      // Closed drawer
      mPool.State.threadDrawerOpen = false
      await mPool.PoolEngine.syncThread()
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'thread-1' })
      expect(poolSendSpy).not.toHaveBeenCalledWith({ type: 'list-threads' })

      poolSendSpy.mockClear()

      // Open drawer
      mPool.State.threadDrawerOpen = true
      await mPool.PoolEngine.syncThread()
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'thread-1' })
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'list-threads' })

      // Test Legacy WebSocketEngine
      const mWs = setupEnv(false)
      mWs.State.ws = { readyState: 1, send: vi.fn() }
      mWs.State.activeThreadId = 'thread-1'
      mWs.State.skipLastThreadFile = false
      const wsSendSpy = vi.spyOn(mWs.WebSocketEngine, 'send')

      // Closed drawer
      mWs.State.threadDrawerOpen = false
      await mWs.WebSocketEngine.syncThread()
      expect(wsSendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'thread-1' })
      expect(wsSendSpy).not.toHaveBeenCalledWith({ type: 'list-threads' })

      wsSendSpy.mockClear()

      // Open drawer
      mWs.State.threadDrawerOpen = true
      await mWs.WebSocketEngine.syncThread()
      expect(wsSendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'thread-1' })
      expect(wsSendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
    })

    it('Cold-start with stored thread ID: requests list IF AND ONLY IF drawer is open', async () => {
      const m = setupEnv(true)
      m.PoolEngine._isConnected = true
      m.State.activeThreadId = null
      m.State.skipLastThreadFile = false

      // Mock Tauri invoke to return a stored thread ID
      ;(window as any).__TAURI__.core = {
        invoke: vi.fn(async (cmd: string) => {
          if (cmd === 'get_last_thread_id') return 'stored-thread-99'
          return null
        })
      }

      const poolSendSpy = vi.spyOn(m.PoolEngine, 'send').mockImplementation(() => {})

      // Drawer closed
      m.State.threadDrawerOpen = false
      await m.PoolEngine.syncThread()
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'stored-thread-99' })
      expect(poolSendSpy).not.toHaveBeenCalledWith({ type: 'list-threads' })

      poolSendSpy.mockClear()

      // Reset state for open drawer test
      m.State.activeThreadId = null
      m.State.threadDrawerOpen = true
      await m.PoolEngine.syncThread()
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'stored-thread-99' })
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
    })

    it('Cold-start fallback (no stored thread): ALWAYS requests list regardless of drawer state', async () => {
      const m = setupEnv(true)
      m.PoolEngine._isConnected = true
      m.State.activeThreadId = null
      m.State.skipLastThreadFile = true

      const poolSendSpy = vi.spyOn(m.PoolEngine, 'send').mockImplementation(() => {})

      m.State.threadDrawerOpen = false
      await m.PoolEngine.syncThread()
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
      expect(m.State.threadListAutoSelectPending).toBe(true)

      poolSendSpy.mockClear()
      m.State.skipLastThreadFile = true
      m.State.threadDrawerOpen = true
      await m.PoolEngine.syncThread()
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
      expect(m.State.threadListAutoSelectPending).toBe(true)
    })

    it('Pinned window: syncThread NEVER requests list even if drawer was open', async () => {
      const m = setupEnv(true)
      m.PoolEngine._isConnected = true
      m.State.pinnedThread = 'pinned-123'
      m.State.threadDrawerOpen = true

      const poolSendSpy = vi.spyOn(m.PoolEngine, 'send').mockImplementation(() => {})

      await m.PoolEngine.syncThread()
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'pinned-123' })
      expect(poolSendSpy).not.toHaveBeenCalledWith({ type: 'list-threads' })
    })
  })

  describe('4. Async Race Conditions & Dynamic Toggling During Cold Start', () => {
    it('Drawer opened during async resolveBootThread is correctly detected upon resolution', async () => {
      const m = setupEnv(true)
      m.PoolEngine._isConnected = true
      m.State.activeThreadId = null
      m.State.skipLastThreadFile = false
      m.State.threadDrawerOpen = false

      let resolveThreadPromise: (id: string) => void = () => {}
      const threadPromise = new Promise<string>((resolve) => {
        resolveThreadPromise = resolve
      })

      // Inject MoonSession with deferred promise
      ;(window as any).MoonSession = {
        resolveBootThread: vi.fn(() => threadPromise)
      }
      ;(window as any).winLabel = 'panel-chat'

      const poolSendSpy = vi.spyOn(m.PoolEngine, 'send').mockImplementation(() => {})

      // Initiate syncThread (which awaits resolveBootThread)
      const syncPromise = m.PoolEngine.syncThread()

      // User opens the drawer mid-flight
      m.State.threadDrawerOpen = true

      // Resolve stored thread ID
      resolveThreadPromise('async-stored-thread')
      await syncPromise

      // Verify subscribe and list-threads were sent because drawer is now open
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'async-stored-thread' })
      expect(poolSendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
    })
  })
})
