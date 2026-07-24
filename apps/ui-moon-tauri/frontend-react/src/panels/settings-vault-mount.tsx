/**
 * settings-vault-mount.tsx - boots SettingsVaultPanel into panel.html's
 * #content-area, replacing the vanilla frontend/panels/settings-vault.js
 * loader path for the 'settings.vault' type.
 *
 * Same observable contract every panel-boot.tsx-dispatched mount function
 * owns (see settings-launcher-mount.tsx's module doc) since panel.html's
 * inline script skips its own bootModule() for React-owned types:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - renders the panel's content into #content-area
 */
import { createRoot } from "react-dom/client"
import { SettingsVaultPanel, SETTINGS_VAULT_TITLE } from "./settings-vault/SettingsVaultPanel"
import type { PanelCtx } from "./panel-ctx"

export const SETTINGS_VAULT_PANEL_TYPES = ["settings.vault"] as const

export function isSettingsVaultPanelType(type: string): boolean {
  return (SETTINGS_VAULT_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsVaultPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = SETTINGS_VAULT_TITLE
  document.title = `Luna — ${SETTINGS_VAULT_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<SettingsVaultPanel ctx={ctx} />)
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
