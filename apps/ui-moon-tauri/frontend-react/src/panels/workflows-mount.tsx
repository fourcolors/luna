/**
 * workflows-mount.tsx - boots WorkflowsPanel into panel.html's
 * #content-area, replacing the vanilla frontend/panels/workflows.js loader
 * path for the 'workflows' panel type.
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips 'workflows' entirely (see its REACT_PANEL_TYPES branch) and never
 * calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-launcher-mount.tsx's shape (the first converted panel to
 * establish this hand-off pattern).
 */
import { createRoot } from "react-dom/client"
import { WorkflowsPanel } from "./workflows/WorkflowsPanel"
import type { PanelCtx } from "./panel-ctx"

declare global {
  interface Window {
    /**
     * Observability contract every panel type sets (vanilla via
     * panel.html's bootModule(), React panels via mountWorkflowsPanel and
     * its siblings) - read by agent-browser smoke checks and tests.
     */
    __PanelInternals?: {
      type: string
      hasModule: boolean
      resolvedRouteKey: string | null
      lastNotice: string | null
    }
  }
}

export const WORKFLOWS_PANEL_TITLE = "Workflows"
export const WORKFLOWS_PANEL_TYPES = ["workflows"] as const

export function isWorkflowsPanelType(type: string): boolean {
  return (WORKFLOWS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountWorkflowsPanel(type: string, _ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = WORKFLOWS_PANEL_TITLE
  document.title = `Luna — ${WORKFLOWS_PANEL_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<WorkflowsPanel />)
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
