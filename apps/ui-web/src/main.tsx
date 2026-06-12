/* @refresh reload */
import { render } from "solid-js/web"
// Side effect: stamps data-palette/theme/chrome/grain on <html> pre-render.
import "./appearance.js"
import { App } from "./App.jsx"
import "./watercolor.css"
import "./styles.css"

const root = document.getElementById("root")
if (!root) throw new Error("missing #root")

render(() => <App />, root)
