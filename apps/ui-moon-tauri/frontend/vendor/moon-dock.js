/**
 * moon-dock.js — minimal native window dragging shared by Moon card windows.
 *
 * Each panel is an independent macOS window. There is deliberately no magnetic
 * docking, cluster towing, overlap correction, snap-on-open, or weld state.
 * The operating system owns the drag from pointer-down until release.
 *
 * Usage: LunaDock.wire({ win: getCurrentWindow(), label: win.label })
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

    g.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || isInteractive(event.target)) return;
      var handle = event.target && event.target.closest &&
        event.target.closest('.title-bar, .chat-header');
      if (!handle || typeof W.startDragging !== 'function') return;

      // startDragging hands the complete gesture to AppKit. No pointer-move or
      // release listener is needed because Moon has no post-drag snap phase.
      event.preventDefault();
      try {
        var result = W.startDragging();
        if (result && typeof result.catch === 'function') result.catch(function () {});
      } catch (_) { /* window chrome must never break the page */ }
    }, true);
  }

  g.LunaDock = { wire: wire };
})(typeof window !== 'undefined' ? window : globalThis);
