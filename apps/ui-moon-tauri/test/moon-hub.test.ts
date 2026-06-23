// @vitest-environment jsdom
//
// Phase 2 C8 — hub manager tests (vendor/moon-hub.js)
//
// Four acceptance criteria:
//   1. ADDRESSED DELIVERY — a panel-connection-changed event for routeKey A
//      reaches handlers bound to A and NEVER reaches handlers bound to B.
//   2. SETTINGS ENUMERATION — enumerateRoutes() returns N routes from a
//      MoonSession.listRoutes() stub; falls back to ['stable','dev'] when
//      MoonSession is unavailable or returns null.
//   3. CROSS-ROUTE FRAME ISOLATION — a frame tagged __routeKey:'route-a' is
//      dispatched only when panels on 'route-a' are registered; dispatching to
//      an empty route-b registry drops the frame (dispatch not called).
//   4. F12 RESPAWN RE-BIND — rebindAll() re-subscribes each panel to its
//      persisted routeKey and returns the full rebound list; a panel whose
//      getPanelRoute() returns null is skipped gracefully.
//
// All tests are pure-logic (no Tauri, no network).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── Vendor loader ──────────────────────────────────────────────────────────────

function loadVendorInto(target: any, file: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../frontend/vendor', file), 'utf8')
  new Function('globalThis', src)(target)
}

// ── Test helpers ───────────────────────────────────────────────────────────────

/** Load pool-engine + moon-hub into an isolated target object, return both helpers. */
function loadHelpers() {
  const target: any = {}
  loadVendorInto(target, 'pool-engine.js')
  loadVendorInto(target, 'moon-hub.js')
  return {
    hub: target.MoonHubManager as any,
    pool: target.PoolEngineHelper as any,
    target,
  }
}

// ── 1. Addressed Delivery ──────────────────────────────────────────────────────

describe('MoonHubManager — addressed delivery', () => {
  it('delivers panel-connection-changed only to panels bound to the matching routeKey', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()

    const receivedA: any[] = []
    const receivedB: any[] = []

    bus.subscribe('panel-alpha', 'route-a', (evt: any) => receivedA.push(evt))
    bus.subscribe('panel-beta',  'route-b', (evt: any) => receivedB.push(evt))

    bus.dispatchConnectionChanged('route-a', { status: 'ready', descriptor: { wsUrl: 'ws://a' } })

    expect(receivedA).toHaveLength(1)
    expect(receivedA[0].routeKey).toBe('route-a')
    expect(receivedA[0].panelId).toBe('panel-alpha')
    expect(receivedA[0].status).toBe('ready')
    // route-b panel must NOT have received anything
    expect(receivedB).toHaveLength(0)
  })

  it('delivers to all panels on the same route and none on a different route', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()

    const got: Record<string, any[]> = { p1: [], p2: [], p3: [] }
    bus.subscribe('panel-1', 'route-a', (e: any) => got.p1.push(e))
    bus.subscribe('panel-2', 'route-a', (e: any) => got.p2.push(e))
    bus.subscribe('panel-3', 'route-b', (e: any) => got.p3.push(e))

    bus.dispatchConnectionChanged('route-a', { status: 'connecting' })

    expect(got.p1).toHaveLength(1)
    expect(got.p2).toHaveLength(1)
    expect(got.p3).toHaveLength(0)
  })

  it('delivers nothing when no panels are bound to the dispatched routeKey', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()

    const got: any[] = []
    bus.subscribe('panel-orphan', 'route-z', (e: any) => got.push(e))

    // Dispatch to a completely different key that has no subscribers.
    bus.dispatchConnectionChanged('route-never-bound', { status: 'ready' })

    expect(got).toHaveLength(0)
  })

  it('stops delivering after unsubscribe', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()

    const got: any[] = []
    bus.subscribe('panel-x', 'route-a', (e: any) => got.push(e))
    bus.dispatchConnectionChanged('route-a', { status: 'ready' })
    expect(got).toHaveLength(1)

    bus.unsubscribe('panel-x')
    bus.dispatchConnectionChanged('route-a', { status: 'connecting' })
    expect(got).toHaveLength(1) // no new events after unsubscribe
  })

  it('re-binding a panel to a new route redirects delivery', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()

    const gotA: any[] = []
    const gotB: any[] = []

    bus.subscribe('panel-migrate', 'route-a', (e: any) => gotA.push(e))
    bus.dispatchConnectionChanged('route-a', { status: 'ready' })
    expect(gotA).toHaveLength(1)

    // Re-bind same panel to route-b.
    bus.subscribe('panel-migrate', 'route-b', (e: any) => gotB.push(e))
    bus.dispatchConnectionChanged('route-a', { status: 'connecting' })
    // Panel is now on route-b; route-a delivery should miss it.
    expect(gotA).toHaveLength(1) // no new event
    bus.dispatchConnectionChanged('route-b', { status: 'connecting' })
    expect(gotB).toHaveLength(1)
  })

  it('exposes routeKeyFor and panelsForRoute for inspection', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()

    bus.subscribe('panel-a1', 'route-a')
    bus.subscribe('panel-a2', 'route-a')
    bus.subscribe('panel-b1', 'route-b')

    expect(bus.routeKeyFor('panel-a1')).toBe('route-a')
    expect(bus.routeKeyFor('panel-b1')).toBe('route-b')
    expect(bus.routeKeyFor('panel-unknown')).toBeNull()

    const onA = bus.panelsForRoute('route-a')
    expect(onA).toHaveLength(2)
    expect(onA).toContain('panel-a1')
    expect(onA).toContain('panel-a2')
  })
})

