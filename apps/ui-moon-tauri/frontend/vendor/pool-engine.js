/**
 * pool-engine.js — Phase 2 C6b: PoolEngine helper (DARK, additive)
 *
 * Extractable, unit-testable logic for the PoolEngine connection layer.
 * The inline PoolEngine object in chat.html delegates its frame-tag gating
 * and generation-counter utilities to helpers defined here so they can be
 * exercised without loading the full chat.html DOM.
 *
 * Exposed as globalThis.PoolEngineHelper (same pattern as other vendor
 * helpers — plain IIFE, no build step).
 *
 * DARK FLAG: this file is only meaningful when `luna_pool_engine==='1'` is
 * set in localStorage, or `window.__LUNA_POOL_ENGINE === true`. The default
 * engine (WebSocketEngine) is completely unaffected when the flag is off.
 */
;(function (g) {
  'use strict';

  // ── Generation counter ─────────────────────────────────────────────────────
  //
  // Gen-gating mirrors the `fix-6` mechanism in WebSocketEngine: each acquire()
  // call on PoolEngine bumps a generation; any frame or connection-state
  // callback captured during an earlier acquire() is dropped when it fires
  // after a newer acquire() has superseded it.

  /**
   * Create a fresh generation counter.
   * Returns an object with:
   *   bump()   — increment and return the new generation number
   *   current  — getter for the current value
   *   gate(g)  — true when g === current (frame passes the gate)
   */
  function createGenCounter() {
    var _gen = 0;
    return {
      bump: function () { return ++_gen; },
      get current() { return _gen; },
      gate: function (g) { return g === _gen; },
    };
  }

  // ── Frame-tag isolation ────────────────────────────────────────────────────
  //
  // C9-partial / cross-route isolation scaffold: every inbound frame is tagged
  // with the routeKey of this engine's sole adapter before dispatch. At the
  // single-adapter PoolEngine layer the gate is a pass-through — a frame from
  // this engine's only adapter is always from this route, so re-tagging it with
  // `routeKey` and then comparing to `routeKey` trivially passes.
  //
  // TRUE cross-route isolation (dropping a frame whose ORIGIN route differs from
  // the expected route) is enforced at C8 (the hub), where multiple adapters feed
  // one dispatch and the ADAPTER stamps the origin before any re-tag.
  // TODO(C8): enforce origin-routeKey isolation at the hub.
  //
  // The tag + gate scaffold ships now so the hub can build on it without touching
  // PoolEngine's frame path.

  /**
   * Tag a frame with a routeKey (non-destructive — original frame untouched).
   * Returns a new object: { ...frame, __routeKey: routeKey }.
   */
  function tagFrame(frame, routeKey) {
    // Shallow-copy: frame objects are plain POJOs from JSON.parse, no prototype.
    var tagged = Object.assign({}, frame);
    tagged.__routeKey = routeKey;
    return tagged;
  }

  /**
   * Gate check: should this tagged frame be dispatched for the given routeKey?
   * Returns true if the frame's __routeKey matches OR __routeKey is absent
   * (untagged legacy frames — treated as pass-through so old paths don't break).
   */
  function framePassesGate(taggedFrame, expectedRouteKey) {
    if (taggedFrame.__routeKey === undefined) return true;
    return taggedFrame.__routeKey === expectedRouteKey;
  }

  /**
   * Build a dispatch function that tags + gate-checks frames before
   * forwarding them to the provided `dispatch` function (e.g. MoonFrames.dispatch).
   *
   * Single-adapter pass-through: at the PoolEngine layer every frame comes from
   * this engine's own adapter, so tagFrame always stamps `routeKey` and the gate
   * always passes. True cross-route blocking is a C8/hub concern.
   *
   * Usage:
   *   const dispatch = makeGatedDispatch('luna-ws://127.0.0.1:4753/ui', MoonFrames.dispatch);
   *   adapter.subscribeFrames((rawFrame) => dispatch(rawFrame));
   *
   * @param {string} routeKey   The key this gated dispatcher owns.
   * @param {function} dispatch The downstream dispatch function.
   * @returns {function}        A function (rawFrame) → void.
   */
  function makeGatedDispatch(routeKey, dispatch) {
    return function gatedDispatch(rawFrame) {
      var tagged = tagFrame(rawFrame, routeKey);
      if (!framePassesGate(tagged, routeKey)) return;
      dispatch(tagged);
    };
  }

  // ── Connection-state mapping ───────────────────────────────────────────────
  //
  // LunaWsAdapter publishes { status } objects via subscribeConnection.
  // Map these to the status strings WebSocketEngine.updateStatus uses
  // so the UI is identical whether the legacy or pool path is active.

  /**
   * Map a LunaWsAdapter connection state to { statusClass, text }.
   * @param {{ status: string, reason?: string }} connState
   * @returns {{ statusClass: string, text: string }}
   */
  function mapAdapterConnState(connState) {
    switch (connState.status) {
      case 'connecting':
        return { statusClass: 'connecting', text: 'Connecting…' };
      case 'ready':
        return { statusClass: 'connected', text: 'Connected' };
      case 'recovering':
        return { statusClass: 'connecting', text: 'Reconnecting…' };
      case 'down':
        return { statusClass: 'disconnected', text: 'Disconnected' };
      case 'auth-failed':
        return { statusClass: 'disconnected', text: 'Auth failed' };
      case 'handshake-timeout':
        return { statusClass: 'disconnected', text: 'Timeout' };
      default:
        return { statusClass: 'disconnected', text: 'Disconnected' };
    }
  }

  // ── Dark-flag reader ───────────────────────────────────────────────────────

  /**
   * Returns true when the pool engine dark flag is active.
   * Two surfaces:
   *   localStorage.getItem('luna_pool_engine') === '1'
   *   window.__LUNA_POOL_ENGINE === true
   */
  function isDarkFlagSet() {
    try {
      if (typeof g !== 'undefined' && g.__LUNA_POOL_ENGINE === true) return true;
      // Access localStorage via `g` (the IIFE's globalThis) so that test
      // harnesses that inject a stub onto `g` are seen correctly.
      var ls = (typeof g !== 'undefined' && g.localStorage) ||
               (typeof localStorage !== 'undefined' ? localStorage : null);
      if (ls && ls.getItem('luna_pool_engine') === '1') return true;
    } catch (_) { /* localStorage may be unavailable in some environments */ }
    return false;
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  g.PoolEngineHelper = {
    createGenCounter: createGenCounter,
    tagFrame: tagFrame,
    framePassesGate: framePassesGate,
    makeGatedDispatch: makeGatedDispatch,
    mapAdapterConnState: mapAdapterConnState,
    isDarkFlagSet: isDarkFlagSet,
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
