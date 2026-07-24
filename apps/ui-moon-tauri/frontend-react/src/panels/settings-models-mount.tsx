/**
 * settings-models-mount.tsx - boots SettingsModelsPanel into panel.html's
 * #content-area, replacing the vanilla frontend/panels/settings-models.js
 * loader path for the 'settings.models' panel type.
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely for 'settings.models' (see panel.html's
 * REACT_PANEL_TYPES map) and never calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-general-mount.tsx's shape exactly (see that file's doc
 * comment for the full rationale).
 */
import { createRoot } from "react-dom/client"
import { PANEL_TITLE, SettingsModelsPanel } from "./settings-models/SettingsModelsPanel"
import type { PanelCtx } from "./panel-ctx"

export const SETTINGS_MODELS_TITLE = PANEL_TITLE
export const SETTINGS_MODELS_PANEL_TYPES = ["settings.models"] as const

export function isSettingsModelsPanelType(type: string): boolean {
  return (SETTINGS_MODELS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsModelsPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = SETTINGS_MODELS_TITLE
  document.title = `Luna — ${SETTINGS_MODELS_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<SettingsModelsPanel ctx={ctx} />)
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