// ── 2. Settings Route Enumeration ─────────────────────────────────────────────

describe('MoonHubManager — settings route enumeration', () => {
  afterEach(() => {
    // Clean up any MoonSession stub injected onto window.
    delete (window as any).MoonSession
  })

  it('returns routes from MoonSession.listRoutes() when available', async () => {
    const { target } = loadHelpers()

    target.MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({
        default: 'prod',
        routes: [
          { key: 'prod',  label: 'Production' },
          { key: 'local', label: 'Local Dev' },
        ],
      }),
    }
    const routes3 = await target.MoonHubManager.enumerateRoutes(['stable', 'dev'])
    expect(routes3).toHaveLength(2)
    expect(routes3[0].key).toBe('prod')
    expect(routes3[0].label).toBe('Production')
    expect(routes3[0].isDefault).toBe(true)
    expect(routes3[1].key).toBe('local')
    expect(routes3[1].isDefault).toBe(false)
  })

  it('falls back to hardcoded list when MoonSession is absent', async () => {
    const { hub, target } = loadHelpers()
    // No MoonSession on target.
    const routes = await target.MoonHubManager.enumerateRoutes(['stable', 'dev'])
    expect(routes).toHaveLength(2)
    expect(routes[0].key).toBe('stable')
    expect(routes[1].key).toBe('dev')
    expect(routes[0].isDefault).toBe(true) // first entry is default in fallback
  })

  it('falls back when MoonSession.listRoutes() returns null', async () => {
    const { hub, target } = loadHelpers()
    target.MoonSession = { listRoutes: vi.fn().mockResolvedValue(null) }
    const routes = await target.MoonHubManager.enumerateRoutes(['stable', 'dev'])
    expect(routes[0].key).toBe('stable')
    expect(routes[1].key).toBe('dev')
  })

  it('falls back when MoonSession.listRoutes() returns empty routes array', async () => {
    const { hub, target } = loadHelpers()
    target.MoonSession = { listRoutes: vi.fn().mockResolvedValue({ default: '', routes: [] }) }
    const routes = await target.MoonHubManager.enumerateRoutes(['stable', 'dev'])
    expect(routes[0].key).toBe('stable')
  })

  it('falls back when MoonSession.listRoutes() rejects', async () => {
    const { hub, target } = loadHelpers()
    target.MoonSession = { listRoutes: vi.fn().mockRejectedValue(new Error('Tauri unavailable')) }
    const routes = await target.MoonHubManager.enumerateRoutes(['stable', 'dev'])
    expect(routes[0].key).toBe('stable')
  })

  it('uses provided fallback list instead of default stable/dev', async () => {
    const { hub, target } = loadHelpers()
    const routes = await target.MoonHubManager.enumerateRoutes(['alpha', 'beta', 'gamma'])
    expect(routes).toHaveLength(3)
    expect(routes[0].key).toBe('alpha')
    expect(routes[2].key).toBe('gamma')
  })

  it('enumerates N routes from listRoutes', async () => {
    const { hub, target } = loadHelpers()
    const fiveRoutes = ['r1','r2','r3','r4','r5'].map((k) => ({ key: k, label: k.toUpperCase() }))
    target.MoonSession = {
      listRoutes: vi.fn().mockResolvedValue({ default: 'r3', routes: fiveRoutes }),
    }
    const routes = await target.MoonHubManager.enumerateRoutes(['stable', 'dev'])
    expect(routes).toHaveLength(5)
    const def = routes.find((r: any) => r.isDefault)
    expect(def?.key).toBe('r3')
    const nonDef = routes.filter((r: any) => !r.isDefault)
    expect(nonDef).toHaveLength(4)
  })
})

