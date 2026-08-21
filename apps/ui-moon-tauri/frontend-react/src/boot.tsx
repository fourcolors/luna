/**
 * boot.tsx - shared React 19 + Astryx boot layer for all four Moon page
 * entries (index/chat/panel/widget).
 *
 * SCAFFOLD PHASE: every page keeps running its existing vanilla content
 * (WebSocketEngine/PoolEngine/ThreadDrawerEngine in chat.html, the per-type
 * modules in panel.html, widget-sandbox.js in widget.html, the crescent hub
 * in index.html) completely unchanged - this only proves the new pipeline
 * (React 19 + Astryx 0.1.8 + the shared @luna/ui-shared reducer, all through
 * a real Vite bundler) mounts, renders, and stays wired end to end, ahead of
 * the actual panel-by-panel conversion (next phase).
 *
 * The mounted root is deliberately invisible (renders null, and its host
 * <div> is display:none) so this scaffold makes ZERO pixel change to any
 * page - no screenshot proof is owed for this commit (see CLAUDE.md's UI
 * screenshot rule: "logic/build/test-only edits with no visual effect are
 * exempt"). Panel conversions that mount real Astryx UI will owe that proof.
 *
 * Import order matters for the boot-layer contract (astryx-moon-bridge.css
 * documents why it is nonetheless layer-safe regardless of order):
 *   1. Astryx reset + component CSS (@layer reset / @layer astryx-base)
 *   2. the Moon<->Astryx token bridge (unlayered, scoped to .moon-astryx-root)
 * Moon's own vendor/moon-palette.css, moon-skins.css, moon-theme.css and
 * vendor/moon-appearance.js's pre-paint stamping stay exactly where each
 * page's <head> already puts them - untouched, still first, still
 * synchronous - since this module loads via a deferred `type="module"`
 * <script> at the end of <body>, always after them.
 */
import { createRoot } from "react-dom/client"
import { useEffect } from "react"
import "./styles/astryx-layer-order.css"
import "@astryxdesign/core/reset.css"
import "@astryxdesign/core/astryx.css"
import "./styles/astryx-moon-bridge.css"
import { createMoonStore, useMoonSelector, type MoonStore } from "./state/store"

export type MoonPage = "index" | "chat" | "panel" | "widget"

declare global {
  interface Window {
    __MoonReactInternals?: {
      page: MoonPage
      mounted: boolean
      reactVersion: string
      astryxVersion: string
      eventCount: number
    }
  }
}

// One store per document (each Moon page/window is its own document - Tauri
// gives every window/webview its own JS realm - so a module-level singleton
// here is exactly the ui-web pattern's per-mount equivalent, not a cross-page
// global).
let sharedStore: MoonStore | null = null
function getSharedStore(): MoonStore {
  if (sharedStore === null) sharedStore = createMoonStore()
  return sharedStore
}

function ReactBootProbe({ page }: { page: MoonPage }) {
  const store = getSharedStore()
  const eventCount = useMoonSelector(store, (s) => s.events.length)

  useEffect(() => {
    window.__MoonReactInternals = {
      page,
      mounted: true,
      reactVersion: "19",
      astryxVersion: "0.1.8",
      eventCount,
    }
  }, [page, eventCount])

  // Renders nothing - see module doc. The host <div> (mountMoonReactRoot)
  // carries display:none as a belt-and-suspenders second guarantee.
  return null
}

/**
 * Mount the boot-layer probe into `page`'s document. Safe to call multiple
 * times (idempotent - reuses the same host element if already mounted),
 * though each entry only calls it once at module load.
 */
export function mountMoonReactRoot(page: MoonPage): void {
  const existing = document.getElementById("moon-react-root")
  if (existing) return

  const host = document.createElement("div")
  host.id = "moon-react-root"
  host.className = "moon-astryx-root"
  host.style.display = "none"
  document.body.appendChild(host)

  createRoot(host).render(<ReactBootProbe page={page} />)
}
