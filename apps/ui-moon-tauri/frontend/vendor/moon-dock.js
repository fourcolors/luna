/**
 * moon-dock.js — minimal native window dragging shared by Moon card windows.
 *
 * Each panel is an independent macOS window. There is deliberately no magnetic
 * docking, cluster towing, overlap correction, snap-on-open, or weld state.
 * The operating system owns the drag from pointer-down until release.
 *
 * Optional redock arming: when `opts.redock` is set on a pinned chat floater,
 * we invoke `begin_redock_drag` BEFORE `startDragging` so Rust can install
 * NSEvent monitors for live dock-preview (insert gap / CSS scale). Window
 * motion itself stays 100% AppKit — never a JS setPosition loop.
 *
 * Usage: LunaDock.wire({ win, label, redock?: { owner, threadId, title? } })
 */
;(function (g) {
  'use strict';

  function isInteractive(target) {
    return !!(target && target.closest && target.closest(
      'button, input, textarea, select, a, [contenteditable="true"], [role="button"]'
    ));
  }

  function wire(opts) {
    var W = opts && opts.win;
    var label = opts && opts.label;
    if (!W || label === 'main') return;

    // The chat keeps its distinct accent title bar; this is appearance only.
    if (label === 'panel-chat') {
      try { g.document.documentElement.setAttribute('data-anchor', 'true'); } catch (_) {}
    }

    var redock = opts && opts.redock;

    g.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || isInteractive(event.target)) return;
      var handle = event.target && event.target.closest &&
        event.target.closest('.title-bar, .chat-header');
      if (!handle || typeof W.startDragging !== 'function') return;

      // Arm native redock tracking first (main-thread NSEvent monitors), then
      // hand the complete motion gesture to AppKit. Order matters: monitors must
      // be live before the drag starts delivering LeftMouseDragged.
      if (redock && g.__TAURI__ && g.__TAURI__.core) {
        try {
          var title = null;
          if (typeof redock.title === 'function') {
            try { title = redock.title(); } catch (_) { title = null; }
          } else if (redock.title != null) {
            title = redock.title;
          }
          g.__TAURI__.core.invoke('begin_redock_drag', {
            ownerLabel: redock.owner,
            threadId: redock.threadId,
            title: title,
          }).catch(function () { /* non-fatal; drag still works */ });
        } catch (_) { /* window chrome must never break the page */ }
      }

      // startDragging hands the complete gesture to AppKit. No pointer-move or
      // release listener is needed for motion — redock end is native-monitored.
      event.preventDefault();
      try {
        var result = W.startDragging();
        if (result && typeof result.catch === 'function') result.catch(function () {});
      } catch (_) { /* window chrome must never break the page */ }
    }, true);
  }

  g.LunaDock = { wire: wire };
})(typeof window !== 'undefined' ? window : globalThis);
