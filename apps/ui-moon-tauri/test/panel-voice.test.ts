// @vitest-environment jsdom
//
// Behavioral tests for settings.voice panel module.
// Drives the REAL module through the REAL panel.html inline script.
// Copies the bootPanel harness from panel-window.test.ts verbatim,
// adjusting the type.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/panel.html'), 'utf8')

type BootOpts = {
  type: string
  invoke?: (cmd: string, args?: any) => any
  withWin?: boolean
}

function bootPanel(opts: BootOpts) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  const invoke = vi.fn(async (cmd: string, args?: any) => (opts.invoke ? opts.invoke(cmd, args) : null))

  // listen mock: captures calls, allows test to fire them later
  const listenHandlers: Record<string, ((ev: any) => void)[]> = {}
  const listenMock = vi.fn(async (event: string, handler: (ev: any) => void) => {
    ;(listenHandlers[event] ||= []).push(handler)
    return () => {}
  })

  const me = {
    label: 'panel-' + opts.type.replace(/\./g, '-'),
    listen: listenMock,
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 360, height: 400 })),
    scaleFactor: vi.fn(async () => 1),
  }

  ;(window as any).__TAURI__ = {
    window: {
      getCurrentWindow: () => (opts.withWin !== false ? me : null),
      Window: { getByLabel: vi.fn(async () => null) },
    },
    core: { invoke },
    event: { listen: vi.fn(async () => () => {}) },
  }

  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(opts.type))

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'deck-snap.js')
  loadVendorInto(window, 'moon-dock.js')

  const moduleFile = path.resolve(__dirname, '../frontend/panels', opts.type.replace(/\./g, '-') + '.js')
  if (fs.existsSync(moduleFile)) {
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)
  }

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  const injected = document.head.querySelector('script[src^="panels/"]')
  if (injected) injected.dispatchEvent(new Event('error'))

  // Helper to fire Tauri window events
  function fireWinEvent(event: string, payload: any) {
    for (const h of listenHandlers[event] || []) h({ payload })
  }

  return { invoke, listenMock, fireWinEvent }
}

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as any).__TAURI__
  delete (window as any).__PanelInternals
  delete (window as any).LunaPanelTypes
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).LunaDeckSnap
  delete (window as any).LunaDock
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('settings.voice panel', () => {

  // ── 1. Initial render ─────────────────────────────────────────────────────
  it('registers and renders the panel with title Voice', async () => {
    bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: true } : null),
    })
    await vi.waitFor(() =>
      expect(document.getElementById('bar-title')!.textContent).toBe('Voice'))
    expect(document.getElementById('voice-mode-seg')).toBeTruthy()
    expect(document.getElementById('voice-speak-replies-toggle')).toBeTruthy()
    expect(document.getElementById('voice-voice-select')).toBeTruthy()
    expect(document.getElementById('voice-silence-slider')).toBeTruthy()
    expect(document.getElementById('voice-model-status')).toBeTruthy()
  })

  // ── 2. Initial state from localStorage ───────────────────────────────────
  it('reads initial voice mode, speak-replies, silence hang from localStorage', async () => {
    localStorage.setItem('luna_voice_mode', 'ptt')
    localStorage.setItem('luna_voice_speak_replies', '0')
    localStorage.setItem('luna_voice_silence_hang_ms', '750')

    bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: true } : null),
    })

    // Wait for probe to settle
    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready'))

    const seg = document.getElementById('voice-mode-seg')!
    const pttBtn = seg.querySelector('[data-voice-mode="ptt"]') as HTMLButtonElement
    const offBtn = seg.querySelector('[data-voice-mode="off"]') as HTMLButtonElement
    expect(pttBtn.getAttribute('aria-checked')).toBe('true')
    expect(offBtn.getAttribute('aria-checked')).toBe('false')

    const cb = document.getElementById('voice-speak-replies-toggle') as HTMLInputElement
    expect(cb.checked).toBe(false)

    expect((document.getElementById('voice-silence-slider') as HTMLInputElement).value).toBe('750')
    expect(document.getElementById('voice-silence-value')!.textContent).toBe('750')
  })

  // ── 3. Voice mode segmented control ──────────────────────────────────────
  it('clicking a mode button updates localStorage and invokes voice_set_mode', async () => {
    const { invoke } = bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: true } : null),
    })
    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready'))

    const seg = document.getElementById('voice-mode-seg')!
    const autoBtn = seg.querySelector('[data-voice-mode="auto"]') as HTMLButtonElement
    autoBtn.click()

    await vi.waitFor(() =>
      expect(localStorage.getItem('luna_voice_mode')).toBe('auto'))
    expect(invoke).toHaveBeenCalledWith('voice_set_mode', { mode: 'auto' })
    expect(autoBtn.getAttribute('aria-checked')).toBe('true')
    const offBtn = seg.querySelector('[data-voice-mode="off"]') as HTMLButtonElement
    expect(offBtn.getAttribute('aria-checked')).toBe('false')
  })

  // ── 4. Speak replies checkbox ─────────────────────────────────────────────
  it('unchecking speak-replies writes luna_voice_speak_replies=0 to localStorage', async () => {
    bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: true } : null),
    })
    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready'))

    const cb = document.getElementById('voice-speak-replies-toggle') as HTMLInputElement
    cb.checked = false
    cb.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_voice_speak_replies')).toBe('0')
  })

  it('checking speak-replies writes luna_voice_speak_replies=1 to localStorage', async () => {
    localStorage.setItem('luna_voice_speak_replies', '0')
    bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: true } : null),
    })
    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready'))

    const cb = document.getElementById('voice-speak-replies-toggle') as HTMLInputElement
    cb.checked = true
    cb.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_voice_speak_replies')).toBe('1')
  })

  // ── 5. Voice picker ───────────────────────────────────────────────────────
  it('populates the voice picker from voice_list_voices and persists selection', async () => {
    const { invoke } = bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => {
        if (cmd === 'voice_status') return { modelPresent: true }
        if (cmd === 'voice_list_voices') return [{ id: 'Samantha', name: 'Samantha', quality: 'enhanced' }]
        return null
      },
    })

    await vi.waitFor(() => {
      const sel = document.getElementById('voice-voice-select') as HTMLSelectElement
      return expect(sel.options.length).toBeGreaterThan(1)
    })

    const sel = document.getElementById('voice-voice-select') as HTMLSelectElement
    expect(Array.from(sel.options).map((o) => o.value)).toContain('Samantha')
    expect(Array.from(sel.options).find((o) => o.value === 'Samantha')!.textContent).toContain('enhanced')

    // Pick the voice
    sel.value = 'Samantha'
    sel.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_voice_id')).toBe('Samantha')
    expect(invoke).toHaveBeenCalledWith('voice_set_voice', { id: 'Samantha' })
  })

  it('selecting System default removes luna_voice_id and invokes voice_set_voice with empty id', async () => {
    localStorage.setItem('luna_voice_id', 'Samantha')
    const { invoke } = bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => {
        if (cmd === 'voice_status') return { modelPresent: true }
        if (cmd === 'voice_list_voices') return [{ id: 'Samantha' }]
        return null
      },
    })
    await vi.waitFor(() => {
      const sel = document.getElementById('voice-voice-select') as HTMLSelectElement
      return expect(sel.options.length).toBeGreaterThan(1)
    })

    const sel = document.getElementById('voice-voice-select') as HTMLSelectElement
    sel.value = ''
    sel.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_voice_id')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('voice_set_voice', { id: '' })
  })

  // ── 6. Silence hang slider ────────────────────────────────────────────────
  it('moving the slider live-updates the value display without writing localStorage', async () => {
    bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: true } : null),
    })
    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready'))

    const slider = document.getElementById('voice-silence-slider') as HTMLInputElement
    slider.value = '850'
    slider.dispatchEvent(new Event('input'))

    expect(document.getElementById('voice-silence-value')!.textContent).toBe('850')
    expect(localStorage.getItem('luna_voice_silence_hang_ms')).toBeNull()
  })

  it('committing the slider writes localStorage and invokes voice_set_config', async () => {
    const { invoke } = bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: true } : null),
    })
    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready'))

    const slider = document.getElementById('voice-silence-slider') as HTMLInputElement
    slider.value = '950'
    slider.dispatchEvent(new Event('change'))

    expect(localStorage.getItem('luna_voice_silence_hang_ms')).toBe('950')
    expect(invoke).toHaveBeenCalledWith('voice_set_config', { silenceHangMs: 950 })
  })

  // ── 7. voice_status unavailable → notice shown, controls disabled ─────────
  it('shows unavailable notice and disables controls when voice_status rejects', async () => {
    bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => {
        if (cmd === 'voice_status') throw new Error('command not found')
        return null
      },
    })

    await vi.waitFor(() => {
      const n = document.getElementById('voice-unavailable-note')
      return expect(n!.hidden).toBe(false)
    })

    const seg = document.getElementById('voice-mode-seg')!
    const btns = seg.querySelectorAll('.voice-mode-btn')
    btns.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true))

    expect((document.getElementById('voice-speak-replies-toggle') as HTMLInputElement).disabled).toBe(true)
    expect((document.getElementById('voice-voice-select') as HTMLSelectElement).disabled).toBe(true)
    expect((document.getElementById('voice-silence-slider') as HTMLInputElement).disabled).toBe(true)
  })

  // ── 8. Model present vs missing ───────────────────────────────────────────
  it('hides Download button when model is already present', async () => {
    bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: true } : null),
    })
    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready'))

    expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(true)
  })

  it('shows Download button and missing text when model is absent', async () => {
    bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: false } : null),
    })
    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('not downloaded'))

    expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(false)
  })

  // ── 9. Download button path ───────────────────────────────────────────────
  it('Download button invokes voice_ensure_model and marks model ready on success', async () => {
    const { invoke } = bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => {
        if (cmd === 'voice_status') return { modelPresent: false }
        if (cmd === 'voice_ensure_model') return null
        return null
      },
    })
    await vi.waitFor(() =>
      expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(false))

    document.getElementById('voice-model-download')!.click()

    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready'))
    expect(invoke).toHaveBeenCalledWith('voice_ensure_model')
    expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(true)
  })

  it('Download failure restores Download button and shows error text', async () => {
    bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => {
        if (cmd === 'voice_status') return { modelPresent: false }
        if (cmd === 'voice_ensure_model') throw new Error('disk full')
        return null
      },
    })
    await vi.waitFor(() =>
      expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(false))

    document.getElementById('voice-model-download')!.click()

    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('failed'))
    expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(false)
    expect((document.getElementById('voice-model-progress') as HTMLElement).hidden).toBe(true)
  })

  // ── 10. voice-model-progress events ──────────────────────────────────────
  it('voice-model-progress event updates progress bar and status text', async () => {
    const { fireWinEvent } = bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: false } : null),
    })
    await vi.waitFor(() =>
      expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(false))

    // Manually start a download so progress bar is shown (simulate click)
    document.getElementById('voice-model-download')!.click()

    // Fire a mid-download progress event
    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-progress')!.hidden).toBe(false))

    fireWinEvent('voice-model-progress', {
      downloadedBytes: 50 * 1024 * 1024,
      totalBytes: 200 * 1024 * 1024,
    })

    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('Downloading'))
    expect(document.getElementById('voice-model-status')!.textContent).toContain('50.0')
    expect(document.getElementById('voice-model-status')!.textContent).toContain('200.0')
  })

  it('voice-model-progress { done: true } calls markModelReady', async () => {
    const { fireWinEvent } = bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: false } : null),
    })
    await vi.waitFor(() =>
      expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(false))

    fireWinEvent('voice-model-progress', { done: true })

    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('ready'))
    expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(true)
  })

  it('voice-model-progress { error } shows error and restores Download button', async () => {
    const { fireWinEvent } = bootPanel({
      type: 'settings.voice',
      invoke: (cmd) => (cmd === 'voice_status' ? { modelPresent: false } : null),
    })
    await vi.waitFor(() =>
      expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(false))

    fireWinEvent('voice-model-progress', { error: 'network timeout' })

    await vi.waitFor(() =>
      expect(document.getElementById('voice-model-status')!.textContent).toContain('network timeout'))
    expect((document.getElementById('voice-model-download') as HTMLButtonElement).hidden).toBe(false)
    expect((document.getElementById('voice-model-progress') as HTMLElement).hidden).toBe(true)
  })
})
