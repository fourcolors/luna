/**
 * main-index.tsx - React 19 + Astryx boot entry for index.html, the Moon
 * "orb <-> widgets" hub shell.
 *
 * Real conversion (not the scaffold-phase invisible probe every other page
 * still uses - see boot.tsx's module doc): index.html's <body> is now just
 * the #moon-hub-root mount point; every DOM node the vanilla script used to
 * build (the moon container, its pips, the setup wizard) is rendered by
 * MoonHubApp and its children. index.html's <head> - the Google Fonts
 * links, the watercolor <style> block, and every classic vendor <script>
 * (moon-appearance.js pre-paint stamping, moon-protocol.js, moon-ws.js,
 * moon-session.js, pool-engine.js, moon-hub.js) - is untouched and still
 * loads first, synchronously, ahead of this deferred module script; those
 * vendor globals (LunaProtocol/LunaWS/MoonSession/PoolEngineHelper/
 * MoonHubManager) are exactly what hubEngines.ts's HubController reads.
 */
import "@astryxdesign/core/reset.css"
import "@astryxdesign/core/astryx.css"
import "./styles/astryx-moon-bridge.css"
import { createRoot } from "react-dom/client"
import { MoonHubApp } from "./hub/MoonHubApp"

const host = document.getElementById("moon-hub-root")
if (host) {
  createRoot(host).render(<MoonHubApp />)
}
