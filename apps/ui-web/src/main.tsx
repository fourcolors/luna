import { createRoot } from "react-dom/client"
// Side effect: stamps data-palette/theme/chrome/grain/font on <html> pre-paint,
// and keeps them live across tabs (shared convention with Moon's appearance).
import "@luna/design-system/appearance"
// The watercolor token + primitive cascade (tokens → studio → final).
import "@luna/design-system/css"
// The ported Final design root. No StrictMode: the design's effects (drag
// listeners, intervals, SpeechSynthesis, the CustomEvent bus) were authored
// for a single mount and are not all double-invoke-safe.
import { StudioApp } from "./studio/final-app.jsx"

const root = document.getElementById("root")
if (!root) throw new Error("missing #root")

createRoot(root).render(<StudioApp />)
