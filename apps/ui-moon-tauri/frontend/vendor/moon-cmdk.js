/**
 * moon-cmdk.js — window-local Cmd+K / Ctrl+K listener that opens the
 * quick-launcher palette.
 *
 * Scope: WINDOW-LOCAL only. This is NOT a Tauri global shortcut — registering
 * a global shortcut (tauri-plugin-global-shortcut → Carbon RegisterEventHotKey)
 * would consume Cmd+K OS-wide, stealing it from Slack/VSCode/terminal for the
 * entire machine. This listener fires only when a Moon window already has focus.
 *
 * Trigger: Cmd+K on macOS, Ctrl+K elsewhere — deliberately NOT both. Ctrl+K is
 * the standard Cocoa emacs binding for kill-to-end-of-line in every macOS text
 * field, including the chat composer; accepting ctrlKey on Darwin would swallow
 * it app-wide. The launcher is already open when this runs inside the launcher
 * panel itself — activating it again is harmless because open_widget's
 * singleton focus logic is idempotent.
 *
 * No-op when window.__TAURI__ is absent (browser dev / jsdom), so this is
 * safe to load unconditionally in every shipping shell.
 *
 * Guard against double-registration: only installs the listener once even if
 * this script is somehow evaluated twice (e.g., duplicate <script> tags in
 * a dev server HMR cycle).
 */
;(function () {
  'use strict';

  if (window.__LUNA_CMDK_REGISTERED__) return;
  window.__LUNA_CMDK_REGISTERED__ = true;

  // navigator.platform is deprecated but is the only SYNCHRONOUS platform read
  // available here; get_platform is an async IPC round-trip and a keydown
  // handler must decide before it can preventDefault. userAgent is the fallback.
  var nav = window.navigator || {};
  var isMac = /Mac|iPhone|iPad|iPod/i.test(nav.platform || nav.userAgent || '');

  document.addEventListener('keydown', function (e) {
    // Mac: Cmd+K only (Ctrl+K is kill-to-end-of-line). Elsewhere: Ctrl+K only.
    if (isMac ? !e.metaKey : !e.ctrlKey) return;
    if (isMac && e.ctrlKey) return;
    if (e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== 'k') return;
    e.preventDefault();

    if (!window.__TAURI__ || !window.__TAURI__.core) return;
    window.__TAURI__.core.invoke('open_widget', { kind: 'launcher' }).catch(function () {});
  });
})();
