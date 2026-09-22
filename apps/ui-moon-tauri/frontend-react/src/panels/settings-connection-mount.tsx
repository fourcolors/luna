/**
 * settings-connection-mount.tsx - boots SettingsConnectionPanel into
 * panel.html's #content-area, replacing the vanilla
 * frontend/panels/settings-connection.js loader path for the
 * 'settings.connection' panel type.
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely for 'settings.connection' (see panel.html's
 * REACT_PANEL_TYPES map) and never calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-general-mount.tsx's shape exactly (see that file's doc
 * comment for the full rationale).
 */
import { mountReactPanel } from "./panel-mount"
import { PANEL_TITLE, SettingsConnectionPanel } from "./settings-connection/SettingsConnectionPanel"
import type { PanelCtx } from "./panel-ctx"

export const SETTINGS_CONNECTION_PANEL_TYPES = ["settings.connection"] as const

export function isSettingsConnectionPanelType(type: string): boolean {
  return (SETTINGS_CONNECTION_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsConnectionPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, PANEL_TITLE, <SettingsConnectionPanel ctx={ctx} />)
}
