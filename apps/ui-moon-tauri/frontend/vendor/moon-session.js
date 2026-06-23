// moon-session.js — Phase 2 C2: route-keyed boot helper
//
// Wraps the C3 Tauri commands (get_panel_route, load_route, list_routes,
// set_default_route, set_panel_route) for the Moon frontend.  Degrades
// gracefully when:
//   • window.__TAURI__ is absent (browser / jsdom dev)
//   • client.toml does not exist (un-migrated user — no routes configured)
//
// In either degraded case every method returns null / empty results so the
// caller can fall back to the legacy luna_ws_url / load_connection path.
//
// Exposed as globalThis.MoonSession (same pattern as other vendor helpers).

;(function (globalThis) {
  'use strict';

  /**
   * Resolve the boot route for this window.
   *
   * Resolution order:
   *   1. If panelId is given → get_panel_route(panelId) → that route key.
   *   2. Else → list_routes() → default route key.
   *   3. load_route(key) → RouteInfo { label, key, endpoints[], token_ref,
   *                                    expect?, transport }.
   *
   * Returns a RouteInfo object on success, or null when Tauri is unavailable
   * or no routes are configured (un-migrated / no client.toml).
   *
   * @param {string|null|undefined} panelId  Optional panel identifier.
   * @returns {Promise<RouteInfo|null>}
   */
  async function resolveBootRoute(panelId) {
    const invoke = _invoke();
    if (!invoke) return null;

    try {
      let routeKey = null;

      if (panelId) {
        // Per-panel assignment (C6/C8 territory, but wired now so it works
        // when set_panel_route has been called for this panel).
        const key = await invoke('get_panel_route', { panelId: String(panelId) });
        if (typeof key === 'string' && key) routeKey = key;
      }

      if (!routeKey) {
        // Fall back to the default route.
        const list = await invoke('list_routes');
        if (!list || typeof list.default !== 'string' || !list.default) {
          // list_routes returned nothing useful → no client.toml configured.
          return null;
        }
        routeKey = list.default;
      }

      // Load the full RouteInfo for this key.
      const route = await invoke('load_route', { routeKey });
      if (!route || !Array.isArray(route.endpoints) || route.endpoints.length === 0) {
        return null;
      }
      return route;
    } catch (e) {
      // Any Tauri error (command not found, client.toml parse error, etc.)
      // → degrade to legacy path.
      if (typeof console !== 'undefined') {
        console.warn('[MoonSession] resolveBootRoute failed, falling back to legacy:', e && e.message || e);
      }
      return null;
    }
  }

  /**
   * Resolve the per-panel/per-route last-thread pointer.
   *
   * Returns the stored thread id string if one is available for this panel in
   * moon-session.json, or null when:
   *   • panelId is absent / falsy (unbound — no route context)
   *   • window.__TAURI__ is not present (browser / jsdom dev)
   *   • No entry exists in moon-session.json AND ~/.luna/.last-thread-default
   *     is absent (the Rust side handles the legacy migration transparently)
   *
   * The migration from the legacy global file is handled entirely in Rust
   * (get_panel_last_thread adopts the legacy file on first call and writes the
   * result into the panel slot).  This function just wraps the Tauri command.
   *
   * PINNED windows (?thread=<id>) must NOT call this — they are bound to a
   * single thread via URL param and must not interact with the restart pointer.
   *
   * @param {string|null|undefined} panelId  Panel identifier (window label).
   * @returns {Promise<string|null>}
   */
  async function resolveBootThread(panelId) {
    if (!panelId) return null;
    const invoke = _invoke();
    if (!invoke) return null;
    try {
      const id = await invoke('get_panel_last_thread', { panelId: String(panelId) });
      return (typeof id === 'string' && id) ? id : null;
    } catch (e) {
      if (typeof console !== 'undefined') {
        console.warn('[MoonSession] resolveBootThread failed, returning null:', e && e.message || e);
      }
      return null;
    }
  }

  /**
   * Persist a thread id as the per-panel last-thread pointer in moon-session.json.
   * Also dual-writes the legacy global file for one-release rollback safety.
   *
   * No-op (returns false) outside Tauri or when panelId is absent.
   *
   * @param {string} panelId
   * @param {string} threadId
   * @returns {Promise<boolean>}
   */
  async function setPanelLastThread(panelId, threadId) {
    if (!panelId || !threadId) return false;
    const invoke = _invoke();
    if (!invoke) return false;
    try {
      await invoke('set_panel_last_thread', { panelId: String(panelId), threadId: String(threadId) });
      return true;
    } catch (e) {
      if (typeof console !== 'undefined') {
        console.warn('[MoonSession] setPanelLastThread failed:', e && e.message || e);
      }
      return false;
    }
  }

  /**
   * Assign a specific route to a panel.
   * No-op (returns false) outside Tauri.
   *
   * @param {string} panelId
   * @param {string} routeKey
   * @returns {Promise<boolean>}
   */
  async function setPanelRoute(panelId, routeKey) {
    const invoke = _invoke();
    if (!invoke) return false;
    try {
      await invoke('set_panel_route', { panelId: String(panelId), routeKey: String(routeKey) });
      return true;
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[MoonSession] setPanelRoute failed:', e && e.message || e);
      return false;
    }
  }

  /**
   * List all configured routes.
   * Returns { default: string, routes: RouteSummary[] } or null outside Tauri /
   * when no client.toml exists.
   *
   * @returns {Promise<RouteList|null>}
   */
  async function listRoutes() {
    const invoke = _invoke();
    if (!invoke) return null;
    try {
      return await invoke('list_routes') || null;
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[MoonSession] listRoutes failed:', e && e.message || e);
      return null;
    }
  }

  /**
   * Set the default route key.
   * Returns true on success, false otherwise.
   *
   * @param {string} routeKey
   * @returns {Promise<boolean>}
   */
  async function setDefaultRoute(routeKey) {
    const invoke = _invoke();
    if (!invoke) return false;
    try {
      await invoke('set_default_route', { routeKey: String(routeKey) });
      return true;
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('[MoonSession] setDefaultRoute failed:', e && e.message || e);
      return false;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Returns the Tauri core.invoke function, or null if not in Tauri. */
  function _invoke() {
    if (typeof globalThis.__TAURI__ === 'undefined') return null;
    const core = globalThis.__TAURI__ && globalThis.__TAURI__.core;
    if (!core || typeof core.invoke !== 'function') return null;
    return core.invoke.bind(core);
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  globalThis.MoonSession = {
    resolveBootRoute,
    resolveBootThread,
    setPanelLastThread,
    setPanelRoute,
    listRoutes,
    setDefaultRoute,
  };

}(typeof globalThis !== 'undefined' ? globalThis : this));
