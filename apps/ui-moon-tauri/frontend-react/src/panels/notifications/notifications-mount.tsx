/**
 * notifications-mount.tsx - boots NotificationsPanel into panel.html's
 * #content-area for the 'notifications' type.
 *
 * Mirrors briefing-mount.tsx exactly (see its module doc for the full
 * observable contract this owns in place of panel.html's bootModule():
 * #bar-title, document.title, window.__PanelInternals, #content-area) -
 * dispatched from panel-boot.tsx.
 */
import { createRoot } from "react-dom/client"
import { NotificationsPanel, NOTIFICATIONS_PANEL_TITLE } from "./NotificationsPanel"
import type { PanelCtx } from "../panel-ctx"

const NOTIFICATIONS_PANEL_TYPES = ["notifications"] as const

export function isNotificationsPanelType(type: string): boolean {
  return (NOTIFICATIONS_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountNotificationsPanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = NOTIFICATIONS_PANEL_TITLE
  document.title = `Luna - ${NOTIFICATIONS_PANEL_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<NotificationsPanel ctx={ctx} />)
  }

  window.__PanelInternals = {
    type,
    hasModule: true,
    resolvedRouteKey: null,
    lastNotice: null,
  }
}
