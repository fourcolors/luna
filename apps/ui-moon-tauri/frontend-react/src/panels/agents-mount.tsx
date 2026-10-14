/**
 * agents-mount.tsx - boots AgentsPanel into panel.html's #content-area,
 * replacing the vanilla frontend/panels/agents.js loader path for the
 * 'agents' type (see PANEL_TYPE below).
 *
 * Owns the same observable contract panel.html's own `bootModule()` owns for
 * every other (still-vanilla) panel type, since panel.html's inline script
 * skips that type entirely (see panel.html's REACT_PANEL_TYPES map) and
 * never calls bootModule() for it:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 *
 * Mirrors settings-launcher-mount.tsx's shape (see its module doc) - this is
 * the second panel type converted through panel-boot.tsx's dispatcher.
 */
import { mountReactPanel } from "./panel-mount"
import { AgentsPanel } from "./agents/AgentsPanel"
import type { PanelCtx } from "./panel-ctx"

const AGENTS_PANEL_TITLE = "Agents"
const AGENTS_PANEL_TYPES = ["agents"] as const

export function isAgentsPanelType(type: string): boolean {
  return (AGENTS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountAgentsPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, AGENTS_PANEL_TITLE, <AgentsPanel ctx={ctx} />)
}
