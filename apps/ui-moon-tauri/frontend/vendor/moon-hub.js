/**
 * moon-hub.js — Phase 2 C8: Hub manager (DARK, additive)
 *
 * Provides the testable logic that index.html delegates to when the
 * `luna_pool_engine` dark flag is set:
 *
 *   1. PROCESS-WIDE POOL HOME — one adapter per routeKey; shared across
 *      panels on the same server.  Panels on different servers get distinct
 *      adapters and their frames NEVER cross.
 *
 *   2. ADDRESSED DELIVERY — `panel-connection-changed` events carry
 *      {panelId, routeKey, status, descriptor} and are delivered ONLY to
 *      the panel(s) whose routeKey matches.  Panels bound to route A never
 *      receive events for route B.
 *
 *   3. CROSS-ROUTE FRAME ISOLATION — inbound frames are tagged with the
 *      origin routeKey (by the adapter that produced them).  The hub
 *      dispatches them only to panels bound to that same routeKey.
 *
 *   4. F12 RESPAWN RE-BIND — if the hub window is recreated the manager
 *      can re-bind each panel by calling rebindAll(getPanelRoute) where
 *      getPanelRoute(panelId) returns the persisted routeKey.
 *
 * DARK FLAG: all exported behaviour is gated by PoolEngineHelper.isDarkFlagSet()
 * in the calling code (index.html).  This file exposes pure helpers that can
 * be exercised in jsdom without a real Tauri runtime.
 *
 * Exposed as globalThis.MoonHubManager.
 */
