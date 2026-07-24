// main-chat.tsx - React 19 + Astryx boot entry for chat.html.
// Scaffold phase: mounts the invisible boot probe only; chat.html's existing
// vanilla content and vendor scripts keep running unchanged. See boot.tsx.
import { mountMoonReactRoot } from "./boot"

mountMoonReactRoot("chat")
