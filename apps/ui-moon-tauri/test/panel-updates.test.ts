// @vitest-environment jsdom
//
// Behavioral tests for the settings.updates panel module (Slice B — the
// staged-update narrative). Drives the REAL module through the REAL panel.html
// inline script, mirroring the bootPanel harness used by panel-general /
// panel-voice. The panel listens via window.__TAURI__.event.listen, so this
// harness gives that a CAPTURING mock (fireUpdateEvent) and also exercises the
// element-mounted test seam (el.__updatesController).
//
// Test seam contract (documented per spec): render() attaches
//   contentArea.__updatesController = { onEvent(name, payload), setState(dto),
//                                       getState(), dispose() }
// onEvent folds a fake update://* event; setState folds an UpdateStateDto.
// We assert on the projected DOM after driving idle → available → downloading
// → ready, and that "Restart to update" invokes apply_update.
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend/panel.html'), 'utf8')

type BootOpts = {
  invoke?: (cmd: string, args?: any) => any
  hasTauri?: boolean
}

function bootPanel(opts: BootOpts = {}) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  const invoke = vi.fn(async (cmd: string, args?: any) => (opts.invoke ? opts.invoke(cmd, args) : null))

  // Capturing event.listen so tests can fire update://* events through the
  // REAL subscription path the panel wires.
  const listenHandlers: Record<string, ((ev: any) => void)[]> = {}
  const eventListen = vi.fn(async (event: string, handler: (ev: any) => void) => {
    ;(listenHandlers[event] ||= []).push(handler)
    return () => {}
  })

  const me = {
    label: 'panel-settings-updates',
    listen: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 380, height: 440 })),
    scaleFactor: vi.fn(async () => 1),
  }

  if (opts.hasTauri === false) {
    delete (window as any).__TAURI__
  } else {
    ;(window as any).__TAURI__ = {
      window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
      core: { invoke },
      event: { listen: eventListen },
    }
  }

  window.history.replaceState({}, '', '/panel.html?type=settings.updates')

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'moon-dock.js')

  const moduleFile = path.resolve(__dirname, '../frontend/panels/settings-updates.js')
  new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  const injected = document.head.querySelector('script[src^="panels/"]')
  if (injected) injected.dispatchEvent(new Event('error'))

  const content = document.getElementById('content-area')!
  const controller = (content as any).__updatesController as {
    onEvent: (name: string, payload?: any) => void
    setState: (dto: any) => void
    getState: () => any
    dispose: () => void
  }

  // Fire a captured update://* event through the panel's real listener.
  function fireUpdateEvent(name: string, payload: any) {
    for (const h of listenHandlers[name] || []) h({ payload })
  }

  return { invoke, controller, content, fireUpdateEvent, listenHandlers }
}

