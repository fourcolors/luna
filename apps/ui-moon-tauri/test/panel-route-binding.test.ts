// @vitest-environment jsdom
//
// Phase 2 C7 — per-panel route binding tests.
//
// Tests the three route-resolution decisions in connectWs:
//   A. Panel-specific route present → use it (wsUrl from route.endpoints[0],
//      token from load_connection); __PanelInternals.resolvedRouteKey populated.
//   B. No panel route / no client.toml (MoonSession returns null) → legacy
//      load_connection path unchanged; no error surfaced.
//   C. Route resolution succeeds but load_connection rejects (Tauri present) →
//      showNotice called with 'Panel connection failed: <reason>'.
//   D. Off-Tauri (no __TAURI__) → silent; no notice.
//
// Approach: register a minimal stub panel type that calls ctx.connectWs(…), then
// boot panel.html's inline script and flush microtasks. Assert on __PanelInternals
// and the DOM .notice element.
//
// Ported to boot frontend-react/panel.html (React 19 + Astryx edition)
// instead of frontend/panel.html: src-tauri/tauri.conf.json's frontendDist
// now points at frontend-react/dist (see vite.config.ts's doc comment), so
// frontend/panel.html is no longer what ships - this suite must exercise the
// real boot file. The ctx/connectWs waterfall under test is byte-for-byte
// identical between the two files (see panel-ctx.ts's module doc on why that
// stays vanilla - no parallel connection/transport logic to keep in sync),
// so every behavioral assertion below is unchanged from the pre-port
// suite; only the html fixture path moved. The stub panel type this suite
// registers (`stub.ws`) is never React-owned, so it always takes the
// still-vanilla bootModule() path panel.html's inline script has always had.

import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── File fixtures ─────────────────────────────────────────────────────────────

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

const html = fs.readFileSync(path.resolve(__dirname, '../frontend-react/panel.html'), 'utf8')

// ── Route fixtures ────────────────────────────────────────────────────────────

const ROUTE_LOCAL = {
  label: 'Local',
  key: 'local',
  endpoints: ['ws://127.0.0.1:4753/ui'],
  token_ref: 'env:LUNA_WS_TOKEN',
  transport: 'websocket',
}

// ── Boot harness ──────────────────────────────────────────────────────────────

/**
 * Boot panel.html's inline script with a minimal stub panel that calls
 * ctx.connectWs() on render, so we can observe the route-resolution path.
 *
 * @param opts.invoke   Tauri invoke stub. Pass null to skip Tauri entirely.
 * @param opts.moonSession  Override for window.MoonSession after vendors load.
 * @param opts.onVendorsLoaded  Called after vendor scripts load but before the
 *   inline script runs — use to spy on window.LunaWS.createClient.
 */
