/**
 * settings-skills-mount.tsx - boots SettingsSkillsPanel into panel.html's
 * #content-area, replacing the vanilla frontend/panels/settings-skills.js
 * loader path for the 'settings.skills' type.
 *
 * Same observable contract every panel-boot.tsx-dispatched mount function
 * owns (see settings-launcher-mount.tsx's module doc) since panel.html's
 * inline script skips its own bootModule() for React-owned types:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 */
import { createRoot } from "react-dom/client"
import { SettingsSkillsPanel, SETTINGS_SKILLS_TITLE } from "./settings-skills/SettingsSkillsPanel"
import type { PanelCtx } from "./panel-ctx"

export const SETTINGS_SKILLS_PANEL_TYPES = ["settings.skills"] as const

export function isSettingsSkillsPanelType(type: string): boolean {
  return (SETTINGS_SKILLS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsSkillsPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = SETTINGS_SKILLS_TITLE
  document.title = `Luna — ${SETTINGS_SKILLS_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<SettingsSkillsPanel ctx={ctx} />)
  }

  window.__PanelInternals = {
    type,
    hasModule: true,
    resolvedRouteKey: null,
    lastNotice: null,
  }
}
