/**
 * notifications-mount.tsx - boots NotificationsPanel into panel.html's
 * #content-area for the 'notifications' type.
 *
 * Mirrors briefing-mount.tsx exactly (see its module doc for the full
 * observable contract this owns in place of panel.html's bootModule():
 * #bar-title, document.title, window.__PanelInternals, #content-area) -
 * dispatched from panel-boot.tsx.
 */
import { mountReactPanel } from "../panel-mount"
import { NotificationsPanel, NOTIFICATIONS_PANEL_TITLE } from "./NotificationsPanel"
import type { PanelCtx } from "../panel-ctx"

const NOTIFICATIONS_PANEL_TYPES = ["notifications"] as const

export function isNotificationsPanelType(type: string): boolean {
  return (NOTIFICATIONS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountNotificationsPanel(type: string, ctx: PanelCtx): void {
  mountReactPanel(type, NOTIFICATIONS_PANEL_TITLE, <NotificationsPanel ctx={ctx} />)
}
