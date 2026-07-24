/**
 * SettingsLauncherPanel.tsx - React 19 + Astryx port of
 * frontend/panels/settings.js (the Settings LAUNCHER panel, widget kind
 * 'settings' / file-name kind 'settings-launcher'). The hub's gear modal
 * died in Phase 3; this panel is its windowed replacement: a vertical list
 * of launcher buttons, one per settings panel, each opening its system
 * widget via open_widget.
 *
 * Skills/Connectors are ALWAYS visible here (v1): this panel has no WS
 * connection of its own, so it cannot read the hello capability gates the
 * hub used to toggle those launchers - acceptable, since the target panels
 * themselves degrade gracefully against servers without the capability.
 *
 * Stateless by design (no reducer/store slice - see the module doc on
 * src/state/store.ts): every row is a static open-this-widget action, so
 * there is no application state to select. Mounted by
 * src/panels/settings-launcher-mount.tsx.
 *
 * Astryx mapping: SideNav (vertical nav container) + two SideNavSection
 * groups (Settings panels / ambient widgets) of SideNavItem rows, separated
 * by a Divider - the real Astryx primitives for "a titled group of nav
 * buttons", not an ad hoc role="menu"/"menuitem" tree the vanilla version
 * hand-rolled. SideNavItem's own accessibility contract (nav landmark +
 * grouped rows) is the more correct pattern for a static list of
 * open-a-window actions, so this conversion adopts it rather than
 * reproducing the vanilla ARIA roles verbatim.
 */
import { Divider, SideNav, SideNavItem, SideNavSection } from "../astryx-kit"
import type { PanelCtx } from "./panel-ctx"

export interface LauncherEntry {
  readonly kind: string
  readonly label: string
}

// The settings panels, in the hub launcher's order.
export const SETTINGS_PANELS: readonly LauncherEntry[] = [
  { kind: "settings.general", label: "General" },
  { kind: "settings.appearance", label: "Appearance" },
  { kind: "settings.connection", label: "Connection" },
  { kind: "settings.voice", label: "Voice" },
  { kind: "settings.models", label: "Models" },
  { kind: "settings.vault", label: "Vault" },
  { kind: "settings.skills", label: "Skills" },
  { kind: "settings.connectors", label: "Connectors" },
  { kind: "settings.apps", label: "Apps" },
  { kind: "settings.updates", label: "Updates" },
]

// Ambient widgets (Phase 5): a manual way to open the rails - the deck also
// summons them by itself (needs-input auto-opens Now) and the agent can
// summon any of them by name.
export const AMBIENT_WIDGETS: readonly LauncherEntry[] = [
  { kind: "now", label: "Now" },
  { kind: "briefing", label: "Briefing" },
  { kind: "workflows", label: "Workflows" },
]

export const SETTINGS_LAUNCHER_TITLE = "Settings"

/**
 * Best-effort: off-Tauri (browser dev / jsdom) the invoke rejects and the
 * launcher simply stays put. macOS owns the placement of the new panel
 * window.
 */
function openWidget(ctx: PanelCtx, kind: string): void {
  ctx.invoke("open_widget", { kind }).catch(() => {})
}

function LauncherRow({ ctx, entry }: { ctx: PanelCtx; entry: LauncherEntry }) {
  return (
    <SideNavItem
      label={entry.label}
      data-testid={entry.kind}
      endContent={<span aria-hidden="true">↗</span>}
      onClick={() => openWidget(ctx, entry.kind)}
    />
  )
}

export function SettingsLauncherPanel({ ctx }: { ctx: PanelCtx }) {
  return (
    <SideNav style={{ width: "100%", height: "100%" }}>
      <SideNavSection id="launcher-list" title="Settings">
        {SETTINGS_PANELS.map((entry) => (
          <LauncherRow key={entry.kind} ctx={ctx} entry={entry} />
        ))}
      </SideNavSection>
      <Divider />
      <SideNavSection id="launcher-widgets" title="Widgets">
        {AMBIENT_WIDGETS.map((entry) => (
          <LauncherRow key={entry.kind} ctx={ctx} entry={entry} />
        ))}
      </SideNavSection>
    </SideNav>
  )
}
