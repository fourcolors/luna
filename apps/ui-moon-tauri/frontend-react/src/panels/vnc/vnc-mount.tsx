/**
 * vnc-mount.tsx - boots VncPanel into panel.html's #content-area for the
 * 'vnc' panel type (registered in widget-registry.json as 'Screen Share').
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips 'vnc' entirely (see its REACT_PANEL_TYPES map) and never calls
 * bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors now-mount.tsx's mountNowPanel shape.
 */
import { mountReactPanel } from "../panel-mount"
import { VncPanel, VNC_PANEL_TITLE } from "./VncPanel"
import type { PanelCtx } from "../panel-ctx"

export function isVncPanelType(type: string): boolean {
  return type === "vnc"
}

export function mountVncPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, VNC_PANEL_TITLE, <VncPanel ctx={ctx} />)
}
