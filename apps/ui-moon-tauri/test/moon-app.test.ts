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
})
