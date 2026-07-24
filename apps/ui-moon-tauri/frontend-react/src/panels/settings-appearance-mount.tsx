/**
 * settings-appearance-mount.tsx - boots SettingsAppearancePanel into
 * panel.html's #content-area, replacing the vanilla
 * frontend/panels/settings-appearance.js loader path for the
 * 'settings.appearance' panel type.
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely for 'settings.appearance' (see panel.html's
 * REACT_PANEL_TYPES map) and never calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-launcher-mount.tsx / settings-general-mount.tsx's shape
 * exactly (see settings-launcher-mount.tsx's doc comment for the full
 * rationale). Unlike those two, SettingsAppearancePanel needs no `ctx`
 * (localStorage + window.LunaAppearance only, no ctx.invoke/connectWs calls)
 * - the `ctx` parameter still exists so panel-boot.tsx's dispatcher can call
 * every mount<Name>Panel(type, ctx) function through one uniform signature.
 */
import { createRoot } from "react-dom/client"
import { SETTINGS_APPEARANCE_TITLE, SettingsAppearancePanel } from "./SettingsAppearancePanel"
import type { PanelCtx } from "./panel-ctx"

export const SETTINGS_APPEARANCE_PANEL_TYPES = ["settings.appearance"] as const

export function isSettingsAppearancePanelType(type: string): boolean {
  return (SETTINGS_APPEARANCE_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsAppearancePanel(type: string, _ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = SETTINGS_APPEARANCE_TITLE
  document.title = `Luna - ${SETTINGS_APPEARANCE_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<SettingsAppearancePanel />)
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
