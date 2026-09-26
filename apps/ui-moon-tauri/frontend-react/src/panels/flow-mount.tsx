/**
 * flow-mount.tsx - boots FlowPanel into panel.html's #content-area,
 * replacing the vanilla frontend/panels/flow.js loader path for the 'flow'
 * panel type.
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips 'flow' entirely (see its REACT_PANEL_TYPES branch) and never calls
 * bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-launcher-mount.tsx / workflows-mount.tsx's shape. Unlike
 * those, this type carries a per-window `?jobId=` URL param - read here
 * (not inside FlowPanel itself) so the component stays a plain
 * `{ ctx, jobId }` prop consumer, easy to mount directly in tests without
 * touching `location`.
 */
import { mountReactPanel } from "./panel-mount"
import { FlowPanel } from "./FlowPanel"
import type { PanelCtx } from "./panel-ctx"

export const FLOW_PANEL_TITLE = "Run history"
const FLOW_PANEL_TYPES = ["flow"] as const

export function isFlowPanelType(type: string): boolean {
  return (FLOW_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountFlowPanel(type: string, ctx: PanelCtx): void {
  const jobId = new URLSearchParams(location.search).get("jobId")

  mountReactPanel(type, FLOW_PANEL_TITLE, <FlowPanel ctx={ctx} jobId={jobId} />)
}
