// @vitest-environment jsdom
//
// Behavioral tests for the point-at-the-UI FeedbackEngine in chat.html.
// Driven through the same test/helpers/chat-harness.ts bridge chat-window.
// test.ts, slash-menu.test.ts and composer-config.test.ts use: chat.html's
// hello handler unconditionally routes through ComposerConfig.applyModels
// (stack23 S16b converted ComposerConfig to a `var` forward-declaration that
// only the harness's bridge patches to a live value - see chat-harness.ts's
// module doc), so any suite that sends a hello frame needs the same bridge,
// not just suites that exercise ComposerConfig directly.
//
// Coverage:
//  - #feedback-btn is hidden until the server advertises capabilities.feedback
//  - entering picker mode reveals the overlay; pointermove tracks the highlight
//  - clicking an element captures a describeTarget() and opens the composer
//  - submit emits exactly one `feedback-submit` frame with the note + target
//  - Escape cancels the picker WITHOUT reaching VoiceEngine.handleEscape
//  - a `feedback-ack` ok:true confirms + auto-hides; ok:false stays open
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  evalChatInlineScriptWithBridge,
  loadVendorInto,
  mountChatDomFromHtml,
  mountChatMessageListBridge,
  readChatHtml,
} from './helpers/chat-harness'

describe('FeedbackEngine (chat.html)', () => {
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
    // Tear down any active picker so its window-capture listeners don't leak
    // into the next test (window persists across tests in jsdom).
    try { (window as any).__MoonInternals?.FeedbackEngine?.cancelPicker() } catch { /* noop */ }
    ;(document as any).elementFromPoint = undefined
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
    FeedbackEngine: any
    describeTarget: (el: Element) => any
    State: any
    WebSocketEngine: any
    VoiceEngine: any
    handleFrame: (f: any) => void
  }

  function sendHello(caps: Record<string, unknown> = {}) {
    internals().handleFrame({ type: 'hello', protocolVersion: 2, capabilities: caps, availableModels: [] })
  }

  const btn = () => document.getElementById('feedback-btn') as HTMLButtonElement
  const overlay = () => document.getElementById('feedback-picker-overlay') as HTMLElement
  const panel = () => document.getElementById('feedback-panel') as HTMLElement
  const input = () => document.getElementById('feedback-input') as HTMLTextAreaElement
  const submitBtn = () => document.getElementById('feedback-submit-btn') as HTMLButtonElement
  const status = () => document.getElementById('feedback-status') as HTMLElement

  // Pick a stable, always-present element as the "pointed-at" target. jsdom
  // does not implement document.elementFromPoint, so assign it directly (spyOn
  // would fail on a missing method).
  function stubTarget(el: Element) {
    ;(document as any).elementFromPoint = () => el
  }

  // submit() is now async — it awaits FeedbackEngine._captureScreenshot()
  // before sending the frame (best-effort native screenshot capture). In
  // these tests window.__TAURI__.core is absent, so _captureScreenshot
  // resolves to null on its first `await` boundary with no further internal
  // awaits. A handful of microtask ticks reliably drains that chain even
  // under vi.useFakeTimers() (which only freezes macrotasks like
  // setTimeout, not the microtask queue).
  async function flushMicrotasks() {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }

  // ── capability gating ────────────────────────────────────────────────────
  it('feedback button is hidden by default (no hello yet)', () => {
    expect(btn().hidden).toBe(true)
  })

  it('feedback button shows only when capabilities.feedback is true', () => {
    sendHello({ feedback: true })
    expect(btn().hidden).toBe(false)
    sendHello({}) // a server without the flag hides it again (fail-closed)
    expect(btn().hidden).toBe(true)
  })

  // ── picker mode ────────────────────────────────────────────────────────────
  it('clicking the button enters picker mode and reveals the overlay', () => {
    sendHello({ feedback: true })
    btn().click()
    expect(internals().FeedbackEngine._picking).toBe(true)
    expect(overlay().hidden).toBe(false)
    expect(btn().classList.contains('active')).toBe(true)
  })

  it('pointermove positions the highlight box over the hovered element', () => {
    sendHello({ feedback: true })
    const target = document.getElementById('message-input')!
    target.getBoundingClientRect = () =>
      ({ top: 5, left: 6, width: 7, height: 8, x: 6, y: 5, right: 13, bottom: 13, toJSON() {} }) as DOMRect
    stubTarget(target)
    btn().click()
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }))
    const box = document.getElementById('feedback-picker-highlight')!
    expect(box.style.top).toBe('5px')
    expect(box.style.left).toBe('6px')
    expect(box.style.width).toBe('7px')
    expect(box.style.height).toBe('8px')
  })

  it('does NOT highlight/pick its own picker chrome', () => {
    sendHello({ feedback: true })
    btn().click()
    // elementFromPoint returns the overlay itself → should be ignored.
    stubTarget(overlay())
    document.body.dispatchEvent(new MouseEvent('click', { clientX: 4, clientY: 4, bubbles: true }))
    // Still picking, no target captured, composer not opened.
    expect(internals().FeedbackEngine._picking).toBe(true)
    expect(panel().hidden).toBe(true)
  })

  // ── target capture ─────────────────────────────────────────────────────────
  it('clicking an element captures a describeTarget() and opens the composer', () => {
    sendHello({ feedback: true })
    const target = document.getElementById('message-input')!
    stubTarget(target)
    btn().click()
    document.body.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }))

    const t = internals().FeedbackEngine._target
    expect(t).toBeTruthy()
    expect(t.tag).toBe('textarea')
    expect(t.id).toBe('message-input')
    expect(typeof t.selector).toBe('string')
    expect(t.selector.length).toBeGreaterThan(0)
    expect(t.route.page).toMatch(/chat\.html|\.html|^$|.+/) // best-effort page label
    expect(t.viewport).toHaveProperty('dpr')
    // Picker torn down, composer shown.
    expect(internals().FeedbackEngine._picking).toBe(false)
    expect(overlay().hidden).toBe(true)
    expect(panel().hidden).toBe(false)
    expect((document.getElementById('feedback-target-chip') as HTMLElement).hidden).toBe(false)
  })

  it('describeTarget truncates long text and reports the pre-truncation length', () => {
    const el = document.createElement('div')
    el.textContent = 'x'.repeat(300)
    const t = internals().describeTarget(el)
    expect(t.textLength).toBe(300)
    expect(t.text.length).toBeLessThanOrEqual(121) // 120 + ellipsis
    expect(t.text.endsWith('…')).toBe(true)
  })

  // ── submit ─────────────────────────────────────────────────────────────────
  it('submit sends exactly one feedback-submit frame with note + target', async () => {
    sendHello({ feedback: true })
    internals().State.ws = { readyState: WebSocket.OPEN }
    internals().State.activeThreadId = 'thr-42'
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })

    const target = document.getElementById('message-input')!
    stubTarget(target)
    btn().click()
    document.body.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }))

    input().value = 'the send button is too small'
    input().dispatchEvent(new Event('input'))
    expect(submitBtn().disabled).toBe(false)
    submitBtn().click()
    await flushMicrotasks()

    const frames = sent.filter((f) => f.type === 'feedback-submit')
    expect(frames).toHaveLength(1)
    const f = frames[0]
    expect(typeof f.requestId).toBe('string')
    expect(f.requestId.length).toBeGreaterThan(0)
    expect(f.note).toBe('the send button is too small')
    expect(f.threadId).toBe('thr-42')
    expect(typeof f.target.selector).toBe('string')
    expect(f.target.id).toBe('message-input')
    expect(typeof f.clientTs).toBe('number')
  })

  it('submit omits the `screenshot` key entirely when window.__TAURI__ has no `core` (normal jsdom/test env)', async () => {
    sendHello({ feedback: true })
    internals().State.ws = { readyState: WebSocket.OPEN }
    // beforeEach sets window.__TAURI__.window/event but never .core — the
    // same shape a non-Tauri (plain browser/jsdom) environment has.
    expect((window as any).__TAURI__.core).toBeUndefined()
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })

    stubTarget(document.getElementById('message-input')!)
    btn().click()
    document.body.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }))
    input().value = 'no screenshot available here'
    input().dispatchEvent(new Event('input'))
    submitBtn().click()
    await flushMicrotasks()

    const frames = sent.filter((f) => f.type === 'feedback-submit')
    expect(frames).toHaveLength(1)
    expect('screenshot' in frames[0]).toBe(false)
  })

  it('submit is a no-op when the socket is not open', () => {
    sendHello({ feedback: true })
    internals().State.ws = { readyState: 3 } // CLOSED
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })
    stubTarget(document.getElementById('message-input')!)
    btn().click()
    document.body.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }))
    input().value = 'hi'
    input().dispatchEvent(new Event('input'))
    submitBtn().click()
    expect(sent.filter((x) => x.type === 'feedback-submit')).toHaveLength(0)
    expect(status().textContent).toMatch(/not connected/i)
  })

  // ── Escape ordering ──────────────────────────────────────────────────────
  it('Escape cancels the picker and does NOT reach VoiceEngine.handleEscape', () => {
    sendHello({ feedback: true })
    const voiceEsc = vi.spyOn(internals().VoiceEngine, 'handleEscape')
    btn().click()
    expect(internals().FeedbackEngine._picking).toBe(true)
    // Dispatch from a descendant so the window CAPTURE listener runs first
    // (mirrors a real keypress whose target is the focused element).
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(internals().FeedbackEngine._picking).toBe(false)
    expect(overlay().hidden).toBe(true)
    expect(voiceEsc).not.toHaveBeenCalled()
  })

  // ── ack round-trip ─────────────────────────────────────────────────────────
  it('feedback-ack ok:true confirms and auto-hides the composer', async () => {
    sendHello({ feedback: true })
    internals().State.ws = { readyState: WebSocket.OPEN }
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })
    stubTarget(document.getElementById('message-input')!)
    btn().click()
    document.body.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }))
    input().value = 'looks off'
    input().dispatchEvent(new Event('input'))
    submitBtn().click()
    await flushMicrotasks()
    const reqId = sent.find((f) => f.type === 'feedback-submit').requestId

    internals().handleFrame({ type: 'feedback-ack', requestId: reqId, ok: true })
    expect(status().classList.contains('ok')).toBe(true)
    expect(panel().hidden).toBe(false)
    vi.advanceTimersByTime(1600)
    expect(panel().hidden).toBe(true) // auto-hid
  })

  it('feedback-ack ok:false shows the error and keeps the composer open', async () => {
    sendHello({ feedback: true })
    internals().State.ws = { readyState: WebSocket.OPEN }
    const sent: any[] = []
    vi.spyOn(internals().WebSocketEngine, 'send').mockImplementation((f: any) => { sent.push(f) })
    stubTarget(document.getElementById('message-input')!)
    btn().click()
    document.body.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }))
    input().value = 'looks off'
    input().dispatchEvent(new Event('input'))
    submitBtn().click()
    await flushMicrotasks()
    const reqId = sent.find((f) => f.type === 'feedback-submit').requestId

    internals().handleFrame({ type: 'feedback-ack', requestId: reqId, ok: false, message: 'nope' })
    expect(status().classList.contains('error')).toBe(true)
    expect(status().textContent).toBe('nope')
    vi.advanceTimersByTime(2000)
    expect(panel().hidden).toBe(false) // stays open on error
    expect(submitBtn().disabled).toBe(false) // retry allowed
  })

  it('a stale feedback-ack (unmatched requestId) is ignored', () => {
    sendHello({ feedback: true })
    internals().FeedbackEngine._reqId = 'fb-current'
    internals().FeedbackEngine.setStatus('Sending…', 'info')
    internals().handleFrame({ type: 'feedback-ack', requestId: 'fb-other', ok: true })
    // Unchanged — the stale ack did not flip status to ok.
    expect(status().classList.contains('ok')).toBe(false)
  })

  // ── cropAndEncodeFeedbackScreenshot (pure helper) ─────────────────────────
  //
  // jsdom does not ship a real <canvas> 2D rasterizer (no `canvas` npm
  // package in this workspace), so `getContext('2d')` returns null by
  // default. These tests stub `HTMLCanvasElement.prototype.getContext` /
  // `toDataURL` to exercise the crop-rect math and the downscale-retry loop
  // without a real rasterizer — the function itself is otherwise pure.
  describe('cropAndEncodeFeedbackScreenshot', () => {
    let origGetContext: any
    let origToDataURL: any

    beforeEach(() => {
      origGetContext = (HTMLCanvasElement.prototype as any).getContext
      origToDataURL = (HTMLCanvasElement.prototype as any).toDataURL
    })

    afterEach(() => {
      ;(HTMLCanvasElement.prototype as any).getContext = origGetContext
      ;(HTMLCanvasElement.prototype as any).toDataURL = origToDataURL
    })

    it('returns the full crop size, unscaled, when the first pass is already within budget', () => {
      ;(HTMLCanvasElement.prototype as any).getContext = function () {
        return { clearRect: () => {}, drawImage: () => {} }
      }
      ;(HTMLCanvasElement.prototype as any).toDataURL = function () {
        // A tiny fixed payload regardless of canvas size — always well under
        // FEEDBACK_SCREENSHOT_TARGET_BYTES, so the retry loop must not fire.
        return 'data:image/png;base64,' + 'A'.repeat(100)
      }
      const fakeImg = { naturalWidth: 2000, naturalHeight: 2000 } as any
      const result = internals().cropAndEncodeFeedbackScreenshot(
        fakeImg,
        { x: 10, y: 20, w: 100, h: 50 },
        1,
      )
      expect(result).toBeTruthy()
      expect(result.width).toBe(100)
      expect(result.height).toBe(50)
      expect(result.base64).toBe('A'.repeat(100))
      expect(result.bytes).toBeGreaterThan(0)
    })

    it('downscales the output when the encoded size exceeds the target budget', () => {
      ;(HTMLCanvasElement.prototype as any).getContext = function () {
        return { clearRect: () => {}, drawImage: () => {} }
      }
      ;(HTMLCanvasElement.prototype as any).toDataURL = function (this: HTMLCanvasElement) {
        // Payload size scales with canvas area so shrinking the canvas
        // actually shrinks the encoded output — proves the retry loop drives
        // real downscaling, not a no-op.
        const chars = Math.max(1, Math.round(this.width * this.height * 4))
        return 'data:image/png;base64,' + 'A'.repeat(chars)
      }
      const fakeImg = { naturalWidth: 4000, naturalHeight: 4000 } as any
      // Requested crop is 2000x1500 CSS px at dpr=2 -> 4000x3000 source px,
      // an encoded size far above FEEDBACK_SCREENSHOT_TARGET_BYTES (400000).
      const result = internals().cropAndEncodeFeedbackScreenshot(
        fakeImg,
        { x: 0, y: 0, w: 2000, h: 1500 },
        2,
      )
      expect(result).toBeTruthy()
      expect(result.width).toBeLessThan(4000)
      expect(result.height).toBeLessThan(3000)
      // Aspect ratio is preserved by the uniform 0.75x shrink factor.
      expect(result.width / result.height).toBeCloseTo(4000 / 3000, 1)
    })

    it('returns null when getContext yields no context (defensive — never throws)', () => {
      ;(HTMLCanvasElement.prototype as any).getContext = function () { return null }
      const fakeImg = { naturalWidth: 500, naturalHeight: 500 } as any
      const result = internals().cropAndEncodeFeedbackScreenshot(fakeImg, { x: 0, y: 0, w: 100, h: 100 }, 1)
      expect(result).toBeNull()
    })

    it('returns null for a degenerate (zero-area) crop rect instead of throwing', () => {
      const fakeImg = { naturalWidth: 500, naturalHeight: 500 } as any
      const result = internals().cropAndEncodeFeedbackScreenshot(fakeImg, { x: 600, y: 600, w: 100, h: 100 }, 1)
      expect(result).toBeNull()
    })
  })
})
