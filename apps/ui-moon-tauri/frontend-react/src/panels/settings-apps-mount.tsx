/**
 * settings-apps-mount.tsx - boots SettingsAppsPanel into panel.html's
 * #content-area, replacing the vanilla frontend/panels/settings-apps.js
 * loader path for the 'settings.apps' type.
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely for this one (see panel.html's REACT_PANEL_TYPES
 * branch) and never calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-launcher-mount.tsx's shape (the first React-owned panel
 * type wired into main-panel.tsx) so a future conversion has one obvious
 * pattern to copy.
 */
import { createRoot } from "react-dom/client"
import { SettingsAppsPanel } from "./SettingsAppsPanel"
import type { PanelCtx } from "./panel-ctx"

export const SETTINGS_APPS_PANEL_TYPE = "settings.apps"
export const SETTINGS_APPS_TITLE = "Apps"

export function isSettingsAppsPanelType(type: string): boolean {
  return type === SETTINGS_APPS_PANEL_TYPE
}

export function mountSettingsAppsPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = SETTINGS_APPS_TITLE
  document.title = `Luna - ${SETTINGS_APPS_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<SettingsAppsPanel ctx={ctx} />)
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
