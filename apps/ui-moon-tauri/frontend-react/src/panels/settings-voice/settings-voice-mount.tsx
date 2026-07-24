/**
 * settings-voice-mount.tsx - boots VoicePanel into panel.html's
 * #content-area, replacing the vanilla frontend/panels/settings-voice.js
 * loader path for the 'settings.voice' panel type.
 *
 * Mirrors settings-launcher-mount.tsx's contract exactly: panel.html's
 * inline script skips the legacy `panels/settings-voice.js` fetch entirely
 * for this type (see its REACT_PANEL_TYPES branch) and never calls
 * bootModule() for it, so this owns:
 *   - #bar-title textContent + document.title
 *   - window.__PanelInternals = { type, hasModule, resolvedRouteKey, lastNotice }
 *   - rendering the panel's content into #content-area
 */
import { createRoot } from "react-dom/client"
import { VoicePanel, PANEL_TITLE } from "./VoicePanel"
import type { PanelCtx } from "../panel-ctx"

export const SETTINGS_VOICE_PANEL_TYPES = ["settings.voice"] as const

export function isSettingsVoicePanelType(type: string): boolean {
  return (SETTINGS_VOICE_PANEL_TYPES as readonly string[]).includes(type)
}

export function mountSettingsVoicePanel(type: string, ctx: PanelCtx): void {
  const barTitle = document.getElementById("bar-title")
  if (barTitle) barTitle.textContent = PANEL_TITLE
  document.title = `Luna — ${PANEL_TITLE}`

  const contentArea = document.getElementById("content-area")
  if (contentArea) {
    createRoot(contentArea).render(<VoicePanel ctx={ctx} />)
  }

  window.__PanelInternals = {
    type,
    hasModule: true,
    resolvedRouteKey: null,
    lastNotice: null,
  }
}
