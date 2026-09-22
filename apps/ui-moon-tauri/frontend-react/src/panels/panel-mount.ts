/**
 * panel-mount.ts - the shared mount body every React panel type's
 * <name>-mount.tsx delegates to.
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips the React-owned types entirely (see panel.html's REACT_PANEL_TYPES
 * map) and never calls bootModule() for them:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Each mount module keeps only its title constant, its is<Name>PanelType
 * predicate / *_PANEL_TYPES list, and a mount<Name>Panel wrapper that builds
 * its element (reading any URL params it needs) and calls mountReactPanel.
 */
import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"

declare global {
  interface Window {
    /**
     * Observability contract every panel type sets (vanilla via
     * panel.html's bootModule(), React panels via mountReactPanel) - read by
     * agent-browser smoke checks and tests.
     */
    __PanelInternals?: {
      type: string
      hasModule: boolean
      resolvedRouteKey: string | null
      lastNotice: string | null
    }
  }
}

export function mountReactPanel(type: string, title: string, element: ReactNode): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = title
  document.title = `Luna - ${title}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(element)
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
