/**
 * moon-ws.js — shared UI-WS client core for Moon host pages.
 *
 * Two pieces, separately adoptable:
 *
 *  - createFrameRegistry(): a frame-type → handler map replacing hard-wired
 *    switch statements. The hub (index.html) adopts this while keeping its
 *    bespoke transport (turn watchdogs stay put until the chat extraction).
 *
 *  - createClient(): a minimal generation-gated WebSocket client for the
 *    widget-page family (widget.html today; panel.html / chat.html later).
 *    Token-in-query, JSON frames, optional automatic ping→pong, close hooks
 *    (the seam that lets secret-wipe policies travel with whichever window
 *    hosts the inputs).
 *
 * Plain-script IIFE (no build step) — attaches `LunaWS` to globalThis, same
 * convention as the other dependency-free vendor modules.
 */
(function (g) {
  'use strict';

  function createFrameRegistry() {
    var handlers = Object.create(null);
    return {
      /** Register a handler for a frame type. Last registration wins. Chainable. */
      register: function (type, fn) {
        handlers[type] = fn;
        return this;
      },
      /** Dispatch a frame. Returns true when a handler ran, false otherwise. */
      dispatch: function (frame) {
        if (!frame || typeof frame.type !== 'string') return false;
        var fn = handlers[frame.type];
        if (!fn) return false;
        fn(frame);
        return true;
      },
      has: function (type) {
        return !!handlers[type];
      },
    };
  }

  /**
   * opts:
   *   registry   — frame registry; unmatched frames go to onUnhandled (if set)
   *   autoPong   — reply {type:'pong', ts} to {type:'ping'} before dispatch
   *   onOpen / onClose / onError / onUnhandled — optional callbacks
   *
   * connect() throws synchronously if the WebSocket constructor throws —
   * callers own that surface (widget.html shows a notice).
   *
   * Generation gating: each connect() supersedes the previous socket; the
   * old socket's late async events (which cannot be detached once added via
   * addEventListener) are ignored. Close hooks run on every real close of
   * the CURRENT socket, before onClose.
   */
  function createClient(opts) {
    opts = opts || {};
    var gen = 0;
    var ws = null;
    var closeHooks = [];

    function connect(wsUrl, wsToken) {
      var myGen = ++gen;
      if (ws) {
        try { ws.close(); } catch (_) { /* already dead */ }
        ws = null;
      }
      var fullUrl = g.LunaProtocol
        ? g.LunaProtocol.buildWsUrl(wsUrl, wsToken)
        : wsUrl;
      var sock = new WebSocket(fullUrl); // may throw — caller handles
      ws = sock;

      sock.addEventListener('open', function () {
        if (myGen !== gen) return;
        if (opts.onOpen) opts.onOpen();
      });

      sock.addEventListener('message', function (evt) {
        if (myGen !== gen) return;
        var frame;
        try { frame = JSON.parse(evt.data); } catch (_) { return; }
        if (opts.autoPong && frame && frame.type === 'ping') {
          try { sock.send(JSON.stringify({ type: 'pong', ts: frame.ts })); } catch (_) { /* racing close */ }
          return;
        }
        var handled = opts.registry ? opts.registry.dispatch(frame) : false;
        if (!handled && opts.onUnhandled) opts.onUnhandled(frame);
      });

      sock.addEventListener('close', function (evt) {
        if (myGen !== gen) return;
        for (var i = 0; i < closeHooks.length; i++) {
          try { closeHooks[i](evt); } catch (_) { /* a hook must never block recovery */ }
        }
        if (opts.onClose) opts.onClose(evt);
      });

      sock.addEventListener('error', function () {
        if (myGen !== gen) return;
        if (opts.onError) opts.onError();
      });

      return sock;
    }

    function send(frame) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(frame));
          return true;
        } catch (_) {
          return false;
        }
      }
      return false;
    }

    function close() {
      gen++; // silence the doomed socket's late events
      if (ws) {
        try { ws.close(); } catch (_) { /* already dead */ }
        ws = null;
      }
    }

    return {
      connect: connect,
      send: send,
      close: close,
      registerCloseHook: function (fn) { closeHooks.push(fn); },
      socket: function () { return ws; },
    };
  }

  g.LunaWS = {
    createFrameRegistry: createFrameRegistry,
    createClient: createClient,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
