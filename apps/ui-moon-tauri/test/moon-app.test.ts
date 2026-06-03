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
})
