/**
 * moon-native-titlebar.js — Antinote-style native macOS traffic lights on card
 * windows (chat / panel / widget).
 *
 * studio + aqua: native close / minimize / zoom stay hidden until the user
 * hovers the #title-bar; they hide again on leave (short grace so clicks land).
 * Position is synced from #title-bar geometry (not a static traffic_light_position)
 * so the cluster sits inside the opaque card header, not the transparent margin.
 * classic: inert here — moon-appearance.js hides native lights and the CSS
 * .dock-lights cluster (or chat's faux close/min) takes over.
 *
 * Load AFTER vendor/moon-appearance.js on every widget-page window.
 * No-op outside Tauri and under jsdom (no dangling timers).
 */
;(function (g) {
  'use strict';

  var SKIN_KEY = 'luna_skin';
  var LEAVE_MS = 180;
  /** macOS standard traffic-light diameter (logical px). */
  var LIGHT_H = 12;
  var leaveTimer = null;
  var barHovered = false;
  var wired = false;
  var resizeWired = false;
  var bootTimer = null;

  function readSkin() {
    try {
      var v = g.localStorage.getItem(SKIN_KEY);
      if (v === 'classic' || v === 'studio' || v === 'aqua') return v;
    } catch (_) { /* unavailable */ }
    return 'studio';
  }

  function usesNativeHover() {
    return readSkin() !== 'classic';
  }

  function invokeVisible(visible) {
    try {
      if (g.__TAURI__ && g.__TAURI__.core) {
        g.__TAURI__.core.invoke('set_native_controls_visible', { visible: !!visible }).catch(function () {});
        return true;
      }
    } catch (_) { /* never throw from chrome */ }
    return false;
  }

  /** @returns {{ x: number, y: number } | null} */
  function measurePosition() {
    var doc = g.document;
    if (!doc) return null;
    var bar = doc.getElementById('title-bar');
    if (!bar) return null;
    var anchor = bar.querySelector('.bar-start') || bar;
    var r = anchor.getBoundingClientRect();
    if (!r.width && !r.height) {
      r = bar.getBoundingClientRect();
    }
    return {
      x: Math.round(r.left),
      y: Math.round(r.top + Math.max(0, (r.height - LIGHT_H) / 2)),
    };
  }

  function syncPosition() {
    if (!usesNativeHover()) return Promise.resolve();
    var pos = measurePosition();
    if (!pos) return Promise.resolve();
    try {
      if (g.__TAURI__ && g.__TAURI__.core) {
        return g.__TAURI__.core.invoke('sync_traffic_light_position', pos).catch(function () {});
      }
    } catch (_) { /* never throw from chrome */ }
    return Promise.resolve();
  }

  function show() {
    if (!usesNativeHover()) return;
    syncPosition().then(function () { invokeVisible(true); });
  }

  function hide() {
    invokeVisible(false);
  }

  function onEnter() {
    barHovered = true;
    if (leaveTimer) {
      g.clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    show();
  }

  function onLeave() {
    barHovered = false;
    if (leaveTimer) g.clearTimeout(leaveTimer);
    leaveTimer = g.setTimeout(function () {
      leaveTimer = null;
      if (!barHovered) hide();
    }, LEAVE_MS);
  }

  function wireResize() {
    if (resizeWired || !g.ResizeObserver) return;
    var bar = g.document && g.document.getElementById('title-bar');
    if (!bar) return;
    resizeWired = true;
    var ro = new g.ResizeObserver(function () { syncPosition(); });
    ro.observe(bar);
    var shell = g.document.querySelector('.widget-shell');
    if (shell) ro.observe(shell);
    g.addEventListener('resize', function () { syncPosition(); });
  }

  function wire() {
    var bar = g.document && g.document.getElementById('title-bar');
    if (!bar || wired) return;
    wired = true;
    bar.addEventListener('mouseenter', onEnter);
    bar.addEventListener('mouseleave', onLeave);
    wireResize();
  }

  function sync() {
    wire();
    hide();
    syncPosition();
  }

  function boot() {
    sync();
    if (!usesNativeHover()) return;
    if (invokeVisible(false)) return;
    try {
      if (/jsdom/i.test((g.navigator && g.navigator.userAgent) || '')) return;
    } catch (_) { /* ignore */ }
    if (bootTimer) g.clearInterval(bootTimer);
    var tries = 0;
    bootTimer = g.setInterval(function () {
      if (invokeVisible(false) || ++tries > 100) {
        g.clearInterval(bootTimer);
        bootTimer = null;
        syncPosition();
      }
    }, 50);
  }

  g.addEventListener('storage', function (e) {
    if (e.key === null || e.key === SKIN_KEY) sync();
  });

  if (g.document && g.document.readyState === 'loading') {
    g.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  g.LunaNativeTitlebar = { sync: sync, wire: wire, syncPosition: syncPosition, measurePosition: measurePosition };
})(typeof window !== 'undefined' ? window : globalThis);
