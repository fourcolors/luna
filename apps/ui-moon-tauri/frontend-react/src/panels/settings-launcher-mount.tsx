/**
 * settings-launcher-mount.tsx - boots SettingsLauncherPanel into panel.html's
 * #content-area, replacing the vanilla frontend/panels/settings.js loader
 * path for the two type values it used to own ('settings' and
 * 'settings-launcher' - see PANEL_TYPES below).
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely for these two types (see panel.html's
 * REACT_OWNED_PANEL_TYPES branch) and never calls bootModule() for them:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors the settings.js module's dual registration under both the widget
 * KIND ('settings', what the chat gear and the agent's open_widget use) and
 * the file-name-derived type ('settings-launcher') - both route here.
 */
import { createRoot } from "react-dom/client"
import { SettingsLauncherPanel, SETTINGS_LAUNCHER_TITLE } from "./SettingsLauncherPanel"
import type { PanelCtx } from "./panel-ctx"

declare global {
  interface Window {
    /**
     * Set by panel.html's inline script (see its `ctx` local) for React
     * panel types to read - the deferred module script that mounts React
     * panels runs after that inline script, so this is how it hands off the
     * already-built Tauri-invoke bridge instead of every React panel
     * re-deriving it from `window.__TAURI__` itself.
     */
    __panelCtx?: PanelCtx
    /**
     * Observability contract every panel type sets (vanilla via
     * panel.html's bootModule(), React panels via mountSettingsLauncherPanel
     * and its future siblings) - read by agent-browser smoke checks and
     * tests.
     */
    __PanelInternals?: {
      type: string
      hasModule: boolean
      resolvedRouteKey: string | null
      lastNotice: string | null
    }
  }
}

export const SETTINGS_LAUNCHER_PANEL_TYPES = ["settings", "settings-launcher"] as const

export function isSettingsLauncherPanelType(type: string): boolean {
  return (SETTINGS_LAUNCHER_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsLauncherPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = SETTINGS_LAUNCHER_TITLE
  document.title = `Luna - ${SETTINGS_LAUNCHER_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<SettingsLauncherPanel ctx={ctx} />)
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
