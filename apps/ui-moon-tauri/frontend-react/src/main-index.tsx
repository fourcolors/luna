// main-index.tsx - React 19 + Astryx boot entry for index.html.
// Scaffold phase: mounts the invisible boot probe only; index.html's existing
// vanilla content and vendor scripts keep running unchanged. See boot.tsx.
import { mountMoonReactRoot } from "./boot"

mountMoonReactRoot("index")
