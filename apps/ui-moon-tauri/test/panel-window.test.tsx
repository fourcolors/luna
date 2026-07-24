// @vitest-environment jsdom
//
// Behavioral tests for panel.html — the SYSTEM widget host (Phase 2), React
// 19 + Astryx edition. Ported from the vanilla test/panel-window.test.ts
// (see git history), which drove frontend/panel.html directly. That file is
// no longer what ships: src-tauri/tauri.conf.json's frontendDist now points
// at frontend-react/dist (see vite.config.ts's doc comment), so this suite
// boots the REAL shipped shell — frontend-react/panel.html — instead.
//
// frontend-react/panel.html's inline vanilla script is otherwise byte-for-
// byte identical to frontend/panel.html's (title-bar, content-area, the
// ctx/connectWs waterfall — see panel-ctx.ts's module doc on why that stays
// vanilla); the only difference is the REACT_PANEL_TYPES hand-off this test
// now also exercises: after the inline script runs, main-panel.tsx calls
// mountReactPanel(type, window.__panelCtx) for every panel type (a no-op for
// types it doesn't own — see panel-boot.tsx) — this harness reproduces that
// exact call so the test proves the real two-stage boot (vanilla shell ->
// React hand-off), not just the vanilla half.
//
// settings.updates is the representative React-owned system-widget the
// panel.html HOST tests ride on (same role the vanilla suite gave it before
// frontend/panels/settings-updates.js was deleted as superseded — see
// UpdatesPanel.tsx). Its own staged-narrative behavior is covered
// exhaustively in settings-updates-panel.test.tsx; here we only assert
// host-level concerns (title wiring, the panel renders, commands fire,
// failures degrade, the shell chrome around it still works).
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import { mountReactPanel } from '../frontend-react/src/panel-boot'
import type { PanelCtx } from '../frontend-react/src/panels/panel-ctx'

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend-react/panel.html'), 'utf8')

function bootPanel(opts: { type: string; invoke?: (cmd: string, args?: any) => any }) {
  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  // Records handlers registered through window.__TAURI__.event.listen, keyed
  // by event name — UpdatesPanel subscribes to the update://* events over
  // this GLOBAL bus (not ctx.win.listen; see UpdatesPanel.tsx's module doc).
  const listenHandlers: Record<string, Array<(ev: unknown) => void>> = {}
  const invoke = vi.fn(async (cmd: string, args?: any) => (opts.invoke ? opts.invoke(cmd, args) : null))
  const me = {
    label: 'panel-' + opts.type.replace(/\./g, '-'),
    listen: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 360, height: 200 })),
    scaleFactor: vi.fn(async () => 1),
  }
  ;(window as any).__TAURI__ = {
    window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
    core: { invoke },
    event: {
      listen: vi.fn(async (event: string, handler: (ev: unknown) => void) => {
        ;(listenHandlers[event] ||= []).push(handler)
        return () => {
          const arr = listenHandlers[event]
          const i = arr ? arr.indexOf(handler) : -1
          if (arr && i >= 0) arr.splice(i, 1)
        }
      }),
    },
  }

  // location.search is read-only in jsdom — the page reads
  // new URLSearchParams(location.search), so stub history state instead.
  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(opts.type))

  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')
  loadVendorInto(window, 'moon-dock.js')

  // Preload the panel module the way the harness must (jsdom never fetches
  // the loader's injected <script src>); the loader sees it registered and
  // boots it directly. Only relevant for still-vanilla types — React-owned
  // types (e.g. settings.updates) have no frontend/panels/<type>.js file on
  // disk any more (deleted once superseded), so this is a no-op for them.
  const moduleFile = path.resolve(__dirname, '../frontend/panels', opts.type.replace(/\./g, '-') + '.js')
  if (fs.existsSync(moduleFile)) {
    new Function('globalThis', fs.readFileSync(moduleFile, 'utf8'))(window)
  }

  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  // React hand-off: reproduces exactly what main-panel.tsx's deferred module
  // script does after the inline script above runs. A no-op for panel types
  // mountReactPanel doesn't own (see panel-boot.tsx) — safe to call always.
  act(() => {
    mountReactPanel(opts.type, (window as any).__panelCtx as PanelCtx)
  })

  // jsdom never loads injected <script src> tags: fire the error event the
  // way a real 404 would, so unknown types reach the notice path.
  const injected = document.head.querySelector('script[src^="panels/"]')
  if (injected) injected.dispatchEvent(new Event('error'))

  return {
    invoke,
    fireUpdateEvent(name: string, payload: unknown) {
      act(() => {
        for (const fn of listenHandlers[name] || []) fn({ payload })
      })
    },
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as any).__TAURI__
  delete (window as any).__panelCtx
  delete (window as any).__PanelInternals
  delete (window as any).LunaPanelTypes
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).LunaDock
  vi.restoreAllMocks()
})