function bootPanel(opts: {
  type?: string
  invoke?: ((cmd: string, args?: any) => any) | null
  moonSession?: {
    resolveBootRoute?: (panelId: string | null) => Promise<any>
    setPanelRoute?: (panelId: string, routeKey: string) => Promise<boolean>
    listRoutes?: () => Promise<any>
    setDefaultRoute?: (routeKey: string) => Promise<boolean>
  } | null
  onVendorsLoaded?: () => void
}) {
  const type = opts.type || 'stub.ws'
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/)
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : ''

  // Install Tauri mock (or leave __TAURI__ absent for off-Tauri tests)
  const invoke = opts.invoke !== null && opts.invoke !== undefined
    ? vi.fn(async (cmd: string, args?: any) => opts.invoke!(cmd, args))
    : null

  const me = {
    label: 'panel-' + type.replace(/\./g, '-'),
    listen: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 360, height: 400 })),
    scaleFactor: vi.fn(async () => 1),
  }

  if (invoke !== null) {
    ;(window as any).__TAURI__ = {
      window: { getCurrentWindow: () => me, Window: { getByLabel: vi.fn(async () => null) } },
      core: { invoke },
      event: { listen: vi.fn(async () => () => {}) },
    }
  }

  // Set location so params parse correctly
  window.history.replaceState({}, '', '/panel.html?type=' + encodeURIComponent(type))

  // Load vendor modules (moon-session.js is now loaded by the <script src> tag
  // in panel.html — we load it here manually since jsdom doesn't fetch scripts).
  loadVendorInto(window, 'moon-protocol.js')
  loadVendorInto(window, 'moon-ws.js')   // sets window.LunaWS with real impl
  loadVendorInto(window, 'moon-dock.js')
  loadVendorInto(window, 'moon-session.js')

  // Hook: spy on LunaWS.createClient AFTER vendors loaded but BEFORE inline runs.
  // Tests that need to intercept connect() calls do so here.
  if (opts.onVendorsLoaded) opts.onVendorsLoaded()

  // Override MoonSession if requested (must be done BEFORE the inline script runs)
  if (opts.moonSession !== undefined) {
    if (opts.moonSession === null) {
      delete (window as any).MoonSession
    } else {
      ;(window as any).MoonSession = {
        resolveBootRoute: vi.fn(async () => null),
        setPanelRoute: vi.fn(async () => false),
        listRoutes: vi.fn(async () => null),
        setDefaultRoute: vi.fn(async () => false),
        ...opts.moonSession,
      }
    }
  }

  // Register a stub panel type that calls ctx.connectWs() when rendered.
  ;(window as any).LunaPanelTypes = {
    [type]: {
      title: 'Stub WS Panel',
      render: function (_area: any, ctx: any) {
        // Store the client reference for inspection; ignore registry shape.
        ;(window as any).__stubClient = ctx.connectWs({})
      },
    },
  }

  // Execute the inline script (the one that contains LunaPanelTypes check)
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.includes('LunaPanelTypes'))
  expect(inline).toHaveLength(1)
  new Function(inline[0])()

  return { invoke }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as any).__TAURI__
  delete (window as any).__PanelInternals
  delete (window as any).__stubClient
  delete (window as any).LunaPanelTypes
  delete (window as any).LunaProtocol
  delete (window as any).LunaWS
  delete (window as any).LunaDock
  delete (window as any).MoonSession
  vi.restoreAllMocks()
})

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('C7 — panel route binding', () => {

  // ── A: panel-specific route → use endpoints[0] as wsUrl ──────────────────

  it('A: panel route present → connects with route endpoint, token from load_connection', async () => {
    let connectSpy = vi.fn()

    bootPanel({
      invoke: (cmd) => {
        if (cmd === 'load_connection') return { wsUrl: 'ws://legacy:4753/ui', wsToken: 'legacy-tok' }
        return null
      },
      moonSession: {
        resolveBootRoute: async () => ROUTE_LOCAL,
      },
      // Spy on LunaWS.createClient AFTER vendors load so the spy survives
      // the loadVendorInto(window, 'moon-ws.js') call inside bootPanel.
      onVendorsLoaded: () => {
        connectSpy = vi.fn()
        ;(window as any).LunaWS = { createClient: () => ({ connect: connectSpy }) }
      },
    })

    await flush()

    // Must use the route's endpoint, NOT the legacy wsUrl
    expect(connectSpy).toHaveBeenCalledWith('ws://127.0.0.1:4753/ui', 'legacy-tok')
    // resolvedRouteKey must be populated on __PanelInternals
    expect((window as any).__PanelInternals.resolvedRouteKey).toBe('local')
    // No error notice
    expect(document.querySelector('.notice')).toBeNull()
  })

  it('A: resolveBootRoute receives the window label as panelId', async () => {
    const resolveBootRoute = vi.fn(async () => null)
    bootPanel({
      invoke: () => null,
      moonSession: { resolveBootRoute },
      onVendorsLoaded: () => {
        ;(window as any).LunaWS = { createClient: () => ({ connect: vi.fn() }) }
      },
    })

    await flush()

    // The window label in the test harness is 'panel-stub-ws'
    expect(resolveBootRoute).toHaveBeenCalledWith('panel-stub-ws')
  })

  // ── B: no client.toml / MoonSession returns null → legacy path unchanged ──

  it('B: no client.toml (MoonSession returns null) → legacy load_connection path', async () => {
    let connectSpy = vi.fn()

    bootPanel({
      invoke: (cmd) => {
        if (cmd === 'load_connection') return { wsUrl: 'ws://legacy:4753/ui', wsToken: 'tok' }
        return null
      },
      moonSession: {
        resolveBootRoute: async () => null,  // no client.toml / un-migrated
      },
      // Spy AFTER vendors load so the spy survives the moon-ws.js overwrite.
      onVendorsLoaded: () => {
        connectSpy = vi.fn()
        ;(window as any).LunaWS = { createClient: () => ({ connect: connectSpy }) }
      },
    })

    await flush()

    // Must fall through to the legacy URL
    expect(connectSpy).toHaveBeenCalledWith('ws://legacy:4753/ui', 'tok')
    // resolvedRouteKey stays null (legacy path)
    expect((window as any).__PanelInternals.resolvedRouteKey).toBeNull()
    // No error notice
    expect(document.querySelector('.notice')).toBeNull()
  })

  // ── C: route resolved but load_connection rejects → surface error ─────────

  it('C: route resolved but load_connection rejects → showNotice with reason', async () => {
    bootPanel({
      invoke: (cmd) => {
        if (cmd === 'load_connection') throw new Error('token vault locked')
        return null
      },
      moonSession: {
        resolveBootRoute: async () => ROUTE_LOCAL,
      },
      onVendorsLoaded: () => {
        ;(window as any).LunaWS = { createClient: () => ({ connect: vi.fn() }) }
      },
    })

    await flush()

    const notice = document.querySelector('.notice')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('Panel connection failed:')
    expect(notice!.textContent).toContain('token vault locked')
    // Also reflected on __PanelInternals
    expect((window as any).__PanelInternals.lastNotice).toContain('token vault locked')
  })

  it('C: legacy load_connection rejects with Tauri present → showNotice', async () => {
    bootPanel({
      invoke: (cmd) => {
        if (cmd === 'load_connection') throw new Error('not configured')
        return null
      },
      moonSession: {
        resolveBootRoute: async () => null,  // no route → legacy path
      },
      onVendorsLoaded: () => {
        ;(window as any).LunaWS = { createClient: () => ({ connect: vi.fn() }) }
      },
    })

    await flush()

    const notice = document.querySelector('.notice')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('Panel connection failed:')
    expect(notice!.textContent).toContain('not configured')
  })

  // ── D: off-Tauri (no __TAURI__) → silent, no notice ─────────────────────

  it('D: off-Tauri → connectWs is a no-op (no connect called, no notice)', async () => {
    let connectSpy = vi.fn()

    // No invoke (Tauri absent) — MoonSession.resolveBootRoute returns null
    // because __TAURI__ is absent (the real moon-session.js degrades).
    bootPanel({
      invoke: null,  // no __TAURI__ installed
      // Spy AFTER vendors load — with no Tauri, connect should never be called.
      onVendorsLoaded: () => {
        connectSpy = vi.fn()
        ;(window as any).LunaWS = { createClient: () => ({ connect: connectSpy }) }
      },
    })

    await flush()

    // connect must not have been called (no URL to connect to off-Tauri)
    expect(connectSpy).not.toHaveBeenCalled()
    // No error notice surfaced
    expect(document.querySelector('.notice')).toBeNull()
  })

  // ── E: child/settings panels without explicit route → default (documented C8) ──

  it('E: child panel with no explicit route binding uses default (C8 follow-up documented)', async () => {
    let connectSpy = vi.fn()

    // A child panel is just another panel window — same code path. Without a
    // set_panel_route call for this panelId, resolveBootRoute falls back to the
    // default route. Here MoonSession returns the default route directly.
    bootPanel({
      invoke: (cmd) => {
        if (cmd === 'load_connection') return { wsUrl: 'ws://legacy/ui', wsToken: 'child-tok' }
        return null
      },
      moonSession: {
        resolveBootRoute: async () => ({
          ...ROUTE_LOCAL,
          key: 'default',
          endpoints: ['ws://default.host/ui'],
        }),
      },
      // Spy AFTER vendors load so the spy survives the moon-ws.js overwrite.
      onVendorsLoaded: () => {
        connectSpy = vi.fn()
        ;(window as any).LunaWS = { createClient: () => ({ connect: connectSpy }) }
      },
    })

    await flush()

    // Child uses the default route endpoint (not the legacy URL)
    expect(connectSpy).toHaveBeenCalledWith('ws://default.host/ui', 'child-tok')
    expect((window as any).__PanelInternals.resolvedRouteKey).toBe('default')
  })

})
