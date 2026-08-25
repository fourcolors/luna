/**
 * settings-accounts-mount.tsx - boots SettingsAccountsPanel into panel.html's
 * #content-area for the 'settings.accounts' type.
 */
import { createRoot } from "react-dom/client"
import { SettingsAccountsPanel, SETTINGS_ACCOUNTS_TITLE } from "./settings-accounts/SettingsAccountsPanel"
import type { PanelCtx } from "./panel-ctx"

export const SETTINGS_ACCOUNTS_PANEL_TYPES = ["settings.accounts"] as const

export function isSettingsAccountsPanelType(type: string): boolean {
  return (SETTINGS_ACCOUNTS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsAccountsPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = SETTINGS_ACCOUNTS_TITLE
  document.title = `Luna - ${SETTINGS_ACCOUNTS_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<SettingsAccountsPanel ctx={ctx} />)
  }

  window.__PanelInternals = {
    type,
    hasModule: true,
    resolvedRouteKey: null,
    lastNotice: null,
  }
}
