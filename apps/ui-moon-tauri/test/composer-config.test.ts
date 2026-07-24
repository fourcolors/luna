// @vitest-environment jsdom
//
// Behavioral tests for the ComposerConfig engine in chat.html.
// Uses the same __MoonInternals harness as chat-window.test.ts.
//
// Coverage:
//  - capability gating hides/shows the effort control
//  - per-model efforts list is used for the effort menu
//  - model pick writes luna_model, effort pick writes luna_effort
//  - sendNewThread includes effort for a capable model and omits for haiku/legacy
//  - live model/effort pick sends set-thread-config when a thread is active
//  - thread-config deferred / rejected / applied reconciliation
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

describe('ComposerConfig (chat.html)', () => {
  let windowEventHandlers: Record<string, (e: { payload: any }) => void>
  let mockMe: any
  let wsSent: any[]

  beforeEach(() => {
    const htmlContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend-react/chat.html'),
      'utf8',
    )
    const bodyMatch = htmlContent.match(/<body>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

    windowEventHandlers = {}
    wsSent = []
    mockMe = {
      label: 'chat-test',
      listen: vi.fn(async (name: string, cb: (e: { payload: any }) => void) => {
        windowEventHandlers[name] = cb
        return () => {}
      }),
      onMoved: vi.fn(async () => () => {}),
      isMinimized: vi.fn(async () => false),
      scaleFactor: vi.fn(async () => 1),
      outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
      outerSize: vi.fn(async () => ({ width: 560, height: 520 })),
      setPosition: vi.fn(async () => {}),
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
    delete (window as any).LunaDock
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const internals = () => (window as any).__MoonInternals as {
    ComposerConfig: any
    State: any
    WebSocketEngine: any
    handleFrame: (f: any) => void
  }

  // ── Helper: send a hello with models + optional effortSelection cap ───────
  function sendHello(opts: {
    models?: Array<{ id: string; label?: string; efforts?: string[] }>
    effortSelection?: boolean
  } = {}) {
    internals().handleFrame({
      type: 'hello',
      protocolVersion: 2,
      capabilities: { effortSelection: opts.effortSelection ?? false },
      availableModels: opts.models ?? [],
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  describe('capability gating', () => {
    it('effort button + separator are hidden by default (no hello yet)', () => {
      expect(document.getElementById('effort-cfg-btn')!.hidden).toBe(true)
      expect(document.getElementById('effort-cfg-sep')!.hidden).toBe(true)
    })

    it('effort button stays hidden when effortSelection cap is false even if model has efforts', () => {
      sendHello({
        models: [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }],
        effortSelection: false,
      })
      expect(document.getElementById('effort-cfg-btn')!.hidden).toBe(true)
      expect(document.getElementById('effort-cfg-sep')!.hidden).toBe(true)
    })

    it('effort button + sep are shown when cap is true AND model has efforts', () => {
      sendHello({
        models: [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }],
        effortSelection: true,
      })
      // need to select that model in localStorage
      localStorage.setItem('luna_model', 'claude-fable-5')
      // re-apply models to trigger refresh
      internals().ComposerConfig.applyModels([
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
      ])
      internals().ComposerConfig.applyCapability(true)
      expect(document.getElementById('effort-cfg-btn')!.hidden).toBe(false)
      expect(document.getElementById('effort-cfg-sep')!.hidden).toBe(false)
    })

    it('effort button hidden when model efforts is empty (e.g. haiku)', () => {
      sendHello({
        models: [{ id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] }],
        effortSelection: true,
      })
      localStorage.setItem('luna_model', 'claude-haiku-4-5')
      internals().ComposerConfig.applyModels([
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
      ])
      internals().ComposerConfig.applyCapability(true)
      expect(document.getElementById('effort-cfg-btn')!.hidden).toBe(true)
    })

    it('composer-config cluster is hidden when no models advertised', () => {
      sendHello({ models: [] })
      expect(document.getElementById('composer-config')!.hidden).toBe(true)
    })

    it('composer-config cluster is shown when models are advertised', () => {
      sendHello({ models: [{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: [] }] })
      expect(document.getElementById('composer-config')!.hidden).toBe(false)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  describe('model menu — lists server-provided models', () => {
    it('model cfg button shows the label of the selected model', () => {
      sendHello({
        models: [{ id: 'claude-fable-5', label: 'Fable 5 (1M context)', efforts: ['max'] }],
      })
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels([
        { id: 'claude-fable-5', label: 'Fable 5 (1M context)', efforts: ['max'] },
      ])
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Fable 5 (1M context)')
    })

    it('model menu rebuilds with correct items when opened', () => {
      const models = [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: [] },
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
      ]
      sendHello({ models })
      internals().ComposerConfig.applyModels(models)
      // Trigger menu rebuild
      internals().ComposerConfig._rebuildModelMenu()
      const items = document.querySelectorAll('#model-cfg-menu .cfg-menu-item')
      expect(items).toHaveLength(2)
      expect(items[0].querySelector('span')!.textContent).toBe('Sonnet 4.6')
      expect(items[1].querySelector('span')!.textContent).toBe('Fable 5')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  describe('effort menu — lists current model efforts', () => {
    it('effort menu contains exactly the selected model efforts', () => {
      const models = [
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'medium', 'high', 'max'] },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
      ]
      sendHello({ models, effortSelection: true })
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig._rebuildEffortMenu()
      const items = document.querySelectorAll('#effort-cfg-menu .cfg-menu-item')
      // items = Default + 4 efforts
      expect(items).toHaveLength(5)
      const effortLabels = Array.from(items).map((el) => el.querySelector('span')!.textContent)
      expect(effortLabels).toContain('Default')
      expect(effortLabels).toContain('Low')
      expect(effortLabels).toContain('Max')
    })

    it('effort menu has only Default when model has no efforts (haiku)', () => {
      const models = [{ id: 'claude-haiku-4-5', label: 'Haiku', efforts: [] }]
      sendHello({ models, effortSelection: true })
      localStorage.setItem('luna_model', 'claude-haiku-4-5')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig._rebuildEffortMenu()
      const items = document.querySelectorAll('#effort-cfg-menu .cfg-menu-item')
      expect(items).toHaveLength(1) // only Default
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  describe('localStorage writes', () => {
    it('selecting a model writes luna_model', () => {
      const models = [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: [] },
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
      ]
      sendHello({ models })
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig._selectModel('claude-fable-5')
      expect(localStorage.getItem('luna_model')).toBe('claude-fable-5')
    })

    it('selecting an effort writes luna_effort', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }]
      sendHello({ models, effortSelection: true })
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig._selectEffort('max')
      expect(localStorage.getItem('luna_effort')).toBe('max')
    })

    it('selecting Default effort removes luna_effort from localStorage', () => {
      localStorage.setItem('luna_effort', 'max')
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }]
      sendHello({ models, effortSelection: true })
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig._selectEffort('')
      expect(localStorage.getItem('luna_effort')).toBeNull()
    })

    it('switching to a model that lacks the saved effort clears luna_effort', () => {
      localStorage.setItem('luna_effort', 'max')
      localStorage.setItem('luna_model', 'claude-fable-5')
      const models = [
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
        { id: 'claude-haiku-4-5', label: 'Haiku', efforts: [] },
      ]
      sendHello({ models, effortSelection: true })
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig._selectModel('claude-haiku-4-5')
      // max is not in haiku's efforts → cleared
      expect(localStorage.getItem('luna_effort')).toBeNull()
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  describe('sendNewThread payload', () => {
    // Intercept WebSocket.send to capture frames sent
    function interceptWsSend() {
      const sent: any[] = []
      const orig = internals().WebSocketEngine.send.bind(internals().WebSocketEngine)
      vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((frame: any) => {
        sent.push(frame)
        return orig(frame)
      })
      return sent
    }

    it('includes effort when effortSelection cap is true and effort is valid for model', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      localStorage.setItem('luna_model', 'claude-fable-5')
      localStorage.setItem('luna_effort', 'max')
      internals().ComposerConfig.applyModels(models)
      const sent = interceptWsSend()
      internals().WebSocketEngine.sendNewThread()
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ type: 'new-thread', model: 'claude-fable-5', effort: 'max' })
    })

    it('omits effort when server cap is false', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }]
      sendHello({ models, effortSelection: false })
      internals().State.serverSupportsEffort = false
      localStorage.setItem('luna_model', 'claude-fable-5')
      localStorage.setItem('luna_effort', 'max')
      internals().ComposerConfig.applyModels(models)
      const sent = interceptWsSend()
      internals().WebSocketEngine.sendNewThread()
      expect(sent).toHaveLength(1)
      expect(sent[0]).not.toHaveProperty('effort')
    })

    it('omits effort when model efforts list is empty (haiku / legacy)', () => {
      const models = [{ id: 'claude-haiku-4-5', label: 'Haiku', efforts: [] }]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      localStorage.setItem('luna_model', 'claude-haiku-4-5')
      localStorage.setItem('luna_effort', 'max')  // stale effort from a different model
      internals().ComposerConfig.applyModels(models)
      const sent = interceptWsSend()
      internals().WebSocketEngine.sendNewThread()
      expect(sent).toHaveLength(1)
      expect(sent[0]).not.toHaveProperty('effort')
    })

    it('omits effort when no effort is set', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      localStorage.setItem('luna_model', 'claude-fable-5')
      // no luna_effort set
      internals().ComposerConfig.applyModels(models)
      const sent = interceptWsSend()
      internals().WebSocketEngine.sendNewThread()
      expect(sent).toHaveLength(1)
      expect(sent[0]).not.toHaveProperty('effort')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  describe('live mid-thread set-thread-config', () => {
    function interceptWsSend() {
      const sent: any[] = []
      vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((frame: any) => {
        sent.push(frame)
      })
      return sent
    }

    it('selecting a model mid-thread sends set-thread-config with model', () => {
      const models = [
        { id: 'claude-sonnet-4-6', label: 'Sonnet', efforts: [] },
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
      ]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thread-abc'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(models)
      const sent = interceptWsSend()
      internals().ComposerConfig._selectModel('claude-fable-5')
      expect(sent.some((f: any) => f.type === 'set-thread-config' && f.model === 'claude-fable-5' && f.threadId === 'thread-abc')).toBe(true)
    })

    it('selecting an effort mid-thread sends set-thread-config with effort', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thread-xyz'
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(models)
      const sent = interceptWsSend()
      internals().ComposerConfig._selectEffort('max')
      expect(sent.some((f: any) => f.type === 'set-thread-config' && f.effort === 'max' && f.threadId === 'thread-xyz')).toBe(true)
    })

    it('does NOT send set-thread-config when no active thread', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = null
      internals().ComposerConfig.applyModels(models)
      const sent = interceptWsSend()
      internals().ComposerConfig._selectModel('claude-fable-5')
      expect(sent.filter((f: any) => f.type === 'set-thread-config')).toHaveLength(0)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  describe('thread-config frame reconciliation', () => {
    it('deferred fields show the hint briefly', () => {
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thread-abc',
        applied: [],
        deferred: ['model'],
        rejected: [],
      })
      const hint = document.getElementById('cfg-deferred-hint')!
      expect(hint.classList.contains('visible')).toBe(true)
      expect(hint.textContent).toContain('model')
      // F8: a deferred (cross-lane) model lands on the next NEW thread, not
      // the next message of the live thread — wording must say "conversation".
      expect(hint.textContent).toContain('applies to next conversation')
    })

    it('applied fields produce no hint (empty deferred)', () => {
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thread-abc',
        applied: ['model'],
        deferred: [],
        rejected: [],
      })
      const hint = document.getElementById('cfg-deferred-hint')!
      expect(hint.classList.contains('visible')).toBe(false)
    })

    it('deferred hint fades after ~4s', () => {
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thread-abc',
        applied: [],
        deferred: ['effort'],
        rejected: [],
      })
      const hint = document.getElementById('cfg-deferred-hint')!
      expect(hint.classList.contains('visible')).toBe(true)
      vi.advanceTimersByTime(4100)
      expect(hint.classList.contains('visible')).toBe(false)
    })

    // F9: rejected picks must roll back the OPTIMISTIC localStorage write
    // made at select time — the prior value must come back in storage AND on
    // the rendered label (not just a re-read of the mutated value).

    it('rejected model rolls back luna_model and the label to the prior pick', () => {
      const models = [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: [] },
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
      ]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thread-abc'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(models)
      // Optimistic pick: writes localStorage + sends set-thread-config.
      internals().ComposerConfig._selectModel('claude-fable-5')
      expect(localStorage.getItem('luna_model')).toBe('claude-fable-5')
      // Server rejects → prior model restored in storage AND on the label.
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thread-abc',
        applied: [],
        deferred: [],
        rejected: [{ field: 'model', reason: 'cross-lane' }],
      })
      expect(localStorage.getItem('luna_model')).toBe('claude-sonnet-4-6')
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
    })

    it('rejected effort rolls back luna_effort and the label to the prior pick', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thread-xyz'
      localStorage.setItem('luna_model', 'claude-fable-5')
      localStorage.setItem('luna_effort', 'low')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig._selectEffort('max')
      expect(localStorage.getItem('luna_effort')).toBe('max')
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thread-xyz',
        applied: [],
        deferred: [],
        rejected: [{ field: 'effort', reason: 'invalid' }],
      })
      expect(localStorage.getItem('luna_effort')).toBe('low')
      expect(document.getElementById('effort-cfg-btn')!.textContent).toBe('Low')
    })

    it('rejected model also restores an effort the model pick cascade-cleared', () => {
      const models = [
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
      ]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thread-abc'
      localStorage.setItem('luna_model', 'claude-fable-5')
      localStorage.setItem('luna_effort', 'max')
      internals().ComposerConfig.applyModels(models)
      // Picking haiku cascade-clears the now-invalid effort.
      internals().ComposerConfig._selectModel('claude-haiku-4-5')
      expect(localStorage.getItem('luna_effort')).toBeNull()
      // Rejection rolls back BOTH the model and the cascade-cleared effort.
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thread-abc',
        applied: [],
        deferred: [],
        rejected: [{ field: 'model', reason: 'cross-lane' }],
      })
      expect(localStorage.getItem('luna_model')).toBe('claude-fable-5')
      expect(localStorage.getItem('luna_effort')).toBe('max')
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Fable 5')
    })

    it('unsolicited rejected (no pending snapshot) changes nothing and does not throw', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }]
      sendHello({ models })
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(models)
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thread-abc',
        applied: [],
        deferred: [],
        rejected: [{ field: 'model', reason: 'cross-lane' }],
      })
      expect(localStorage.getItem('luna_model')).toBe('claude-fable-5')
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Fable 5')
    })

    it('an applied ack consumes the snapshot — a later rejected cannot restore stale values', () => {
      const models = [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: [] },
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
      ]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thread-abc'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig._selectModel('claude-fable-5')
      // Server confirms — snapshot must be discarded.
      internals().handleFrame({
        type: 'thread-config', threadId: 'thread-abc',
        applied: ['model'], deferred: [], rejected: [],
      })
      // A later (unsolicited) rejected must NOT roll back to sonnet.
      internals().handleFrame({
        type: 'thread-config', threadId: 'thread-abc',
        applied: [], deferred: [], rejected: [{ field: 'model', reason: 'late' }],
      })
      expect(localStorage.getItem('luna_model')).toBe('claude-fable-5')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  describe('Escape dismissal (F10)', () => {
    it('Esc closes an open model menu and does NOT reach VoiceEngine', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }]
      sendHello({ models })
      internals().ComposerConfig.applyModels(models)
      const voiceEsc = vi.spyOn((internals() as any).VoiceEngine, 'handleEscape')
      // Open the model popover via its real button.
      document.getElementById('model-cfg-btn')!.click()
      const menu = document.getElementById('model-cfg-menu')!
      expect(menu.classList.contains('open')).toBe(true)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(menu.classList.contains('open')).toBe(false)
      expect(voiceEsc).not.toHaveBeenCalled()
    })

    it('Esc with no menu open still reaches VoiceEngine.handleEscape', () => {
      const voiceEsc = vi.spyOn((internals() as any).VoiceEngine, 'handleEscape')
      expect(internals().ComposerConfig.anyMenuOpen()).toBe(false)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      expect(voiceEsc).toHaveBeenCalledTimes(1)
    })

    it('non-Escape keys never close an open menu', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }]
      sendHello({ models })
      internals().ComposerConfig.applyModels(models)
      document.getElementById('model-cfg-btn')!.click()
      const menu = document.getElementById('model-cfg-menu')!
      expect(menu.classList.contains('open')).toBe(true)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
      expect(menu.classList.contains('open')).toBe(true)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  describe('legacy cache back-compat', () => {
    it('normalizeEntry handles plain string entries (legacy cache)', () => {
      const CC = internals().ComposerConfig
      const result = CC._normalizeEntry('claude-haiku-4-5')
      expect(result).toEqual({ id: 'claude-haiku-4-5', label: 'claude-haiku-4-5', efforts: [] })
    })

    it('normalizeEntry handles new object entries', () => {
      const CC = internals().ComposerConfig
      const result = CC._normalizeEntry({ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] })
      expect(result).toEqual({ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] })
    })

    it('normalizeEntry returns null for bogus entries', () => {
      const CC = internals().ComposerConfig
      expect(CC._normalizeEntry(null)).toBeNull()
      expect(CC._normalizeEntry({ bogus: true })).toBeNull()
    })

    it('isEffortValidForCurrentModel returns false for legacy (no efforts) model', () => {
      const models = [{ id: 'old-model', label: 'Old', efforts: [] }]
      sendHello({ models, effortSelection: true })
      localStorage.setItem('luna_model', 'old-model')
      internals().ComposerConfig.applyModels(models)
      expect(internals().ComposerConfig.isEffortValidForCurrentModel('max')).toBe(false)
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Per-thread truth: the composer shows the ACTIVE thread's actual
  // model/effort (learned from server frames), not the global localStorage
  // picks — the fix for "changing the model/effort doesn't work".
  describe('per-thread model/effort truth', () => {
    const twoModels = [
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['low', 'max'] },
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]

    function interceptWsSend() {
      const sent: any[] = []
      vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((frame: any) => {
        sent.push(frame)
      })
      return sent
    }

    it('thread-list records each thread model/effort; active thread wins over localStorage', () => {
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      localStorage.setItem('luna_effort', 'low')
      internals().ComposerConfig.applyModels(twoModels)
      internals().handleFrame({
        type: 'thread-list',
        threads: [
          { id: 'thr-1', model: 'claude-fable-5', effort: 'max' },
          { id: 'thr-2', model: 'claude-sonnet-4-6' },
        ],
      })
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Fable 5')
      expect(document.getElementById('effort-cfg-btn')!.textContent).toBe('Max')
      // The global new-thread picks are untouched.
      expect(localStorage.getItem('luna_model')).toBe('claude-sonnet-4-6')
      expect(localStorage.getItem('luna_effort')).toBe('low')
    })

    it('a smart-bar model pill updates the active thread label (live switch feedback)', () => {
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(twoModels)
      internals().handleFrame({
        type: 'smart-bar',
        threadId: 'thr-1',
        version: 1,
        items: [{ id: 'model', kind: 'info', label: 'model', value: 'claude-fable-5', icon: '✶', group: 'context', priority: 1 }],
      })
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Fable 5')
    })

    it('an applied thread-config ack records the EFFECTIVE effort (clamp feedback)', () => {
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(twoModels)
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thr-1',
        model: 'claude-fable-5',
        effort: 'max',           // server-clamped effective value
        applied: ['effort'],
        deferred: [],
        rejected: [],
      })
      expect(document.getElementById('effort-cfg-btn')!.textContent).toBe('Max')
    })

    it('re-picking the global default on a thread running another model STILL sends set-thread-config', () => {
      // Regression guard: change detection must compare against the THREAD's
      // model, not the localStorage pick — else this exact pick silently no-ops.
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(twoModels)
      // Server told us the thread actually runs sonnet.
      internals().State.threadModels['thr-1'] = 'claude-sonnet-4-6'
      const sent = interceptWsSend()
      internals().ComposerConfig._selectModel('claude-fable-5')
      expect(sent.some((f: any) => f.type === 'set-thread-config' && f.model === 'claude-fable-5' && f.threadId === 'thr-1')).toBe(true)
    })

    it('picking the model the thread already runs does NOT send set-thread-config', () => {
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(twoModels)
      internals().State.threadModels['thr-1'] = 'claude-fable-5'
      const sent = interceptWsSend()
      internals().ComposerConfig._selectModel('claude-fable-5')
      expect(sent.filter((f: any) => f.type === 'set-thread-config')).toHaveLength(0)
    })

    it('a rejected model ack rolls back the per-thread optimistic write', () => {
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(twoModels)
      internals().State.threadModels['thr-1'] = 'claude-sonnet-4-6'
      interceptWsSend()
      internals().ComposerConfig._selectModel('claude-fable-5')
      // Optimistic per-thread write happened.
      expect(internals().State.threadModels['thr-1']).toBe('claude-fable-5')
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thr-1',
        applied: [],
        deferred: [],
        rejected: [{ field: 'model', reason: 'cross-lane' }],
      })
      expect(internals().State.threadModels['thr-1']).toBe('claude-sonnet-4-6')
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
    })
  })
})
