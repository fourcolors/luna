/**
 * launcher-mount.tsx — boots LauncherPanel into panel.html's #content-area
 * for the 'launcher' type.
 *
 * Owns the same observable contract panel.html's own `bootModule()` sets for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips the vanilla loader for types listed in REACT_PANEL_TYPES and leaves
 * #content-area / bar-title / document.title / window.__PanelInternals to
 * whichever mount function this module dispatches to once main-panel.tsx runs:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-apps-mount.tsx exactly (the established conversion recipe).
 */
import { createRoot } from "react-dom/client"
import { LauncherPanel } from "./LauncherPanel"
import type { PanelCtx } from "../panel-ctx"

export const LAUNCHER_PANEL_TYPE = "launcher"
export const LAUNCHER_TITLE = "Launcher"

export function isLauncherPanelType(type: string): boolean {
  return type === LAUNCHER_PANEL_TYPE
}

export function mountLauncherPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = LAUNCHER_TITLE
  document.title = `Luna - ${LAUNCHER_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<LauncherPanel ctx={ctx} />)
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
