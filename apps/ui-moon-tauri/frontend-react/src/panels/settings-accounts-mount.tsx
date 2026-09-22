/**
 * settings-accounts-mount.tsx - boots SettingsAccountsPanel into panel.html's
 * #content-area for the 'settings.accounts' type.
 */
import { mountReactPanel } from "./panel-mount"
import { SettingsAccountsPanel, SETTINGS_ACCOUNTS_TITLE } from "./settings-accounts/SettingsAccountsPanel"
import type { PanelCtx } from "./panel-ctx"

export const SETTINGS_ACCOUNTS_PANEL_TYPES = ["settings.accounts"] as const

export function isSettingsAccountsPanelType(type: string): boolean {
  return (SETTINGS_ACCOUNTS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsAccountsPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, SETTINGS_ACCOUNTS_TITLE, <SettingsAccountsPanel ctx={ctx} />)
}
