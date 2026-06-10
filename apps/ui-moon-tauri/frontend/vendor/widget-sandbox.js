/**
 * widget-sandbox.js — the widget trust boundary (PRD Part C / W4 §16).
 *
 * Generated widgets are AGENT-AUTHORED CODE THAT EXECUTES. They render in a
 * hard sandbox: an `<iframe sandbox="allow-scripts">` (NO allow-same-origin →
 * unique opaque origin, no parent-DOM access, no cookies/storage, no
 * window.__TAURI__) loaded via `srcdoc` (inline — never a network src), with a
 * strict CSP that forbids ALL network by default. The ONLY door out is the
 * `luna.*` bridge, a postMessage channel gated by the widget's `bridge_caps`
 * allowlist (read-only obs-event subscribe in v1).
 *
 * This module is pure + side-effect-free so the sandbox-assembly and the
 * cap-gating — the load-bearing security logic — are unit-testable in
 * isolation. The host (widget.html) wires the actual iframe + postMessage.
 * Exposes `globalThis.LunaWidgetSandbox`.
 */
;(function (g) {
  "use strict"

  // No network: default-src 'none' blocks fetch/XHR/WebSocket/external scripts;
  // inline script+style are allowed (the widget is self-contained); images may
  // come from data:/blob: only. This is the "no network by default" cage.
  var CSP =
    "default-src 'none'; " +
    "script-src 'unsafe-inline'; " +
    "style-src 'unsafe-inline'; " +
    "img-src data: blob:; " +
    "font-src data:; " +
    "connect-src 'none'; " +
    "form-action 'none'; " +
    "base-uri 'none'"

  // The bridge shim, injected into the iframe BEFORE the agent's HTML so
  // `window.luna` exists when the widget's own scripts run. It can ONLY talk to
  // its parent via postMessage — it has no same-origin access to the parent.
  var BRIDGE_SHIM =
    "<script>(function(){" +
    "var subs=[];" +
    "window.addEventListener('message',function(e){" +
    "if(e.source!==window.parent)return;" + // only accept host→widget messages
    "var m=e.data;" +
    "if(m&&m.__luna==='event'){subs.forEach(function(cb){try{cb(m.event)}catch(_){}});}" +
    "});" +
    "window.luna={" +
    "subscribe:function(kinds,cb){" +
    "if(typeof kinds==='function'){cb=kinds;kinds=['*'];}" +
    "if(typeof cb!=='function')return function(){};" +
    "subs.push(cb);" +
    "window.parent.postMessage({__luna:'subscribe',kinds:kinds||['*']},'*');" +
    "return function(){var i=subs.indexOf(cb);if(i>=0)subs.splice(i,1);};" +
    "}," +
    "refresh:function(){window.parent.postMessage({__luna:'refresh'},'*');}," +
    "ready:function(){window.parent.postMessage({__luna:'ready'},'*');}" +
    "};" +
    "})();<\/script>"

  /**
   * Assemble the full srcdoc string for a widget artifact: strict CSP meta +
   * the luna bridge shim + the agent-authored HTML body. The host sets this as
   * the iframe's `srcdoc` with `sandbox="allow-scripts"` (no allow-same-origin).
   */
  function buildSrcdoc(html) {
    var body = typeof html === "string" ? html : ""
    return (
      "<!doctype html><html><head>" +
      '<meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' +
      CSP +
      '">' +
      "</head><body>" +
      BRIDGE_SHIM +
      body +
      "</body></html>"
    )
  }

  /**
   * Does this widget's bridge_caps allowlist permit subscribing to an obs-event
   * of `kind`? Caps are entries like "obs:ToolCall" or the wildcard "obs:*".
   * FAILS CLOSED: null/empty/garbage caps permit nothing.
   */
  function subscribeAllowed(bridgeCaps, kind) {
    if (!Array.isArray(bridgeCaps) || bridgeCaps.length === 0) return false
    if (typeof kind !== "string" || kind.length === 0) return false
    return (
      bridgeCaps.indexOf("obs:*") !== -1 ||
      bridgeCaps.indexOf("obs:" + kind) !== -1
    )
  }

  /** The sandbox attribute the host MUST use. Centralised so a test can pin it
   *  — adding "allow-same-origin" here would be a sandbox escape. */
  var SANDBOX_ATTR = "allow-scripts"

  g.LunaWidgetSandbox = {
    buildSrcdoc: buildSrcdoc,
    subscribeAllowed: subscribeAllowed,
    SANDBOX_ATTR: SANDBOX_ATTR,
    CSP: CSP,
  }
})(typeof globalThis !== "undefined" ? globalThis : this)
