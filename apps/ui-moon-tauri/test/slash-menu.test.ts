// @vitest-environment jsdom
//
// Behavioral tests for the SlashMenu engine in chat.html — the UI-owned slash
// command menu driven by window.LunaCapabilities (the bundled @luna/capabilities).
// Uses the same __MoonInternals harness as composer-config.test.ts.
//
// Coverage: open/filter on '/', kind-exclusion, arrow-nav highlight, Tab complete,
// Enter accept + dispatch, Esc (does not reach voice), mousedown accept, and the
// handleSubmit intercept for typed "/cmd args".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

describe('SlashMenu (chat.html)', () => {
  let mockMe: any

  beforeEach(() => {
    const htmlContent = fs.readFileSync(path.resolve(__dirname, '../frontend/chat.html'), 'utf8')
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
    }
    ;(window as any).__TAURI__ = {
      window: { getCurrentWindow: () => mockMe, Window: { getByLabel: vi.fn(async () => null) } },
      event: { listen: vi.fn(async () => () => {}) },
    }

    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'deck-snap.js')
    loadVendorInto(window, 'moon-dock.js')
    loadVendorInto(window, 'capabilities.js') // exposes window.LunaCapabilities

    localStorage.clear()

    const inlineScripts = [...htmlContent.matchAll(/<script>([\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .filter((s) => s.includes('WebSocketEngine'))
    expect(inlineScripts).toHaveLength(1)
    new Function(inlineScripts[0])()

    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__TAURI__
    delete (window as any).__MoonInternals
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    delete (window as any).LunaMarkdown
    delete (window as any).LunaDeckSnap
    delete (window as any).LunaDock
    delete (window as any).LunaCapabilities
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
})
