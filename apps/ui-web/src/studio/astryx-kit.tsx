// astryx-kit.tsx — single re-export surface for every @astryxdesign/core
// primitive Studio uses. Import Astryx components from here, not from
// "@astryxdesign/core/*" or the "@astryxdesign/core" barrel directly.
//
// Why this exists: the per-component Astryx port (feat/astryx-ui) had each
// file reach into the library on its own, and two files (skills-panel.jsx,
// studio-widget.jsx) drifted onto the top-level barrel import
// (`from "@astryxdesign/core"`) while the rest used per-component subpath
// imports (`from "@astryxdesign/core/Button"`). Both resolve today, but they
// are not equivalent long-term: subpath imports are what keeps a
// non-tree-shaking consumer (or a bundler running without sideEffects:false
// on the barrel) from pulling in every Astryx component Studio doesn't use.
// Centralizing here means:
//   - one place enforces the subpath-import convention (every re-export
//     below pulls from its own "@astryxdesign/core/<Name>" subpath);
//   - a future Studio-wide default (e.g. a shared `size` or a themed
//     wrapper) has one call site to change instead of eighteen;
//   - a component rename/removal in an Astryx version bump surfaces as one
//     diff here instead of a grep-and-replace across every panel.
//
// Keep this file to re-exports only — no JSX, no wrapper components. A
// prop-level default belongs on the specific call site until at least two
// files need the same override, at which point it earns a named wrapper
// here (see the module doc for the "two call sites" bar).
export { Banner } from "@astryxdesign/core/Banner"
export { Badge } from "@astryxdesign/core/Badge"
export { Button } from "@astryxdesign/core/Button"
export { Card } from "@astryxdesign/core/Card"
export { CheckboxInput } from "@astryxdesign/core/CheckboxInput"
export { Collapsible } from "@astryxdesign/core/Collapsible"
export {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu"
export { EmptyState } from "@astryxdesign/core/EmptyState"
export { FileInput } from "@astryxdesign/core/FileInput"
export { IconButton } from "@astryxdesign/core/IconButton"
export { NumberInput } from "@astryxdesign/core/NumberInput"
export { Selector } from "@astryxdesign/core/Selector"
export { Slider } from "@astryxdesign/core/Slider"
export { Switch } from "@astryxdesign/core/Switch"
export { TextInput } from "@astryxdesign/core/TextInput"
export { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton"
