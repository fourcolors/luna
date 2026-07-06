// WidgetFrame.jsx — the REAL vibe-coded widget host.
//
// studio-widget.jsx's GeneratedWidget is a client-side MOCK: a fixed set of
// React components (`counter`/`checklist`/`gauge`/…) picked by a local
// text heuristic. This is the real thing — it renders whatever HTML the
// agent actually authored (widget_write for kind="widget", mcp_app_write for
// kind="mcp-app") inside Luna's real trust boundary:
//
//   <iframe sandbox="allow-scripts"> (no allow-same-origin: no parent-DOM
//   access, no cookies/storage, no window.__TAURI__), content mounted via
//   srcdoc (never a network src), CSP `default-src 'none'`.
//
// This file only wires the two host-side halves the shared modules
// deliberately leave to the caller:
//   - kind="widget": the `luna.*` postMessage bridge (subscribe/refresh),
//     forwarding live obs events — cap-gated by the artifact's bridgeCaps,
//     never a backlog replay.
//   - kind="mcp-app": @luna/ui-shared/mcp-app-host's `host()`, which drives
//     the MCP Apps JSON-RPC handshake and routes tools/call through the
//     `mcp` relay (WS mcp-tool-call/-result, correlated by requestId in
//     useLunaData).
//
// buildSrcdoc / SANDBOX_ATTR / subscribeAllowed and the mcp host are
// imported verbatim from @luna/ui-shared — never reimplemented here (the
// security cage is parity-tested against Moon's vendored copy).
import React, { useEffect, useRef, useState } from "react";
import {
  SANDBOX_ATTR,
  buildSrcdoc,
  subscribeAllowed,
} from "@luna/ui-shared/widget-sandbox";
import { host as mcpHost } from "@luna/ui-shared/mcp-app-host";

/**
 * @param {{
 *   artifact: { id: string, kind: "widget"|"mcp-app", title?: string, content: string, bridgeCaps?: (string[]|null) },
 *   mcp?: { readResource: (uri: string) => Promise<any>, callTool: (appUri: string, tool: string, args: unknown) => Promise<any> },
 *   obsEvents?: ReadonlyArray<{ kind: string }>,
 *   fresh?: boolean,
 * }} props
 */
export function WidgetFrame({ artifact, mcp, obsEvents, fresh }) {
  const frameRef = useRef(null);
  const obsEventsRef = useRef(obsEvents || []);
  obsEventsRef.current = obsEvents || [];
  const subscribedRef = useRef(false);
  const lastSeenRef = useRef(null);
  const [painting, setPainting] = useState(!!fresh);

  const kind = artifact && artifact.kind;
  const content = (artifact && artifact.content) || "";
  const artifactId = artifact && artifact.id;
  const bridgeCaps = (artifact && artifact.bridgeCaps) || null;
  const title = (artifact && artifact.title) || "widget";

  // Same "wet paint" sweep the mock GeneratedWidget uses for a freshly
  // created widget — continuity for the moment a describe-a-widget request
  // resolves, whether it lands as the mock or the real artifact.
  useEffect(() => {
    if (!fresh) return;
    const tm = setTimeout(() => setPainting(false), 820);
    return () => clearTimeout(tm);
  }, [fresh]);

  // kind="widget": mount the srcdoc + host the luna.* subscribe/refresh
  // bridge (BRIDGE_SHIM in widget-sandbox.ts talks ONLY to this iframe).
  useEffect(() => {
    if (kind !== "widget") return;
    const frame = frameRef.current;
    if (!frame) return;
    subscribedRef.current = false;
    lastSeenRef.current = null;
    function onMessage(e) {
      if (e.source !== frame.contentWindow) return;
      const m = e.data;
      if (!m || typeof m !== "object") return;
      if (m.__luna === "subscribe") {
        subscribedRef.current = true;
        // Anchor at the current newest -> forward only events that arrive
        // AFTER subscribe (never replay the backlog).
        lastSeenRef.current = obsEventsRef.current[0] || null;
      } else if (m.__luna === "refresh") {
        frame.srcdoc = buildSrcdoc(content);
      }
    }
    window.addEventListener("message", onMessage);
    frame.srcdoc = buildSrcdoc(content);
    return () => window.removeEventListener("message", onMessage);
  }, [kind, content, artifactId]);

  // Forward newly-arrived obs events to a subscribed widget, cap-gated and in
  // chronological order, whenever the store's (newest-first, capped) event
  // list grows. Mirrors ArtifactPanel.tsx's widgetEventsToForward.
  useEffect(() => {
    if (kind !== "widget") return;
    const frame = frameRef.current;
    if (!subscribedRef.current || !frame || !frame.contentWindow) return;
    const events = obsEvents || [];
    const freshEvents = [];
    for (const ev of events) {
      if (ev === lastSeenRef.current) break;
      freshEvents.push(ev);
    }
    freshEvents.reverse();
    for (const ev of freshEvents) {
      if (subscribeAllowed(bridgeCaps, ev.kind)) {
        frame.contentWindow.postMessage({ __luna: "event", event: ev }, "*");
      }
    }
    if (events.length > 0) lastSeenRef.current = events[0];
  }, [kind, obsEvents, bridgeCaps]);

  // kind="mcp-app": host the MCP Apps JSON-RPC relay via the shared client.
  // `host()` owns srcdoc assignment for this case (buildGeneratedAppSrcdoc /
  // buildMcpSrcdoc) — do not set it here too.
  useEffect(() => {
    if (kind !== "mcp-app" || !mcp) return;
    const frame = frameRef.current;
    if (!frame) return;
    const trimmed = content.trim();
    const isPointer = /^ui:\/\//i.test(trimmed);
    const appUri = isPointer ? trimmed : "ui://luna/app/" + encodeURIComponent(artifactId || "");
    const handle = mcpHost({
      frameEl: frame,
      uri: appUri,
      html: isPointer ? null : content,
      transport: {
        readResource: (uri) => mcp.readResource(uri),
        callTool: (tool, args) => mcp.callTool(appUri, tool, args),
      },
    });
    return () => handle.dispose();
  }, [kind, content, artifactId, mcp]);

  if (kind === "mcp-app" && !mcp) {
    // Older/capability-less server: no live relay to drive the JSON-RPC
    // handshake — show the source instead of mounting a dead iframe (mirrors
    // ArtifactPanel.tsx's mcp-app fallback-to-source-view behavior).
    return (
      <div className="gw-wrap widget-frame-host">
        <pre className="widget-frame-source">{content}</pre>
      </div>
    );
  }

  return (
    <div className="gw-wrap widget-frame-host">
      {painting && <div className="gw-painting"></div>}
      <iframe
        ref={frameRef}
        className="widget-frame-iframe"
        title={title}
        sandbox={SANDBOX_ATTR}
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
