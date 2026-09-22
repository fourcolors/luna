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
import { mountReactPanel } from "./panel-mount"
import { WorkflowsPanel } from "./workflows/WorkflowsPanel"
import type { PanelCtx } from "./panel-ctx"

export const WORKFLOWS_PANEL_TITLE = "Workflows"
export const WORKFLOWS_PANEL_TYPES = ["workflows"] as const

export function isWorkflowsPanelType(type: string): boolean {
  return (WORKFLOWS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountWorkflowsPanel(type: string, _ctx: PanelCtx): void {
  mountReactPanel(type, WORKFLOWS_PANEL_TITLE, <WorkflowsPanel />)
}
