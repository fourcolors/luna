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
 *   luna_palette  — 'dawn' | 'meadow' | 'tide'              (default 'tide')
 *   luna_theme    — 'light' | 'dark'                        (default 'dark')
 *   luna_chrome   — 'wash' | 'ink'                          (default 'wash')
 *   luna_grain    — 'true' | 'false'                        (default 'false')
 *   luna_font     — 'sans' | 'serif' | 'mono' | 'hand'      (default 'sans')
 *   luna_fontsize — 'small'|'medium'|'large'|'xlarge'       (default 'medium')
 *
 * font / fontsize only re-skin the CHAT surfaces (bubbles + composer) via the
 * --font-chat / --font-scale tokens (vendor/moon-palette.css), never the
 * window chrome — so panel/widget layout never reflows.
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
    skin: 'luna_skin',
    grain: 'luna_grain',
    font: 'luna_font',
    fontSize: 'luna_fontsize',
  };

  var VALID = {
    palette: ['dawn', 'meadow', 'tide'],
    theme: ['light', 'dark'],
    chrome: ['wash', 'ink'],
    skin: ['studio', 'classic', 'aqua'],
    grain: ['true', 'false'],
    font: ['sans', 'serif', 'mono', 'hand'],
    fontSize: ['small', 'medium', 'large', 'xlarge'],
  };

  var DEFAULTS = {
    palette: 'tide',
    theme: 'dark',
    chrome: 'wash',
    skin: 'studio',
    grain: 'false',
    font: 'sans',
    fontSize: 'medium',
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
    var skin = read('skin');
    el.setAttribute('data-skin', skin);
    el.setAttribute('data-grain', read('grain') === 'true' ? 'on' : 'off');
    el.setAttribute('data-font', read('font'));
    el.setAttribute('data-fontsize', read('fontSize'));
    // Native lights are ALWAYS VISIBLE on studio/aqua (native-window model;
    // moon-native-titlebar.js positions them in the card header) and hidden on
    // classic, which uses the CSS faux controls instead. Deferred via
    // syncNativeControls because apply() can run before __TAURI__ is injected.
    // Inert on the orb window (no native buttons).
    syncNativeControls(skin);
    if (g.LunaNativeTitlebar && g.LunaNativeTitlebar.sync) {
      g.LunaNativeTitlebar.sync();
    }
  }

  // Native lights track the skin: visible on studio/aqua (always-on, the
  // native-window model — moon-native-titlebar.js owns positioning), hidden on
  // classic (CSS faux cluster). window.__TAURI__ is injected slightly after
  // the first-paint apply(), so fire immediately if the API is live, else poll
  // briefly until it is.
  var nativeCtlTimer = null;
  function syncNativeControls(skin) {
    var visible = skin !== 'classic';
    function fire() {
      try {
        if (g.__TAURI__ && g.__TAURI__.core) {
          g.__TAURI__.core.invoke('set_native_controls_visible', { visible: visible }).catch(function () {});
          return true;
        }
      } catch (e) { /* never throw from a stamp */ }
      return false;
    }
    if (nativeCtlTimer) { g.clearInterval(nativeCtlTimer); nativeCtlTimer = null; }
    if (fire()) return;
    // __TAURI__ injects shortly after this first-paint stamp, so poll until it
    // is live. Skip the poll only under jsdom (unit tests) so no timer is left
    // running there — real Tauri/WKWebView is never reported as jsdom.
    try { if (/jsdom/i.test((g.navigator && g.navigator.userAgent) || '')) return; } catch (e) {}
    var tries = 0;
    nativeCtlTimer = g.setInterval(function () {
      if (fire() || ++tries > 100) { g.clearInterval(nativeCtlTimer); nativeCtlTimer = null; }
    }, 50);
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
      skin: read('skin'),
      grain: read('grain') === 'true',
      font: read('font'),
      fontSize: read('fontSize'),
    };
  }

  // Another window changed a preference → re-stamp. (e.key === null means
  // localStorage.clear(); re-applying defaults is the right response.)
  g.addEventListener('storage', function (e) {
    if (e.key === null ||
        e.key === KEYS.palette || e.key === KEYS.theme ||
        e.key === KEYS.chrome || e.key === KEYS.skin || e.key === KEYS.grain ||
        e.key === KEYS.font || e.key === KEYS.fontSize) {
      apply();
    }
  });

  apply();

  g.LunaAppearance = { apply: apply, set: set, get: get, KEYS: KEYS, DEFAULTS: DEFAULTS };
})(typeof window !== 'undefined' ? window : globalThis);
