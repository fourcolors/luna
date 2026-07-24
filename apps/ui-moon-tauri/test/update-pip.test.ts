// @vitest-environment jsdom
//
// update-pip.test.ts — Slice C, surface #3: the ambient orb update pip
// (frontend/index.html). Mirrors the moon-app.test harness: load index.html's
// body + the hub script, stub the Tauri window surface, then drive the pip via
// __MoonInternals.showUpdatePip and assert default-hidden → shown, and that
// clicking it opens the Updates panel without disturbing the moon's chat click.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

describe('Luna Moon — Update Pip (Slice C surface #3)', () => {
  let htmlContent: string

  beforeEach(() => {
    htmlContent = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf8')
    const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/)
    document.body.innerHTML = bodyMatch ? bodyMatch[1] : htmlContent

    const mockGetCurrentWindow = vi.fn().mockReturnValue({
      startDragging: vi.fn().mockResolvedValue(undefined),
      setSize: vi.fn().mockResolvedValue(undefined),
      setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
    })
    class MockLogicalSize {
      type = 'Logical'
      constructor(public width: number, public height: number) {}
    }
    ;(window as any).__TAURI__ = {
      window: { getCurrentWindow: mockGetCurrentWindow, LogicalSize: MockLogicalSize },
    }

    loadVendorInto(window, 'moon-protocol.js')
    loadVendorInto(window, 'moon-ws.js')

    localStorage.clear()

    const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/)
    new Function(scriptMatch ? scriptMatch[1] : '')()

    vi.useFakeTimers()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).__TAURI__
    delete (window as any).__MoonInternals
    delete (window as any).LunaProtocol
    delete (window as any).LunaWS
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('the update pip is present and HIDDEN by default', () => {
    const pip = document.getElementById('update-pip') as HTMLElement
    expect(pip).not.toBeNull()
    expect(pip.hidden).toBe(true)
  })

  it('showUpdatePip() reveals it (unsets hidden)', () => {
    const m = (window as any).__MoonInternals
    expect(typeof m.showUpdatePip).toBe('function')
    const pip = document.getElementById('update-pip') as HTMLElement
    expect(pip.hidden).toBe(true)

    m.showUpdatePip()
    expect(pip.hidden).toBe(false)
  })

  it('clicking the lit pip opens the Updates panel and does NOT open chat', () => {
    const invoke = vi.fn(async () => 'panel-settings-updates')
    ;(window as any).__TAURI__.core = { invoke }

    const m = (window as any).__MoonInternals
    m.showUpdatePip()
    const pip = document.getElementById('update-pip') as HTMLElement

    pip.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(invoke).toHaveBeenCalledWith('open_widget', { kind: 'settings.updates' })
    // The pip stops propagation, so the moon's open-chat path is never invoked.
    expect(invoke).not.toHaveBeenCalledWith('open_widget', { kind: 'chat' })
  })

  it('a pointerup on the pip does NOT co-trigger the moon open-chat, even after a recent moon press', () => {
    // Regression for the gap where the pip stopped `click`/`pointerdown` but not
    // `pointerup`. The moon opens chat on `pointerup` (handlePointerUp) when the
    // press was recent (<280ms) and small (<5px). If a pip pointerup bubbled to
    // #moon while State held a recent in-threshold press, chat would open ON TOP
    // of the Updates panel. The pip must stop the whole pointer sequence.
    const invoke = vi.fn(async () => 'panel-settings-updates')
    ;(window as any).__TAURI__.core = { invoke }

    const m = (window as any).__MoonInternals
    m.showUpdatePip()
    const pip = document.getElementById('update-pip') as HTMLElement

    // Simulate a moon press that JUST happened, at the pip's pointerup point —
    // i.e. the worst case where the open-chat threshold (recent + within 5px)
    // would be satisfied if the pointerup reached #moon.
    m.State.pressStartTime = Date.now()
    m.State.pressStartX = 10
    m.State.pressStartY = 10

    pip.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, clientX: 10, clientY: 10 } as any),
    )

    // The pointerup is swallowed at the pip → open-chat never fires.
    expect(invoke).not.toHaveBeenCalledWith('open_widget', { kind: 'chat' })
  })
})
