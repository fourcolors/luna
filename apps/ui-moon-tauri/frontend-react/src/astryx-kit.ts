// astryx-kit.ts - single re-export surface for @astryxdesign/core primitives
// used inside Moon's React surface. Mirrors apps/ui-web/src/studio/astryx-kit.tsx
// (same convention, same rationale): import Astryx components from here, not
// from "@astryxdesign/core/*" or the top-level barrel directly, so the
// subpath-import convention that keeps a non-tree-shaking consumer from
// pulling in every Astryx component stays enforced from one place.
//
// Panel-by-panel conversion phase: add re-exports here as panels convert,
// following ui-web's per-component subpath pattern. Each export appears
// exactly ONCE in this file even when more than one panel uses it (concurrent
// panel conversions have landed duplicate `export { X } from ...` lines for
// the same component before - that is a SyntaxError, not a harmless
// re-export - so a new panel that needs a component already listed below
// just cites itself in that line's comment instead of adding another line).

// Settings launcher panel (src/panels/SettingsLauncherPanel.tsx): SideNav +
// SideNavSection + SideNavItem for the grouped launcher-button rows, Divider
// between the settings-panels and ambient-widgets sections.
export { SideNav, SideNavSection, SideNavItem } from "@astryxdesign/core/SideNav"
export { Divider } from "@astryxdesign/core/Divider"

// FlowPanel (per-job run inspector, src/panels/FlowPanel.tsx): Button for the
// Refresh action, Badge for the scheduled/on-demand/paused chip, HStack for
// the header row layout.
// settings.voice panel (src/panels/settings-voice/VoicePanel.tsx): Button for
// the model-download action.
export { Button } from "@astryxdesign/core/Button"
export { Badge } from "@astryxdesign/core/Badge"
export { HStack } from "@astryxdesign/core/HStack"

// settings.general panel (src/panels/settings-general/SettingsGeneralPanel.tsx).
// settings.voice panel (src/panels/settings-voice/VoicePanel.tsx): Switch for
// the speak-replies toggle.
export { Switch } from "@astryxdesign/core/Switch"
export { Text } from "@astryxdesign/core/Text"
export { TextInput } from "@astryxdesign/core/TextInput"
export { VStack } from "@astryxdesign/core/VStack"

// settings.models panel (src/panels/settings-models/SettingsModelsPanel.tsx):
// Card per provider row, Banner for the no-server-support / gated-provider /
// saving-status notices, NumberInput for the (unenforced) monthly cap,
// Selector for the per-role model dropdown.
// settings.voice panel (src/panels/settings-voice/VoicePanel.tsx): Banner for
// the "voice unavailable in this build" notice.
export { Card } from "@astryxdesign/core/Card"
export { Selector } from "@astryxdesign/core/Selector"
export { NumberInput } from "@astryxdesign/core/NumberInput"
export { Banner } from "@astryxdesign/core/Banner"

// settings.skills panel (src/panels/settings-skills/SettingsSkillsPanel.tsx):
// ToggleButton for the category/source/enabled-only filter chips (standalone,
// not ToggleButtonGroup - see that file's module doc for why).
// settings.voice panel (src/panels/settings-voice/VoicePanel.tsx):
// ToggleButtonGroup + ToggleButton for the mode segmented control (this one
// IS a real single-select group, unlike settings.skills' standalone chips).
// settings.appearance panel (src/panels/SettingsAppearancePanel.tsx):
// ToggleButtonGroup + ToggleButton (single-select) for the two rows that need
// custom visible content per option - palette swatches and chat-font previews
// - SegmentedControlItem's label is text-only, ToggleButton's `children` isn't.
export { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton"

// settings.appearance panel (src/panels/SettingsAppearancePanel.tsx):
// SegmentedControl + SegmentedControlItem for every plain-text single-select
// row (window skin, theme, panel chrome, chat text size) - real role="radio"
// items replacing the vanilla `.chip`/`.on` button row.
export { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl"

// settings.voice panel (src/panels/settings-voice/VoicePanel.tsx): Slider for
// the silence-hang control, ProgressBar for the model-download progress bar.
export { Slider } from "@astryxdesign/core/Slider"
export { ProgressBar } from "@astryxdesign/core/ProgressBar"

// Agents panel (src/panels/agents/AgentsPanel.tsx): EmptyState for the
// no-thread / capability-unsupported notices (Badge above already covers its
// per-node running/done/error status pill).
export { EmptyState } from "@astryxdesign/core/EmptyState"

// settings.apps panel (src/panels/SettingsAppsPanel.tsx): TextArea for the
// app-content composer field (Button/TextInput/Badge already exported above).
export { TextArea } from "@astryxdesign/core/TextArea"

// Actions panel (src/panels/actions/ActionsPanel.tsx): Card per suggested
// action row, Badge for the status pill, Button for Accept/Dismiss (Card/
// Badge/Button already exported above — this only adds the BadgeVariant
// type the panel's status->variant mapping needs).
export type { BadgeVariant } from "@astryxdesign/core/Badge"

// settings.connectors panel (src/panels/settings-connectors/ConnectorsPanel.tsx):
// CheckboxInput for the per-capability grant checkboxes in the consent sheet
// (Card/Badge/Button/TextInput/Banner/EmptyState already exported above).
export { CheckboxInput } from "@astryxdesign/core/CheckboxInput"

// settings.vault panel (src/panels/settings-vault/SettingsVaultPanel.tsx):
// Badge for the kind/source chips, Button for every action, SegmentedControl
// + SegmentedControlItem for the env-secret/op-token kind choice, Switch for
// the 1Password sync toggle, NumberInput for the poll-seconds field,
// TextInput (text/password) for every text field - all already exported
// above.
