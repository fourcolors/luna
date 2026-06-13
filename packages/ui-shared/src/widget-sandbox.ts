/**
 * widget-sandbox.ts — the widget trust boundary (PRD Part C / W4 §16), shared.
 *
 * Generated widgets are AGENT-AUTHORED CODE THAT EXECUTES. They render in a
 * hard sandbox: an `<iframe sandbox="allow-scripts">` (NO allow-same-origin →
 * unique opaque origin: no parent-DOM access, no cookies/storage, no
 * window.__TAURI__) loaded via `srcdoc` (inline — never a network src), with a
 * strict CSP that forbids ALL network by default. The ONLY door out is the
 * `luna.*` bridge, a postMessage channel gated by the widget's `bridge_caps`
 * allowlist (read-only obs-event subscribe in v1).
 *
 * This is the ES-module source of truth consumed by the WEB client (ui-web via
 * ui-shared-solid). Moon cannot import ES (its frontend is raw <script src>
 * vendored IIFE), so it keeps apps/ui-moon-tauri/frontend/vendor/widget-sandbox.js;
 * `widget-sandbox.parity.test.ts` asserts the two produce BYTE-IDENTICAL output
 * so the security cage can never drift between the two clients.
 *
 * Pure + side-effect-free: the sandbox-assembly and the cap-gating — the
 * load-bearing security logic — are unit-testable in isolation. The host wires
 * the actual iframe + postMessage.
 */

// No network: default-src 'none' blocks fetch/XHR/WebSocket/external scripts;
// inline script+style are allowed (the widget is self-contained); images may
// come from data:/blob: only. This is the "no network by default" cage.
export const CSP =
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
const BRIDGE_SHIM =
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
export function buildSrcdoc(html: string): string {
  const body = typeof html === "string" ? html : ""
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
 * Assemble the srcdoc for a plain HTML doc / external MCP app: same strict CSP
 * and the same sandbox attribute as buildSrcdoc, but NO luna.* bridge shim — a
 * plain HTML preview is static content, and an external MCP app brings its own
 * protocol script. Injecting the shim here would hand it a door it was never
 * granted.
 */
export function buildMcpSrcdoc(html: string): string {
  const body = typeof html === "string" ? html : ""
  return (
    "<!doctype html><html><head>" +
    '<meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    CSP +
    '">' +
    "</head><body>" +
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
const MCP_CLIENT_SHIM =
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
 * Assemble the srcdoc for a GENERATED MCP app (describe-to-spawn / Apps panel).
 * Same cage as buildMcpSrcdoc PLUS the `window.mcp` client helper, so the
 * agent/user only writes the visual app and calls `window.mcp.call(...)`.
 */
export function buildGeneratedAppSrcdoc(html: string): string {
  const body = typeof html === "string" ? html : ""
  return (
    "<!doctype html><html><head>" +
    '<meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    CSP +
    '">' +
    "</head><body>" +
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
export function subscribeAllowed(
  bridgeCaps: ReadonlyArray<string> | null | undefined,
  kind: string,
): boolean {
  if (!Array.isArray(bridgeCaps) || bridgeCaps.length === 0) return false
  if (typeof kind !== "string" || kind.length === 0) return false
  return (
    bridgeCaps.indexOf("obs:*") !== -1 ||
    bridgeCaps.indexOf("obs:" + kind) !== -1
  )
}

/** The sandbox attribute the host MUST use. Centralised so a test can pin it —
 *  adding "allow-same-origin" here would be a sandbox escape. */
export const SANDBOX_ATTR = "allow-scripts"
