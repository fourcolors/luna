/**
 * moon-window-float.js — honors the "Always on Top" preference for panel and
 * widget windows (chat.html / panel.html / widget.html).
 *
 * Panels and screens are created NOT always-on-top (see spawn_panel_at /
 * open_artifact_widget in src-tauri/src/main.rs). This script re-floats them
 * ONLY when the user has explicitly enabled the setting — i.e. it treats an
 * UNSET key as "off". That is the deliberate difference from the orb window
 * (index.html), which reads the same key as default-ON and is therefore left
 * untouched: this script is intentionally NOT loaded by index.html.
 *
 *   luna_always_on_top — "true" | "false"   (UNSET here ⇒ off / not floating)
 *
 * Cross-window sync: the writing window (the settings panel) never receives
 * its own `storage` event, so every OTHER open panel/widget learns about the
 * change here and re-applies live — same pattern as vendor/moon-appearance.js.
 *
 * No Tauri dependency required to load: in jsdom / a plain browser the
 * getCurrentWindow() guard short-circuits, so this is safe everywhere.
 */
;(function () {
  'use strict';

  var KEY = 'luna_always_on_top';

  // UNSET ⇒ false. Only the literal string "true" floats the window.
  function wantsFloat() {
    return localStorage.getItem(KEY) === 'true';
  }

  function apply(enabled) {
    if (!window.__TAURI__ || !window.__TAURI__.window) return;
    try {
      window.__TAURI__.window.getCurrentWindow().setAlwaysOnTop(enabled);
    } catch (e) {
      // Non-fatal: window flag failures must never break the panel UI.
      if (window.console) console.warn('moon-window-float: setAlwaysOnTop failed', e);
    }
  }

  // Apply the persisted value once the window exists.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(wantsFloat()); });
  } else {
    apply(wantsFloat());
  }

  // Live cross-window updates from the settings panel.
  window.addEventListener('storage', function (e) {
    if (!e || e.key !== KEY) return;
    apply(e.newValue === 'true');
  });
})();
