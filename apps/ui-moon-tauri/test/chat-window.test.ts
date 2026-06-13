// @vitest-environment jsdom
//
// chat-window.test.ts — behavioral suite for frontend/chat.html, the chat
// WIDGET WINDOW (widget-system.md Phase 4 "extraction-as-new-page").
//
// The chat-scope describes are COPIES of their moon-app.test.ts originals
// (which keep covering the hub's dormant chat code until the Phase 6
// cleanup), adapted to the chat.html harness: widget-window chrome instead
// of the moon, window-targeted voice/hub events, and the window owning the
// thread. New-here coverage: the secret-prompt engine surface, thread
// bootstrap, hello extras (buildSha/availableModels/protocol skew), window
// chrome + hub-event return channel, and the attachments composer.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// jsdom never fetches external <script src> tags, so required vendor files
// are loaded by hand, in the same order the page declares them (same
// mechanism as moon-app.test.ts / widget-window.test.ts).
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

describe('Luna Chat Window (chat.html) - Behavioral Tests', () => {
  let htmlContent: string
  // Window-targeted event handlers captured from getCurrentWindow().listen —
  // voice-state / voice-transcript / voice-error / hub-event / dock-group.
  let windowEventHandlers: Record<string, (e: { payload: any }) => void>
  let mockMe: any

  beforeEach(() => {
    // 1. Load chat.html content + body structure.
    htmlContent = fs.readFileSync(path.resolve(__dirname, '../frontend/chat.html'), 'utf8')
    const bodyMatch = htmlContent.match(/<body>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

    // 2. Mock the Tauri window surface. NOTE: no `core` by default — boot
    // degrades exactly like the hub harness (voice unavailable, localStorage
    // connection branch). Tests that need invoke inject __TAURI__.core.
    windowEventHandlers = {}
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

    // 3. Load the vendor modules the page script uses at definition time.
    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'deck-snap.js')
    loadVendorInto(window, 'moon-dock.js')

    // Clean localStorage so persisted-prefs tests don't leak across cases.
    localStorage.clear()

    // 4. Select the inline page script by CONTENT, not position (an added
    // config stub must fail loudly here, not silently run the wrong script).
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
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Composer submit + the 90s turn watchdog
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
      expect(userMessage!.querySelector('.msg-body')!.textContent).toBe('How does this look?')

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
  // Feature: Live-streaming markdown render (vendor/moon-markdown.js through the page)
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
    // Canonical fix (commit cf7deed):
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
      expect(answer2.querySelector('.msg-body')?.textContent?.trim()).toBe('Found 3 lines.')
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
  // Feature: ChatState reducer (the chat transcript source of truth)
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
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Per-message action row — always-visible copy + relative send-time
  //
  // Each settled user/assistant bubble carries a `.msg-meta` footer holding the
  // `.msg-copy` button (writes the message's RAW source to the clipboard) and a
  // `.msg-time` "9m ago" stamp. Content lives in `.msg-body` so the time text
  // stays out of the bubble's textContent. The row is rebuilt inside
  // _paintUser/_paintText each paint (survives the reconciler), and the time
  // refreshes on focus/click via a delegated listener — no timer.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: per-message action row (copy + time)', () => {
    const M = () => (window as any).__MoonInternals
    let chat: HTMLElement

    beforeEach(() => {
      // Synchronous rAF so each frame's render is observable immediately.
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      M().ChatState.reset()
      chat = document.getElementById('chat-messages') as HTMLElement
      chat.innerHTML = ''
    })

    it('Scenario: a settled assistant answer copies its RAW markdown (not the rendered text)', async () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'Hello **world** and `code`' })
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: 'Hello **world** and `code`' } })

      const bubble = chat.querySelector('.msg.assistant') as HTMLElement
      // The bubble shows rendered markdown...
      expect(bubble.innerHTML).toContain('<strong>world</strong>')
      // ...but the copy button writes the raw source so a paste keeps structure.
      const btn = bubble.querySelector('.msg-copy') as HTMLButtonElement
      expect(btn).not.toBeNull()

      let captured: string | null = null
      ;(navigator as any).clipboard = {
        writeText: (t: string) => { captured = t; return Promise.resolve() },
      }
      btn.click()
      await Promise.resolve()           // flush the writeText().then(flashDone)
      expect(captured).toBe('Hello **world** and `code`')

      // Flips to the mint "copied" confirmation, then reverts after the beat.
      expect(btn.dataset.copied).toBe('1')
      vi.advanceTimersByTime(1200)
      expect(btn.dataset.copied).toBeUndefined()
    })

    it('Scenario: a user message copies its typed text; .msg-body keeps the visible text clean', async () => {
      M().handleFrame({ type: 'thread-snapshot', messages: [{ role: 'user', text: 'copy me please' }] })

      const userMsg = chat.querySelector('.msg.user') as HTMLElement
      // Content lives in .msg-body, so the body reads exactly the typed message
      // even though the meta footer adds a time stamp alongside it.
      expect(userMsg.querySelector('.msg-body')!.textContent).toBe('copy me please')

      const btn = userMsg.querySelector('.msg-meta .msg-copy') as HTMLButtonElement
      expect(btn).not.toBeNull()

      let captured: string | null = null
      ;(navigator as any).clipboard = {
        writeText: (t: string) => { captured = t; return Promise.resolve() },
      }
      btn.click()
      await Promise.resolve()
      expect(captured).toBe('copy me please')
    })

    it('Scenario: a still-streaming assistant bubble has NO copy button (gated on done)', () => {
      // A single non-final delta renders a text bubble whose segment is not yet
      // done — the copy affordance must not appear (or re-appear) mid-stream.
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'partial answer' })

      const bubble = chat.querySelector('.msg.assistant') as HTMLElement
      expect(bubble).not.toBeNull()
      expect(bubble.dataset.streamRaw).toBe('partial answer')   // proves it rendered
      expect(chat.querySelector('.msg-copy')).toBeNull()

      // Once the turn finalizes, the button appears.
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: 'partial answer' } })
      expect(chat.querySelector('.msg.assistant .msg-copy')).not.toBeNull()
    })

    it('Scenario: a rejected clipboard write leaves the glyph unchanged (no false "copied")', async () => {
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'something' })
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: 'something' } })
      const btn = chat.querySelector('.msg.assistant .msg-copy') as HTMLButtonElement

      ;(navigator as any).clipboard = {
        writeText: () => Promise.reject(new Error('insecure context')),
      }
      btn.click()
      await Promise.resolve()
      // No confirmation state, and the copy glyph (two squares = a <rect>) stays.
      expect(btn.dataset.copied).toBeUndefined()
      expect(btn.querySelector('rect')).not.toBeNull()
    })

    it('Scenario: the copy icon carries explicit width/height so WKWebView renders it (regression)', () => {
      // The icon is injected via innerHTML at runtime; WKWebView needs explicit
      // intrinsic dimensions on the <svg> (a viewBox-only SVG sized only by CSS
      // renders blank there). jsdom doesn't lay out, so we pin the attributes.
      M().handleFrame({ type: 'assistant-delta', turnId: 't1', text: 'hi' })
      M().handleFrame({ type: 'assistant-done', turnId: 't1', message: { text: 'hi' } })
      const svg = chat.querySelector('.msg.assistant .msg-copy svg') as SVGElement
      expect(svg).not.toBeNull()
      expect(svg.getAttribute('width')).toBe('14')
      expect(svg.getAttribute('height')).toBe('14')
    })

    it('Scenario: settled user + assistant messages each render a meta row with copy + time', () => {
      const now = Date.now()   // frozen by the suite's fake timers
      M().handleFrame({
        type: 'thread-snapshot',
        messages: [
          { role: 'user', text: 'hi', ts: now - 9 * 60_000 },
          { role: 'assistant', text: 'hello', ts: now - 9 * 60_000 },
        ],
      })
      for (const sel of ['.msg.user', '.msg.assistant']) {
        const meta = chat.querySelector(`${sel} .msg-meta`) as HTMLElement
        expect(meta).not.toBeNull()
        expect(meta.querySelector('.msg-copy')).not.toBeNull()
        const time = meta.querySelector('.msg-time') as HTMLElement
        expect(time).not.toBeNull()
        // The diff renders from the stored ts against "now".
        expect(time.textContent).toBe('9m ago')
        expect(time.dataset.ts).toBe(String(now - 9 * 60_000))
      }
    })

    it('Scenario: a message with no ts (pre-`ts` server) renders the copy button but omits the time', () => {
      M().handleFrame({ type: 'thread-snapshot', messages: [{ role: 'assistant', text: 'legacy' }] })
      const meta = chat.querySelector('.msg.assistant .msg-meta') as HTMLElement
      expect(meta).not.toBeNull()
      expect(meta.querySelector('.msg-copy')).not.toBeNull()
      expect(meta.querySelector('.msg-time')).toBeNull()
    })

    it('Scenario: focusing or clicking a message refreshes its relative time (no timer)', () => {
      const now = Date.now()
      M().handleFrame({ type: 'thread-snapshot', messages: [{ role: 'assistant', text: 'hi', ts: now - 60_000 }] })
      const span = chat.querySelector('.msg-time') as HTMLElement
      expect(span.textContent).toBe('1m ago')

      // Five minutes pass with no re-render — the stamp goes stale...
      vi.advanceTimersByTime(5 * 60_000)
      expect(span.textContent).toBe('1m ago')

      // ...until you tab onto the copy button (focusin bubbles to the delegated
      // listener on #chat-messages), which recomputes it.
      const btn = chat.querySelector('.msg-copy') as HTMLButtonElement
      btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      expect(span.textContent).toBe('6m ago')

      // Clicking the bubble refreshes it too.
      vi.advanceTimersByTime(60 * 60_000)
      ;(chat.querySelector('.msg.assistant') as HTMLElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(span.textContent).toBe('1h ago')

      // And clicking the COPY BUTTON itself refreshes — WKWebView doesn't focus
      // a <button> on click, so the click must be allowed to bubble to the
      // delegated listener (regression guard: a stopPropagation on the copy
      // handler would silently break refresh-on-copy in the real app).
      ;(navigator as any).clipboard = { writeText: () => Promise.resolve() }
      vi.advanceTimersByTime(60 * 60_000)
      btn.click()
      expect(span.textContent).toBe('2h ago')
    })

    it('Scenario: formatRelTime renders the compact relative forms', () => {
      const f = M().formatRelTime
      const now = 10_000_000_000
      expect(f(now - 5_000, now)).toBe('just now')
      expect(f(now - 59_000, now)).toBe('just now')
      expect(f(now - 60_000, now)).toBe('1m ago')
      expect(f(now - 9 * 60_000, now)).toBe('9m ago')
      expect(f(now - 60 * 60_000, now)).toBe('1h ago')
      expect(f(now - 5 * 3_600_000, now)).toBe('5h ago')
      expect(f(now - 24 * 3_600_000, now)).toBe('1d ago')
      expect(f(now - 3 * 86_400_000, now)).toBe('3d ago')
      expect(f(undefined, now)).toBe('')               // no ts → empty (time span omitted)
      expect(f(now + 5_000, now)).toBe('just now')      // clock skew clamps to "just now"
    })

    it('Scenario: the reducer captures send-time ts (history, user, assistant-done)', () => {
      const S = M().ChatState
      // History keeps each server stamp.
      S.reset()
      S.loadHistory([{ role: 'user', text: 'a', ts: 111 }, { role: 'assistant', text: 'b', ts: 222 }])
      expect(S.turns[0].ts).toBe(111)
      expect(S.turns[1].ts).toBe(222)
      // appendUser honors an explicit stamp...
      S.reset()
      S.appendUser('hi', null, 555)
      expect(S.turns[0].ts).toBe(555)
      // ...and defaults to a real client clock when omitted.
      S.reset()
      S.appendUser('hi', null)
      expect(typeof S.turns[0].ts).toBe('number')
      // assistant-done's message.ts lands on the turn via finishTurn.
      S.reset()
      S.applyDelta('t1', 'answer')
      S.finishTurn('t1', 'answer', 777)
      expect(S.turns[0].ts).toBe(777)
    })

    it('Scenario: the reducer rejects non-finite ts (NaN/Infinity) instead of storing a junk stamp', () => {
      const S = M().ChatState
      // History: a non-finite server ts drops to undefined (no time rendered).
      S.reset()
      S.loadHistory([{ role: 'user', text: 'a', ts: NaN }, { role: 'assistant', text: 'b', ts: Infinity }])
      expect(S.turns[0].ts).toBeUndefined()
      expect(S.turns[1].ts).toBeUndefined()
      // appendUser: a non-finite stamp falls back to the real clock (no u-NaN- key).
      S.reset()
      S.appendUser('hi', null, NaN)
      expect(Number.isFinite(S.turns[0].ts)).toBe(true)
      expect(S.turns[0].key).not.toContain('NaN')
      // finishTurn: a non-finite ts leaves the turn unstamped (time stays omitted).
      S.reset()
      S.applyDelta('t1', 'answer')
      S.finishTurn('t1', 'answer', Infinity)
      expect(S.turns[0].ts).toBeUndefined()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: UserAsk / alignment-survey (survey-request → survey-response)
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
  // Feature: secure secret-entry panel (agent request_secret). The hub's suite
  // only pinned the collapse-path wipe; the chat window hosts the inputs now,
  // so the engine surface + the registerCloseHook wipe are pinned here.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: secure secret-entry panel', () => {
    const M = () => (window as any).__MoonInternals

    const showFrame = () => M().handleFrame({
      type: 'secret-request',
      requestId: 'req-1',
      prompt: 'Paste the API key for FooCorp',
      destinationLabel: 'env:FOOCORP_API_KEY',
    })
    const input = () => document.getElementById('secret-prompt-input') as HTMLInputElement
    const panel = () => document.getElementById('secret-prompt-panel') as HTMLElement
    const status = () => document.getElementById('secret-prompt-status') as HTMLElement

    beforeEach(() => {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      M().ChatState.reset()
      M().SecretPromptEngine.hide()
    })

    it('a secret-request frame reveals the panel with prompt + consent destination', () => {
      showFrame()
      expect(panel().hidden).toBe(false)
      expect(document.getElementById('secret-prompt-prompt')!.textContent)
        .toBe('Paste the API key for FooCorp')
      const consent = document.getElementById('secret-prompt-consent') as HTMLElement
      expect(consent.hidden).toBe(false)
      expect(consent.textContent).toContain('env:FOOCORP_API_KEY')
      expect(input().value).toBe('')
    })

    it('a missing destinationLabel hides the consent line', () => {
      M().handleFrame({ type: 'secret-request', requestId: 'req-nl', prompt: 'Key?' })
      expect((document.getElementById('secret-prompt-consent') as HTMLElement).hidden).toBe(true)
    })

    it('submit with an empty value shows an error and sends nothing', () => {
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      showFrame()
      document.getElementById('secret-prompt-submit')!.click()
      expect(sendSpy).not.toHaveBeenCalled()
      expect(status().textContent).toBe('Enter a value first.')
    })

    it('submit while the socket is not OPEN refuses (send() logs frames when not open — the leak guard)', () => {
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      showFrame()
      M().State.ws = null
      input().value = 'sk-secret'
      document.getElementById('secret-prompt-submit')!.click()
      expect(sendSpy).not.toHaveBeenCalled()
      expect(status().textContent).toBe('Not connected.')
      // Not wiped: the operator can retry after the reconnect lands.
      expect(input().value).toBe('sk-secret')
    })

    it('submit on an OPEN socket sends ONE secret-result and wipes the input immediately', () => {
      showFrame()
      M().State.ws = { readyState: WebSocket.OPEN, send: vi.fn() }
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      input().value = 'sk-live-12345'
      document.getElementById('secret-prompt-submit')!.click()
      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect(sendSpy.mock.calls[0][0]).toEqual({
        type: 'secret-result', requestId: 'req-1', secret: 'sk-live-12345',
      })
      expect(input().value).toBe('')          // one-shot — never retained
      expect(status().textContent).toBe('Saving…')
    })

    it('Enter in the password field submits (single-field form feel)', () => {
      showFrame()
      M().State.ws = { readyState: WebSocket.OPEN, send: vi.fn() }
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      input().value = 'sk-enter'
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect((sendSpy.mock.calls[0][0] as any).secret).toBe('sk-enter')
    })

    it('cancel sends secret-result cancelled:true (when OPEN), hides + wipes', () => {
      showFrame()
      M().State.ws = { readyState: WebSocket.OPEN, send: vi.fn() }
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      input().value = 'half-typed'
      document.getElementById('secret-prompt-cancel')!.click()
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'secret-result', requestId: 'req-1', cancelled: true,
      })
      expect(input().value).toBe('')
      expect(panel().hidden).toBe(true)
    })

    it('secret-status: a stale requestId is ignored; the matching ok ack auto-hides after 1.5s', () => {
      showFrame()
      M().handleFrame({ type: 'secret-status', requestId: 'other', ok: true, message: 'nope' })
      expect(status().textContent).toBe('')   // unmatched → ignored
      M().handleFrame({ type: 'secret-status', requestId: 'req-1', ok: true, message: 'Saved to vault.' })
      expect(status().textContent).toBe('Saved to vault.')
      expect(panel().hidden).toBe(false)      // brief "saved" stays readable…
      vi.advanceTimersByTime(1500)
      expect(panel().hidden).toBe(true)       // …then the panel hides
      expect(input().value).toBe('')
    })

    it('a failed secret-status leaves the message + panel visible (now inert)', () => {
      showFrame()
      M().handleFrame({ type: 'secret-status', requestId: 'req-1', ok: false, message: 'op vault rejected it' })
      expect(status().textContent).toBe('op vault rejected it')
      vi.advanceTimersByTime(5000)
      expect(panel().hidden).toBe(false)
      // _reqId cleared → a stray submit is inert.
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      input().value = 'retyped'
      M().SecretPromptEngine.submit()
      expect(sendSpy).not.toHaveBeenCalled()
    })

    it('the WS close hook wipes a typed-but-unsent secret (registerCloseHook seam)', () => {
      showFrame()
      input().value = 'typed-not-sent'
      const hooks = M().WebSocketEngine._closeHooks
      expect(hooks.length).toBeGreaterThanOrEqual(1)
      for (const hook of hooks) hook()
      expect(input().value).toBe('')
      // VALUE only — the panel stays up so the success flow's brief "saved"
      // message (server restarts → socket closes) isn't killed early.
      expect(panel().hidden).toBe(false)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: handleSubmit single-fire guard (no double-send)
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
  // Feature: Long-running turn timeline stays scrollable (CSS regression)
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

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: thread reattach (subscribe watchdog, in-memory preference, restart-survival)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: thread reattach correctness', () => {
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
  // Feature: thread bootstrap — THE CHAT WINDOW OWNS THE THREAD now
  // (one-window-per-thread). thread-list/-created drive auto-subscribe and
  // auto-create exactly as the hub's connection did.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: thread bootstrap (window owns the thread)', () => {
    const M = () => (window as any).__MoonInternals

    beforeEach(() => {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      M().ChatState.reset()
      M().State.activeThreadId = null
      M().State.pendingUserMessage = null
    })

    it('thread-list with threads and no active thread subscribes to the most recent', () => {
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().handleFrame({ type: 'thread-list', threads: [{ id: 'th-new' }, { id: 'th-old' }] })
      expect(M().State.activeThreadId).toBe('th-new')
      expect(sendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'th-new' })
    })

    it('thread-list with NO threads auto-creates one (new-thread frame)', () => {
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().handleFrame({ type: 'thread-list', threads: [] })
      expect(sendSpy).toHaveBeenCalledWith({ type: 'new-thread' })
    })

    it('the new-thread frame carries the persisted model pick (luna_model)', () => {
      localStorage.setItem('luna_model', 'gemini-3-flash')
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().handleFrame({ type: 'thread-list', threads: [] })
      expect(sendSpy).toHaveBeenCalledWith({ type: 'new-thread', model: 'gemini-3-flash' })
    })

    it('an existing active thread ignores a thread-list (no re-subscribe)', () => {
      M().State.activeThreadId = 'th-current'
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().handleFrame({ type: 'thread-list', threads: [{ id: 'th-other' }] })
      expect(sendSpy).not.toHaveBeenCalled()
      expect(M().State.activeThreadId).toBe('th-current')
    })

    it('thread-created subscribes and flushes the queued user message after the settle delay', () => {
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().State.pendingUserMessage = { text: 'queued hello', attachments: undefined }
      M().handleFrame({ type: 'thread-created', thread: { id: 'th-fresh' } })
      expect(M().State.activeThreadId).toBe('th-fresh')
      expect(sendSpy).toHaveBeenCalledWith({ type: 'subscribe', threadId: 'th-fresh' })
      expect(M().State.pendingUserMessage).toBeNull()  // claimed before the delay
      vi.advanceTimersByTime(100)
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'user-message',
        threadId: 'th-fresh',
        text: 'queued hello',
        client: expect.objectContaining({ name: 'luna-moon' }),
      }))
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: hello extras — build identity, the availableModels cache the
  // settings.connection panel reads, and the protocol version-skew defence.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: hello — buildSha + availableModels cache + protocol skew', () => {
    const M = () => (window as any).__MoonInternals

    beforeEach(() => {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      M().ChatState.reset()
    })

    it('hello caches advertised model list (with label + efforts) to luna_available_models', () => {
      M().handleFrame({
        type: 'hello', protocolVersion: 2, capabilities: {},
        availableModels: [{ id: 'm-1', label: 'One', efforts: ['low', 'max'] }, { id: 'm-2' }, { bogus: true }],
      })
      const cached = JSON.parse(localStorage.getItem('luna_available_models')!)
      // New cache shape: array of {id, label, efforts} objects (not plain id strings).
      expect(cached).toHaveLength(2)
      expect(cached[0]).toEqual({ id: 'm-1', label: 'One', efforts: ['low', 'max'] })
      // m-2 has no label or efforts — defaults applied.
      expect(cached[1]).toEqual({ id: 'm-2', label: 'm-2', efforts: [] })
    })

    it('hello with a buildSha reveals the header build label; absent hides it again', () => {
      M().handleFrame({ type: 'hello', protocolVersion: 2, capabilities: {}, buildSha: 'abc1234' })
      const el = document.getElementById('build-sha') as HTMLElement
      expect(el.hidden).toBe(false)
      expect(el.textContent).toBe('build abc1234')
      M().handleFrame({ type: 'hello', protocolVersion: 2, capabilities: {} })
      expect(el.hidden).toBe(true)
    })

    it('a protocol-version MISMATCH warns loudly but keeps chatting enabled (idempotent banner)', () => {
      M().handleFrame({ type: 'hello', protocolVersion: 99, capabilities: {} })
      const statusEl = document.getElementById('connection-status')!
      expect(statusEl.className).toBe('version-warning')
      expect(statusEl.textContent).toContain('v99')
      expect(document.getElementById('protocol-mismatch-banner')).not.toBeNull()
      // Reconnects re-deliver hello — no duplicate banners.
      M().handleFrame({ type: 'hello', protocolVersion: 99, capabilities: {} })
      expect(document.querySelectorAll('#protocol-mismatch-banner').length).toBe(1)
    })

    it('an older server with NO protocolVersion gets one soft note, never a hard banner', () => {
      M().handleFrame({ type: 'hello', capabilities: {} })
      M().handleFrame({ type: 'hello', capabilities: {} })
      expect(document.getElementById('protocol-mismatch-banner')).toBeNull()
      const notes = Array.from(document.querySelectorAll('#chat-messages .msg.assistant'))
        .filter((n) => n.textContent!.includes('older server'))
      expect(notes.length).toBe(1)
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Behavioral Feature: Voice — transcript routing into the EXACT send path
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
      expect(userMsgs[0].querySelector('.msg-body')!.textContent).toBe('what time is it')
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
  // Behavioral Feature: Voice — persisted settings load
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice settings persistence', () => {
    const M = () => (window as any).__MoonInternals

    // The Settings → Voice controls (mode segment, speak-replies toggle,
    // silence slider, voice picker) moved to the standalone voice panel —
    // covered in test/panel-voice.test.ts. The hub still owns loadSettings()
    // (localStorage → VoiceEngine state at boot), pinned here.

    it('Scenario: a stored out-of-range silence hang is clamped on load', () => {
      localStorage.setItem('luna_voice_silence_hang_ms', '99999')
      M().VoiceEngine.loadSettings()
      expect(M().VoiceEngine.silenceHangMs).toBe(1200)
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
  // Behavioral Feature: Voice — availability probe + boot wiring (chat window).
  // Voice events arrive WINDOW-TARGETED here (getCurrentWindow().listen), not
  // via the global event API — they are broadcast app-wide by the Rust core.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Voice availability + boot wiring (chat window)', () => {
    const M = () => (window as any).__MoonInternals

    it('Scenario: without a Tauri voice backend the window degrades (mic hidden, engine unavailable)', () => {
      // The shared beforeEach has no __TAURI__.core: VoiceEngine.init() lands
      // in "unavailable" synchronously at boot.
      expect(M().VoiceEngine.available).toBe(false)
      expect(document.getElementById('voice-mic-btn')!.hidden).toBe(true)
    })

    it('Scenario: a Rust core whose voice_status REJECTS (older build) degrades silently, no throw', async () => {
      const invoke = vi.fn().mockRejectedValue(new Error('unknown command voice_status'))
      ;(window as any).__TAURI__.core = { invoke }
      await M().VoiceEngine.init()
      expect(M().VoiceEngine.available).toBe(false)
      expect(document.getElementById('voice-mic-btn')!.hidden).toBe(true)
      // Only the probe was attempted — no follow-up voice commands to spam.
      expect(invoke.mock.calls.map((c) => c[0])).toEqual(['voice_status'])
    })

    it('Scenario: with a voice backend, boot probes status, subscribes WINDOW-TARGETED events, re-applies persisted settings', async () => {
      localStorage.setItem('luna_voice_mode', 'auto')
      localStorage.setItem('luna_voice_silence_hang_ms', '800')
      const invoke = vi.fn(async (cmd: string) => {
        if (cmd === 'voice_status') return { state: 'idle', mode: 'off', modelPresent: true }
        return null
      })
      ;(window as any).__TAURI__.core = { invoke }

      await M().VoiceEngine.init()

      expect(invoke).toHaveBeenCalledWith('voice_status')
      expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'auto' })
      expect(invoke).toHaveBeenCalledWith('voice_set_config', { silenceHangMs: 800 })
      // Voice events ride getCurrentWindow().listen — window-targeted, no
      // model-progress here (that is the settings.voice panel's concern).
      expect(Object.keys(windowEventHandlers)).toEqual(expect.arrayContaining([
        'voice-state', 'voice-transcript', 'voice-error',
      ]))
      expect(windowEventHandlers['voice-model-progress']).toBeUndefined()
      expect(document.getElementById('voice-mic-btn')!.hidden).toBe(false)

      // A captured voice-transcript event routes through the real send path.
      const sendSpy = vi.spyOn(M().WebSocketEngine, 'send').mockImplementation(() => {})
      M().State.activeThreadId = 'th-boot'
      M().VoiceEngine.micPaused = false
      windowEventHandlers['voice-transcript']({ payload: { text: 'hello from voice', final: true } })
      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'user-message', text: 'hello from voice',
      }))
    })

    it('Scenario: voice-state events drive the MIC visuals (no moon wrapper in this window)', () => {
      const V = M().VoiceEngine
      const mic = document.getElementById('voice-mic-btn')!
      V.onStateEvent({ state: 'listening', mode: 'auto', level: 0.5 })
      expect(mic.dataset.voiceState).toBe('listening')
      V.onStateEvent({ state: 'speaking', mode: 'auto' })
      expect(mic.dataset.voiceState).toBe('speaking')
      V.onStateEvent({ state: 'off', mode: 'off' })
      expect(mic.dataset.voiceState).toBe('')
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

      V.setMode('auto')                          // user picked Hands-free, no model yet
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
      expect(V.micPaused).toBe(true)
      expect(V.rustMode).toBe('off')

      invoke.mockClear()
      V.onMicClick()                             // first click must START voice…
      expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'auto' })
      expect(invoke).not.toHaveBeenCalledWith('voice_set_mode', { mode: 'off' })  // …not "pause" it
    })

    it('Scenario: mic click while voice is OFF opens the settings.voice panel (discoverability)', () => {
      const invoke = vi.fn(async () => null)
      ;(window as any).__TAURI__.core = { invoke }
      const V = M().VoiceEngine
      V.available = true
      V.mode = 'off'
      document.getElementById('voice-mic-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'settings.voice' })
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

    it('the mic button still carries the hidden attribute by default', () => {
      // The override only matters because the element SHIPS hidden and is
      // toggled via the property; keep that contract pinned. (The
      // voice-unavailable note moved to the voice panel: test/panel-voice.test.ts.)
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
      // Snap-on-open (Rust) positions the pop-out; the click just fires the
      // open with {artifactId, title} — no deck census, no cascade math.
      const invokeMock = vi.fn(async () => undefined)
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

      expect(invokeMock).toHaveBeenCalledWith('open_artifact_widget', {
        artifactId: 'pin-pop',
        title: 'deploy.sh',
      })
      // No deck census, no cascade: exactly one invoke, never list_widget_windows.
      expect(invokeMock).toHaveBeenCalledTimes(1)
      expect(invokeMock).not.toHaveBeenCalledWith('list_widget_windows')
    })

    it('(f) pop-out button on a session artifact PINS it, then opens the widget; no-ops without Tauri', async () => {
      const m = M()

      // Part 1 — with Tauri present.
      const invokeMock = vi.fn(async () => undefined)
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

      // Widget windows render PINNED artifacts: popping out a session row
      // pins it first (artifact-pin rides the WS), then opens — snap-on-open
      // (Rust) tiles it flush against the nearest open panel.
      expect(invokeMock).toHaveBeenCalledWith('open_artifact_widget', {
        artifactId: 'msg-pop:0',
        title: 'snippet.py',
      })
      // No deck census IPC — snap-on-open positions it, not cascade math.
      expect(invokeMock).not.toHaveBeenCalledWith('list_widget_windows')

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

  // ───────────────────────────────────────────────────────────────────────────
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
  // Feature: widget-window chrome + the hub-event return channel. The window
  // follows panel.html's conventions (close_widget, LunaDock.wire) and acts on
  // window-targeted hub-events with the dock-group `for:` discipline.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: widget-window chrome + hub-event return channel', () => {
    const M = () => (window as any).__MoonInternals

    beforeEach(() => {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      M().ChatState.reset()
    })

    it('✕ closes via close_widget with this window label', () => {
      const invoke = vi.fn(async () => null)
      ;(window as any).__TAURI__.core = { invoke }
      document.getElementById('close-btn')!.click()
      expect(invoke).toHaveBeenCalledWith('close_widget', { label: 'chat-test' })
    })

    it('the GEAR opens the settings launcher widget', () => {
      const invoke = vi.fn(async () => null)
      ;(window as any).__TAURI__.core = { invoke }
      document.getElementById('toggle-settings')!.click()
      expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'settings' })
    })

    it('the GEAR degrades to a no-op off-Tauri (no core) without throwing', () => {
      expect(() => document.getElementById('toggle-settings')!.click()).not.toThrow()
    })

    it("hub-event 'fresh-thread' addressed to THIS window starts a new conversation", async () => {
      const m = M()
      m.State.activeThreadId = 'th-old'
      expect(windowEventHandlers['hub-event']).toBeTypeOf('function')
      windowEventHandlers['hub-event']({ payload: { for: 'chat-test', name: 'fresh-thread' } })
      await Promise.resolve()
      await Promise.resolve()
      expect(m.State.activeThreadId).toBeNull()
      expect(document.getElementById('chat-messages')!.textContent)
        .toContain('New conversation started')
    })

    it('hub-events addressed to OTHER windows are ignored (for-discipline)', async () => {
      const m = M()
      m.State.activeThreadId = 'th-keep'
      windowEventHandlers['hub-event']({ payload: { for: 'chat-other', name: 'fresh-thread' } })
      await Promise.resolve()
      await Promise.resolve()
      expect(m.State.activeThreadId).toBe('th-keep')
    })

    it('an unknown hub-event name is ignored without throwing', async () => {
      expect(() => {
        windowEventHandlers['hub-event']({ payload: { for: 'chat-test', name: 'mystery-action' } })
      }).not.toThrow()
      await Promise.resolve()
    })

    it('dock wiring is live: LunaDock.wire hooked this window (onMoved + dock-group listener)', () => {
      expect(mockMe.onMoved).toHaveBeenCalled()
      expect(windowEventHandlers['dock-group']).toBeTypeOf('function')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: attachments composer (Phase-1 uploads, copied engine). FileReader
  // paths run under REAL timers — jsdom delivers reader events async.
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: attachments composer', () => {
    const M = () => (window as any).__MoonInternals
    const A = () => M().Attachments

    beforeEach(() => {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      M().ChatState.reset()
      A().items = []
      A().setError(null)
      A().render()
    })

    it('classify() routes images / text / pdf / binary correctly', () => {
      expect(A().classify({ type: 'image/png', name: 'shot.png' })).toBe('image')
      expect(A().classify({ type: '', name: 'main.ts' })).toBe('text')
      expect(A().classify({ type: 'text/plain', name: 'notes' })).toBe('text')
      expect(A().classify({ type: 'application/pdf', name: 'doc.pdf' })).toBe('pdf')
      expect(A().classify({ type: '', name: 'paper.pdf' })).toBe('pdf')
      expect(A().classify({ type: 'application/octet-stream', name: 'blob.bin' })).toBe('binary')
    })

    it('an unsupported binary is declined with a visible error (no item staged)', async () => {
      vi.useRealTimers()
      await A().addFiles([new File(['x'], 'blob.bin', { type: 'application/octet-stream' })])
      const err = document.getElementById('attach-error') as HTMLElement
      expect(err.hidden).toBe(false)
      expect(err.textContent).toContain("can't read blob.bin")
      expect(A().items).toHaveLength(0)
    })

    it('a text file stages a chip, folds into the WIRE text, and stays out of the visible bubble', async () => {
      vi.useRealTimers()
      await A().addFiles([new File(['const x = 1'], 'snippet.ts', { type: 'text/plain' })])
      expect(A().items).toHaveLength(1)

      const strip = document.getElementById('attachments-strip') as HTMLElement
      expect(strip.hidden).toBe(false)
      expect(strip.querySelectorAll('.attachment-chip').length).toBe(1)
      expect(strip.textContent).toContain('snippet.ts')

      const m = M()
      m.handleFrame({ type: 'thread-created', thread: { id: 'th-att' } })
      const sendSpy = vi.spyOn(m.WebSocketEngine, 'send').mockImplementation(() => {})
      const ta = document.getElementById('message-input') as HTMLTextAreaElement
      ta.value = 'see attached'
      document.getElementById('chat-form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }))

      const um = sendSpy.mock.calls.find((c) => (c[0] as any).type === 'user-message')![0] as any
      expect(um.text).toContain('see attached')
      expect(um.text).toContain('<attached-file name="snippet.ts">')
      expect(um.text).toContain('const x = 1')
      // The visible bubble shows only the typed text + a preview chip.
      const bubble = document.querySelector('#chat-messages .msg.user')!
      expect(bubble.textContent).not.toContain('const x = 1')
      expect(bubble.querySelector('.attachment-chip')).not.toBeNull()
      // Composer state cleared after send.
      expect(A().items).toHaveLength(0)
      expect((document.getElementById('attachments-strip') as HTMLElement).hidden).toBe(true)
    })

    it('the × chip button removes a staged attachment', () => {
      A().items = [{ id: 'att_1', kind: 'text', name: 'a.txt', text: 'hi' }]
      A().render()
      const strip = document.getElementById('attachments-strip') as HTMLElement
      expect(strip.querySelectorAll('.attachment-chip').length).toBe(1)
      ;(strip.querySelector('.att-remove') as HTMLButtonElement).click()
      expect(A().items).toHaveLength(0)
      expect(strip.hidden).toBe(true)
    })

    it('the per-turn cap (8) rejects the 9th file with a visible error', async () => {
      vi.useRealTimers()
      A().items = Array.from({ length: 8 }, (_, i) => ({
        id: 'att_' + i, kind: 'text', name: i + '.txt', text: 'x',
      }))
      await A().addFiles([new File(['y'], 'ninth.txt', { type: 'text/plain' })])
      expect(A().items).toHaveLength(8)
      expect(document.getElementById('attach-error')!.textContent).toContain('Max 8 attachments')
    })

    it('wireAttachments() carries images/PDFs; textBlock() folds text files in XML tags', () => {
      A().items = [
        { id: '1', kind: 'image', name: 'p.png', mediaType: 'image/png', data: 'AAAA' },
        { id: '2', kind: 'pdf', name: 'd.pdf', mediaType: 'application/pdf', data: 'BBBB' },
        { id: '3', kind: 'text', name: 'n.md', text: '# hi' },
      ]
      expect(A().wireAttachments()).toEqual([
        { mediaType: 'image/png', data: 'AAAA' },
        { mediaType: 'application/pdf', data: 'BBBB' },
      ])
      expect(A().textBlock()).toBe('<attached-file name="n.md">\n# hi\n</attached-file>')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: Subagent (Agent tool) rendering
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: Subagent (Agent tool) rendering', () => {
    const M = () => (window as any).__MoonInternals

    beforeEach(() => {
      ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
      ;(window as any).cancelAnimationFrame = () => {}
      M().ChatState.reset()
      const chat = document.getElementById('chat-messages')!
      chat.innerHTML = ''
    })

    // ── ChatState.applyToolCall preserves parentToolUseId ────────────────────
    it('applyToolCall stores parentToolUseId on the segment when present', () => {
      const state = M().ChatState
      state.applyToolCall('t1', 'tc-1', 'Agent', { description: 'do stuff', prompt: 'x' }, 'parent-42')
      const seg = state.turns[0].segments[0]
      expect(seg.kind).toBe('tool')
      expect(seg.name).toBe('Agent')
      expect(seg.parentToolUseId).toBe('parent-42')
    })

    it('applyToolCall without parentToolUseId leaves the field absent (no undefined key)', () => {
      const state = M().ChatState
      state.applyToolCall('t1', 'tc-1', 'Read', { file_path: '/etc/hosts' })
      const seg = state.turns[0].segments[0]
      expect(seg.kind).toBe('tool')
      expect('parentToolUseId' in seg).toBe(false)
    })

    // ── ChatRenderer.buildToolStep: Agent label with description ─────────────
    it('buildToolStep renders "Agent — <description>" for an Agent tool call with a description', () => {
      const seg = {
        kind: 'tool',
        id: 'tc-agent',
        name: 'Agent',
        input: { description: 'Research lunar cycles', prompt: 'look it up' },
        result: null,
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const nameEl = card.querySelector('.tool-card-name')!
      expect(nameEl.textContent).toBe('Agent — Research lunar cycles')
    })

    it('buildToolStep renders "Agent — <description>" for a Task (legacy alias) tool call', () => {
      const seg = {
        kind: 'tool',
        id: 'tc-task',
        name: 'Task',
        input: { description: 'Compile the report', prompt: 'do it' },
        result: null,
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const nameEl = card.querySelector('.tool-card-name')!
      expect(nameEl.textContent).toBe('Agent — Compile the report')
    })

    it('buildToolStep renders just the tool name for Agent/Task when input has no description', () => {
      const seg = {
        kind: 'tool',
        id: 'tc-noDesc',
        name: 'Agent',
        input: { prompt: 'do something' },
        result: null,
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const nameEl = card.querySelector('.tool-card-name')!
      expect(nameEl.textContent).toBe('Agent')
    })

    it('buildToolStep appends a muted subagent_type span when subagent_type is present', () => {
      const seg = {
        kind: 'tool',
        id: 'tc-sub',
        name: 'Agent',
        input: { description: 'Analyze code', prompt: 'x', subagent_type: 'codebase-analyzer' },
        result: null,
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const nameEl = card.querySelector('.tool-card-name')!
      expect(nameEl.textContent).toBe('Agent — Analyze code')
      const sub = card.querySelector('.tool-card-subtype')!
      expect(sub).not.toBeNull()
      expect(sub.textContent).toBe('codebase-analyzer')
    })

    // ── ↳ prefix for parented (nested subagent) segments ────────────────────
    it('buildToolStep prefixes the label with "↳ " when seg.parentToolUseId is set', () => {
      const seg = {
        kind: 'tool',
        id: 'tc-nested',
        name: 'Read',
        input: { file_path: '/etc/hosts' },
        result: null,
        parentToolUseId: 'parent-agent-id',
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const nameEl = card.querySelector('.tool-card-name')!
      expect(nameEl.textContent).toBe('↳ Read')
    })

    it('buildToolStep prefixes "↳ Agent — <desc>" when a parented Agent has a description', () => {
      const seg = {
        kind: 'tool',
        id: 'tc-nested-agent',
        name: 'Agent',
        input: { description: 'Sub-task', prompt: 'do it' },
        result: null,
        parentToolUseId: 'outer-agent-call',
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const nameEl = card.querySelector('.tool-card-name')!
      expect(nameEl.textContent).toBe('↳ Agent — Sub-task')
    })

    it('buildToolStep does NOT add the "↳ " prefix when parentToolUseId is absent', () => {
      const seg = {
        kind: 'tool',
        id: 'tc-top',
        name: 'Bash',
        input: { command: 'ls' },
        result: null,
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const nameEl = card.querySelector('.tool-card-name')!
      expect(nameEl.textContent).toBe('Bash')
      expect(nameEl.textContent).not.toContain('↳')
    })

    // ── Input-dump clamp for long string values ──────────────────────────────
    it('buildToolStep elides a string field over 400 chars in the input dump', () => {
      const longPrompt = 'x'.repeat(600)
      const seg = {
        kind: 'tool',
        id: 'tc-long',
        name: 'Agent',
        input: { description: 'big task', prompt: longPrompt },
        result: null,
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const inputEl = card.querySelector('.tool-card-input')!
      expect(inputEl.textContent).toContain('… (+200 chars)')
      // The full value must not appear (it was elided).
      expect(inputEl.textContent).not.toContain(longPrompt)
      // The first 400 chars should appear.
      expect(inputEl.textContent).toContain('x'.repeat(400))
    })

    it('buildToolStep does NOT elide string fields at or under 400 chars', () => {
      const borderline = 'y'.repeat(400)
      const seg = {
        kind: 'tool',
        id: 'tc-border',
        name: 'Read',
        input: { file_path: borderline },
        result: null,
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const inputEl = card.querySelector('.tool-card-input')!
      expect(inputEl.textContent).not.toContain('… (+')
      expect(inputEl.textContent).toContain(borderline)
    })

    it('buildToolStep clamp applies to ALL tools, not just Agent (a large Bash command is also elided)', () => {
      const bigCmd = 'z'.repeat(500)
      const seg = {
        kind: 'tool',
        id: 'tc-bash-long',
        name: 'Bash',
        input: { command: bigCmd },
        result: null,
      }
      const card = M().ChatRenderer.buildToolStep(seg, 'turn-1')
      const inputEl = card.querySelector('.tool-card-input')!
      expect(inputEl.textContent).toContain('… (+100 chars)')
      expect(inputEl.textContent).not.toContain(bigCmd)
    })

    // ── End-to-end via handleFrame (regression guard) ────────────────────────
    it('a tool-call frame with name=Agent renders "Agent — <description>" in the timeline', () => {
      M().handleFrame({
        type: 'tool-call',
        turnId: 't1',
        toolCallId: 'tc-agent',
        name: 'Agent',
        input: { description: 'Run the search', prompt: 'find stuff' },
      })
      const nameEl = document.querySelector('.tool-card-name')!
      expect(nameEl).not.toBeNull()
      expect(nameEl.textContent).toBe('Agent — Run the search')
    })

    it('a tool-call frame with parentToolUseId stores the id in ChatState and renders "↳ " prefix', () => {
      M().handleFrame({
        type: 'tool-call',
        turnId: 't1',
        toolCallId: 'tc-nested',
        name: 'Read',
        input: { file_path: '/tmp/x' },
        parentToolUseId: 'parent-call-id',
      })
      // Reducer stored it.
      const seg = M().ChatState.turns[0].segments[0]
      expect(seg.parentToolUseId).toBe('parent-call-id')
      // Renderer showed the ↳ prefix.
      const nameEl = document.querySelector('.tool-card-name')!
      expect(nameEl.textContent).toBe('↳ Read')
    })

    it('an old server frame without parentToolUseId renders exactly as before (no prefix, no breakage)', () => {
      M().handleFrame({
        type: 'tool-call',
        turnId: 't1',
        toolCallId: 'tc-plain',
        name: 'Bash',
        input: { command: 'echo hi' },
      })
      const nameEl = document.querySelector('.tool-card-name')!
      expect(nameEl.textContent).toBe('Bash')
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Feature: S4 Agents-panel jump link (clickable card + luna:// prose links)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Feature: S4 Agents-panel jump link', () => {
    const M = () => (window as any).__MoonInternals

    it('a top-level Agent card shows a "view ↗" link that opens the agents panel for the active thread', () => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      ;(window as any).__TAURI__.core = { invoke }
      M().State.activeThreadId = 'thr-1'
      const card = M().appendToolCallCard({
        type: 'tool-call', threadId: 'thr-1', turnId: 'turn-1', toolCallId: 'ag1',
        name: 'Agent', input: { description: 'map the repo' },
      })
      const link = card.querySelector('.agent-view-link') as HTMLButtonElement
      expect(link).not.toBeNull()
      link.click()
      expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'agents', params: { thread: 'thr-1' } })
    })

    it('a NESTED Agent step (parentToolUseId set) has NO view link — nested spawns share one panel', () => {
      const card = M().appendToolCallCard({
        type: 'tool-call', threadId: 'thr-1', turnId: 'turn-1', toolCallId: 'ag2',
        name: 'Agent', input: { description: 'sub' }, parentToolUseId: 'ag1',
      })
      expect(card.querySelector('.agent-view-link')).toBeNull()
    })

    it('clicking the view link does not toggle the <details> (stopPropagation)', () => {
      ;(window as any).__TAURI__.core = { invoke: vi.fn().mockResolvedValue(undefined) }
      M().State.activeThreadId = 'thr-1'
      const card = M().appendToolCallCard({
        type: 'tool-call', threadId: 'thr-1', turnId: 'turn-1', toolCallId: 'ag1',
        name: 'Agent', input: { description: 'x' },
      })
      const details = card.querySelector('details') as HTMLDetailsElement
      const before = details.open
      ;(card.querySelector('.agent-view-link') as HTMLButtonElement).click()
      expect(details.open).toBe(before)
    })

    it('a luna:// link in an assistant message opens the named widget via open_widget', () => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      ;(window as any).__TAURI__.core = { invoke }
      const chat = document.getElementById('chat-messages')!
      // Render an assistant body with a luna:// markdown link (real renderer).
      const bubble = document.createElement('div')
      bubble.innerHTML = M().renderMarkdown('[open the agents panel](luna://widget/agents?thread=thr-1)')
      chat.appendChild(bubble)
      const a = chat.querySelector('a[data-luna-link]') as HTMLAnchorElement
      expect(a).not.toBeNull()
      a.click()
      expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'agents', params: { thread: 'thr-1' } })
    })

    it('a non-luna markdown link is NOT tagged and does not trigger open_widget', () => {
      const invoke = vi.fn().mockResolvedValue(undefined)
      ;(window as any).__TAURI__.core = { invoke }
      const chat = document.getElementById('chat-messages')!
      const bubble = document.createElement('div')
      bubble.innerHTML = M().renderMarkdown('[docs](https://example.com)')
      chat.appendChild(bubble)
      expect(chat.querySelector('a[data-luna-link]')).toBeNull()
      ;(chat.querySelector('a') as HTMLAnchorElement).click()
      expect(invoke).not.toHaveBeenCalled()
    })
  })
})