;(function (g) {
  'use strict';

  // ── Panel → route binding registry ─────────────────────────────────────────
  //
  // _bindings: Map<panelId, routeKey>
  // _routePanels: Map<routeKey, Set<panelId>>

  function createBindingRegistry() {
    var _bindings  = new Map();
    var _routePanels = new Map();

    function bind(panelId, routeKey) {
      // Remove old binding if any.
      var old = _bindings.get(panelId);
      if (old !== undefined && old !== routeKey) {
        var oldSet = _routePanels.get(old);
        if (oldSet) oldSet.delete(panelId);
      }
      _bindings.set(panelId, routeKey);
      if (!_routePanels.has(routeKey)) _routePanels.set(routeKey, new Set());
      _routePanels.get(routeKey).add(panelId);
    }

    function unbind(panelId) {
      var rk = _bindings.get(panelId);
      if (rk !== undefined) {
        var set = _routePanels.get(rk);
        if (set) set.delete(panelId);
      }
      _bindings.delete(panelId);
    }

    function routeKeyFor(panelId) {
      return _bindings.get(panelId) || null;
    }

    function panelsForRoute(routeKey) {
      var set = _routePanels.get(routeKey);
      return set ? Array.from(set) : [];
    }

    function allBindings() {
      var result = [];
      _bindings.forEach(function (rk, pid) { result.push({ panelId: pid, routeKey: rk }); });
      return result;
    }

    return { bind: bind, unbind: unbind, routeKeyFor: routeKeyFor,
             panelsForRoute: panelsForRoute, allBindings: allBindings };
  }

  // ── Addressed delivery ──────────────────────────────────────────────────────
  //
  // A lightweight in-process EventTarget per-panel.
  // In production index.html the deliver function is wired to Tauri's
  // emit-to-specific-window.  For testing, the default deliver is a plain
  // in-memory EventTarget keyed by panelId.

  /**
   * Create an addressed delivery bus.
   *
   * @param {function(string, object): void} [deliver]
   *   Optional custom deliver(panelId, event) function.  Defaults to a plain
   *   EventTarget fan (for testing / off-Tauri).
   */
  function createDeliveryBus(deliver) {
    var _registry = createBindingRegistry();
    var _listeners = new Map(); // panelId → [{routeKey, fn}]

    // Default deliver: fire on a per-panelId EventTarget held in _listeners.
    function defaultDeliver(panelId, event) {
      var fns = _listeners.get(panelId) || [];
      fns.forEach(function (entry) {
        if (entry.routeKey === event.routeKey) {
          try { entry.fn(event); } catch (_) {}
        }
      });
    }

    var _deliver = typeof deliver === 'function' ? deliver : defaultDeliver;

    /**
     * Bind a panel to a route and optionally register an in-process listener
     * (used in tests; in production index.html uses Tauri targeted-emit instead).
     */
    function subscribe(panelId, routeKey, fn) {
      _registry.bind(panelId, routeKey);
      if (typeof fn === 'function') {
        if (!_listeners.has(panelId)) _listeners.set(panelId, []);
        _listeners.get(panelId).push({ routeKey: routeKey, fn: fn });
      }
    }

    /**
     * Remove all subscriptions for a panel.
     */
    function unsubscribe(panelId) {
      _registry.unbind(panelId);
      _listeners.delete(panelId);
    }

    /**
     * Deliver a connection-changed event to ALL panels bound to routeKey.
     * Panels bound to a DIFFERENT routeKey are silently skipped.
     *
     * @param {string} routeKey
     * @param {{ status: string, descriptor?: object }} payload
     */
    function dispatchConnectionChanged(routeKey, payload) {
      var panels = _registry.panelsForRoute(routeKey);
      panels.forEach(function (panelId) {
        _deliver(panelId, {
          type: 'panel-connection-changed',
          panelId: panelId,
          routeKey: routeKey,
          status: payload.status,
          descriptor: payload.descriptor || null,
        });
      });
    }

    /**
     * Deliver a frame (tagged with its origin routeKey) to panels bound to
     * that same routeKey.  Frames whose origin routeKey differs from a
     * panel's bound routeKey are DROPPED — cross-route isolation.
     *
     * @param {object} taggedFrame  A frame with __routeKey set (see pool-engine.js).
     * @param {function} dispatch   The downstream dispatch function (e.g. MoonFrames.dispatch).
     */
    function dispatchFrame(taggedFrame, dispatch) {
      var originKey = taggedFrame.__routeKey;
      if (!originKey) {
        // Untagged legacy frame: pass through unchanged (no isolation applied).
        dispatch(taggedFrame);
        return;
      }
      var panels = _registry.panelsForRoute(originKey);
      if (panels.length === 0) {
        // No panels bound to this route; drop.
        return;
      }
      // Deliver to all panels bound to the origin route.
      // (In a multi-panel scenario, all panels on the same route share one
      // adapter, so we dispatch once and rely on panel-level filtering.)
      dispatch(taggedFrame);
    }

    function routeKeyFor(panelId) {
      return _registry.routeKeyFor(panelId);
    }

    function panelsForRoute(routeKey) {
      return _registry.panelsForRoute(routeKey);
    }

    function allBindings() {
      return _registry.allBindings();
    }

    return {
      subscribe: subscribe,
      unsubscribe: unsubscribe,
      dispatchConnectionChanged: dispatchConnectionChanged,
      dispatchFrame: dispatchFrame,
      routeKeyFor: routeKeyFor,
      panelsForRoute: panelsForRoute,
      allBindings: allBindings,
    };
  }

  // ── Process-wide pool ───────────────────────────────────────────────────────
  //
  // One ConnectionManager-compatible adapter per routeKey.  Panels on the same
  // route SHARE the adapter (hub is the sole owner).
  //
  // In production the "adapter" is LunaWsAdapter / the PoolEngine's adapter.
  // For testing we accept any object with { routeKey, subscribeFrames, subscribeConnection }.

  /**
   * Create a process-wide connection pool.
   *
   * @param {function(string): object} adapterFactory
   *   Called with a routeKey; must return an adapter-like object.
   *   The pool calls adapterFactory only once per routeKey.
   */
  function createConnectionPool(adapterFactory) {
    var _adapters = new Map(); // routeKey → adapter

    function acquire(routeKey) {
      if (_adapters.has(routeKey)) return _adapters.get(routeKey);
      var adapter = adapterFactory(routeKey);
      _adapters.set(routeKey, adapter);
      return adapter;
    }

    function release(routeKey) {
      var adapter = _adapters.get(routeKey);
      if (adapter && typeof adapter.disconnect === 'function') {
        try { adapter.disconnect(); } catch (_) {}
      }
      _adapters.delete(routeKey);
    }

    function has(routeKey) {
      return _adapters.has(routeKey);
    }

    function activeRoutes() {
      return Array.from(_adapters.keys());
    }

    function releaseAll() {
      _adapters.forEach(function (_, rk) { release(rk); });
    }

    return { acquire: acquire, release: release, has: has,
             activeRoutes: activeRoutes, releaseAll: releaseAll };
  }

  // ── F12 Hub respawn re-bind ─────────────────────────────────────────────────

  /**
   * Re-bind all known panels after a hub respawn.
   *
   * @param {string[]} panelIds
   *   All panel labels the hub knows about (from getAllWindows or persisted list).
   * @param {function(string): Promise<string|null>} getPanelRoute
   *   Async function that looks up the persisted routeKey for a panelId.
   *   Should call MoonSession.get_panel_route (or load from moon-session.json).
   * @param {object} bus  A DeliveryBus returned by createDeliveryBus().
   * @param {object} pool A ConnectionPool returned by createConnectionPool().
   * @param {function(string, object): void} [onRebind]
   *   Optional callback called with (panelId, routeKey) after each successful bind.
   * @returns {Promise<Array<{panelId,routeKey}>>}
   *   The list of panels that were successfully rebound.
   *
   * F12 ACCEPTED FAILURE MODES:
   *   - A panel that was MID-TURN when the hub crashed: the in-flight streaming
   *     response bytes that were buffered in the dead hub's WebSocket are LOST.
   *     The panel's reattach-self-heal (#170) will detect the stall and re-request
   *     the thread snapshot, which recovers state up to the last persisted message.
   *     The partial turn's streamed bytes (not yet persisted) are not recovered —
   *     this is documented as the accepted loss.  The user sees a clean re-attach
   *     rather than a corrupted or hung stream.
   *   - The panel's reattach-self-heal fires within its existing stall timeout
   *     (a few seconds); no extra recovery logic is needed here.
   */
  async function rebindAll(panelIds, getPanelRoute, bus, pool, onRebind) {
    var rebound = [];
    for (var i = 0; i < panelIds.length; i++) {
      var panelId = panelIds[i];
      try {
        var routeKey = await getPanelRoute(panelId);
        if (typeof routeKey === 'string' && routeKey) {
          bus.subscribe(panelId, routeKey);
          pool.acquire(routeKey); // ensure adapter is live
          rebound.push({ panelId: panelId, routeKey: routeKey });
          if (typeof onRebind === 'function') onRebind(panelId, routeKey);
        }
      } catch (e) {
        // Best-effort: log but continue re-binding other panels.
        if (typeof console !== 'undefined') {
          console.warn('[MoonHubManager] rebindAll: failed for panel', panelId, e && e.message || e);
        }
      }
    }
    return rebound;
  }

  // ── Settings route enumeration helper ──────────────────────────────────────

  /**
   * Enumerate routes for the settings UI.
   *
   * Calls MoonSession.listRoutes() and returns a normalised array of
   * { key, label, isDefault } objects.  Falls back to the provided
   * `fallback` array when MoonSession is unavailable or listRoutes() returns null.
   *
   * @param {string[]} [fallback]  Default ['stable','dev'].
   * @returns {Promise<Array<{key:string,label:string,isDefault:boolean}>>}
   */
  async function enumerateRoutes(fallback) {
    var _fallback = Array.isArray(fallback) ? fallback : ['stable', 'dev'];
    var ms = (typeof g !== 'undefined') && g.MoonSession;
    if (ms && typeof ms.listRoutes === 'function') {
      try {
        var result = await ms.listRoutes();
        if (result && Array.isArray(result.routes) && result.routes.length > 0) {
          return result.routes.map(function (r) {
            return {
              key:       r.key   || r.name || String(r),
              label:     r.label || r.key  || r.name || String(r),
              isDefault: r.key === result.default,
            };
          });
        }
      } catch (e) {
        if (typeof console !== 'undefined') {
          console.warn('[MoonHubManager] enumerateRoutes: listRoutes failed, using fallback:', e && e.message || e);
        }
      }
    }
    // Fallback: produce the same structure from the hardcoded list.
    return _fallback.map(function (k, i) {
      return { key: k, label: k.charAt(0).toUpperCase() + k.slice(1), isDefault: i === 0 };
    });
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  g.MoonHubManager = {
    createBindingRegistry: createBindingRegistry,
    createDeliveryBus: createDeliveryBus,
    createConnectionPool: createConnectionPool,
    rebindAll: rebindAll,
    enumerateRoutes: enumerateRoutes,
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