const $ = (id: string) => document.getElementById(id)

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as any).__TAURI__
  delete (window as any).__PanelInternals
  delete (window as any).LunaPanelTypes
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).LunaDock
  const style = document.getElementById('luna-updates-style')
  if (style) style.remove()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('settings.updates panel — staged narrative', () => {
  // ── Initial render ─────────────────────────────────────────────────────────

  it('renders title "Updates" and the header pill (idle / up to date)', () => {
    bootPanel()
    expect($('bar-title')!.textContent).toBe('Updates')
    expect($('update-pill')!.textContent).toBe('Up to date')
    expect($('check-update-btn')).toBeTruthy()
  })

  it('starts with card + progress hidden and Restart not shown', () => {
    bootPanel()
    expect(($('update-card') as HTMLElement).hidden).toBe(true)
    expect(($('update-progress') as HTMLElement).hidden).toBe(true)
    expect(($('restart-update-btn') as HTMLElement).hidden).toBe(true)
  })

  it('exposes the test seam controller on the panel element', () => {
    const { controller } = bootPanel()
    expect(typeof controller.onEvent).toBe('function')
    expect(typeof controller.setState).toBe('function')
    expect(controller.getState().phase).toBe('idle')
  })

  it('calls update_state once on render (replay-on-open)', () => {
    const { invoke } = bootPanel()
    expect(invoke).toHaveBeenCalledWith('update_state')
  })

  // ── idle → available ───────────────────────────────────────────────────────

  it('update://available shows the card with version + notes (textContent list)', () => {
    const { controller } = bootPanel()
    controller.onEvent('update://available', {
      version: '0.0.33',
      notes: 'First headline\nSecond line\nThird line',
    })
    const card = $('update-card') as HTMLElement
    expect(card.hidden).toBe(false)
    expect($('update-card-version')!.textContent).toBe('Version 0.0.33')
    expect($('update-pill')!.textContent).toBe('Update found')
    const items = ($('update-notes') as HTMLElement).querySelectorAll('li')
    expect(items.length).toBe(3)
    expect(items[0].textContent).toBe('First headline')
    expect(items[2].textContent).toBe('Third line')
  })

  it('caps the notes list at 6 lines', () => {
    const { controller } = bootPanel()
    const notes = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    controller.onEvent('update://available', { version: '1.2.3', notes })
    expect(($('update-notes') as HTMLElement).querySelectorAll('li').length).toBe(6)
  })

  it('renders notes via textContent (no HTML injection from release notes)', () => {
    const { controller } = bootPanel()
    controller.onEvent('update://available', {
      version: '9.9.9',
      notes: '<img src=x onerror=alert(1)>',
    })
    const li = ($('update-notes') as HTMLElement).querySelector('li')!
    // The angle-bracket text is preserved verbatim and NOT parsed into an <img>.
    expect(li.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(($('update-notes') as HTMLElement).querySelector('img')).toBeNull()
  })

  it('auto-advances a manually-discovered update into the staged download (no dead-end)', () => {
    const { controller, invoke } = bootPanel()
    controller.onEvent('update://available', { version: '0.0.33', notes: 'n' })
    // The panel kicks start_update_download itself so "available" never parks as
    // a button-less card waiting on the background loop.
    expect(invoke).toHaveBeenCalledWith('start_update_download')
  })

  it('only kicks start_update_download once per version', () => {
    const { controller, invoke } = bootPanel()
    const kicks = () => invoke.mock.calls.filter((c: any[]) => c[0] === 'start_update_download').length
    controller.onEvent('update://available', { version: '0.0.33', notes: 'n' })
    controller.onEvent('update://available', { version: '0.0.33', notes: 'n' })
    expect(kicks()).toBe(1)
    // A newer version is a fresh target → kicks again.
    controller.onEvent('update://available', { version: '0.0.34', notes: 'n' })
    expect(kicks()).toBe(2)
  })

  // ── available → downloading ──────────────────────────────────────────────

  it('update://progress shows the progress bar with bytes + percent', () => {
    const { controller } = bootPanel()
    controller.onEvent('update://available', { version: '0.0.33', notes: 'notes' })
    controller.onEvent('update://progress', { downloaded: 14 * 1024 * 1024, total: 28 * 1024 * 1024 })
    expect(($('update-progress') as HTMLElement).hidden).toBe(false)
    expect($('update-pill')!.textContent).toBe('Downloading…')
    expect($('update-percent')!.textContent).toBe('50%')
    expect($('update-bytes')!.textContent).toBe('14.0 / 28.0 MB')
    expect(($('update-progress-fill') as HTMLElement).style.width).toBe('50%')
    // Not yet verified mid-download.
    expect(($('update-verified') as HTMLElement).hidden).toBe(true)
  })

  it('progress with null total shows downloaded MB only (no percent crash)', () => {
    const { controller } = bootPanel()
    controller.onEvent('update://progress', { downloaded: 3 * 1024 * 1024, total: null })
    expect($('update-bytes')!.textContent).toBe('3.0 MB')
    expect($('update-percent')!.textContent).toBe('0%')
  })

  it('exposes the progress bar to assistive tech (role=progressbar + aria-valuenow)', () => {
    const { controller } = bootPanel()
    controller.onEvent('update://progress', { downloaded: 14 * 1024 * 1024, total: 28 * 1024 * 1024 })
    const track = document.querySelector('.upd-prog-track') as HTMLElement
    expect(track.getAttribute('role')).toBe('progressbar')
    expect(track.getAttribute('aria-valuenow')).toBe('50')
    expect(track.getAttribute('aria-valuetext')).toBe('14.0 / 28.0 MB')
  })

  // ── downloading → ready ────────────────────────────────────────────────────

  it('update://ready shows Restart + Later, "Signature verified", and 100%', () => {
    const { controller } = bootPanel()
    controller.onEvent('update://available', { version: '0.0.33', notes: 'notes' })
    controller.onEvent('update://progress', { downloaded: 28 * 1024 * 1024, total: 28 * 1024 * 1024 })
    controller.onEvent('update://ready', { version: '0.0.33', notes: 'notes' })
    expect($('update-pill')!.textContent).toBe('Ready to update')
    expect(($('restart-update-btn') as HTMLElement).hidden).toBe(false)
    expect(($('later-update-btn') as HTMLElement).hidden).toBe(false)
    expect(($('check-update-btn') as HTMLElement).hidden).toBe(true)
    expect(($('update-verified') as HTMLElement).hidden).toBe(false)
    expect($('update-percent')!.textContent).toBe('100%')
    expect(($('update-progress-fill') as HTMLElement).style.width).toBe('100%')
  })

  it('Restart to update invokes apply_update', async () => {
    const { invoke } = bootPanel()
    const content = document.getElementById('content-area')!
    ;(content as any).__updatesController.onEvent('update://ready', { version: '0.0.33', notes: 'n' })
    ;($('restart-update-btn') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('apply_update'))
  })

  it('Check for updates invokes check_for_update', async () => {
    const { invoke } = bootPanel()
    ;($('check-update-btn') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('check_for_update'))
  })

  // ── Full sequence through the REAL event bus (wiring proof) ────────────────

  it('drives idle → available → downloading → ready via window.__TAURI__.event.listen', async () => {
    const { fireUpdateEvent, invoke } = bootPanel()
    // idle
    expect($('update-pill')!.textContent).toBe('Up to date')
    // available
    fireUpdateEvent('update://available', { version: '0.0.40', notes: 'Shiny new thing' })
    expect(($('update-card') as HTMLElement).hidden).toBe(false)
    expect($('update-card-version')!.textContent).toBe('Version 0.0.40')
    // downloading
    fireUpdateEvent('update://progress', { downloaded: 7 * 1024 * 1024, total: 28 * 1024 * 1024 })
    expect($('update-percent')!.textContent).toBe('25%')
    // ready
    fireUpdateEvent('update://ready', { version: '0.0.40', notes: 'Shiny new thing' })
    expect(($('restart-update-btn') as HTMLElement).hidden).toBe(false)
    // Restart wired to apply_update.
    ;($('restart-update-btn') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('apply_update'))
  })

  // ── Snapshot replay (setState) ─────────────────────────────────────────────

  it('setState replays a ready UpdateStateDto snapshot straight to the ready face', () => {
    const { controller } = bootPanel()
    controller.setState({
      phase: 'ready',
      version: '2.0.0',
      notes: 'a\nb',
      downloaded: 28 * 1024 * 1024,
      total: 28 * 1024 * 1024,
      current: '1.9.0',
    })
    expect($('update-pill')!.textContent).toBe('Ready to update')
    expect(($('restart-update-btn') as HTMLElement).hidden).toBe(false)
    expect($('update-card-version')!.textContent).toBe('Version 2.0.0')
    expect(($('update-verified') as HTMLElement).hidden).toBe(false)
    // The replay snapshot also stamps the running build version in the header.
    expect($('update-current')!.textContent).toBe('Current version 1.9.0')
  })

  // ── Error path (never red — just a muted line) ─────────────────────────────

  it('update://error shows the error line and keeps Check available', () => {
    const { controller } = bootPanel()
    controller.onEvent('update://error', { message: 'network down' })
    expect(($('update-error') as HTMLElement).hidden).toBe(false)
    expect($('update-error')!.textContent).toBe('network down')
    expect(($('check-update-btn') as HTMLElement).hidden).toBe(false)
  })

  it('update://none returns to the up-to-date pill', () => {
    const { controller } = bootPanel()
    controller.onEvent('update://available', { version: '1.0.0', notes: 'x' })
    controller.onEvent('update://none', {})
    expect($('update-pill')!.textContent).toBe('Up to date')
    expect(($('update-card') as HTMLElement).hidden).toBe(true)
  })

  // ── Degrades without Tauri (jsdom) ─────────────────────────────────────────

  it('renders without window.__TAURI__ and does not call update_state', () => {
    const { invoke } = bootPanel({ hasTauri: false })
    expect($('update-pill')!.textContent).toBe('Up to date')
    expect(invoke).not.toHaveBeenCalled()
  })
})
