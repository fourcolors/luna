// @vitest-environment jsdom
//
// Behavioral tests for the SlashMenu engine in src/chat/SlashMenu.tsx - the
// UI-owned slash command menu driven by window.LunaCapabilities (the bundled
// @luna/capabilities). Mounted into chat.html via chat-harness.ts.
// Uses the same __MoonInternals harness as composer-config.test.ts.
//
// Coverage: open/filter on '/', kind-exclusion, arrow-nav highlight, Tab complete,
// Enter accept + dispatch, Esc (does not reach voice), mousedown accept, and the
// handleSubmit intercept for typed "/cmd args".
//
// Also covers src/chat/SmartBarEngine.tsx (stack23 S16d) - the composer's
// context-pill Smart Bar - driven through the SAME `internals().handleFrame`
// seam composer-config.test.ts's own `smart-bar`-frame test uses. These are
// the VANILLA-IDENTICAL differential probes: written and confirmed green
// against chat.html's former vanilla `SmartBarEngine` object BEFORE the S16d
// port, then reconfirmed green after - see SmartBarEngine.tsx's module doc
// for the one enumerated invisible-only delta (JSX's auto-escaping replacing
// the vanilla object's manual `_esc`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  mountChatMessageListBridge,
  readChatHtml,
} from './helpers/chat-harness'

