// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

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

    // 4. Extract and execute the frontend script to bind event listeners
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
      
      // Verification: Window should shrink back to 140x140
      expect(mockSetSize).toHaveBeenCalledWith({ type: 'Logical', width: 140, height: 140 })
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

      // pointerdown captures startW = TauriService.lastSize.w (140 on boot)
      //   and startX/startY = the pointer's screen coords.
      grip!.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, clientX: 0, clientY: 0, screenX: 100, screenY: 100,
      }))
      // pointermove computes pendingW = max(MIN_W=360, round(140 + dx)),
      //   pendingH = max(MIN_H=360, round(140 + dy)). With dx=dy=400 -> 540, 540.
      grip!.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true, clientX: 0, clientY: 0, screenX: 500, screenY: 500,
      }))
      // pointerup -> endResize -> PanelSize.save(pendingW, pendingH).
      grip!.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true, clientX: 0, clientY: 0, screenX: 500, screenY: 500,
      }))

      const stored = localStorage.getItem('luna.moon.chatSize')
      expect(stored).not.toBeNull()
      expect(JSON.parse(stored!)).toEqual({ w: 540, h: 540 })
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

      expect(mockSetSize).toHaveBeenCalledWith({ type: 'Logical', width: 140, height: 140 })
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

    // ── Empty-bubble cleanup ──────────────────────────────────────────────
    it('Scenario: isVisuallyEmpty returns true for an empty bubble', () => {
      const isVisuallyEmpty = (internals() as any).isVisuallyEmpty
      const bubble = document.createElement('div')
      expect(isVisuallyEmpty(bubble)).toBe(true)
    })

    it('Scenario: isVisuallyEmpty returns true for a whitespace-only bubble', () => {
      const isVisuallyEmpty = (internals() as any).isVisuallyEmpty
      const bubble = document.createElement('div')
      bubble.innerHTML = '   \n   '
      expect(isVisuallyEmpty(bubble)).toBe(true)
    })

    it('Scenario: isVisuallyEmpty returns false for a bubble with text content', () => {
      const isVisuallyEmpty = (internals() as any).isVisuallyEmpty
      const bubble = document.createElement('div')
      bubble.innerHTML = '<p>hi</p>'
      expect(isVisuallyEmpty(bubble)).toBe(false)
    })

    it('Scenario: isVisuallyEmpty returns false for a bubble with a rich block (table/img/pre/ul/a)', () => {
      const isVisuallyEmpty = (internals() as any).isVisuallyEmpty
      for (const html of ['<table></table>', '<img src="x">', '<pre></pre>', '<ul></ul>', '<a href="#"></a>']) {
        const b = document.createElement('div')
        b.innerHTML = html
        expect(isVisuallyEmpty(b)).toBe(false)
      }
    })

    it('Scenario: isVisuallyEmpty returns false for a typing-dots bubble (in-flight turn cue)', () => {
      const isVisuallyEmpty = (internals() as any).isVisuallyEmpty
      const b = document.createElement('div')
      b.innerHTML = '<div class="typing-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>'
      // Typing-dots have no textContent and no img/pre/etc, but they ARE a
      // visible "still working" indicator — the sweep must skip them so an
      // in-flight turn isn't GC'd before its first delta with real text.
      expect(isVisuallyEmpty(b)).toBe(false)
    })

    // ── sweepTrailingEmptyAssistantBubbles ────────────────────────────────
    it('Scenario: sweepTrailingEmptyAssistantBubbles removes consecutive empty assistant tail bubbles', () => {
      const { sweepTrailingEmptyAssistantBubbles } = internals() as any
      const chat = document.getElementById('chat-messages')!
      // Real content + 3 trailing empties.
      chat.innerHTML = ''
      const real = document.createElement('div'); real.className = 'msg assistant'; real.innerHTML = '<p>hello</p>'
      chat.appendChild(real)
      for (let i = 0; i < 3; i++) {
        const empty = document.createElement('div'); empty.className = 'msg assistant'
        chat.appendChild(empty)
      }
      expect(chat.children.length).toBe(4)
      sweepTrailingEmptyAssistantBubbles()
      expect(chat.children.length).toBe(1)
      expect(chat.children[0]).toBe(real)
    })

    it('Scenario: sweepTrailingEmptyAssistantBubbles stops at the first non-empty bubble (does NOT eat real content)', () => {
      const { sweepTrailingEmptyAssistantBubbles } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      const a = document.createElement('div'); a.className = 'msg assistant'; a.innerHTML = '<p>one</p>'
      const b = document.createElement('div'); b.className = 'msg assistant'  // empty
      const c = document.createElement('div'); c.className = 'msg assistant'; c.innerHTML = '<p>two</p>'  // not at tail
      const tail = document.createElement('div'); tail.className = 'msg assistant'  // empty at tail
      chat.appendChild(a); chat.appendChild(b); chat.appendChild(c); chat.appendChild(tail)

      sweepTrailingEmptyAssistantBubbles()
      // Only the trailing empty gets removed; the interior empty (b) survives
      // because the walk stops at c (non-empty assistant).
      expect(chat.children.length).toBe(3)
      expect(chat.children[chat.children.length - 1]).toBe(c)
    })

    it('Scenario: sweepTrailingEmptyAssistantBubbles stops at a non-assistant bubble (e.g. user message)', () => {
      const { sweepTrailingEmptyAssistantBubbles } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      const user = document.createElement('div'); user.className = 'msg user'; user.textContent = 'hi'
      chat.appendChild(user)
      // No trailing assistant bubble at all -> sweep is a no-op.
      sweepTrailingEmptyAssistantBubbles()
      expect(chat.children.length).toBe(1)
      expect(chat.children[0]).toBe(user)
    })

    it('Scenario: sweepTrailingEmptyAssistantBubbles preserves a typing-dots bubble at the tail', () => {
      const { sweepTrailingEmptyAssistantBubbles } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      const dots = document.createElement('div'); dots.className = 'msg assistant'
      dots.innerHTML = '<div class="typing-dots"><div class="dot"></div></div>'
      chat.appendChild(dots)
      sweepTrailingEmptyAssistantBubbles()
      // Typing-dots aren't visually empty per isVisuallyEmpty, so they stay.
      expect(chat.children.length).toBe(1)
    })

    it('Scenario: sweepTrailingEmptyAssistantBubbles handles a chat list with ONLY empty assistant bubbles', () => {
      const { sweepTrailingEmptyAssistantBubbles } = internals() as any
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
      for (let i = 0; i < 4; i++) {
        const empty = document.createElement('div'); empty.className = 'msg assistant'
        chat.appendChild(empty)
      }
      sweepTrailingEmptyAssistantBubbles()
      expect(chat.children.length).toBe(0)
    })
  })
})