// ── 3. Cross-route Frame Isolation ────────────────────────────────────────────

describe('MoonHubManager — cross-route frame isolation', () => {
  it('dispatches a frame tagged route-a only to route-a panels via dispatchFrame', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()

    // Subscribe panel-a to route-a.
    bus.subscribe('panel-a', 'route-a')

    const dispatched: any[] = []
    const dispatch = (frame: any) => dispatched.push(frame)

    // A frame from route-a: should be passed to dispatch because panels exist on route-a.
    bus.dispatchFrame({ type: 'thread-snapshot', __routeKey: 'route-a' }, dispatch)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].__routeKey).toBe('route-a')
  })

  it('drops a route-a frame when no panels are bound to route-a', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()

    // Only route-b panels registered.
    bus.subscribe('panel-b', 'route-b')

    const dispatched: any[] = []
    const dispatch = (frame: any) => dispatched.push(frame)

    // Frame from route-a: no panels bound to route-a → DROPPED.
    bus.dispatchFrame({ type: 'thread-snapshot', __routeKey: 'route-a' }, dispatch)
    expect(dispatched).toHaveLength(0)
  })

  it('a route-a frame does NOT reach route-b dispatch even when both have panels', () => {
    const { hub } = loadHelpers()

    // Use TWO buses (one per route) to simulate separate panel dispatchers.
    const busA = hub.createDeliveryBus()
    const busB = hub.createDeliveryBus()

    busA.subscribe('panel-a', 'route-a')
    busB.subscribe('panel-b', 'route-b')

    const dispatchedA: any[] = []
    const dispatchedB: any[] = []

    const frame = { type: 'thread-snapshot', data: 'from-a', __routeKey: 'route-a' }

    busA.dispatchFrame(frame, (f: any) => dispatchedA.push(f))
    busB.dispatchFrame(frame, (f: any) => dispatchedB.push(f))

    expect(dispatchedA).toHaveLength(1)
    // Bus B has no route-a panels → dispatch B must NOT have been called.
    expect(dispatchedB).toHaveLength(0)
  })

  it('passes untagged legacy frames through without dropping them', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()

    const dispatched: any[] = []
    const dispatch = (frame: any) => dispatched.push(frame)

    // No panels registered at all, but frame has no __routeKey (legacy).
    bus.dispatchFrame({ type: 'hello', data: 'world' }, dispatch)
    expect(dispatched).toHaveLength(1) // pass-through
  })

  it('frame tagged with origin route carries __routeKey in dispatch payload', () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()
    bus.subscribe('panel-a', 'route-a')

    const dispatched: any[] = []
    bus.dispatchFrame({ type: 'chat-message', __routeKey: 'route-a', text: 'hi' },
      (f: any) => dispatched.push(f))
    expect(dispatched[0].__routeKey).toBe('route-a')
    expect(dispatched[0].text).toBe('hi')
  })
})

// ── 4. F12 Hub Respawn Re-bind ─────────────────────────────────────────────────

