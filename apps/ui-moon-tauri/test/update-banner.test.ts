// @vitest-environment jsdom
//
// update-banner.test.ts — Slice C, surface #2: the in-chat composer update
// banner (frontend-react/chat.html UpdateBanner engine - this is what
// actually ships, see chat-window.test.ts's module doc). Mirrors the
// chat-window.test harness: load chat.html's body + the WebSocketEngine
// inline script, stub the Tauri window surface, and drive UpdateBanner
// through __MoonInternals.
//
// Coverage (per SPEC.md Slice C "Tests"):
//   - onReady inserts the bar as a sibling directly ABOVE .composer-input-wrap
//   - "Restart" invokes apply_update (mocked invoke)
//   - dismiss hides the bar + persists luna_update_dismissed + suppresses a
//     same-version re-show, but a NEWER version shows again
//   - "What's new" opens the Updates panel (open_widget settings.updates)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createUpdateBanner } from '../frontend-react/src/chat/updateBanner'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { evalChatInlineScriptWithBridge, loadVendorInto, mountChatDomFromHtml, readChatHtml } from './helpers/chat-harness'

// jsdom never fetches external <script src> tags; load the vendor files the page
// script references at definition time, in declaration order (same mechanism as
// chat-window.test.ts).
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

describe('Luna Chat Window — Update Banner (Slice C surface #2)', () => {
  let htmlContent: string

  beforeEach(() => {
    // 1. Load chat.html body structure.
    htmlContent = fs.readFileSync(path.resolve(__dirname, '../frontend-react/chat.html'), 'utf8')
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

    // 2. Mock the Tauri window surface (no core by default — boot degrades like
    //    the chat harness; tests that need invoke inject __TAURI__.core).
    ;(window as any).__TAURI__ = {
      window: {
        getCurrentWindow: () => ({
          label: 'chat-test',
          listen: vi.fn(async () => () => {}),
          onMoved: vi.fn(async () => () => {}),
          isMinimized: vi.fn(async () => false),
          scaleFactor: vi.fn(async () => 1),
          outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
          outerSize: vi.fn(async () => ({ width: 560, height: 520 })),
          setPosition: vi.fn(async () => {}),
        }),
        Window: { getByLabel: vi.fn(async () => null) },
      },
      event: { listen: vi.fn(async () => () => {}) },
    }

    // 3. Vendor modules the page script uses at definition time.
    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')
    loadVendorInto(window, 'moon-markdown.js')
    loadVendorInto(window, 'moon-dock.js')

    localStorage.clear()

    // Inert WebSocket stub so boot's connect() never fires onerror→onclose timers
    // that leak across cases (see chat-window.test.ts for the full rationale).
    vi.stubGlobal('WebSocket', class {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      readyState = 0
      url: string
      onopen: any = null; onclose: any = null; onerror: any = null; onmessage: any = null
      constructor(url: string) { this.url = url }
      send() {}
      close() { this.readyState = 3 }
      addEventListener() {}
      removeEventListener() {}
    })

    // 4. Select the inline page script by CONTENT (the WebSocketEngine one).
    // Through the SHARED boot (stack23 S20d). This suite predated chat-harness
    // and hand-rolled its own `new Function(inlineScript)` boot so it could
    // assign UpdateBanner inside that scope. There is no inline script any
    // more, and bootChat() constructs the banner itself - so the hand-rolled
    // boot is not just broken, it is redundant.
    evalChatInlineScriptWithBridge()
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
    vi.unstubAllGlobals()
  })

  const UB = () => (window as any).__MoonInternals.UpdateBanner
  // Give the chat harness a core.invoke (the shared mock has none).
  const stubInvoke = (impl?: (cmd: string, args?: any) => any) => {
    const invoke = vi.fn(impl ?? (() => Promise.resolve(null)))
    ;(window as any).__TAURI__.core = { invoke }
    return invoke
  }

  it('is exposed on __MoonInternals for the harness', () => {
    expect(UB()).toBeTruthy()
    expect(typeof UB().onReady).toBe('function')
  })

  it('onReady inserts the bar as a sibling directly ABOVE .composer-input-wrap', () => {
    const wrap = document.querySelector('.chat-input-area .composer-input-wrap')
    expect(wrap).not.toBeNull()

    UB().onReady({ version: '0.0.33' })

    const bar = document.getElementById('update-banner')
    expect(bar).not.toBeNull()
    expect(bar!.hidden).toBe(false)
    // It must be the immediate previous sibling of the composer input wrap.
    expect(wrap!.previousElementSibling).toBe(bar)
    // Both share the same parent (the flex-column .chat-input-area).
    expect(bar!.parentElement).toBe(wrap!.parentElement)
    // Version rendered safely via textContent.
    expect(bar!.querySelector('.ub-title')!.textContent).toContain('0.0.33')
  })

  it('"Restart" invokes apply_update', () => {
    const invoke = stubInvoke()
    UB().onReady({ version: '0.0.33' })
    const restart = document.querySelector('#update-banner .ub-btn.primary') as HTMLButtonElement
    expect(restart).not.toBeNull()
    restart.click()
    expect(invoke).toHaveBeenCalledWith('apply_update')
  })

  it('"What\'s new" opens the Updates panel (open_widget settings.updates)', () => {
    const invoke = stubInvoke()
    UB().onReady({ version: '0.0.33' })
    const buttons = [...document.querySelectorAll('#update-banner .ub-btn')] as HTMLButtonElement[]
    const whatsNew = buttons.find((b) => /what/i.test(b.textContent || ''))!
    expect(whatsNew).toBeTruthy()
    whatsNew.click()
    expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'settings.updates' })
  })

  it('dismiss hides the bar + persists luna_update_dismissed and suppresses the SAME version, but a NEWER version shows again', () => {
    UB().onReady({ version: '0.0.33' })
    let bar = document.getElementById('update-banner')!
    expect(bar.hidden).toBe(false)

    // Dismiss via the × button.
    const dismiss = document.querySelector('#update-banner .ub-dismiss') as HTMLButtonElement
    dismiss.click()
    expect(bar.hidden).toBe(true)
    expect(localStorage.getItem('luna_update_dismissed')).toBe('0.0.33')

    // A re-show for the SAME version stays hidden.
    UB().onReady({ version: '0.0.33' })
    bar = document.getElementById('update-banner')!
    expect(bar.hidden).toBe(true)

    // A NEWER version shows again.
    UB().onReady({ version: '0.0.34' })
    bar = document.getElementById('update-banner')!
    expect(bar.hidden).toBe(false)
    expect(bar.querySelector('.ub-title')!.textContent).toContain('0.0.34')
  })

  it('onApply and _openUpdates no-op cleanly when there is no Tauri core (off-Tauri / pre-Slice-A)', () => {
    // No core injected — the shared harness mock has none.
    UB().onReady({ version: '0.0.33' })
    // Clicking must not throw despite the absent core.
    expect(() => {
      ;(document.querySelector('#update-banner .ub-btn.primary') as HTMLButtonElement).click()
    }).not.toThrow()
  })
})
