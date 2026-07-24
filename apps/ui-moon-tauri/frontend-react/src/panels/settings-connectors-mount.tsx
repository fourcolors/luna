/**
 * settings-connectors-mount.tsx - boots ConnectorsPanel into panel.html's
 * #content-area, replacing the vanilla frontend/panels/settings-connectors.js
 * loader path for the 'settings.connectors' panel type.
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely for 'settings.connectors' (see panel.html's
 * REACT_PANEL_TYPES map) and never calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-connection-mount.tsx's shape exactly.
 */
import { createRoot } from "react-dom/client"
import { ConnectorsPanel, PANEL_TITLE } from "./settings-connectors/ConnectorsPanel"
import type { PanelCtx } from "./panel-ctx"

export const SETTINGS_CONNECTORS_PANEL_TYPES = ["settings.connectors"] as const

export function isSettingsConnectorsPanelType(type: string): boolean {
  return (SETTINGS_CONNECTORS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsConnectorsPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = PANEL_TITLE
  document.title = `Luna — ${PANEL_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<ConnectorsPanel ctx={ctx} />)
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
