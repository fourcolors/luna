// @vitest-environment jsdom
//
// Unit tests for vendor/moon-session.js (Phase 2 C2).
//
// Three behavioural scenarios:
//   A. Panel-route present → load_route returns that route → RouteInfo returned.
//   B. No panel-route → falls back to default → load_route returns default
//      route → RouteInfo returned.
//   C. No client.toml (list_routes throws or returns no default) → null.
//   D. No __TAURI__ (browser / jsdom dev) → null immediately.
//   E. setPanelRoute / listRoutes / setDefaultRoute passthroughs work.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Vendor loader (same pattern as moon-vendor.test.ts) ─────────────────────
function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const ROUTE_A: RouteInfo = {
  label: 'Local dev',
  key: 'local',
  endpoints: ['ws://127.0.0.1:4753/ui'],
  token_ref: 'env:LUNA_WS_TOKEN',
  transport: 'websocket',
}
const ROUTE_DEFAULT: RouteInfo = {
  label: 'Production',
  key: 'prod',
  endpoints: ['wss://luna.example.com/ui'],
  token_ref: 'env:PROD_TOKEN',
  transport: 'websocket',
}

interface RouteInfo {
  label: string
  key: string
  endpoints: string[]
  token_ref: string
  transport: string
  expect?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Install a mock __TAURI__ with a scripted invoke on `target`. */
function installTauri(target: any, invokeImpl: (cmd: string, args?: any) => any) {
  target.__TAURI__ = {
    core: {
      invoke(cmd: string, args?: any) {
        return Promise.resolve().then(() => invokeImpl(cmd, args))
      },
    },
  }
}

function removeTauri(target: any) {
  delete target.__TAURI__
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  loadVendorInto(window, 'moon-session.js')
})

afterEach(() => {
  removeTauri(window)
  delete (window as any).MoonSession
})

const S = () => (window as any).MoonSession

describe('MoonSession.resolveBootRoute — no __TAURI__', () => {
  it('returns null immediately without Tauri', async () => {
    // __TAURI__ not installed → degraded path
    expect(await S().resolveBootRoute()).toBeNull()
  })

  it('returns null with a panel id too', async () => {
    expect(await S().resolveBootRoute('panel-42')).toBeNull()
  })
})

describe('MoonSession.resolveBootRoute — panel-route present (A)', () => {
  it('uses get_panel_route then load_route and returns RouteInfo', async () => {
    const invoke = vi.fn().mockImplementation((cmd: string, args: any) => {
      if (cmd === 'get_panel_route') return 'local'
      if (cmd === 'load_route' && args?.routeKey === 'local') return ROUTE_A
      return null
    })
    installTauri(window, invoke)

    const result = await S().resolveBootRoute('panel-42')
    expect(result).toEqual(ROUTE_A)
    // must NOT call list_routes when panel-route resolves
    expect(invoke).not.toHaveBeenCalledWith('list_routes')
    expect(invoke).toHaveBeenCalledWith('get_panel_route', { panelId: 'panel-42' })
    expect(invoke).toHaveBeenCalledWith('load_route', { routeKey: 'local' })
  })
})

describe('MoonSession.resolveBootRoute — no panel-route, falls back to default (B)', () => {
  it('calls list_routes then load_route with the default key', async () => {
    const invoke = vi.fn().mockImplementation((cmd: string, args: any) => {
      if (cmd === 'get_panel_route') return null            // no panel assignment
      if (cmd === 'list_routes') return { default: 'prod', routes: [{ key: 'prod', label: 'Production', is_default: true }] }
      if (cmd === 'load_route' && args?.routeKey === 'prod') return ROUTE_DEFAULT
      return null
    })
    installTauri(window, invoke)

    const result = await S().resolveBootRoute()            // no panelId
    expect(result).toEqual(ROUTE_DEFAULT)
    // list_routes takes no args; Tauri invoke passes undefined for the args param
    expect(invoke).toHaveBeenCalledWith('list_routes', undefined)
    expect(invoke).toHaveBeenCalledWith('load_route', { routeKey: 'prod' })
  })

  it('falls back to default even when panelId given but no panel assignment', async () => {
    const invoke = vi.fn().mockImplementation((cmd: string, args: any) => {
      if (cmd === 'get_panel_route') return null
      if (cmd === 'list_routes') return { default: 'prod', routes: [] }
      if (cmd === 'load_route') return ROUTE_DEFAULT
      return null
    })
    installTauri(window, invoke)

    const result = await S().resolveBootRoute('panel-99')
    expect(result).toEqual(ROUTE_DEFAULT)
    expect(invoke).toHaveBeenCalledWith('get_panel_route', { panelId: 'panel-99' })
    expect(invoke).toHaveBeenCalledWith('list_routes', undefined)
  })
})

describe('MoonSession.resolveBootRoute — no client.toml / error cases (C)', () => {
  it('returns null when list_routes throws (no client.toml)', async () => {
    installTauri(window, (cmd) => {
      if (cmd === 'list_routes') throw new Error('client.toml not found')
      return null
    })
    const result = await S().resolveBootRoute()
    expect(result).toBeNull()
  })

  it('returns null when list_routes returns empty default', async () => {
    installTauri(window, (cmd) => {
      if (cmd === 'list_routes') return { default: '', routes: [] }
      return null
    })
    expect(await S().resolveBootRoute()).toBeNull()
  })

  it('returns null when list_routes returns no default key', async () => {
    installTauri(window, (cmd) => {
      if (cmd === 'list_routes') return { routes: [] }   // no .default field
      return null
    })
    expect(await S().resolveBootRoute()).toBeNull()
  })

  it('returns null when load_route returns an empty endpoints array', async () => {
    installTauri(window, (cmd, args) => {
      if (cmd === 'list_routes') return { default: 'empty', routes: [] }
      if (cmd === 'load_route') return { label: 'Bad', key: 'empty', endpoints: [], token_ref: '', transport: 'websocket' }
      return null
    })
    expect(await S().resolveBootRoute()).toBeNull()
  })

  it('returns null when load_route throws', async () => {
    installTauri(window, (cmd) => {
      if (cmd === 'list_routes') return { default: 'prod', routes: [] }
      if (cmd === 'load_route') throw new Error('route not found')
      return null
    })
    expect(await S().resolveBootRoute()).toBeNull()
  })
})

describe('MoonSession passthroughs', () => {
  it('setPanelRoute invokes set_panel_route and returns true', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    installTauri(window, invoke)

    const ok = await S().setPanelRoute('panel-1', 'local')
    expect(ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('set_panel_route', { panelId: 'panel-1', routeKey: 'local' })
  })

  it('setPanelRoute returns false outside Tauri', async () => {
    expect(await S().setPanelRoute('panel-1', 'local')).toBe(false)
  })

  it('listRoutes returns the list from Tauri', async () => {
    const payload = { default: 'prod', routes: [{ key: 'prod', label: 'Prod', is_default: true }] }
    installTauri(window, () => payload)
    expect(await S().listRoutes()).toEqual(payload)
  })

  it('listRoutes returns null outside Tauri', async () => {
    expect(await S().listRoutes()).toBeNull()
  })

  it('setDefaultRoute invokes set_default_route and returns true', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    installTauri(window, invoke)

    const ok = await S().setDefaultRoute('prod')
    expect(ok).toBe(true)
    expect(invoke).toHaveBeenCalledWith('set_default_route', { routeKey: 'prod' })
  })

  it('setDefaultRoute returns false outside Tauri', async () => {
    expect(await S().setDefaultRoute('prod')).toBe(false)
  })
})
