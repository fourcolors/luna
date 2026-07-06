/**
 * moon-native-titlebar.js — native macOS traffic lights on card windows
 * (chat / panel / widget), ALWAYS VISIBLE — exactly like a native window.
 *
 * studio + aqua: the native close / minimize / zoom cluster is revealed at
 * boot and stays up. AppKit natively handles everything a real window does:
 * hover glyphs, unfocused greying, the disabled (zoomless) green button.
 * Position is synced from #title-bar geometry (not a static
 * traffic_light_position) so the cluster sits inside the opaque card header,
 * not the transparent margin — and re-synced on resize, weld repaint, skin
 * change and window focus (AppKit re-pins + shrinks its container view on
 * reveal/resize/zoom/focus; without the focus re-sync the lights keep
 * painting but stop hit-testing — "click-dead").
 * classic: inert here — moon-appearance.js hides native lights and the CSS
 * .dock-lights cluster (or chat's faux close/min) takes over.
 *
 * Load AFTER vendor/moon-appearance.js on every widget-page window.
 * No-op outside Tauri and under jsdom (no dangling timers).
 */
;(function (g) {
  'use strict';

  var SKIN_KEY = 'luna_skin';
  /** macOS standard traffic-light diameter (logical px). */
  var LIGHT_H = 12;
  /** Width of the 3-button cluster from the close-button left edge, plus a
   * little slack. macOS spaces the buttons ~20px on-centre; 3 buttons + a
   * diameter ≈ 52px. Kept TIGHT: everything beyond the cluster is normal
   * title bar and must stay grabbable for the window drag (native windows
   * have no dead zone around their lights). */
  var CLUSTER_W = 60;
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

  /** Are the NATIVE lights the active model (studio/aqua)? classic uses the
   * CSS faux cluster instead. */
  function usesNativeLights() {
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
    if (!usesNativeLights()) return Promise.resolve();
    // During a native window resize the shell fires the ResizeObserver every
    // frame; syncing the traffic lights per-frame floods the main thread with
    // IPC + objc2 work that competes with the resize's own setFrame:. Skip
    // while resizing — moon-resize.js fires one sync on release.
    if (g.__LUNA_NATIVE_RESIZING__) return Promise.resolve();
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
    if (!usesNativeLights()) return;
    // Reveal FIRST, then position. Un-hiding makes AppKit re-lay-out the
    // standard buttons to their default top-left CORNER (in the transparent
    // card-inset margin) — so a sync done before the reveal gets clobbered and
    // the lights strand in the buffer. Repositioning AFTER the reveal, plus a
    // next-frame re-sync to beat AppKit's deferred relayout, lands them flush
    // in the card header.
    invokeVisible(true);
    syncPosition();
    g.requestAnimationFrame(function () { syncPosition(); });
    g.setTimeout(syncPosition, 60);
  }

  function hide() {
    invokeVisible(false);
  }

  /**
   * Is the client point (cx, cy) over the native light cluster in the
   * title-bar's top-left? The lights are AppKit views overlaying the webview;
   * a mousedown there must not arm a window drag (moon-dock.js consults this
   * as its drag guard). Kept to the CLUSTER's own footprint — the rest of the
   * bar stays grabbable, same as a native title bar.
   */
  function overLights(cx, cy) {
    // Only meaningful when the native lights are the active model; on classic
    // the corner is faux DOM buttons (no native views to protect), so report
    // false there — this keeps the moon-dock drag guard from carving a dead
    // zone out of the classic title bar.
    if (!usesNativeLights()) return false;
    var bar = g.document && g.document.getElementById('title-bar');
    if (!bar) return false;
    var br = bar.getBoundingClientRect();
    return cy <= br.bottom + 2 && cx <= br.left + CLUSTER_W;
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
    // AppKit re-pins + shrinks the NSTitlebarContainerView when the window
    // becomes key; without re-running the layout the buttons paint but stop
    // hit-testing (clicks fall through to the webview). One sync per focus
    // gain keeps them clickable.
    g.addEventListener('focus', function () {
      if (usesNativeLights()) syncPosition();
    });
    wireResize();
  }

  function sync() {
    wire();
    if (usesNativeLights()) show();
    else hide();
  }

  function boot() {
    wire();
    if (!usesNativeLights()) {
      invokeVisible(false);
      return;
    }
    // __TAURI__ injects slightly after the first-paint script run; reveal as
    // soon as it is live (show() re-syncs after the reveal because un-hiding
    // relays the buttons out to the default corner).
    if (g.__TAURI__ && g.__TAURI__.core) { show(); return; }
    try {
      if (/jsdom/i.test((g.navigator && g.navigator.userAgent) || '')) return;
    } catch (_) { /* ignore */ }
    if (bootTimer) g.clearInterval(bootTimer);
    var tries = 0;
    bootTimer = g.setInterval(function () {
      var live = g.__TAURI__ && g.__TAURI__.core;
      if (live || ++tries > 100) {
        g.clearInterval(bootTimer);
        bootTimer = null;
        if (live) show();
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

  g.LunaNativeTitlebar = { sync: sync, wire: wire, syncPosition: syncPosition, measurePosition: measurePosition, overLights: overLights };
})(typeof window !== 'undefined' ? window : globalThis);
