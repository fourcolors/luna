/**
 * moon-protocol.js — the client half of the UI-WS protocol seam.
 *
 * Mirrors packages/ui-ws/src/protocol.ts (UI_WS_PROTOCOL_VERSION and the
 * HelloFrame `capabilities` shape). This file is the ONLY place client pages
 * encode protocol literals; it must stay free of anything server-specific so
 * the server behind the protocol remains swappable.
 *
 * Plain-script IIFE (no build step) — attaches `LunaProtocol` to globalThis,
 * same convention as deck-snap.js / widget-sandbox.js.
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

  g.LunaProtocol = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    parseHelloCapabilities: parseHelloCapabilities,
    buildWsUrl: buildWsUrl,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
