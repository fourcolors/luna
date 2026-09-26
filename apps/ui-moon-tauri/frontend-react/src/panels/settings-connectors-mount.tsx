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
import { mountReactPanel } from "./panel-mount"
import { ConnectorsPanel, PANEL_TITLE } from "./settings-connectors/ConnectorsPanel"
import type { PanelCtx } from "./panel-ctx"

const SETTINGS_CONNECTORS_PANEL_TYPES = ["settings.connectors"] as const

export function isSettingsConnectorsPanelType(type: string): boolean {
  return (SETTINGS_CONNECTORS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsConnectorsPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, PANEL_TITLE, <ConnectorsPanel ctx={ctx} />)
}