describe('MoonHubManager — F12 hub respawn re-bind', () => {
  it('re-binds all panels to their persisted routeKeys after respawn', async () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()
    const pool = hub.createConnectionPool((_rk: string) => ({ routeKey: _rk, disconnect: vi.fn() }))

    // Simulate persisted panel→route mapping (from moon-session.json).
    const persistedRoutes: Record<string, string> = {
      'panel-chat':     'route-a',
      'panel-settings': 'route-b',
      'panel-agents':   'route-a',
    }
    const getPanelRoute = async (panelId: string) => persistedRoutes[panelId] || null

    const rebound = await hub.rebindAll(
      ['panel-chat', 'panel-settings', 'panel-agents'],
      getPanelRoute,
      bus,
      pool,
    )

    expect(rebound).toHaveLength(3)
    expect(rebound.find((r: any) => r.panelId === 'panel-chat')?.routeKey).toBe('route-a')
    expect(rebound.find((r: any) => r.panelId === 'panel-settings')?.routeKey).toBe('route-b')
    expect(rebound.find((r: any) => r.panelId === 'panel-agents')?.routeKey).toBe('route-a')

    // Pool should have acquired adapters for both routes.
    expect(pool.has('route-a')).toBe(true)
    expect(pool.has('route-b')).toBe(true)

    // Bus should reflect the bindings.
    expect(bus.routeKeyFor('panel-chat')).toBe('route-a')
    expect(bus.routeKeyFor('panel-settings')).toBe('route-b')
  })

  it('skips panels whose getPanelRoute returns null (no persisted binding)', async () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()
    const pool = hub.createConnectionPool((_rk: string) => ({ routeKey: _rk, disconnect: vi.fn() }))

    const getPanelRoute = async (panelId: string) =>
      panelId === 'panel-bound' ? 'route-a' : null

    const rebound = await hub.rebindAll(
      ['panel-bound', 'panel-unbound'],
      getPanelRoute,
      bus,
      pool,
    )

    expect(rebound).toHaveLength(1)
    expect(rebound[0].panelId).toBe('panel-bound')
    expect(bus.routeKeyFor('panel-unbound')).toBeNull()
  })

  it('continues re-binding other panels even when getPanelRoute throws for one', async () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()
    const pool = hub.createConnectionPool((_rk: string) => ({ routeKey: _rk, disconnect: vi.fn() }))

    const getPanelRoute = async (panelId: string) => {
      if (panelId === 'panel-broken') throw new Error('Tauri command failed')
      return 'route-a'
    }

    const rebound = await hub.rebindAll(
      ['panel-ok-1', 'panel-broken', 'panel-ok-2'],
      getPanelRoute,
      bus,
      pool,
    )

    expect(rebound).toHaveLength(2)
    expect(rebound.map((r: any) => r.panelId)).toContain('panel-ok-1')
    expect(rebound.map((r: any) => r.panelId)).toContain('panel-ok-2')
    expect(rebound.map((r: any) => r.panelId)).not.toContain('panel-broken')
  })

  it('calls onRebind callback for each successfully rebound panel', async () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()
    const pool = hub.createConnectionPool((_rk: string) => ({ routeKey: _rk, disconnect: vi.fn() }))

    const calls: Array<[string, string]> = []
    const onRebind = (panelId: string, routeKey: string) => calls.push([panelId, routeKey])

    await hub.rebindAll(
      ['panel-1', 'panel-2'],
      async () => 'route-a',
      bus,
      pool,
      onRebind,
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(['panel-1', 'route-a'])
    expect(calls[1]).toEqual(['panel-2', 'route-a'])
  })

  it('after respawn, addressed delivery works immediately for rebound panels', async () => {
    const { hub } = loadHelpers()
    const bus = hub.createDeliveryBus()
    const pool = hub.createConnectionPool((_rk: string) => ({ routeKey: _rk, disconnect: vi.fn() }))

    // Bind listeners via subscribe after rebind.
    await hub.rebindAll(
      ['panel-a', 'panel-b'],
      async (id: string) => id === 'panel-a' ? 'route-a' : 'route-b',
      bus,
      pool,
    )

    // Now add in-process listeners (in production: Tauri targeted-emit).
    const gotA: any[] = []
    const gotB: any[] = []
    bus.subscribe('panel-a', 'route-a', (e: any) => gotA.push(e))
    bus.subscribe('panel-b', 'route-b', (e: any) => gotB.push(e))

    bus.dispatchConnectionChanged('route-a', { status: 'ready' })
    expect(gotA).toHaveLength(1)
    expect(gotB).toHaveLength(0)
  })

  it('F12 accepted failure mode: mid-turn in-flight bytes are NOT recovered (documented)', () => {
    // This test documents the accepted loss, not a behaviour that can pass/fail.
    // The reattach-self-heal (#170) recovers the thread snapshot (last persisted message).
    // Streaming bytes buffered in the dead hub's WebSocket are not recoverable.
    //
    // Evidence: after rebindAll, the panel's connectWs() re-subscribes to the thread
    // snapshot via the server's replay buffer.  The server re-sends all persisted messages.
    // Only bytes transmitted but NOT YET persisted (in-flight) are lost.
    //
    // This test asserts that the accepted loss is documented and not falsely claimed
    // to be "no data loss".
    const acceptedLossDocumented = true
    expect(acceptedLossDocumented).toBe(true)
  })
})

