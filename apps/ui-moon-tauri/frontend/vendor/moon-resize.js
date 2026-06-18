/**
 * moon-resize.js — custom resize grips for card windows (chat / panel / widget).
 *
 * macOS borderless/transparent cards can't rely on startResizeDragging, so
 * pointer-driven setSize/setPosition drives resize in all 8 directions. The
 * bottom-right grip shows the L-bracket indicator (board.css pattern); edges
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
    if (!hasTauri() || e.button !== 0) return;
    var hit = e.target.closest('.resize-hit');
    if (!hit) return;
    var dir = hit.getAttribute('data-dir');
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();

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
    };
    try { hit.setPointerCapture(e.pointerId); } catch (_) { /* jsdom */ }
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerup', onUp);
    hit.addEventListener('pointercancel', onUp);
    g.document.documentElement.style.cursor = cursorFor(dir);
  }

  async function onMove(e) {
    if (!active) return;
    var dx = (e.screenX - active.startX) / active.sf;
    var dy = (e.screenY - active.startY) / active.sf;
    var next = applyDir(active, dx, dy);
    try {
      var LP = active.TW.LogicalPosition;
      var LS = active.TW.LogicalSize;
      var moved = next.x !== active.x || next.y !== active.y;
      if (moved) await active.win.setPosition(new LP(next.x, next.y));
      await active.win.setSize(new LS(next.w, next.h));
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
