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
 * those, this type carries a per-window `?jobId=` URL param — read here
 * (not inside FlowPanel itself) so the component stays a plain
 * `{ ctx, jobId }` prop consumer, easy to mount directly in tests without
 * touching `location`.
 */
import { createRoot } from "react-dom/client"
import { FlowPanel } from "./FlowPanel"
import type { PanelCtx } from "./panel-ctx"

declare global {
  interface Window {
    /**
     * Observability contract every panel type sets (vanilla via
     * panel.html's bootModule(), React panels via mountFlowPanel and its
     * siblings) - read by agent-browser smoke checks and tests.
     */
    __PanelInternals?: {
      type: string
      hasModule: boolean
      resolvedRouteKey: string | null
      lastNotice: string | null
    }
  }
}

export const FLOW_PANEL_TITLE = "Run history"
export const FLOW_PANEL_TYPES = ["flow"] as const

export function isFlowPanelType(type: string): boolean {
  return (FLOW_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountFlowPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = FLOW_PANEL_TITLE
  document.title = `Luna — ${FLOW_PANEL_TITLE}`

  const jobId = new URLSearchParams(location.search).get("jobId")

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<FlowPanel ctx={ctx} jobId={jobId} />)
  }

  // Same shape panel.html's own bootModule() sets for vanilla panels, so
  // agent-browser smoke checks and tests keep one observability contract
  // regardless of which renderer owns a given panel type.
  window.__PanelInternals = {
    type,
    hasModule: true,
    resolvedRouteKey: null,
    lastNotice: null,
  }
}