describe('panel.html system-widget host (React 19 + Astryx)', () => {
  it('unknown type renders a notice and registers no module', () => {
    bootPanel({ type: 'settings.nope' })
    expect((window as any).__PanelInternals.hasModule).toBe(false)
    expect(document.getElementById('bar-title')!.textContent).toBe('Unknown panel')
    expect(document.querySelector('.notice')!.textContent).toContain('settings.nope')
  })

  it('settings.updates renders the staged panel with the panel title', () => {
    bootPanel({ type: 'settings.updates' })
    expect(document.getElementById('bar-title')!.textContent).toBe('Updates')
    expect(document.getElementById('check-update-btn')).toBeTruthy()
    // Idle by default: status pill reads "Up to date", card hidden.
    expect(document.getElementById('update-pill')!.textContent).toBe('Up to date')
    expect((document.getElementById('update-card') as HTMLElement).hidden).toBe(true)
  })

  it('Check for updates invokes check_for_update through the host ctx', async () => {
    const { invoke } = bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => (cmd === 'check_for_update' ? null : null),
    })
    // Async act callback (not a bare sync one): lets the invoke() promise
    // chain's .then(dispatch) microtask settle inside act's flush window,
    // same pattern settings-updates-panel.test.tsx uses for this exact
    // click -> async-invoke -> store-dispatch shape.
    await act(async () => {
      document.getElementById('check-update-btn')!.click()
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('check_for_update'))
  })

  it('check returning a version moves the pill to "Update found" and shows the card', async () => {
    bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => (cmd === 'check_for_update' ? { version: '9.9.9' } : null),
    })
    await act(async () => {
      document.getElementById('check-update-btn')!.click()
    })
    await vi.waitFor(() =>
      expect(document.getElementById('update-pill')!.textContent).toBe('Update found'))
    expect((document.getElementById('update-card') as HTMLElement).hidden).toBe(false)
    expect(document.getElementById('update-card-version')!.textContent).toContain('9.9.9')
  })

  it('check failure paints the error line instead of throwing', async () => {
    bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => {
        if (cmd === 'check_for_update') throw new Error('offline')
        return null
      },
    })
    await expect(
      act(async () => {
        document.getElementById('check-update-btn')!.click()
      }),
    ).resolves.not.toThrow()
    await vi.waitFor(() =>
      expect((document.getElementById('update-error') as HTMLElement).hidden).toBe(false))
    expect(document.getElementById('update-error')!.textContent).toContain('offline')
  })

  it('Restart to update (at ready) invokes apply_update; failure re-enables it', async () => {
    const { invoke, fireUpdateEvent } = bootPanel({
      type: 'settings.updates',
      invoke: (cmd) => {
        if (cmd === 'apply_update') throw new Error('sig mismatch')
        return null
      },
    })
    // Drive to the ready face via the real update://ready event (replaces
    // the deleted vanilla module's __updatesController test seam).
    fireUpdateEvent('update://ready', { version: '9.9.9', notes: 'n' })
    const restartBtn = document.getElementById('restart-update-btn') as HTMLButtonElement
    expect(restartBtn.hidden).toBe(false)
    await act(async () => {
      restartBtn.click()
    })
    await vi.waitFor(() =>
      expect((document.getElementById('update-error') as HTMLElement).hidden).toBe(false))
    expect(document.getElementById('update-error')!.textContent).toContain('sig mismatch')
    // Failure path re-enables the button so the user can retry.
    expect(restartBtn.disabled).toBe(false)
    expect(invoke).toHaveBeenCalledWith('apply_update')
  })

  it('the Luna collapse action tucks the workspace into the moon (shell chrome survives the React hand-off)', async () => {
    const { invoke } = bootPanel({ type: 'settings.updates' })
    document.getElementById('collapse-moon-btn')!.click()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('collapse_to_moon'))
  })
})
