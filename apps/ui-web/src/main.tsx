import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// Side effect: stamps data-palette/theme/chrome/grain/font on <html> pre-paint,
// and keeps them live across tabs (shared convention with Moon's appearance).
import "@luna/design-system/appearance"
// The watercolor token + primitive cascade (tokens → studio → final).
import "@luna/design-system/css"
import { App } from "./App"

const root = document.getElementById("root")
if (!root) throw new Error("missing #root")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
