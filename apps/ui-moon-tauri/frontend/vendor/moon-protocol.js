/**
 * moon-protocol.js — the client half of the UI-WS protocol seam.
 *
 * Mirrors packages/ui-ws/src/protocol.ts (UI_WS_PROTOCOL_VERSION and the
 * HelloFrame `capabilities` shape). This file is the ONLY place client pages
 * encode protocol literals; it must stay free of anything server-specific so
 * the server behind the protocol remains swappable.
 *
 * Plain-script IIFE (no build step) — attaches `LunaProtocol` to globalThis,
 * same convention as the other dependency-free vendor modules.
 */
(function (g) {
  'use strict';

  // Bump in lockstep with UI_WS_PROTOCOL_VERSION in packages/ui-ws.
  var PROTOCOL_VERSION = 2;

  /**
   * Normalize a hello frame's capability flags. Every flag is additive and
   * fail-closed: absent capabilities (older servers) coerce to false, so
   * feature gates degrade instead of throwing.
   */
  function parseHelloCapabilities(frame) {
    var c = (frame && frame.capabilities) || {};
    return {
      turnComplete: !!c.turnComplete,
      skills: !!c.skills,
      connectors: !!c.connectors,
      artifacts: !!c.artifacts,
      workflows: !!c.workflows,
      vault: !!c.vault,
      mcpApps: !!c.mcpApps,
      // Subagents (chat-subagents): the server tags subagent activity with
      // parentToolUseId and the Agents panel reads broadcast subagent-tree
      // frames. Absent on older servers → false.
      subagents: !!c.subagents,
      // model+effort switcher (§1 wire contract): server advertises effort
      // selection support via this capability; absent on older servers → false.
      effortSelection: !!c.effortSelection,
      // model-routing settings (PR 1): server sends model-routing-list after
      // hello and routes model-routing-save. Absent on older servers → false.
      modelRouting: !!c.modelRouting,
      // capability layer (backend-advertised commands): server sends a
      // capability-catalog frame after hello and routes capability-execute.
      // Absent on older/other servers → false, so the client clears any stale
      // backend catalog (e.g. after attaching to a different machine).
      commands: !!c.commands,
      // point-at-the-UI feedback: server has a feedbackSink bound — accepts
      // `feedback-submit` and replies `feedback-ack`. Absent on older servers
      // → false, so the feedback button stays hidden and no frame is sent.
      feedback: !!c.feedback,
    };
  }

  /**
   * Append the auth token as a query parameter, respecting an existing
   * query string. A missing/empty token returns the URL unchanged.
   */
  function buildWsUrl(wsUrl, wsToken) {
    if (!wsToken) return wsUrl;
    var sep = wsUrl.indexOf('?') >= 0 ? '&' : '?';
    return wsUrl + sep + 'token=' + encodeURIComponent(wsToken);
  }

  /**
   * Rebuild a DISPLAY-SAFE version of a WS URL from its parsed components
   * ONLY - scheme, host, port, and path - discarding the query string,
   * fragment, and any userinfo wholesale. Never returns any part of the
   * input on failure.
   *
   * This is the security invariant from docs/next/routes-and-view-mode-plan.md
   * ("The security invariant, which is not deferrable"): buildWsUrl embeds
   * the bearer token in the query string (`?token=...`), so any surface that
   * wants to SHOW a WS url must call this instead of rendering the raw
   * string - a token-parameter strip would be a denylist, wrong by default
   * for the next credential-bearing parameter and blind to
   * `wss://user:pass@host`. Rebuilding from parsed components is right by
   * default: the output structurally cannot contain '?', '#', or userinfo,
   * regardless of what producer supplied the input.
   *
   * Unparseable input returns a FIXED placeholder, never the input itself -
   * a malformed URL is exactly the case a naive string-strip would get wrong.
   */
  function describeWsUrl(wsUrl) {
    try {
      var u = new URL(wsUrl);
      var port = u.port ? (':' + u.port) : '';
      return u.protocol + '//' + u.hostname + port + u.pathname;
    } catch (_) {
      return '<unparseable url>';
    }
  }

  g.LunaProtocol = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    parseHelloCapabilities: parseHelloCapabilities,
    buildWsUrl: buildWsUrl,
    describeWsUrl: describeWsUrl,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
