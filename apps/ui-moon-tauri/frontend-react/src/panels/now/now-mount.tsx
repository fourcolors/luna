/**
 * now-mount.tsx - boots NowPanel into panel.html's #content-area, replacing
 * the vanilla frontend/panels/now.js loader path for the 'now' panel type.
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips 'now' entirely (see its REACT_PANEL_TYPES map) and never calls
 * bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-launcher-mount.tsx's mountSettingsLauncherPanel shape.
 */
import { createRoot } from "react-dom/client"
import { NowPanel, NOW_PANEL_TITLE } from "./NowPanel"
import type { PanelCtx } from "../panel-ctx"

export function isNowPanelType(type: string): boolean {
  return type === "now"
}

export function mountNowPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = NOW_PANEL_TITLE
  document.title = `Luna - ${NOW_PANEL_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<NowPanel ctx={ctx} />)
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
