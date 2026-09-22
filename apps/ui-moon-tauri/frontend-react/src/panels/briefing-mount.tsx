/**
 * briefing-mount.tsx - boots BriefingPanel into panel.html's #content-area,
 * replacing the vanilla frontend/panels/briefing.js loader path for the
 * 'briefing' type (see PANEL_TYPE below).
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely (see panel.html's REACT_PANEL_TYPES map) and
 * never calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors agents-mount.tsx / settings-launcher-mount.tsx's shape (see their
 * module docs) - dispatched from panel-boot.tsx.
 */
import { mountReactPanel } from "./panel-mount"
import { BriefingPanel, BRIEFING_PANEL_TITLE } from "./briefing/BriefingPanel"
import type { PanelCtx } from "./panel-ctx"

const BRIEFING_PANEL_TYPES = ["briefing"] as const

export function isBriefingPanelType(type: string): boolean {
  return (BRIEFING_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountBriefingPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, BRIEFING_PANEL_TITLE, <BriefingPanel ctx={ctx} />)
}
