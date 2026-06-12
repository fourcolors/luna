/**
 * moon-appearance.js — applies the watercolor appearance preferences to the
 * current window and keeps them live across every Luna window.
 *
 * Load AFTER vendor/moon-palette.css, in <head>, so the data attributes are
 * stamped before first paint (no flash of the default palette).
 *
 * Preferences live in localStorage under individual keys (same convention as
 * luna_always_on_top & friends in panels/settings-general.js):
 *
 *   luna_palette — 'dawn' | 'meadow' | 'tide'      (default 'tide')
 *   luna_theme   — 'light' | 'dark'                (default 'dark')
 *   luna_chrome  — 'wash' | 'ink'                  (default 'wash')
 *   luna_grain   — 'true' | 'false'                (default 'false')
 *
 * Cross-window sync: localStorage `storage` events fire in every OTHER
 * window on the same origin — exactly how the hub already learns about
 * settings-panel changes — so a palette change in the Appearance panel
 * re-paints every open widget window live. The WRITING window gets no
 * storage event, so set() also applies locally.
 *
 * No Tauri dependency: safe in jsdom tests and plain browsers.
 */
;(function (g) {
  'use strict';

  var KEYS = {
    palette: 'luna_palette',
    theme: 'luna_theme',
    chrome: 'luna_chrome',
    grain: 'luna_grain',
  };

  var VALID = {
    palette: ['dawn', 'meadow', 'tide'],
    theme: ['light', 'dark'],
    chrome: ['wash', 'ink'],
    grain: ['true', 'false'],
  };

  var DEFAULTS = {
    palette: 'tide',
    theme: 'dark',
    chrome: 'wash',
    grain: 'false',
  };

  // Unknown/corrupt stored values fall back to the default (never throw —
  // localStorage can be unavailable in exotic embeds).
  function read(name) {
    var v = null;
    try { v = g.localStorage.getItem(KEYS[name]); } catch (_) { /* unavailable */ }
    return VALID[name].indexOf(v) !== -1 ? v : DEFAULTS[name];
  }

  function apply() {
    var el = g.document && g.document.documentElement;
    if (!el) return;
    el.setAttribute('data-palette', read('palette'));
    el.setAttribute('data-theme', read('theme'));
    el.setAttribute('data-chrome', read('chrome'));
    el.setAttribute('data-grain', read('grain') === 'true' ? 'on' : 'off');
  }

  function set(name, value) {
    if (!KEYS[name]) return;
    var v = String(value);
    if (VALID[name].indexOf(v) === -1) return;
    try { g.localStorage.setItem(KEYS[name], v); } catch (_) { /* unavailable */ }
    apply();
  }

  function get() {
    return {
      palette: read('palette'),
      theme: read('theme'),
      chrome: read('chrome'),
      grain: read('grain') === 'true',
    };
  }

  // Another window changed a preference → re-stamp. (e.key === null means
  // localStorage.clear(); re-applying defaults is the right response.)
  g.addEventListener('storage', function (e) {
    if (e.key === null ||
        e.key === KEYS.palette || e.key === KEYS.theme ||
        e.key === KEYS.chrome || e.key === KEYS.grain) {
      apply();
    }
  });

  apply();

  g.LunaAppearance = { apply: apply, set: set, get: get, KEYS: KEYS, DEFAULTS: DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
