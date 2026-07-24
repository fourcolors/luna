/**
 * briefing-mount.tsx - boots BriefingPanel into panel.html's #content-area,
 * replacing the vanilla frontend/panels/briefing.js loader path for the
 * 'briefing' type (see PANEL_TYPE below).
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely (see panel.html's REACT_PANEL_TYPES map) and
 * never calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors agents-mount.tsx / settings-launcher-mount.tsx's shape (see their
 * module docs) - dispatched from panel-boot.tsx.
 */
import { createRoot } from "react-dom/client"
import { BriefingPanel, BRIEFING_PANEL_TITLE } from "./briefing/BriefingPanel"
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

const BRIEFING_PANEL_TYPES = ["briefing"] as const

export function isBriefingPanelType(type: string): boolean {
  return (BRIEFING_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountBriefingPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = BRIEFING_PANEL_TITLE
  document.title = `Luna - ${BRIEFING_PANEL_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<BriefingPanel ctx={ctx} />)
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
