// main-panel.tsx - React 19 + Astryx boot entry for panel.html.
//
// Mounts the invisible boot probe (see boot.tsx) for every panel type -
// panel.html's existing vanilla content and vendor scripts keep running
// unchanged there. On top of that, panel-by-panel conversion has begun:
// React-owned panel types (see panel-boot.tsx's mountReactPanel) are mounted
// here instead of falling through to panel.html's vanilla `panels/<type>.js`
// loader, which panel.html's inline script skips for exactly those types
// (see its REACT_PANEL_TYPES map) so the two renderers can never race or
// double-mount #content-area.
import { mountMoonReactRoot } from "./boot"
import { mountReactPanel } from "./panel-boot"

mountMoonReactRoot("panel")

const panelType = new URLSearchParams(location.search).get("type") ?? ""
if (window.__panelCtx) {
  mountReactPanel(panelType, window.__panelCtx)
}
