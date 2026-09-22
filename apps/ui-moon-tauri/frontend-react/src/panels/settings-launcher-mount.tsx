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
import { mountReactPanel } from "./panel-mount"
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
  }
}

export const SETTINGS_LAUNCHER_PANEL_TYPES = ["settings", "settings-launcher"] as const

export function isSettingsLauncherPanelType(type: string): boolean {
  return (SETTINGS_LAUNCHER_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsLauncherPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, SETTINGS_LAUNCHER_TITLE, <SettingsLauncherPanel ctx={ctx} />)
}
