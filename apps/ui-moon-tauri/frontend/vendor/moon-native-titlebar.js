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
  /** Width of the 3-button cluster from the close-button left edge, plus slack.
   * macOS spaces the buttons ~20px on-centre; 3 buttons + a diameter ≈ 52px,
   * widened so a fast pointer that hands off a few px shy still counts. */
  var CLUSTER_W = 78;
  var leaveTimer = null;
  var barHovered = false;
  /** Tracks the last visibility we asked AppKit for, so the document-level
   * mousemove watcher only does geometry work while the lights are actually up. */
  var lightsVisible = false;
  var docMoveWired = false;
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
    lightsVisible = true;
    // Reveal FIRST, then position. Un-hiding makes AppKit re-lay-out the
    // standard buttons to their default top-left CORNER (in the transparent
    // card-inset margin) — so a sync done before the reveal gets clobbered and
    // the lights strand in the buffer. Repositioning AFTER the reveal, plus a
    // next-frame re-sync to beat AppKit's deferred relayout, lands them flush in
    // the card header.
    invokeVisible(true);
    syncPosition();
    g.requestAnimationFrame(function () { syncPosition(); });
    g.setTimeout(syncPosition, 60);
  }

  function hide() {
    lightsVisible = false;
    invokeVisible(false);
  }

  /**
   * Is the client point (cx, cy) in the title-bar's top-left region where the
   * native lights live? The lights are AppKit views overlaying the webview: when
   * the pointer crosses onto them WebKit fires `#title-bar` mouseleave (it lost
   * the pointer), and hiding there is what makes them "vanish on approach".
   *
   * AppKit may render the cluster at the window's default top-left CORNER (in the
   * transparent card margin, y can be slightly negative) or — when the position
   * sync holds — a little lower in the header. Both are top-left, so we guard the
   * whole top-left band by geometry rather than the exact (and unreliable) synced
   * coordinates: anything at/above the title-bar bottom and within its left edge
   * counts as "reaching for a light".
   */
  function overLights(cx, cy) {
    var bar = g.document && g.document.getElementById('title-bar');
    if (!bar) return false;
    var br = bar.getBoundingClientRect();
    return cy <= br.bottom + 2 && cx <= br.left + CLUSTER_W;
  }

  function scheduleHide() {
    if (leaveTimer) g.clearTimeout(leaveTimer);
    leaveTimer = g.setTimeout(function () {
      leaveTimer = null;
      if (!barHovered) hide();
    }, LEAVE_MS);
  }

  function onEnter() {
    barHovered = true;
    if (leaveTimer) {
      g.clearTimeout(leaveTimer);
      leaveTimer = null;
    }
    show();
  }

  function onLeave(e) {
    barHovered = false;
    // The pointer is heading onto the native lights (which overlay the webview),
    // not away — keep them up so the click lands. The document mousemove watcher
    // re-tucks them once the pointer is genuinely back in the content area.
    if (e && overLights(e.clientX, e.clientY)) return;
    scheduleHide();
  }

  /**
   * Re-tuck the lights once the pointer is back in the page content, clear of
   * the title bar and the cluster. While the pointer sits on a native light the
   * webview gets no events at all, so this never fires there — the lights simply
   * stay up (and clickable) until the user moves on.
   */
  function onDocMove(e) {
    if (!lightsVisible || barHovered) return;
    var bar = g.document && g.document.getElementById('title-bar');
    if (!bar) return;
    var br = bar.getBoundingClientRect();
    if (e.clientY >= br.top && e.clientY <= br.bottom) return; // still on the bar
    if (overLights(e.clientX, e.clientY)) return;
    scheduleHide();
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
    if (!docMoveWired && g.document) {
      docMoveWired = true;
      // Capture so we still see moves that land on inner widgets/iframes.
      g.document.addEventListener('mousemove', onDocMove, true);
      // Lost key status (another window/app, or a native-minimize) — tuck away.
      g.addEventListener('blur', function () { if (lightsVisible) hide(); });
    }
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
