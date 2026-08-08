// @vitest-environment jsdom
//
// luna-chat-host.parity.test.ts - the runtime half of window.LunaChatHost's
// membership drift guard (stack23 S16c-host). chat-host.ts's
// CHAT_HOST_MEMBERS is the compile-time half, checked by `bun run
// typecheck` against the LunaChatHostApi interface; this file boots the REAL
// chat.html via the shared harness (the same technique
// luna-markdown.parity.test.ts uses for the standalone vendor script, but
// chat.html's publish block is NOT standalone-loadable - it needs the whole
// classic script - so this test goes through test/helpers/chat-harness.ts
// instead of a bare `new Function(src)`) and asserts the object it actually
// constructs against CHAT_HOST_MEMBER_NAMES, in both directions: a member
// added to chat.html without a matching .d.ts edit fails HERE (at runtime);
// a member added to the interface without a matching chat.html edit fails
// under typecheck (at compile time, via CHAT_HOST_MEMBERS).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CHAT_HOST_MEMBER_NAMES } from '../frontend-react/src/chat/chat-host'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  mountChatMessageListBridge,
  readChatHtml,
} from './helpers/chat-harness'

describe('window.LunaChatHost (stack23 S16c-host runtime parity)', () => {
  beforeEach(() => {
    const htmlContent = readChatHtml()
    mountChatDomFromHtml(htmlContent)

    const mockMe = {
      label: 'chat-test',
      listen: vi.fn(async () => () => {}),
      onMoved: vi.fn(async () => () => {}),
      isMinimized: vi.fn(async () => false),
      scaleFactor: vi.fn(async () => 1),
      outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
      outerSize: vi.fn(async () => ({ width: 560, height: 520 })),
      setPosition: vi.fn(async () => {}),
    }
    ;(window as any).__TAURI__ = {
      window: { getCurrentWindow: () => mockMe, Window: { getByLabel: vi.fn(async () => null) } },
      event: { listen: vi.fn(async () => () => {}) },
    }

    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'moon-dock.js')
    loadVendorInto(window, 'capabilities.js') // exposes window.LunaCapabilities

    localStorage.clear()

    const mount = mountChatMessageListBridge(document.getElementById('chat-messages'))
    evalChatInlineScriptWithBridge(htmlContent, mount)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__TAURI__
    delete (window as any).__MoonInternals
    delete (window as any).LunaChatHost
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    delete (window as any).LunaMarkdown
    delete (window as any).LunaDock
    delete (window as any).LunaCapabilities
    delete (window as any).ChatState
    delete (window as any).ChatLoop
    vi.restoreAllMocks()
  })

  it('is published as a frozen object once the classic script has run', () => {
    expect(window.LunaChatHost).toBeTruthy()
    expect(Object.isFrozen(window.LunaChatHost)).toBe(true)
  })

  it('exposes exactly the documented members - no more, no less', () => {
    expect(Object.keys(window.LunaChatHost!).sort()).toEqual([...CHAT_HOST_MEMBER_NAMES])
  })

  it('every member has the type luna-chat-host.d.ts declares', () => {
    const host = window.LunaChatHost!
    expect(typeof host.state).toBe('function')
    expect(typeof host.send).toBe('function')
    expect(typeof host.isConnected).toBe('function')
    expect(typeof host.clearTurnTimeout).toBe('function')
    expect(typeof host.startTurnTimeout).toBe('function')
    expect(typeof host.startSubscribeTimeout).toBe('function')
    expect(typeof host.sendNewThread).toBe('function')
    // GROUP C IS GONE as of S19k. appendMessage / newConversation /
    // autoGrowMessageInput were its last three members and were all
    // ChatEngine calls; ChatEngine is a module, so its callers hold it
    // directly. What is left is the wire and state reads.
    expect('appendMessage' in host).toBe(false)
    expect('newConversation' in host).toBe(false)
    expect('autoGrowMessageInput' in host).toBe(false)
    expect('closeLocalShellMenu' in host).toBe(false)
    expect('buildMessageMeta' in host).toBe(false)
    // S20b moved the capability provider to frames.ts with the `hello`
    // handler that clears its catalog, so these three left the host too.
    expect('backendCapabilities' in host).toBe(false)
    expect('executeCapability' in host).toBe(false)
    expect('dispatchFrame' in host).toBe(false)
  })

  it('state() returns the live State object (fields the ChatHostState interface names)', () => {
    const s = window.LunaChatHost!.state()
    expect(s).toHaveProperty('activeThreadId')
    expect(s).toHaveProperty('threadModels')
    expect(s).toHaveProperty('threadEfforts')
    expect(s).toHaveProperty('serverSupportsEffort')
    expect(s).toHaveProperty('serverSupportsWorkflows')
    expect(s).toHaveProperty('serverSupportsTurnComplete')
    expect(s).toHaveProperty('selectedEffort')
    expect(s).toHaveProperty('pinnedThread')
  })

  it('the frame layer starts with an empty backend catalog', () => {
    // Asserted on frames.ts, which owns the provider as of S20b. Same
    // behaviour, correct owner.
    expect((window as any).__MoonInternals.frames.backendCapabilities()).toEqual([])
  })

  it('executeCapability() resolves the real frame-provider\'s own unavailable path when no capability-catalog frame has arrived', async () => {
    const result = await (window as any).__MoonInternals.frames.executeCapability({ kind: 'command', id: 'nope', args: '' })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'unavailable' })
  })
})

describe('window.LunaChatHost executeCapability() absent-provider fallback (window.LunaCapabilities never loaded)', () => {
  beforeEach(() => {
    const htmlContent = readChatHtml()
    mountChatDomFromHtml(htmlContent)

    const mockMe = {
      label: 'chat-test',
      listen: vi.fn(async () => () => {}),
      onMoved: vi.fn(async () => () => {}),
      isMinimized: vi.fn(async () => false),
      scaleFactor: vi.fn(async () => 1),
      outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
      outerSize: vi.fn(async () => ({ width: 560, height: 520 })),
      setPosition: vi.fn(async () => {}),
    }
    ;(window as any).__TAURI__ = {
      window: { getCurrentWindow: () => mockMe, Window: { getByLabel: vi.fn(async () => null) } },
      event: { listen: vi.fn(async () => () => {}) },
    }

    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'moon-dock.js')
    // capabilities.js deliberately NOT loaded: window.LunaCapabilities stays
    // undefined, so chat.html's `_capProvider` guard (chat.html's "Backend-
    // advertised capabilities" block) never constructs a provider - this is
    // the only way to reach the absent-provider fallback this slice adds.

    localStorage.clear()

    const mount = mountChatMessageListBridge(document.getElementById('chat-messages'))
    evalChatInlineScriptWithBridge(htmlContent, mount)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__TAURI__
    delete (window as any).__MoonInternals
    delete (window as any).LunaChatHost
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    delete (window as any).LunaMarkdown
    delete (window as any).LunaDock
    delete (window as any).ChatState
    delete (window as any).ChatLoop
    vi.restoreAllMocks()
  })

  it('executeCapability() is total: resolves the declared absent-provider warning instead of rejecting', async () => {
    // frames.ts owns the provider as of S20b, so the totality guarantee is
    // asserted there. This is the ONLY path that reaches the absent-provider
    // branch: window.LunaCapabilities is deliberately never loaded above, so
    // createFrames never constructs a provider at all.
    const result = await (window as any).__MoonInternals.frames.executeCapability({ kind: 'command', id: 'nope', args: '' })
    expect(result).toEqual({ ok: false, error: 'capability layer unavailable', reason: 'unavailable' })
  })
})
