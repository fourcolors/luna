/**
 * chat-chrome-mount.tsx - boots the React 19 + Astryx title-bar chrome into
 * chat.html's `#bar-title-root` / `#collapse-moon-btn-root` mount points.
 *
 * SCOPE: this is the same "window-envelope chrome" boundary
 * ../widget/WidgetChrome.tsx already converted for widget.html - "Astryx
 * only reaches the surrounding window-envelope chrome", not page content.
 * chat.html's collapse-into-moon button is the literal same affordance as
 * widget.html's (same `invoke('collapse_to_moon')`, same best-effort catch),
 * so this reuses WidgetChrome's CollapseMoonButton/WidgetChromeCtx directly
 * instead of forking a duplicate component.
 *
 * chat.html's title never changes at runtime - confirmed by grepping the
 * pre-conversion file: nothing ever wrote `#bar-title`'s textContent, it was
 * always the static literal "Luna" - so unlike widget.html's per-thread
 * title this chrome needs no store/reducer; the text mounts as a plain
 * literal via Astryx's Text.
 *
 * Everything else in chat.html's title bar (redock-btn) stays
 * exactly as before: those are chat-specific, state-driven affordances
 * (pinned-floater detection, live composer-draft capture, Tauri window
 * handles) outside the shared window-envelope chrome boundary this mount
 * covers - not converted here.
 */
import { createRoot, type Root } from "react-dom/client"
import { Text } from "../astryx-kit"
import { CollapseMoonButton, type WidgetChromeCtx } from "../widget/WidgetChrome"

// Roots this module owns. React 19 schedules its work on a macrotask, so a
// root that is never unmounted keeps firing after a test's jsdom environment
// is torn down - surfacing as an unattributable `ReferenceError: window is
// not defined` charged to whichever test file happens to run next in the same
// worker. Tracking them is what makes unmountChatChrome() possible.
let roots: Root[] = []

/**
 * Unmount whatever this module previously mounted. Idempotent, and safe on a
 * container that has already been detached (best-effort per root).
 *
 * Production never needs this - chat.html mounts its chrome once for the life
 * of the window - but any harness that boots the page more than once does.
 */
export function unmountChatChrome(): void {
  for (const root of roots) {
    try { root.unmount() } catch { /* container already gone - best effort */ }
  }
  roots = []
}

/**
 * Mounts both chrome pieces. `titleHost`/`collapseHost` missing (e.g. a
 * harness that only stubs part of the page) degrades to a no-op mount for
 * that piece rather than throwing - matches every other mount*'s
 * `if (host) createRoot(host).render(...)` guard.
 */
export function mountChatChrome(ctx: WidgetChromeCtx): void {
  // Re-mounting without releasing the previous roots would leak them.
  unmountChatChrome()

  const titleHost = document.getElementById("bar-title-root")
  if (titleHost) {
    const titleRoot = createRoot(titleHost)
    roots.push(titleRoot)
    titleRoot.render(
      <Text as="span" className="bar-title">
        Luna
      </Text>,
    )
  }

  const collapseHost = document.getElementById("collapse-moon-btn-root")
  if (collapseHost) {
    const collapseRoot = createRoot(collapseHost)
    roots.push(collapseRoot)
    collapseRoot.render(<CollapseMoonButton ctx={ctx} />)
  }
}
