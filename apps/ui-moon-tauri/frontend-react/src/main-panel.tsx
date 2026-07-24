// main-panel.tsx - React 19 + Astryx boot entry for panel.html.
// Scaffold phase: mounts the invisible boot probe only; panel.html's existing
// vanilla content and vendor scripts keep running unchanged. See boot.tsx.
import { mountMoonReactRoot } from "./boot"

mountMoonReactRoot("panel")
