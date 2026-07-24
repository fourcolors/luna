/**
 * moon-dock.js — minimal native window dragging shared by Moon card windows.
 *
 * Each panel is an independent macOS window. There is deliberately no magnetic
 * docking, cluster towing, overlap correction, snap-on-open, or weld state.
 * The operating system owns the drag from pointer-down until release.
 *
 * Optional redock arming: when `opts.redock` is set on a pinned chat floater,
 * we await `begin_redock_drag` BEFORE `startDragging` so NSEvent monitors are
 * live before AppKit takes the gesture. Window motion stays 100% AppKit —
 * never a JS setPosition loop, never CSS scale of .widget-shell (breaks
 * native traffic lights).
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
    var dragArming = false;

    g.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || isInteractive(event.target)) return;
      var handle = event.target && event.target.closest &&
        event.target.closest('.title-bar, .chat-header');
      if (!handle || typeof W.startDragging !== 'function') return;
      if (dragArming) return;

      // Prevent the webview from also selecting/dragging content.
      event.preventDefault();

      var startNative = function () {
        dragArming = false;
        try {
          var result = W.startDragging();
          if (result && typeof result.catch === 'function') result.catch(function () {});
        } catch (_) { /* window chrome must never break the page */ }
      };

      // Arm native redock tracking first, then hand motion to AppKit.
      // Awaiting prevents the race where the move loop starts before monitors.
      if (redock && g.__TAURI__ && g.__TAURI__.core) {
        dragArming = true;
        var title = null;
        if (typeof redock.title === 'function') {
          try { title = redock.title(); } catch (_) { title = null; }
        } else if (redock.title != null) {
          title = redock.title;
        }
        Promise.resolve(
          g.__TAURI__.core.invoke('begin_redock_drag', {
            ownerLabel: redock.owner,
            threadId: redock.threadId,
            title: title,
          })
        ).then(startNative, startNative);
        return;
      }

      startNative();
    }, true);
  }

  g.LunaDock = { wire: wire };
})(typeof window !== 'undefined' ? window : globalThis);
