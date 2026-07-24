import { createRoot } from "react-dom/client"
// Astryx component library CSS - reset + compiled component styles. Loaded
// BEFORE @luna/design-system/css so Luna's own (unlayered) rules win the
// cascade for anything both systems touch; Astryx's own styles live in
// `@layer astryx-base`, which unlayered CSS always outranks regardless of
// source order (see astryx-watercolor-theme.css for the full rationale).
import "@astryxdesign/core/reset.css"
import "@astryxdesign/core/astryx.css"
// Side effect: stamps data-palette/theme/chrome/grain/font on <html> pre-paint,
// and keeps them live across tabs (shared convention with Moon's appearance).
import "@luna/design-system/appearance"
// The watercolor token + primitive cascade (tokens → studio → final).
import "@luna/design-system/css"
// Bridges Astryx's --color-*/--radius-*/etc. tokens onto Luna's watercolor
// tokens so Astryx components (e.g. Button in settings-panel.jsx) render in
// the watercolor look. Must come after @luna/design-system/css: it reads
// --paper/--ink/--accent/etc, which that cascade defines.
import "./styles/astryx-watercolor-theme.css"
// Dev-ops panel styles (settings/connectors/obs/artifacts/skills/vault/workflows).
import "./studio/devops-panels.css"
// The ported Final design root. No StrictMode: the design's effects (drag
// listeners, intervals, SpeechSynthesis, the CustomEvent bus) were authored
// for a single mount and are not all double-invoke-safe.
import { StudioApp } from "./studio/final-app.jsx"

const root = document.getElementById("root")
if (!root) throw new Error("missing #root")

createRoot(root).render(<StudioApp />)
