/**
 * actions-mount.tsx - boots ActionsPanel into panel.html's #content-area,
 * replacing the vanilla frontend/panels/actions.js loader path for the
 * 'actions' type (see ACTIONS_PANEL_TYPES below).
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely (see panel.html's REACT_PANEL_TYPES map) and
 * never calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Reads the `?thread=` URL param here (once, at mount time) and passes it
 * down as a prop rather than having ActionsPanel read `location.search`
 * itself - mirrors FlowPanel.tsx's jobId-prop shape, which keeps the
 * component trivially testable without touching jsdom's location.
 *
 * Mirrors settings-launcher-mount.tsx's shape (see its module doc).
 */
import { createRoot } from "react-dom/client"
import { ActionsPanel } from "./actions/ActionsPanel"
import type { PanelCtx } from "./panel-ctx"

declare global {
  interface Window {
    /**
     * Observability contract every panel type sets (vanilla via
     * panel.html's bootModule(), React panels via mount*Panel functions like
     * this one) - read by agent-browser smoke checks and tests.
     */
    __PanelInternals?: {
      type: string
      hasModule: boolean
      resolvedRouteKey: string | null
      lastNotice: string | null
    }
  }
}

export const ACTIONS_PANEL_TITLE = "Suggested Actions"
const ACTIONS_PANEL_TYPES = ["actions"] as const

export function isActionsPanelType(type: string): boolean {
  return (ACTIONS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountActionsPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = ACTIONS_PANEL_TITLE
  document.title = `Luna - ${ACTIONS_PANEL_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    const threadId = new URLSearchParams(location.search).get("thread") || ""
    createRoot(contentArea).render(<ActionsPanel ctx={ctx} threadId={threadId} />)
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
