// @vitest-environment jsdom
//
// Behavioral tests for the ComposerConfig engine in chat.html - the
// optimistic-revert protocol PINNING suite for stack23 S16b's React
// conversion (see src/chat/ComposerConfig.tsx's module doc). Driven through
// the SAME test/helpers/chat-harness.ts bridge chat-window.test.ts and
// slash-menu.test.ts already use, so this file exercises ComposerConfig
// identically whether it's still chat.html's vanilla `const` object or the
// converted React component behind the `var ComposerConfig` bridge -
// swapping which one is live never requires touching this file's own setup
// or assertions.
//
// Coverage:
//  - capability gating hides/shows the effort control
//  - per-model efforts list is used for the effort menu
//  - model pick writes luna_model, effort pick writes luna_effort
//  - sendNewThread includes effort for a capable model and omits for haiku/legacy
//  - live model/effort pick sends set-thread-config when a thread is active
//  - thread-config deferred / rejected / applied reconciliation
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  mountChatMessageListBridge,
  readChatHtml,
} from './helpers/chat-harness'

describe('ComposerConfig (chat.html)', () => {
  let windowEventHandlers: Record<string, (e: { payload: any }) => void>
  let mockMe: any
  let wsSent: any[]

  beforeEach(() => {
    const htmlContent = readChatHtml()
    mountChatDomFromHtml(htmlContent)

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

    const mount = mountChatMessageListBridge(document.getElementById('chat-messages'))
    evalChatInlineScriptWithBridge(htmlContent, mount)

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
    delete (window as any).ChatState
    delete (window as any).ChatLoop
    delete (window as any).Attachments
    delete (window as any).ComposerConfig
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

    // The vanilla `_refreshEffortVisibility` was called ONLY from
    // `applyCapability` and from `reconcileThreadConfig`'s
    // `reverted || changed` branch - never from `applyModels`,
    // `refreshComposer`, `_selectModel` or `_selectEffort`. Picking a model
    // with an empty efforts list through the real select path therefore does
    // NOT immediately re-gate an already-visible effort control; only an
    // explicit applyCapability()/reconcile call does. This is the exact path
    // the S16b conversion first got wrong (effortVisible was being
    // recomputed on every publish()) - pinned here so it can't regress.
    it('picking a model with no efforts via _selectModel does not immediately hide an already-visible effort control', () => {
      const models = [
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: [] },
      ]
      sendHello({ models, effortSelection: true })
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig.applyCapability(true)
      expect(document.getElementById('effort-cfg-btn')!.hidden).toBe(false)

      // Pick a model with an empty efforts list via the real select path -
      // the effort control must stay visible (stale) until something
      // explicitly re-gates it.
      internals().ComposerConfig._selectModel('claude-haiku-4-5')
      expect(document.getElementById('effort-cfg-btn')!.hidden).toBe(false)

      // A subsequent refreshComposer() (thread-list/thread-created's call
      // site) must not re-gate it either.
      internals().ComposerConfig.refreshComposer()
      expect(document.getElementById('effort-cfg-btn')!.hidden).toBe(false)

      // Only an explicit applyCapability() re-gates it.
      internals().ComposerConfig.applyCapability(true)
      expect(document.getElementById('effort-cfg-btn')!.hidden).toBe(true)
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
  // Vanilla's `applyModels` called ONLY `_rebuildModelMenu()` + `_refreshLabels()`,
  // NEVER `_rebuildEffortMenu()` - and applyModels runs on EVERY hello frame
  // (chat.html's `applyAvailableModels`, whose own doc notes reconnects
  // re-deliver hello). An OPEN effort popover must survive a reconnect that
  // advertises a changed efforts list for the same model with its item list
  // untouched - only re-opening the popover (a fresh `_rebuildEffortMenu()`
  // call) picks up the new list.
  describe('applyModels on a reconnect does not repaint an OPEN effort popover', () => {
    it('leaves the open effort menu items unchanged when hello re-advertises a different efforts list for the same model', () => {
      const modelV1 = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }]
      sendHello({ models: modelV1, effortSelection: true })
      internals().State.serverSupportsEffort = true
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(modelV1)
      internals().ComposerConfig.applyCapability(true)

      document.getElementById('effort-cfg-btn')!.click()
      const menu = document.getElementById('effort-cfg-menu')!
      expect(menu.classList.contains('open')).toBe(true)
      const labelsBefore = Array.from(menu.querySelectorAll('.cfg-menu-item')).map(
        (el) => el.querySelector('span')!.textContent,
      )
      expect(labelsBefore).toEqual(['Default', 'Low', 'Max'])

      // Reconnect: the server now advertises a THIRD effort level for the
      // same model, with the popover still open.
      const modelV2 = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'ultracode', 'max'] }]
      internals().ComposerConfig.applyModels(modelV2)

      const labelsAfter = Array.from(menu.querySelectorAll('.cfg-menu-item')).map(
        (el) => el.querySelector('span')!.textContent,
      )
      expect(labelsAfter).toEqual(['Default', 'Low', 'Max'])
      expect(menu.classList.contains('open')).toBe(true)
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

    it('deferred hint joins multiple fields with " & "', () => {
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thread-abc',
        applied: [],
        deferred: ['model', 'effort'],
        rejected: [],
      })
      const hint = document.getElementById('cfg-deferred-hint')!
      expect(hint.textContent).toBe('model & effort applies to next conversation')
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
  // The vanilla `_selectModel`/`_selectEffort` both called `this.closeAllMenus()`
  // before returning. A real mouse click on a menu item is accidentally saved
  // by the document click-closer even without that call (the click bubbles
  // past the item), but a keyboard Enter/Space on a `.cfg-menu-item` fires no
  // DOM click at all (MenuItemRow's onKeyDown calls onSelect directly) - so
  // _selectModel/_selectEffort must close the menu themselves.
  describe('menu closes on selection', () => {
    it('_selectModel closes the model popover (keyboard Enter path bypasses the click listener)', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }]
      sendHello({ models })
      internals().ComposerConfig.applyModels(models)
      document.getElementById('model-cfg-btn')!.click()
      const menu = document.getElementById('model-cfg-menu')!
      expect(menu.classList.contains('open')).toBe(true)
      internals().ComposerConfig._selectModel('claude-fable-5')
      expect(menu.classList.contains('open')).toBe(false)
      expect(document.getElementById('model-cfg-btn')!.getAttribute('aria-expanded')).toBe('false')
    })

    it('_selectEffort closes the effort popover (keyboard Enter path)', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig.applyCapability(true)
      document.getElementById('effort-cfg-btn')!.click()
      const menu = document.getElementById('effort-cfg-menu')!
      expect(menu.classList.contains('open')).toBe(true)
      internals().ComposerConfig._selectEffort('max')
      expect(menu.classList.contains('open')).toBe(false)
      expect(document.getElementById('effort-cfg-btn')!.getAttribute('aria-expanded')).toBe('false')
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Vanilla's `init()` called `this._rebuildModelMenu()` / `this.
  // _rebuildEffortMenu()` immediately before adding `.open` on every button
  // click - and NEITHER of those touched `_refreshLabels()`. So opening a
  // popover rebuilds the MENU ITEMS from the CURRENT display state (else the
  // popover would show whatever the LAST unrelated store notify produced),
  // but the BUTTON LABEL stays at whatever was last painted until something
  // else calls the full label-repainting path. A drawer row click
  // (ThreadDrawerEngine.onRowClick) flips State.activeThreadId directly with
  // NO ComposerConfig call, so opening either popover right afterward is the
  // sharpest repro of both halves of this at once.
  describe('menu open rebuilds the MENU ITEMS from the CURRENT state, but leaves the button label stale', () => {
    const twoModelsWithEfforts = [
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: ['low', 'max'] },
      { id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] },
    ]

    it('opening the model popover after a drawer thread switch rebuilds the menu items for the NEW thread but leaves the label at the last-painted value', () => {
      sendHello({ models: twoModelsWithEfforts, effortSelection: true })
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(twoModelsWithEfforts)
      // thread-list's handler records EVERY thread's summary, active or not
      // (chat.html:7185) - this does not publish for a non-active thread.
      internals().ComposerConfig.recordThreadConfig('thr-1', 'claude-sonnet-4-6', null)
      internals().ComposerConfig.recordThreadConfig('thr-2', 'claude-fable-5', null)
      // ThreadDrawerEngine.onRowClick('thr-2') - flips activeThreadId, calls
      // NO ComposerConfig method (chat.html:5424).
      internals().State.activeThreadId = 'thr-2'

      document.getElementById('model-cfg-btn')!.click()

      // The label was last painted for thr-1 and nothing has repainted it
      // since - vanilla's _rebuildModelMenu() never touched _refreshLabels().
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
      // The menu ITEMS, however, are rebuilt from the CURRENT thread (thr-2).
      const menu = document.getElementById('model-cfg-menu')!
      const checked = [...menu.querySelectorAll('.cfg-menu-item')]
        .filter((el) => el.classList.contains('selected'))
        .map((el) => (el as HTMLElement).dataset['modelId'])
      expect(checked).toEqual(['claude-fable-5'])
    })

    it('opening the effort popover after a drawer thread switch rebuilds the menu items for the NEW thread but leaves the label at the last-painted value', () => {
      sendHello({ models: twoModelsWithEfforts, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(twoModelsWithEfforts)
      internals().ComposerConfig.applyCapability(true)
      internals().ComposerConfig.recordThreadConfig('thr-1', 'claude-sonnet-4-6', 'low')
      internals().ComposerConfig.recordThreadConfig('thr-2', 'claude-fable-5', 'max')
      internals().State.activeThreadId = 'thr-2'

      document.getElementById('effort-cfg-btn')!.click()

      expect(document.getElementById('effort-cfg-btn')!.textContent).toBe('Low')
      const menu = document.getElementById('effort-cfg-menu')!
      const checked = [...menu.querySelectorAll('.cfg-menu-item')]
        .filter((el) => el.classList.contains('selected'))
        .map((el) => (el as HTMLElement).dataset['effortId'])
      expect(checked).toEqual(['max'])
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Real DOM click/keydown dispatch on rendered `.cfg-menu-item` elements -
  // every other test in this file drives the pick through the
  // `_selectModel`/`_selectEffort` bridge directly, which never exercises
  // MenuItemRow's own onClick/onKeyDown React handlers.
  describe('real click/keydown paths on rendered menu items', () => {
    it('a real click on a model menu item selects it and closes the popover', () => {
      const models = [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', efforts: [] },
        { id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] },
      ]
      sendHello({ models })
      internals().ComposerConfig.applyModels(models)
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      document.getElementById('model-cfg-btn')!.click()
      const menu = document.getElementById('model-cfg-menu')!
      expect(menu.classList.contains('open')).toBe(true)
      const item = menu.querySelector('.cfg-menu-item[data-model-id="claude-fable-5"]') as HTMLElement
      item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

      expect(localStorage.getItem('luna_model')).toBe('claude-fable-5')
      expect(menu.classList.contains('open')).toBe(false)
      expect(document.getElementById('model-cfg-btn')!.getAttribute('aria-expanded')).toBe('false')
      expect(consoleError).not.toHaveBeenCalled()
      consoleError.mockRestore()
    })

    it('a real Enter keydown on an effort menu item selects it and closes the popover', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['low', 'max'] }]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      localStorage.setItem('luna_model', 'claude-fable-5')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig.applyCapability(true)
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      document.getElementById('effort-cfg-btn')!.click()
      const menu = document.getElementById('effort-cfg-menu')!
      expect(menu.classList.contains('open')).toBe(true)
      const item = menu.querySelector('.cfg-menu-item[data-effort-id="max"]') as HTMLElement
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

      expect(localStorage.getItem('luna_effort')).toBe('max')
      expect(menu.classList.contains('open')).toBe(false)
      expect(consoleError).not.toHaveBeenCalled()
      consoleError.mockRestore()
    })

    // The vanilla effort menu's "Default" row never got a keydown listener
    // (only click) - MenuItemRow's `withKeyboardActivation={false}` on that
    // one row preserves this asymmetry exactly, marked
    // TODO(#459): fix-or-remove at ComposerConfig.tsx's withKeyboardActivation
    // prop. Pinned here since nothing else in this file asserts either
    // attribute; closing #459 means rewriting this test, not deleting it.
    it('the effort menu Default row has no keydown handler - Enter does nothing', () => {
      const models = [{ id: 'claude-fable-5', label: 'Fable 5', efforts: ['max'] }]
      sendHello({ models, effortSelection: true })
      internals().State.serverSupportsEffort = true
      localStorage.setItem('luna_model', 'claude-fable-5')
      localStorage.setItem('luna_effort', 'max')
      internals().ComposerConfig.applyModels(models)
      internals().ComposerConfig.applyCapability(true)

      document.getElementById('effort-cfg-btn')!.click()
      const menu = document.getElementById('effort-cfg-menu')!
      const defaultItem = menu.querySelector('.cfg-menu-item[data-effort-id=""]') as HTMLElement
      expect(defaultItem).toBeTruthy()
      defaultItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

      // No onKeyDown handler on this row - luna_effort is untouched, the
      // menu stays open (only a real click reaches _selectEffort('')).
      expect(localStorage.getItem('luna_effort')).toBe('max')
      expect(menu.classList.contains('open')).toBe(true)
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

    it('rejecting both model and effort in the same ack rolls back both independently', () => {
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thread-abc'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      localStorage.setItem('luna_effort', 'low')
      internals().ComposerConfig.applyModels(twoModels)
      internals().ComposerConfig._selectModel('claude-fable-5')
      internals().ComposerConfig._selectEffort('max')
      expect(localStorage.getItem('luna_model')).toBe('claude-fable-5')
      expect(localStorage.getItem('luna_effort')).toBe('max')
      // Both twoModels entries list the same efforts, so the model pick does
      // NOT cascade-clear luna_effort - the optimistic per-thread effort
      // write below is the state ONLY the 'effort' rejected-field branch
      // rolls back (the 'model' branch's cascade-restore only touches
      // localStorage, not State.threadEfforts). Asserting it here means this
      // test actually requires both rejected-field branches to run, not just
      // the 'model' one - see ComposerConfig.tsx's reconcileThreadConfig.
      expect(internals().State.threadEfforts['thread-abc']).toBe('max')
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thread-abc',
        applied: [],
        deferred: [],
        rejected: [
          { field: 'model', reason: 'cross-lane' },
          { field: 'effort', reason: 'invalid' },
        ],
      })
      expect(localStorage.getItem('luna_model')).toBe('claude-sonnet-4-6')
      expect(localStorage.getItem('luna_effort')).toBe('low')
      expect(internals().State.threadEfforts['thread-abc']).toBeUndefined()
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
      expect(document.getElementById('effort-cfg-btn')!.textContent).toBe('Low')
    })

    it('a settled ack with nothing applied/deferred/rejected does not repaint a since-diverged label', () => {
      // vanilla's own `if (reverted || changed)` repaint gate: a no-op ack
      // must not force a recompute from whatever State.activeThreadId is
      // NOW, which can have diverged (a drawer thread switch) from what the
      // ack is even about.
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(twoModels)
      internals().ComposerConfig.recordThreadConfig('thr-1', 'claude-sonnet-4-6', null)
      internals().ComposerConfig.recordThreadConfig('thr-2', 'claude-fable-5', null)
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
      // Drawer switch - no ComposerConfig call.
      internals().State.activeThreadId = 'thr-2'
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thr-2',
        applied: [],
        deferred: [],
        rejected: [],
      })
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
    })

    it('a deferred-only ack after a drawer thread switch shows the hint but does not repaint the since-diverged label', () => {
      // Same divergence window as the settled-ack test above, but with a
      // deferred field present: reconcileThreadConfig's `deferred.length > 0`
      // branch must still show the hint (a narrow write) while leaving the
      // label at whatever was last painted for thr-1 - a full publish() here
      // would repaint it to thr-2's model instead.
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      internals().ComposerConfig.applyModels(twoModels)
      internals().ComposerConfig.recordThreadConfig('thr-1', 'claude-sonnet-4-6', null)
      internals().ComposerConfig.recordThreadConfig('thr-2', 'claude-fable-5', null)
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
      // Drawer switch - no ComposerConfig call.
      internals().State.activeThreadId = 'thr-2'
      internals().handleFrame({
        type: 'thread-config',
        threadId: 'thr-1',
        applied: [],
        deferred: ['model'],
        rejected: [],
      })
      expect(document.getElementById('cfg-deferred-hint')!.classList.contains('visible')).toBe(true)
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
    })

    it('applyCapability after a drawer thread switch re-gates the effort control but does not repaint the since-diverged labels', () => {
      // Vanilla's applyCapability called ONLY _refreshEffortVisibility, never
      // _refreshLabels. A full publish() here would repaint both button
      // labels from thr-2's config even though they were last correctly
      // painted for thr-1.
      sendHello({ models: twoModels, effortSelection: true })
      internals().State.serverSupportsEffort = true
      internals().State.activeThreadId = 'thr-1'
      localStorage.setItem('luna_model', 'claude-sonnet-4-6')
      localStorage.setItem('luna_effort', 'low')
      internals().ComposerConfig.applyModels(twoModels)
      internals().ComposerConfig.applyCapability(true)
      internals().ComposerConfig.recordThreadConfig('thr-1', 'claude-sonnet-4-6', 'low')
      internals().ComposerConfig.recordThreadConfig('thr-2', 'claude-fable-5', 'max')
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
      expect(document.getElementById('effort-cfg-btn')!.textContent).toBe('Low')
      // Drawer switch - no ComposerConfig call.
      internals().State.activeThreadId = 'thr-2'
      internals().ComposerConfig.applyCapability(true)
      expect(document.getElementById('model-cfg-btn')!.textContent).toBe('Sonnet 4.6')
      expect(document.getElementById('effort-cfg-btn')!.textContent).toBe('Low')
    })

    it('recordThreadConfig accepts any truthy threadId (not narrowed to string), matching vanilla', () => {
      // Vanilla's `if (!threadId) return` accepted a non-string truthy id
      // and relied on JS's own object-key coercion when writing
      // State.threadModels[threadId] = model - a numeric id must still land,
      // coerced to its string key.
      sendHello({ models: twoModels })
      internals().ComposerConfig.recordThreadConfig(12345, 'claude-fable-5', null)
      expect(internals().State.threadModels['12345']).toBe('claude-fable-5')
    })
  })
})
