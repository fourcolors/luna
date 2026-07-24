// main-widget.tsx - React 19 + Astryx boot entry for widget.html.
// Scaffold phase: mounts the invisible boot probe only; widget.html's existing
// vanilla content and vendor scripts keep running unchanged. See boot.tsx.
import { mountMoonReactRoot } from "./boot"

mountMoonReactRoot("widget")