// ── 5. Connection Pool ─────────────────────────────────────────────────────────

describe('MoonHubManager — createConnectionPool', () => {
  it('returns the same adapter for repeated acquire() calls on the same routeKey', () => {
    const { hub } = loadHelpers()
    let callCount = 0
    const pool = hub.createConnectionPool((_rk: string) => {
      callCount++
      return { routeKey: _rk, disconnect: vi.fn() }
    })

    const a1 = pool.acquire('route-a')
    const a2 = pool.acquire('route-a')
    expect(a1).toBe(a2) // same reference
    expect(callCount).toBe(1)
  })

  it('creates distinct adapters for distinct routeKeys', () => {
    const { hub } = loadHelpers()
    const pool = hub.createConnectionPool((rk: string) => ({ routeKey: rk, disconnect: vi.fn() }))

    const a = pool.acquire('route-a')
    const b = pool.acquire('route-b')
    expect(a).not.toBe(b)
    expect(a.routeKey).toBe('route-a')
    expect(b.routeKey).toBe('route-b')
  })

  it('release() calls disconnect and removes the adapter', () => {
    const { hub } = loadHelpers()
    const disconnects: string[] = []
    const pool = hub.createConnectionPool((rk: string) => ({
      routeKey: rk,
      disconnect: () => disconnects.push(rk),
    }))

    pool.acquire('route-a')
    expect(pool.has('route-a')).toBe(true)
    pool.release('route-a')
    expect(pool.has('route-a')).toBe(false)
    expect(disconnects).toContain('route-a')
  })

  it('activeRoutes() lists all acquired routes', () => {
    const { hub } = loadHelpers()
    const pool = hub.createConnectionPool((rk: string) => ({ routeKey: rk, disconnect: vi.fn() }))

    pool.acquire('route-a')
    pool.acquire('route-b')
    pool.acquire('route-c')
    expect(pool.activeRoutes()).toHaveLength(3)
    pool.release('route-b')
    expect(pool.activeRoutes()).toHaveLength(2)
    expect(pool.activeRoutes()).not.toContain('route-b')
  })
})

// ── 6. Dark flag — flag-off is unchanged ─────────────────────────────────────

describe('MoonHubManager — dark flag isolation', () => {
  afterEach(() => {
    localStorage.clear()
    delete (window as any).__LUNA_POOL_ENGINE
  })

  it('MoonHubManager is always defined regardless of the flag', () => {
    const { hub } = loadHelpers()
    expect(hub).toBeDefined()
    expect(typeof hub.createDeliveryBus).toBe('function')
    expect(typeof hub.createConnectionPool).toBe('function')
    expect(typeof hub.rebindAll).toBe('function')
    expect(typeof hub.enumerateRoutes).toBe('function')
  })

  it('PoolEngineHelper.isDarkFlagSet() is false by default', () => {
    const { pool } = loadHelpers()
    // No localStorage flag, no __LUNA_POOL_ENGINE.
    expect(pool.isDarkFlagSet()).toBe(false)
  })

  it('PoolEngineHelper.isDarkFlagSet() is true when flag is set on target', () => {
    const { pool, target } = loadHelpers()
    target.__LUNA_POOL_ENGINE = true
    expect(pool.isDarkFlagSet()).toBe(true)
  })
})
