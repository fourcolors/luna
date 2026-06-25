/**
 * moon-resize.js — custom resize grips for card windows (chat / panel / widget).
 *
 * Native resize-drag (Tauri startResizeDragging → tao drag_resize_window) is
 * UNIMPLEMENTED on macOS — the tao impl returns NotSupported and does nothing
 * (Tauri swallows the error, so the call looks like it succeeds). So these
 * transparent, borderless cards drive resize themselves: a pointermove loop reads
 * the cursor and setPosition/setSize's the window. That loop is COALESCED to one
 * update per animation frame (flushResize) so the resized edge tracks the cursor
 * instead of trailing it — the same fix the live drag uses, since the lag came
 * from firing two IPC calls on EVERY pointer-move.
 *
 * The bottom-right grip shows the L-bracket indicator (board.css pattern); edges
 * and other corners are thin hit strips revealed on card hover.
 *
 * Load after moon-dock.js on every widget-page window. No-op outside Tauri.
 */
;(function (g) {
  'use strict';

  var MIN_W = 220;
  var MIN_H = 120;
  var DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'sw', 'se'];

  function hasTauri() {
    return !!(g.__TAURI__ && g.__TAURI__.window && g.__TAURI__.window.getCurrentWindow);
  }

  function ensureLayer() {
    var shell = g.document.querySelector('.widget-shell');
    if (!shell || shell.querySelector('#resize-layer')) return;
    var layer = g.document.createElement('div');
    layer.id = 'resize-layer';
    layer.className = 'resize-layer';
    layer.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < DIRS.length; i++) {
      var dir = DIRS[i];
      var el = g.document.createElement('div');
      el.className = 'resize-hit resize-' + dir + (dir === 'se' ? ' resize-grip' : '');
      el.setAttribute('data-dir', dir);
      el.title = dir === 'se' ? 'Resize' : '';
      layer.appendChild(el);
    }
    shell.appendChild(layer);
    layer.addEventListener('pointerdown', onDown);
  }

  var active = null;

  function cursorFor(dir) {
    if (dir === 'n' || dir === 's') return 'ns-resize';
    if (dir === 'e' || dir === 'w') return 'ew-resize';
    if (dir === 'ne' || dir === 'sw') return 'nesw-resize';
    return 'nwse-resize';
  }

  async function readLogical(win) {
    var sf = 1;
    try { sf = (await win.scaleFactor()) || 1; } catch (_) { /* default */ }
    var pos = await win.outerPosition();
    var size = await win.outerSize();
    return {
      sf: sf,
      x: pos.x / sf,
      y: pos.y / sf,
      w: size.width / sf,
      h: size.height / sf,
    };
  }

  function applyDir(start, dx, dy) {
    var x = start.x;
    var y = start.y;
    var w = start.w;
    var h = start.h;
    var dir = start.dir;

    if (dir.indexOf('e') !== -1) w = Math.max(MIN_W, start.w + dx);
    if (dir.indexOf('w') !== -1) {
      w = Math.max(MIN_W, start.w - dx);
      x = start.x + (start.w - w);
    }
    if (dir.indexOf('s') !== -1) h = Math.max(MIN_H, start.h + dy);
    if (dir.indexOf('n') !== -1) {
      h = Math.max(MIN_H, start.h - dy);
      y = start.y + (start.h - h);
    }
    return { x: x, y: y, w: w, h: h };
  }

  async function onDown(e) {
    // Finding B: ignore a second pointerdown while a resize is already active.
    // A resize is inherently single-pointer; a concurrent down would strand the
    // first gesture's capture and leave orphaned listeners.
    if (active) return;
    if (!hasTauri() || e.button !== 0) return;
    var hit = e.target.closest('.resize-hit');
    if (!hit) return;
    var dir = hit.getAttribute('data-dir');
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();

    // On macOS, hand the WHOLE gesture to Rust (begin_native_resize drives
    // NSWindow.setFrame: from an NSEvent monitor — native speed, no per-frame
    // IPC). tao's startResizeDragging is a no-op there, and the emulated loop
    // below is laggy. Everywhere else we fall through to the emulated path.
    var core = g.__TAURI__ && g.__TAURI__.core;
    var isMac =
      /Mac/i.test((g.navigator && g.navigator.platform) || '') ||
      /Mac OS X/i.test((g.navigator && g.navigator.userAgent) || '');
    if (core && core.invoke && isMac) {
      active = { native: true }; // re-entry guard (onDown returns early if active)
      g.document.documentElement.style.cursor = cursorFor(dir);
      // Suppress per-frame traffic-light sync while the native resize drives
      // setFrame: (moon-native-titlebar.js syncPosition checks this). Sync once
      // on release so the lights settle to the final geometry.
      g.__LUNA_NATIVE_RESIZING__ = true;
      var endUnlisten = null, endDone = false;
      var reset = function () {
        endDone = true;
        g.document.documentElement.style.cursor = '';
        active = null;
        g.__LUNA_NATIVE_RESIZING__ = false;
        try {
          if (g.LunaNativeTitlebar && g.LunaNativeTitlebar.syncPosition) {
            g.LunaNativeTitlebar.syncPosition();
          }
        } catch (_) { /* best-effort */ }
        g.removeEventListener('pointerup', reset, true);
        g.removeEventListener('blur', reset, true);
        if (endUnlisten) { try { endUnlisten(); } catch (_) {} endUnlisten = null; }
      };
      // Primary end signal: Rust's begin_native_resize emits `luna-resize-ended`
      // on its NSEvent-monitor teardown, which fires reliably even when the mouse
      // is released OUTSIDE the window (no webview pointerup/blur then). The
      // pointerup/blur listeners below are the in-window fallback.
      try {
        var win = g.__TAURI__.window && g.__TAURI__.window.getCurrentWindow
          ? g.__TAURI__.window.getCurrentWindow()
          : null;
        var listen = win && typeof win.listen === 'function'
          ? win.listen.bind(win)
          : (g.__TAURI__.event && g.__TAURI__.event.listen);
        if (listen) {
          var ep = listen('luna-resize-ended', function () { reset(); });
          if (ep && ep.then) ep.then(function (u) {
            if (endDone) { try { u(); } catch (_) {} } else { endUnlisten = u; }
          });
        }
      } catch (_) { /* no listener → pointerup/blur fallbacks */ }
      g.addEventListener('pointerup', reset, true);
      g.addEventListener('blur', reset, true);
      core.invoke('begin_native_resize', { direction: dir }).catch(function () {
        reset();
      });
      return;
    }

    var TW = g.__TAURI__.window;
    var win = TW.getCurrentWindow();
    var snap;
    try { snap = await readLogical(win); } catch (_) { return; }

    active = {
      dir: dir,
      win: win,
      TW: TW,
      startX: e.screenX,
      startY: e.screenY,
      x: snap.x,
      y: snap.y,
      w: snap.w,
      h: snap.h,
      sf: snap.sf,
      handle: hit,
      pid: e.pointerId,
      // rAF coalescing: pointermove only stashes the latest screen coords + arms
      // one frame; flushResize does the actual setPosition/setSize once per frame.
      lastX: e.screenX,
      lastY: e.screenY,
      rafPending: false,
    };
    try { hit.setPointerCapture(e.pointerId); } catch (_) { /* jsdom */ }
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerup', onUp);
    hit.addEventListener('pointercancel', onUp);
    g.document.documentElement.style.cursor = cursorFor(dir);
  }

  // pointermove is hot (≤120 Hz). Do NO work here beyond stashing the latest
  // cursor position and arming one rAF — the actual setPosition/setSize runs in
  // flushResize, at most once per painted frame. The old loop fired BOTH IPC calls
  // on EVERY pointer-move, flooding the channel so the edge trailed the cursor.
  function onMove(e) {
    if (!active) return;
    active.lastX = e.screenX;
    active.lastY = e.screenY;
    if (active.rafPending) return;
    active.rafPending = true;
    var raf = g.requestAnimationFrame
      ? function (cb) { g.requestAnimationFrame(cb); }
      : function (cb) { setTimeout(cb, 16); };
    raf(flushResize);
  }

  // The per-frame resize step: compute the new rect from the latest cursor and
  // push it in ONE pair of fire-and-forget calls (awaiting would re-serialize the
  // channel we just unclogged). setPosition before setSize so a w/n drag's moved
  // origin and new size land together; e/s/se grips only change size.
  function flushResize() {
    if (!active) return;
    active.rafPending = false;
    var dx = (active.lastX - active.startX) / active.sf;
    var dy = (active.lastY - active.startY) / active.sf;
    var next = applyDir(active, dx, dy);
    try {
      var LP = active.TW.LogicalPosition;
      var LS = active.TW.LogicalSize;
      var moved = next.x !== active.x || next.y !== active.y;
      if (moved && LP) active.win.setPosition(new LP(next.x, next.y));
      if (LS) active.win.setSize(new LS(next.w, next.h));
    } catch (_) { /* best-effort */ }
  }

  function onUp() {
    if (!active) return;
    var hit = active.handle;
    var pid = active.pid;
    try { hit.releasePointerCapture(pid); } catch (_) {}
    hit.removeEventListener('pointermove', onMove);
    hit.removeEventListener('pointerup', onUp);
    hit.removeEventListener('pointercancel', onUp);
    g.document.documentElement.style.cursor = '';
    active = null;
  }

  function wire() {
    if (!g.document.querySelector('.widget-shell')) return;
    ensureLayer();
  }

  if (g.document && g.document.readyState === 'loading') {
    g.document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  g.LunaResize = { wire: wire };
})(typeof window !== 'undefined' ? window : globalThis);
