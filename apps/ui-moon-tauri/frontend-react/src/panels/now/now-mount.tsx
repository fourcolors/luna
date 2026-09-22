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
import { mountReactPanel } from "../panel-mount"
import { NowPanel, NOW_PANEL_TITLE } from "./NowPanel"
import type { PanelCtx } from "../panel-ctx"

export function isNowPanelType(type: string): boolean {
  return type === "now"
}

export function mountNowPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, NOW_PANEL_TITLE, <NowPanel ctx={ctx} />)
}
