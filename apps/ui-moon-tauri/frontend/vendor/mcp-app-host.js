/**
 * mcp-app-host.js — the CLIENT half of the MCP Apps host (widget-system.md
 * Phase 7, SEP-1865 v1, spec rev 2026-01-26).
 *
 * `LunaMcpHost.host({ frameEl, uri, transport, onError })` turns a sandboxed
 * iframe into an MCP App frame:
 *   1. fetch the app HTML via transport.readResource(uri) (widget.html wires
 *      this to the UI-WS `mcp-resource-read` frame),
 *   2. build the srcdoc via LunaWidgetSandbox.buildMcpSrcdoc — same CSP/
 *      sandbox cage as widgets, but NO luna.* shim (the app brings its own
 *      protocol script),
 *   3. speak the HOST side of MCP Apps JSON-RPC 2.0 over postMessage:
 *        - answer `ui/initialize` (protocolVersion/host/capabilities),
 *        - accept `ui/notifications/initialized`, then push the
 *          spec-required `ui/notifications/tool-input` ({arguments:{}}),
 *        - route `tools/call` through transport.callTool with JSON-RPC
 *          result/error replies,
 *        - reply method-not-found to unknown requests; IGNORE unknown
 *          notifications and malformed messages (per spec),
 *        - trust ONLY e.source === frameEl.contentWindow.
 *
 * Deliberately raw JSON-RPC instead of the official ~3MB app/host SDK: the
 * sandbox CSP forbids network, and this protocol surface is ~100 lines.
 * Dependency-free plain-script IIFE — attaches `LunaMcpHost` to globalThis,
 * same convention as widget-sandbox.js / moon-ws.js.
 */
;(function (g) {
  'use strict';

  var PROTOCOL_VERSION = '2026-01-26';
  var HOST_NAME = 'luna-moon';

  // ── Pure JSON-RPC shape helpers (exported for unit tests) ──────────────
  function isRpc(m) {
    return !!m && typeof m === 'object' && m.jsonrpc === '2.0';
  }
  /** A request: has a method AND a non-null id. */
  function isRpcRequest(m) {
    return isRpc(m) && typeof m.method === 'string' && m.id !== undefined && m.id !== null;
  }
  /** A notification: has a method and NO id. */
  function isRpcNotification(m) {
    return isRpc(m) && typeof m.method === 'string' && (m.id === undefined || m.id === null);
  }

  /**
   * opts:
   *   frameEl   — the sandboxed <iframe> (sandbox attr already set by caller)
   *   uri       — the ui:// resource to render (used to identify the app +,
   *               in fetch mode, to read its HTML)
   *   html      — OPTIONAL inline app HTML. When present (a GENERATED / store-
   *               backed app), the HTML is mounted directly via the generated-
   *               app cage (window.mcp helper) and transport.readResource is
   *               NOT called. When absent (a static / external app), the HTML
   *               is fetched via transport.readResource(uri) into the bare cage.
   *   transport — { readResource(uri) -> Promise<{ok,mimeType?,text?,message?}>,
   *                 callTool(tool, args) -> Promise<{ok,result?,message?}> }
   *               (the transport is already scoped to ONE app, so callTool
   *                takes no appUri — widget.html stamps it on the wire frame)
   *   onError   — optional (message) callback for load failures
   *
   * Returns { dispose } — removes the message listener and inerts all
   * in-flight callbacks (re-render / window teardown).
   */
  function host(opts) {
    opts = opts || {};
    var frameEl = opts.frameEl;
    var uri = opts.uri;
    var inlineHtml = typeof opts.html === 'string' ? opts.html : null;
    var transport = opts.transport;
    var onError = typeof opts.onError === 'function' ? opts.onError : function () {};
    var disposed = false;
    var initializedSeen = false;

    function reply(msg) {
      try {
        if (frameEl.contentWindow) frameEl.contentWindow.postMessage(msg, '*');
      } catch (_) { /* iframe gone */ }
    }

    function onMessage(e) {
      if (disposed) return;
      // Trust boundary: only the rendered app's window — never siblings,
      // never the parent chain, never a detached iframe's stale source.
      if (!frameEl.contentWindow || e.source !== frameEl.contentWindow) return;
      var m = e.data;

      if (isRpcRequest(m)) {
        if (m.method === 'ui/initialize') {
          reply({
            jsonrpc: '2.0',
            id: m.id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              host: { name: HOST_NAME },
              capabilities: { serverTools: {} },
            },
          });
          return;
        }
        if (m.method === 'tools/call') {
          var params = (m.params && typeof m.params === 'object') ? m.params : {};
          var name = typeof params.name === 'string' ? params.name : '';
          var args = params.arguments !== undefined ? params.arguments : {};
          transport.callTool(name, args).then(
            function (res) {
              if (disposed) return;
              if (res && res.ok) {
                reply({ jsonrpc: '2.0', id: m.id, result: res.result !== undefined ? res.result : null });
              } else {
                reply({
                  jsonrpc: '2.0',
                  id: m.id,
                  error: { code: -32000, message: (res && res.message) || 'tool call failed' },
                });
              }
            },
            function () {
              if (disposed) return;
              reply({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'tool call failed' } });
            }
          );
          return;
        }
        // Unknown REQUEST → JSON-RPC method-not-found (requests demand replies).
        reply({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found: ' + m.method } });
        return;
      }

      if (isRpcNotification(m)) {
        if (m.method === 'ui/notifications/initialized' && !initializedSeen) {
          initializedSeen = true;
          // Spec: the host pushes tool-input after init. v1 core apps pull
          // their own data, so the payload is an empty arguments object.
          reply({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: {} } });
        }
        // All other notifications: ignore (spec-sanctioned for unknowns).
        return;
      }
      // Not JSON-RPC 2.0 → ignore (malformed / unrelated postMessage traffic).
    }

    g.addEventListener('message', onMessage);

    var sb = g.LunaWidgetSandbox;

    if (inlineHtml !== null) {
      // GENERATED / store-backed app: HTML is already in hand. Mount it in the
      // generated-app cage (CSP + the window.mcp client helper) — no network
      // fetch. The same-server tool rule + curated allowlist are still enforced
      // server-side on every tools/call (stamped with this app's uri).
      if (!sb || typeof sb.buildGeneratedAppSrcdoc !== 'function') {
        onError('MCP sandbox builder unavailable in this build.');
      } else {
        frameEl.srcdoc = sb.buildGeneratedAppSrcdoc(inlineHtml);
      }
    } else {
      // STATIC / external app: fetch the template, mount in the bare cage (the
      // app brings its own protocol client).
      transport.readResource(uri).then(
        function (res) {
          if (disposed) return;
          if (!res || !res.ok || typeof res.text !== 'string') {
            onError((res && res.message) || ('Could not load MCP app: ' + uri));
            return;
          }
          if (!sb || typeof sb.buildMcpSrcdoc !== 'function') {
            onError('MCP sandbox builder unavailable in this build.');
            return;
          }
          frameEl.srcdoc = sb.buildMcpSrcdoc(res.text);
        },
        function () {
          if (disposed) return;
          onError('Could not load MCP app: ' + uri);
        }
      );
    }

    return {
      dispose: function () {
        disposed = true;
        g.removeEventListener('message', onMessage);
      },
    };
  }

  g.LunaMcpHost = {
    host: host,
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    HOST_NAME: HOST_NAME,
    isRpcRequest: isRpcRequest,
    isRpcNotification: isRpcNotification,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
