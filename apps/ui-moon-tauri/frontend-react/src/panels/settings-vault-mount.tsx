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
import { mountReactPanel } from "./panel-mount"
import { SettingsVaultPanel, SETTINGS_VAULT_TITLE } from "./settings-vault/SettingsVaultPanel"
import type { PanelCtx } from "./panel-ctx"

const SETTINGS_VAULT_PANEL_TYPES = ["settings.vault"] as const

export function isSettingsVaultPanelType(type: string): boolean {
  return (SETTINGS_VAULT_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsVaultPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, SETTINGS_VAULT_TITLE, <SettingsVaultPanel ctx={ctx} />)
}
