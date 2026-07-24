/**
 * widget-chrome-mount.tsx - boots the React 19 + Astryx title-bar chrome
 * (WidgetChrome.tsx) into widget.html's `#bar-title-root` / `#bar-end-root`
 * mount points, replacing the superseded vanilla `#bar-title` textContent
 * assignment and `#collapse-moon-btn` click listener that used to live in
 * widget.html's own inline <script>.
 *
 * widget.html's inline script (unchanged otherwise - see its module doc)
 * still owns the WebSocket connection and every `#content-area` render path;
 * it hands this module a single `WidgetChromeCtx` at boot and, from then on,
 * only calls the returned handle's `setTitle()` - never touches the title
 * DOM directly - so a transport callback's whole job stays "dispatch an
 * action", exactly like every other converted panel's contract
 * (see src/panels/agents/agentsReducer.ts's module doc for the same rule).
 */
import { createRoot } from "react-dom/client"
import { createStore } from "../state/store"
import { CollapseMoonButton, WidgetTitleText, type WidgetChromeCtx } from "./WidgetChrome"
import {
  initialWidgetTitleState,
  reduceWidgetTitle,
  type WidgetTitleAction,
  type WidgetTitleState,
} from "./widgetTitleReducer"

export interface WidgetChromeHandle {
  /** Replaces the title-bar text. Safe to call before or after mount. */
  setTitle: (title: string) => void
}

declare global {
  interface Window {
    /**
     * Set once mountWidgetChrome() runs (main-widget.tsx, at module-load
     * time - always before the inline script's async WS-driven render()
     * calls, since a deferred `type="module"` script always executes before
     * any network/Tauri-invoke round trip can complete). Widened `undefined`
     * on purpose: off-Tauri static analysis / early calls must not assume it
     * is set.
     */
    __widgetChrome?: WidgetChromeHandle
  }
}

/**
 * Mounts both chrome pieces and returns the imperative handle widget.html's
 * inline script uses in place of direct DOM writes. `titleHost`/`endHost`
 * missing (e.g. a harness that only stubs part of the page) degrades to a
 * no-op mount for that piece rather than throwing - matches every other
 * mount*Panel's `if (host) createRoot(host).render(...)` guard.
 */
export function mountWidgetChrome(ctx: WidgetChromeCtx): WidgetChromeHandle {
  const store = createStore<WidgetTitleState, WidgetTitleAction>(
    reduceWidgetTitle,
    initialWidgetTitleState(),
  )

  const titleHost = document.getElementById("bar-title-root")
  if (titleHost) {
    createRoot(titleHost).render(<WidgetTitleText store={store} />)
  }

  const endHost = document.getElementById("bar-end-root")
  if (endHost) {
    createRoot(endHost).render(<CollapseMoonButton ctx={ctx} />)
  }

  return {
    setTitle: (title) => store.dispatch({ type: "set-title", title }),
  }
}
