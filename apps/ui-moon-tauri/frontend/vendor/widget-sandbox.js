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

  // A passive, capability-FREE theme shim injected into the MCP-app cages
  // (buildMcpSrcdoc + buildGeneratedAppSrcdoc). It listens for the host's
  // SEP-1865 style variables — carried on the ui/initialize result and on every
  // ui/notifications/host-context-changed — and applies them to documentElement
  // so var(--color-background-primary)/var(--color-ring-primary)/… inherit Luna's
  // theme. It sends NOTHING, opens no network, and references neither window.luna
  // nor window.mcp: it grants NO capability, only mirrors host-provided CSS custom
  // properties — so ANY hosted app (incl. a third party's) themes with zero author
  // code. The trust check (e.source===window.parent) means only the host can feed it.
  var THEME_SHIM =
    "<script>(function(){" +
    "function apply(s){" +
    "if(!s||typeof s!=='object')return;" +
    "var v=s.variables||s;" +
    "if(!v||typeof v!=='object')return;" +
    "var r=document.documentElement;" +
    "for(var k in v){if(Object.prototype.hasOwnProperty.call(v,k)&&typeof v[k]==='string'){try{r.style.setProperty(k,v[k]);}catch(_){}}}" +
    "}" +
    "window.addEventListener('message',function(e){" +
    "if(e.source!==window.parent)return;" +
    "var m=e.data; if(!m||m.jsonrpc!=='2.0')return;" +
    "if(m.result&&m.result.styles){apply(m.result.styles);}" +
    "else if(m.method==='ui/notifications/host-context-changed'&&m.params){apply(m.params.styles);}" +
    "});" +
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
   * Assemble the srcdoc for an MCP APP (widget-system.md Phase 7): same
   * strict CSP and the same sandbox attribute as buildSrcdoc, but NO luna.*
   * bridge shim — an MCP app brings its own protocol script and speaks raw
   * MCP Apps JSON-RPC over postMessage with the host (vendor/mcp-app-host.js).
   * Injecting the shim here would hand every third-party app a second,
   * cap-gated door it was never granted. Used for STATIC / external apps that
   * ship a spec-compliant protocol client of their own.
   */
  function buildMcpSrcdoc(html) {
    var body = typeof html === "string" ? html : ""
    return (
      "<!doctype html><html><head>" +
      '<meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' +
      CSP +
      '">' +
      "</head><body>" +
      THEME_SHIM +
      body +
      "</body></html>"
    )
  }

  // A tiny MCP Apps CLIENT helper, injected into GENERATED app cages so a
  // Luna-authored app can `await window.mcp.call('tool', args)` instead of
  // hand-rolling JSON-RPC. It grants NO new capability: a generated app could
  // already postMessage a tools/call to the host — this just drives the spec
  // handshake (ui/initialize → initialized) and correlates request ids. The
  // real enforcement stays server-side (the curated read-only allowlist keyed
  // on the app's appUri). Talks ONLY to window.parent (the host), same opaque-
  // origin boundary as the luna.* shim.
  var MCP_CLIENT_SHIM =
    "<script>(function(){" +
    "var seq=0,pending={};" +
    "function post(m){try{window.parent.postMessage(m,'*');}catch(_){}}" +
    "window.addEventListener('message',function(e){" +
    "if(e.source!==window.parent)return;" +
    "var m=e.data; if(!m||m.jsonrpc!=='2.0')return;" +
    "if(m.id!=null&&pending[m.id]){var p=pending[m.id];delete pending[m.id];" +
    "if(m.error){p.reject(new Error((m.error&&m.error.message)||'tool error'));}" +
    "else{p.resolve(m.result);}}" +
    "});" +
    "function call(name,args){return new Promise(function(res,rej){" +
    "var id='c'+(++seq);pending[id]={resolve:res,reject:rej};" +
    "post({jsonrpc:'2.0',id:id,method:'tools/call',params:{name:name,arguments:args||{}}});" +
    "});}" +
    "var ready=new Promise(function(res){" +
    "pending['init']={resolve:function(){post({jsonrpc:'2.0',method:'ui/notifications/initialized'});res();},reject:function(){res();}};" +
    "post({jsonrpc:'2.0',id:'init',method:'ui/initialize',params:{protocolVersion:'2026-01-26',capabilities:{}}});" +
    "});" +
    "window.mcp={ready:ready,call:function(n,a){return ready.then(function(){return call(n,a);});}};" +
    "})();<\/script>"

  /**
   * Assemble the srcdoc for a GENERATED MCP app (describe-to-spawn / Apps
   * panel). Same cage as buildMcpSrcdoc PLUS the `window.mcp` client helper, so
   * the agent/user only writes the visual app and calls `window.mcp.call(...)`.
   * Distinct from buildMcpSrcdoc on purpose: external apps bring their own
   * protocol client and must NOT get a second one injected.
   */
  function buildGeneratedAppSrcdoc(html) {
    var body = typeof html === "string" ? html : ""
    return (
      "<!doctype html><html><head>" +
      '<meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="' +
      CSP +
      '">' +
      "</head><body>" +
      THEME_SHIM +
      MCP_CLIENT_SHIM +
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
    buildMcpSrcdoc: buildMcpSrcdoc,
    buildGeneratedAppSrcdoc: buildGeneratedAppSrcdoc,
    subscribeAllowed: subscribeAllowed,
    SANDBOX_ATTR: SANDBOX_ATTR,
    CSP: CSP,
  }
})(typeof globalThis !== "undefined" ? globalThis : this)
