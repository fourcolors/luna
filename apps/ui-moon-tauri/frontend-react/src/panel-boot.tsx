/**
 * panel-boot.tsx - shared dispatcher for every React-owned panel type on
 * panel.html.
 *
 * panel.html's inline script keeps a plain `REACT_PANEL_TYPES` object
 * (type -> true) and skips its legacy `panels/<type>.js` vanilla loader for
 * every type listed there, leaving #content-area/bar-title/document.title/
 * window.__PanelInternals ownership to whichever mount function this module
 * dispatches to once the deferred React boot script (main-panel.tsx) runs.
 *
 * Converting another panel type to React: add its type string to panel.html's
 * REACT_PANEL_TYPES object AND a branch here that calls its own
 * mount<Name>Panel(type, ctx) function - one line in each file, so two
 * panel conversions landing concurrently only conflict if they touch the
 * exact same line.
 */
import type { PanelCtx } from "./panels/panel-ctx"
import { isSettingsLauncherPanelType, mountSettingsLauncherPanel } from "./panels/settings-launcher-mount"
import { isSettingsGeneralPanelType, mountSettingsGeneralPanel } from "./panels/settings-general-mount"
import { isAgentsPanelType, mountAgentsPanel } from "./panels/agents-mount"
import { isSettingsSkillsPanelType, mountSettingsSkillsPanel } from "./panels/settings-skills-mount"
import { isWorkflowsPanelType, mountWorkflowsPanel } from "./panels/workflows-mount"
import { isSettingsAppsPanelType, mountSettingsAppsPanel } from "./panels/settings-apps-mount"
import { isSettingsVoicePanelType, mountSettingsVoicePanel } from "./panels/settings-voice/settings-voice-mount"
import { isActionsPanelType, mountActionsPanel } from "./panels/actions-mount"
import { isSettingsAppearancePanelType, mountSettingsAppearancePanel } from "./panels/settings-appearance-mount"
import { isBriefingPanelType, mountBriefingPanel } from "./panels/briefing-mount"
import { isFlowPanelType, mountFlowPanel } from "./panels/flow-mount"
import { isNowPanelType, mountNowPanel } from "./panels/now/now-mount"
import { isSettingsModelsPanelType, mountSettingsModelsPanel } from "./panels/settings-models-mount"
import { isSettingsConnectionPanelType, mountSettingsConnectionPanel } from "./panels/settings-connection-mount"
import { isSettingsVaultPanelType, mountSettingsVaultPanel } from "./panels/settings-vault-mount"
import { isSettingsConnectorsPanelType, mountSettingsConnectorsPanel } from "./panels/settings-connectors-mount"
import { isSettingsUpdatesPanelType, mountSettingsUpdatesPanel } from "./panels/settings-updates/settings-updates-mount"
import { isLauncherPanelType, mountLauncherPanel } from "./panels/launcher/launcher-mount"
import { isNotificationsPanelType, mountNotificationsPanel } from "./panels/notifications/notifications-mount"

/** Returns true if `type` was a React-owned panel type this dispatched. */
export function mountReactPanel(type: string, ctx: PanelCtx): boolean {
  if (isNowPanelType(type)) {
    mountNowPanel(type, ctx)
    return true
  }
  if (isSettingsLauncherPanelType(type)) {
    mountSettingsLauncherPanel(type, ctx)
    return true
  }
  if (isSettingsGeneralPanelType(type)) {
    mountSettingsGeneralPanel(type, ctx)
    return true
  }
  if (isAgentsPanelType(type)) {
    mountAgentsPanel(type, ctx)
    return true
  }
  if (isSettingsSkillsPanelType(type)) {
    mountSettingsSkillsPanel(type, ctx)
    return true
  }
  if (isWorkflowsPanelType(type)) {
    mountWorkflowsPanel(type, ctx)
    return true
  }
  if (isSettingsAppsPanelType(type)) {
    mountSettingsAppsPanel(type, ctx)
    return true
  }
  if (isSettingsVoicePanelType(type)) {
    mountSettingsVoicePanel(type, ctx)
    return true
  }
  if (isActionsPanelType(type)) {
    mountActionsPanel(type, ctx)
    return true
  }
  if (isSettingsAppearancePanelType(type)) {
    mountSettingsAppearancePanel(type, ctx)
    return true
  }
  if (isBriefingPanelType(type)) {
    mountBriefingPanel(type, ctx)
    return true
  }
  if (isFlowPanelType(type)) {
    mountFlowPanel(type, ctx)
    return true
  }
  if (isSettingsModelsPanelType(type)) {
    mountSettingsModelsPanel(type, ctx)
    return true
  }
  if (isSettingsConnectionPanelType(type)) {
    mountSettingsConnectionPanel(type, ctx)
    return true
  }
  if (isSettingsVaultPanelType(type)) {
    mountSettingsVaultPanel(type, ctx)
    return true
  }
  if (isSettingsConnectorsPanelType(type)) {
    mountSettingsConnectorsPanel(type, ctx)
    return true
  }
  if (isSettingsUpdatesPanelType(type)) {
    mountSettingsUpdatesPanel(type, ctx)
    return true
  }
  if (isLauncherPanelType(type)) {
    mountLauncherPanel(type, ctx)
    return true
  }
  if (isNotificationsPanelType(type)) {
    mountNotificationsPanel(type, ctx)
    return true
  }
  return false
}
