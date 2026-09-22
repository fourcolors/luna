/**
 * settings-updates-mount.tsx - boots UpdatesPanel into panel.html's
 * #content-area, replacing the vanilla frontend/panels/settings-updates.js
 * loader path for the 'settings.updates' panel type.
 *
 * Mirrors settings-voice-mount.tsx's contract exactly: panel.html's inline
 * script skips the legacy `panels/settings-updates.js` fetch entirely for
 * this type (see its REACT_PANEL_TYPES branch) and never calls bootModule()
 * for it, so this owns:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - rendering the panel's content into #content-area
 */
import { mountReactPanel } from "../panel-mount"
import { UpdatesPanel, PANEL_TITLE } from "./UpdatesPanel"
import type { PanelCtx } from "../panel-ctx"

export const SETTINGS_UPDATES_PANEL_TYPES = ["settings.updates"] as const

export function isSettingsUpdatesPanelType(type: string): boolean {
  return (SETTINGS_UPDATES_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsUpdatesPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, PANEL_TITLE, <UpdatesPanel ctx={ctx} />)
}