describe('SlashMenu (src/chat/SlashMenu.tsx)', () => {
  let mockMe: any

  beforeEach(() => {
    const htmlContent = readChatHtml()
    mountChatDomFromHtml(htmlContent)

    mockMe = {
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

    vi.useFakeTimers()
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
    vi.useRealTimers()
  })

  const internals = () => (window as any).__MoonInternals as {
    SlashMenu: any
    ComposerConfig: any
    ChatEngine: any
    VoiceEngine: any
    WebSocketEngine: any
    State: any
    Attachments: any
    SmartBarEngine: any
    handleFrame: (f: any) => void
  }

  function seedModels(models: Array<{ id: string; label?: string; efforts?: string[] }>, effortSelection = true) {
    internals().handleFrame({
      type: 'hello', protocolVersion: 2,
      capabilities: { effortSelection }, availableModels: models,
    })
    internals().ComposerConfig.applyModels(models)
  }

  const menu = () => document.getElementById('slash-menu')!
  const items = () => Array.from(menu().querySelectorAll('.slash-menu-item'))
  const activeItems = () => Array.from(menu().querySelectorAll('.slash-menu-item.active'))
  const input = () => document.getElementById('message-input') as HTMLTextAreaElement

  function typeInComposer(v: string) {
    input().value = v
    input().dispatchEvent(new Event('input', { bubbles: true }))
  }
  function keyInComposer(key: string) {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  it('menu is hidden on load', () => {
    expect(menu().classList.contains('open')).toBe(false)
  })

  it('typing "/" opens the menu; without models only clear/new/help', () => {
    typeInComposer('/')
    expect(menu().classList.contains('open')).toBe(true)
    expect(items().map((el) => el.getAttribute('data-command'))).toEqual(['clear', 'new', 'help'])
  })

  it('typing "/" with models seeded includes /model and /effort', () => {
    seedModels([{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }])
    typeInComposer('/')
    const cmds = items().map((el) => el.getAttribute('data-command'))
    expect(cmds).toContain('model')
    expect(cmds).toContain('effort')
  })

  it('typing "/mo" filters to only the model command (models seeded)', () => {
    seedModels([{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }])
    typeInComposer('/mo')
    expect(items().map((el) => el.getAttribute('data-command'))).toEqual(['model'])
  })

  it('typing a non-slash line does not open the menu', () => {
    typeInComposer('hello luna')
    expect(menu().classList.contains('open')).toBe(false)
  })

  it('clearing the input closes the menu', () => {
    typeInComposer('/')
    expect(menu().classList.contains('open')).toBe(true)
    typeInComposer('')
    expect(menu().classList.contains('open')).toBe(false)
  })

  it('a trailing space (a complete verb) closes the menu', () => {
    typeInComposer('/clear ')
    expect(menu().classList.contains('open')).toBe(false)
  })

  it('ArrowDown moves the highlight to exactly one row', () => {
    typeInComposer('/')
    keyInComposer('ArrowDown')
    expect(activeItems()).toHaveLength(1)
    expect(activeItems()[0].getAttribute('data-command')).toBe('new') // 0->clear, down->new
  })

  it('Arrow nav wraps and keeps exactly one active row', () => {
    typeInComposer('/') // clear,new,help
    keyInComposer('ArrowUp') // wraps to last
    expect(activeItems()).toHaveLength(1)
    expect(activeItems()[0].getAttribute('data-command')).toBe('help')
  })

  it('Tab completes a single match to "/clear "', () => {
    typeInComposer('/cl')
    keyInComposer('Tab')
    expect(input().value).toBe('/clear ')
  })

  it('Enter accepts the highlighted command, dispatches it, and does NOT call handleSubmit', () => {
    const newConv = vi.spyOn(internals().ChatEngine, 'newConversation').mockImplementation(() => {})
    const submit = vi.spyOn(internals().ChatEngine, 'handleSubmit')
    typeInComposer('/clear')
    keyInComposer('Enter')
    expect(newConv).toHaveBeenCalledTimes(1)
    expect(input().value).toBe('')
    expect(submit).not.toHaveBeenCalled() // stopPropagation/preventDefault path
  })

  it('Esc closes the menu and does NOT reach VoiceEngine', () => {
    const voiceEsc = vi.spyOn(internals().VoiceEngine, 'handleEscape')
    typeInComposer('/')
    expect(menu().classList.contains('open')).toBe(true)
    keyInComposer('Escape')
    expect(menu().classList.contains('open')).toBe(false)
    expect(voiceEsc).not.toHaveBeenCalled()
  })

  it('mousedown on a row dispatches that command', () => {
    const newConv = vi.spyOn(internals().ChatEngine, 'newConversation').mockImplementation(() => {})
    typeInComposer('/')
    const clearRow = menu().querySelector('[data-command="clear"]') as HTMLElement
    clearRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    expect(newConv).toHaveBeenCalledTimes(1)
  })

  it('handleSubmit intercepts "/help" -> appendMessage(assistant), no user send', () => {
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    input().value = '/help'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    const roles = append.mock.calls.map((c: any[]) => c[0])
    expect(roles).toContain('assistant')
    expect(roles).not.toContain('user') // returned before the normal send path
    expect(input().value).toBe('')
  })

  it('handleSubmit intercepts "/model sonnet" -> _selectModel with the matched id', () => {
    seedModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: [] },
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
    ])
    const sel = vi.spyOn(internals().ComposerConfig, '_selectModel').mockImplementation(() => {})
    input().value = '/model sonnet'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(sel).toHaveBeenCalledWith('claude-sonnet-4-6')
  })

  it('SlashMenu open/close/isOpen API round-trips', () => {
    const SM = internals().SlashMenu
    expect(SM.isOpen()).toBe(false)
    SM.open()
    expect(SM.isOpen()).toBe(true)
    SM.close()
    expect(SM.isOpen()).toBe(false)
  })

  // ── Data-loss guard: argless verbs with trailing prose must NOT be commands ──
  function stubSendPath() {
    vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation(() => {})
    if (internals().VoiceEngine?.onUserSend) vi.spyOn(internals().VoiceEngine, 'onUserSend').mockImplementation(() => {})
  }

  it('"/new feature idea" is NOT a command — does not wipe the thread, sends as a message', () => {
    // A connected socket: WebSocketEngine.isConnected() gates handleSubmit's
    // send path on State.ws.readyState — without it this takes the offline
    // branch and never calls appendMessage('user', ...) at all.
    internals().State.ws = { readyState: WebSocket.OPEN, send: () => {} }
    const newConv = vi.spyOn(internals().ChatEngine, 'newConversation').mockImplementation(() => {})
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation(() => {})
    if (internals().VoiceEngine?.onUserSend) vi.spyOn(internals().VoiceEngine, 'onUserSend').mockImplementation(() => {})
    input().value = '/new feature idea'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(newConv).not.toHaveBeenCalled() // no thread wipe
    const userCalls = append.mock.calls.filter((c: any[]) => c[0] === 'user')
    expect(userCalls.length).toBeGreaterThanOrEqual(1)
    expect(userCalls[0][1]).toBe('/new feature idea') // prose preserved
  })

  it('"/clear notes" is NOT a command — sends as a message, no wipe', () => {
    const newConv = vi.spyOn(internals().ChatEngine, 'newConversation').mockImplementation(() => {})
    stubSendPath()
    input().value = '/clear notes'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(newConv).not.toHaveBeenCalled()
  })

  it('bare "/clear" IS a command — calls newConversation', () => {
    const newConv = vi.spyOn(internals().ChatEngine, 'newConversation').mockImplementation(() => {})
    input().value = '/clear'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(newConv).toHaveBeenCalledTimes(1)
  })

  it('"/help me write code" is NOT /help — sends as a message', () => {
    // A connected socket: WebSocketEngine.isConnected() gates handleSubmit's
    // send path on State.ws.readyState — without it this takes the offline
    // branch and never calls appendMessage('user', ...) at all.
    internals().State.ws = { readyState: WebSocket.OPEN, send: () => {} }
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation(() => {})
    if (internals().VoiceEngine?.onUserSend) vi.spyOn(internals().VoiceEngine, 'onUserSend').mockImplementation(() => {})
    input().value = '/help me write code'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    const userCalls = append.mock.calls.filter((c: any[]) => c[0] === 'user')
    expect(userCalls.length).toBeGreaterThanOrEqual(1)
    expect(userCalls[0][1]).toBe('/help me write code')
    expect(append.mock.calls.some((c: any[]) => /Available commands/.test(String(c[1])))).toBe(false)
  })

  // ── arg dispatch + error branches ──
  it('"/effort low" dispatches _selectEffort("low")', () => {
    seedModels([{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }])
    const sel = vi.spyOn(internals().ComposerConfig, '_selectEffort').mockImplementation(() => {})
    input().value = '/effort low'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(sel).toHaveBeenCalledWith('low')
  })

  it('"/effort default" dispatches _selectEffort("")', () => {
    seedModels([{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }])
    const sel = vi.spyOn(internals().ComposerConfig, '_selectEffort').mockImplementation(() => {})
    input().value = '/effort default'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(sel).toHaveBeenCalledWith('')
  })

  it('"/effort bogus" warns and does not call _selectEffort', () => {
    seedModels([{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }])
    const sel = vi.spyOn(internals().ComposerConfig, '_selectEffort').mockImplementation(() => {})
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    input().value = '/effort bogus'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(sel).not.toHaveBeenCalled()
    expect(append.mock.calls.some((c: any[]) => /Unknown effort/.test(String(c[1])))).toBe(true)
  })

  it('"/model zzz" warns and does not call _selectModel', () => {
    seedModels([{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }])
    const sel = vi.spyOn(internals().ComposerConfig, '_selectModel').mockImplementation(() => {})
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    input().value = '/model zzz'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(sel).not.toHaveBeenCalled()
    expect(append.mock.calls.some((c: any[]) => /Unknown model/.test(String(c[1])))).toBe(true)
  })

  it('"/model x" matching multiple models warns (no silent pick)', () => {
    seedModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: [] },
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
    ])
    const sel = vi.spyOn(internals().ComposerConfig, '_selectModel').mockImplementation(() => {})
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    input().value = '/model claude' // substring of both ids
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(sel).not.toHaveBeenCalled()
    expect(append.mock.calls.some((c: any[]) => /multiple models/.test(String(c[1])))).toBe(true)
  })

  // ── no-arg pickers: hand off to the REAL ComposerConfig bridge ──
  // dispatchModel/dispatchEffort's no-arg branch (SlashMenu.tsx:489-508)
  // reaches into the SAME #model-cfg-menu/#effort-cfg-menu nodes
  // ComposerConfig.tsx owns roots on, deferred one tick via setTimeout(0) so
  // the mouse-accept path's trailing document 'click' closer runs first -
  // driven here through the real bridge, not a stub, per this slice's NOTE.
  it('bare "/model" opens the picker via the REAL ComposerConfig bridge after setTimeout(0)', () => {
    seedModels([{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }])
    const rebuild = vi.spyOn(internals().ComposerConfig, '_rebuildModelMenu')
    const modelMenu = document.getElementById('model-cfg-menu') as HTMLElement
    const modelBtn = document.getElementById('model-cfg-btn') as HTMLElement
    input().value = '/model'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(modelMenu.classList.contains('open')).toBe(false) // deferred, not yet
    vi.advanceTimersByTime(0)
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(modelMenu.classList.contains('open')).toBe(true)
    expect(modelMenu.getAttribute('aria-hidden')).toBe('false')
    expect(modelBtn.getAttribute('aria-expanded')).toBe('true')
  })

  it('bare "/effort" opens the picker via the REAL ComposerConfig bridge when available', () => {
    const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }]
    seedModels(models)
    localStorage.setItem('luna_model', 'claude-fable-5')
    internals().ComposerConfig.applyModels(models)
    internals().ComposerConfig.applyCapability(true) // re-gates effortCfgBtn.hidden, mirrors composer-config.test.ts
    expect((document.getElementById('effort-cfg-btn') as HTMLButtonElement).hidden).toBe(false) // precondition
    const rebuild = vi.spyOn(internals().ComposerConfig, '_rebuildEffortMenu')
    const effortMenu = document.getElementById('effort-cfg-menu') as HTMLElement
    const effortBtn = document.getElementById('effort-cfg-btn') as HTMLElement
    input().value = '/effort'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(effortMenu.classList.contains('open')).toBe(false) // deferred, not yet
    vi.advanceTimersByTime(0)
    expect(rebuild).toHaveBeenCalledTimes(1)
    expect(effortMenu.classList.contains('open')).toBe(true)
    expect(effortMenu.getAttribute('aria-hidden')).toBe('false')
    expect(effortBtn.getAttribute('aria-expanded')).toBe('true')
  })

  it('bare "/effort" warns instead of opening when effortCfgBtn.hidden is true (dom.effortBtn.hidden read as truth)', () => {
    const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }]
    seedModels(models, false) // effortSelection:false
    localStorage.setItem('luna_model', 'claude-fable-5')
    internals().ComposerConfig.applyModels(models)
    internals().ComposerConfig.applyCapability(false)
    expect((document.getElementById('effort-cfg-btn') as HTMLButtonElement).hidden).toBe(true) // precondition
    const rebuild = vi.spyOn(internals().ComposerConfig, '_rebuildEffortMenu')
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    input().value = '/effort'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    vi.advanceTimersByTime(0)
    expect(rebuild).not.toHaveBeenCalled()
    expect(document.getElementById('effort-cfg-menu')!.classList.contains('open')).toBe(false)
    expect(append.mock.calls.some((c: any[]) => /not available for the current model/.test(String(c[1])))).toBe(true)
  })

  // ── a11y + focus ──
  it('aria-expanded + aria-activedescendant live on the textarea, not the listbox', () => {
    typeInComposer('/')
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe('slash-opt-clear')
    expect(menu().hasAttribute('aria-activedescendant')).toBe(false)
    keyInComposer('Escape')
    expect(input().getAttribute('aria-expanded')).toBe('false')
    expect(input().hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('blur on the composer closes the menu', () => {
    typeInComposer('/')
    expect(menu().classList.contains('open')).toBe(true)
    input().dispatchEvent(new FocusEvent('blur'))
    expect(menu().classList.contains('open')).toBe(false)
  })

  // ── attachments: wiped only by clear/new, preserved by settings/help ──
  it('dispatching "/clear" clears staged attachments (no stranded tray)', () => {
    vi.spyOn(internals().ChatEngine, 'newConversation').mockImplementation(() => {})
    const clear = vi.spyOn(internals().Attachments, 'clear')
    internals().Attachments.items = [{ id: 'att_x', kind: 'text' }]
    input().value = '/clear'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(clear).toHaveBeenCalled()
    expect(internals().Attachments.items).toEqual([])
  })

  it('dispatching "/help" preserves staged attachments', () => {
    vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    const clear = vi.spyOn(internals().Attachments, 'clear')
    input().value = '/help'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(clear).not.toHaveBeenCalled()
  })

  it('dispatching "/model sonnet" preserves staged attachments', () => {
    seedModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: [] }])
    vi.spyOn(internals().ComposerConfig, '_selectModel').mockImplementation(() => {})
    const clear = vi.spyOn(internals().Attachments, 'clear')
    input().value = '/model sonnet'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(clear).not.toHaveBeenCalled()
  })

  it('dispatching "/effort low" preserves staged attachments', () => {
    seedModels([{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }])
    vi.spyOn(internals().ComposerConfig, '_selectEffort').mockImplementation(() => {})
    const clear = vi.spyOn(internals().Attachments, 'clear')
    input().value = '/effort low'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(clear).not.toHaveBeenCalled()
  })

  // ── Backend-advertised capabilities (capability-catalog -> merge -> dispatch) ──
  const interruptCap = {
    kind: 'command', id: 'interrupt', title: 'Stop',
    description: 'Stop the current assistant turn', executor: 'server', schemaVersion: 1,
  }
  const sendCapCatalog = (caps: any[]) =>
    internals().handleFrame({ type: 'capability-catalog', catalog: { generation: 1, agreedSchema: 1, capabilities: caps } })

  it('a capability-catalog frame adds the backend command with a "luna" source chip', () => {
    sendCapCatalog([interruptCap])
    typeInComposer('/')
    expect(items().map((el) => el.getAttribute('data-command'))).toContain('interrupt')
    const row = menu().querySelector('[data-command="interrupt"]') as HTMLElement
    expect(row.querySelector('.source-chip')?.textContent).toBe('luna')
  })

  it('UI commands carry no source chip', () => {
    sendCapCatalog([interruptCap])
    typeInComposer('/')
    const clearRow = menu().querySelector('[data-command="clear"]') as HTMLElement
    expect(clearRow.querySelector('.source-chip')).toBeNull()
  })

  it('a UI command wins a (kind,id) collision and routes to the CLIENT (no backend frame)', () => {
    // A malicious/buggy backend advertising id:'clear', executor:'server' must NOT hijack /clear.
    sendCapCatalog([{ ...interruptCap, id: 'clear', title: 'Backend Clear', executor: 'server' }])
    const newConv = vi.spyOn(internals().ChatEngine, 'newConversation').mockImplementation(() => {})
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })
    typeInComposer('/clear')
    keyInComposer('Enter')
    expect(newConv).toHaveBeenCalledTimes(1) // the UI-owned client /clear ran
    expect(sent.some((f) => f.type === 'capability-execute')).toBe(false) // backend never invoked
    const row = menu().querySelector('[data-command="clear"]') as HTMLElement | null
    if (row) expect(row.querySelector('.source-chip')).toBeNull()
  })

  it('surfaces a backend command failure (capability-execute-result ok:false)', async () => {
    sendCapCatalog([interruptCap])
    internals().State.activeThreadId = 'thread-abc'
    const reqIds: string[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => {
      if (f.type === 'capability-execute') reqIds.push(f.requestId)
    })
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    typeInComposer('/interrupt')
    keyInComposer('Enter')
    expect(reqIds.length).toBe(1)
    internals().handleFrame({ type: 'capability-execute-result', requestId: reqIds[0], ok: false, message: 'no active turn' })
    await Promise.resolve(); await Promise.resolve()
    expect(append.mock.calls.some((c: any[]) => /no active turn/.test(String(c[1])))).toBe(true)
  })

  it('accepting /interrupt with an active thread sends a capability-execute frame', () => {
    sendCapCatalog([interruptCap])
    internals().State.activeThreadId = 'thread-abc'
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })
    typeInComposer('/interrupt')
    keyInComposer('Enter')
    const exec = sent.find((f) => f.type === 'capability-execute')
    expect(exec).toBeDefined()
    expect(exec.kind).toBe('command')
    expect(exec.id).toBe('interrupt')
    expect(exec.args).toMatchObject({ threadId: 'thread-abc' })
    expect(typeof exec.requestId).toBe('string')
  })

  it('a server command with no active thread warns and sends nothing', () => {
    sendCapCatalog([interruptCap])
    internals().State.activeThreadId = null
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })
    typeInComposer('/interrupt')
    keyInComposer('Enter')
    expect(sent.some((f) => f.type === 'capability-execute')).toBe(false)
    expect(append.mock.calls.some((c: any[]) => /No active conversation/.test(String(c[1])))).toBe(true)
  })

  it('the handleSubmit intercept dispatches a typed "/interrupt" + Enter', () => {
    sendCapCatalog([interruptCap])
    internals().State.activeThreadId = 'thread-xyz'
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })
    input().value = '/interrupt'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    expect(sent.some((f) => f.type === 'capability-execute' && f.id === 'interrupt')).toBe(true)
  })

  it('a malformed capability-catalog frame is ignored; the menu still works', () => {
    internals().handleFrame({ type: 'capability-catalog', catalog: { capabilities: 'nope' } })
    typeInComposer('/')
    expect(menu().classList.contains('open')).toBe(true)
    expect(items().map((el) => el.getAttribute('data-command'))).not.toContain('interrupt')
  })

  it('every hello clears the previous backend catalog (server-swap safety)', () => {
    sendCapCatalog([interruptCap])
    typeInComposer('/')
    expect(items().map((el) => el.getAttribute('data-command'))).toContain('interrupt')
    // A fresh hello — even from another COMMAND-CAPABLE server (commands:true) — must drop
    // the stale catalog until that server's own capability-catalog frame arrives. Clearing
    // only on the absent flag would let server A's commands keep routing to server B.
    internals().handleFrame({ type: 'hello', protocolVersion: 2, capabilities: { commands: true }, availableModels: [] })
    typeInComposer('/')
    expect(items().map((el) => el.getAttribute('data-command'))).not.toContain('interrupt')
  })

  // ── RULING R3 regression: the /help line is ORACLE-PINNED product copy ──
  it('the /help output line for a known command is em-dash separated (ORACLE-PINNED, RULING R3)', () => {
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    input().value = '/help'
    internals().ChatEngine.handleSubmit({ preventDefault() {} })
    const helpMsg = append.mock.calls.map((c: any[]) => String(c[1])).find((m) => /Available commands/.test(m))
    expect(helpMsg).toContain('/clear — Start a new conversation')
  })

  // ── Seam pins: window.LunaChatHost (stack23 S16c-host) degrades, never throws ──
  //
  // Object.freeze forbids deleting a single member off the live host, so both
  // pins below swap the WHOLE window.LunaChatHost global instead of poking one
  // accessor - see chat-host.ts's HOST_ABSENT fallback and the standing
  // late-bound-read rule (chat.html's own construction-site comment).
  it('with the capability provider gone, the menu builds only local commands without throwing', () => {
    // RETARGETED at the frame layer (stack23 S20b). The backend catalog used
    // to live in chat.html behind LunaChatHost.backendCapabilities, so
    // deleting the host was how you simulated "no backend commands". The
    // provider moved to frames.ts with the `hello` handler that clears it, so
    // the honest equivalent is emptying THAT - deleting the host now only
    // removes state reads and the wire, which is a different scenario.
    sendCapCatalog([interruptCap])
    vi.spyOn(internals().frames, 'backendCapabilities').mockReturnValue([])
    expect(() => typeInComposer('/')).not.toThrow()
    expect(items().map((el) => el.getAttribute('data-command'))).toEqual(['clear', 'new', 'help'])
  })

  it('with executeCapability unavailable, a backend-command dispatch surfaces the host-unavailable warning instead of throwing (RULING 3a: executeCapability is total)', async () => {
    sendCapCatalog([interruptCap])
    internals().State.activeThreadId = 'thread-abc'
    // Swap in a host whose executeCapability resolves the same {ok:false}
    // shape chat-host.ts's HOST_ABSENT fallback does - backendCapabilities()
    // stays real so '/interrupt' is still found and routed as executor:'server'.
    // Stubbed on the FRAME LAYER, which owns executeCapability as of S20b.
    // backendCapabilities() stays real so '/interrupt' is still found and
    // routed as executor:'server' - the point is the execute path, not lookup.
    vi.spyOn(internals().frames, 'executeCapability').mockResolvedValue(
      { ok: false, error: 'chat host unavailable', reason: 'unavailable' } as never,
    )
    const append = vi.spyOn(internals().ChatEngine, 'appendMessage').mockImplementation(() => {})
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })
    typeInComposer('/interrupt')
    expect(() => keyInComposer('Enter')).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    // The ONE declared test-visible delta from totalizing executeCapability:
    // an unavailable result now surfaces the warning line rather than
    // silently doing nothing.
    expect(append.mock.calls.some((c: any[]) => /⚠️ chat host unavailable/.test(String(c[1])))).toBe(true)
  })

  // ── SmartBar (src/chat/SmartBarEngine.tsx, stack23 S16d) ──────────────────
  //
  // Differential probes for the context-pill Smart Bar, driven through the
  // real `smart-bar` frame handler (chat.html) -> SmartBarEngine.applyFrame
  // seam, exactly like a real server push. Ported 1:1 from the vanilla
  // object's `_render`/`_renderItem` logic - see SmartBarEngine.tsx's module
  // doc.
  describe('SmartBar (src/chat/SmartBarEngine.tsx)', () => {
    const smartBar = () => document.getElementById('smart-bar')!
    const pills = () => Array.from(smartBar().querySelectorAll('.sb-item'))

    function sendSmartBar(items: any[], threadId = 'thr-1') {
      internals().handleFrame({ type: 'smart-bar', threadId, version: 1, items })
    }

    it('the bar is hidden on load', () => {
      expect(smartBar().hidden).toBe(true)
    })

    it('a single info item renders one pill and unhides the bar', () => {
      sendSmartBar([{ id: 'git.worktree', kind: 'info', label: 'branch', value: 'main', icon: '⎇' }])
      expect(smartBar().hidden).toBe(false)
      expect(pills()).toHaveLength(1)
      const pill = pills()[0]
      expect(pill.querySelector('.sb-lbl')!.textContent).toBe('branch')
      expect(pill.querySelector('.sb-val')!.textContent).toBe('main')
      expect(pill.querySelector('.sb-ic')!.textContent).toBe('⎇')
    })

    it('non-"info" kinds are silently skipped (v1: info only)', () => {
      sendSmartBar([{ id: 'x', kind: 'warning', label: 'a', value: 'b' }])
      expect(smartBar().hidden).toBe(true)
      expect(pills()).toHaveLength(0)
    })

    it('sorts rendered pills by group then priority (lower priority number = leftmost)', () => {
      sendSmartBar([
        { id: 'b', kind: 'info', group: 'z', priority: 1, value: 'B' },
        { id: 'a', kind: 'info', group: 'a', priority: 2, value: 'A2' },
        { id: 'c', kind: 'info', group: 'a', priority: 1, value: 'A1' },
      ])
      expect(pills().map((p) => p.querySelector('.sb-val')!.textContent)).toEqual(['A1', 'A2', 'B'])
    })

    it('an item with no priority sorts after prioritized items in the same group (default 999)', () => {
      sendSmartBar([
        { id: 'a', kind: 'info', group: 'g', value: 'no-priority' },
        { id: 'b', kind: 'info', group: 'g', priority: 1, value: 'has-priority' },
      ])
      expect(pills().map((p) => p.querySelector('.sb-val')!.textContent)).toEqual(['has-priority', 'no-priority'])
    })

    it('the git.worktree item gets the flagship accent class; others do not', () => {
      sendSmartBar([
        { id: 'git.worktree', kind: 'info', value: 'main' },
        { id: 'other', kind: 'info', value: 'x' },
      ])
      expect(pills()[0]!.classList.contains('sb-flagship')).toBe(true)
      expect(pills()[1]!.classList.contains('sb-flagship')).toBe(false)
    })

    it('tone "good"/"warn" map to sb-good/sb-warn; a plain item gets neither', () => {
      sendSmartBar([
        { id: 'ok', kind: 'info', value: '1', tone: 'good' },
        { id: 'bad', kind: 'info', value: '2', tone: 'warn' },
        { id: 'plain', kind: 'info', value: '3' },
      ])
      const [ok, warn, plain] = pills()
      expect(ok!.classList.contains('sb-good')).toBe(true)
      expect(warn!.classList.contains('sb-warn')).toBe(true)
      expect(plain!.classList.contains('sb-good')).toBe(false)
      expect(plain!.classList.contains('sb-warn')).toBe(false)
    })

    it('a tooltip becomes the pill\'s title attribute; no tooltip means no title attribute', () => {
      sendSmartBar([
        { id: 'x', kind: 'info', value: '1', tooltip: 'hover text' },
        { id: 'y', kind: 'info', value: '2' },
      ])
      const [withTip, withoutTip] = pills()
      expect(withTip!.getAttribute('title')).toBe('hover text')
      expect(withoutTip!.hasAttribute('title')).toBe(false)
    })

    it('omits the icon/label/value spans entirely when the item omits them (not just empties them)', () => {
      sendSmartBar([{ id: 'x', kind: 'info' }])
      const pill = pills()[0]!
      expect(pill.querySelector('.sb-ic')).toBeNull()
      expect(pill.querySelector('.sb-lbl')).toBeNull()
      expect(pill.querySelector('.sb-val')).toBeNull()
    })

    it('a value of 0 still renders (present-but-falsy, not treated as absent)', () => {
      sendSmartBar([{ id: 'x', kind: 'info', value: 0 }])
      expect(pills()[0]!.querySelector('.sb-val')!.textContent).toBe('0')
    })

    it('a later frame REPLACES the bar wholesale, it does not merge with the previous one', () => {
      sendSmartBar([
        { id: 'a', kind: 'info', value: '1' },
        { id: 'b', kind: 'info', value: '2' },
      ])
      expect(pills()).toHaveLength(2)
      sendSmartBar([{ id: 'c', kind: 'info', value: '3' }])
      expect(pills()).toHaveLength(1)
      expect(pills()[0]!.querySelector('.sb-val')!.textContent).toBe('3')
    })

    it('an empty items array hides the bar again', () => {
      sendSmartBar([{ id: 'a', kind: 'info', value: '1' }])
      expect(smartBar().hidden).toBe(false)
      sendSmartBar([])
      expect(smartBar().hidden).toBe(true)
    })

    it('HTML-special characters in label/value render as literal text, never as markup', () => {
      sendSmartBar([{ id: 'x', kind: 'info', label: '<b>&"', value: '<i>tag</i>' }])
      const pill = pills()[0]!
      expect(pill.querySelector('.sb-lbl')!.textContent).toBe('<b>&"')
      expect(pill.querySelector('.sb-val')!.textContent).toBe('<i>tag</i>')
      expect(pill.querySelector('.sb-val')!.querySelector('i')).toBeNull() // never parsed as an element
    })

    it('a malformed frame (items missing/non-array) degrades to an empty, hidden bar without throwing', () => {
      sendSmartBar([{ id: 'a', kind: 'info', value: '1' }])
      expect(smartBar().hidden).toBe(false)
      expect(() => internals().handleFrame({ type: 'smart-bar', threadId: 'thr-1', version: 1 })).not.toThrow()
      expect(smartBar().hidden).toBe(true)
      expect(pills()).toHaveLength(0)
    })
  })
})
