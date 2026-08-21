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
import { createRoot } from "react-dom/client"
import { Text } from "../astryx-kit"
import { CollapseMoonButton, type WidgetChromeCtx } from "../widget/WidgetChrome"

/**
 * Mounts both chrome pieces. `titleHost`/`collapseHost` missing (e.g. a
 * harness that only stubs part of the page) degrades to a no-op mount for
 * that piece rather than throwing - matches every other mount*'s
 * `if (host) createRoot(host).render(...)` guard.
 */
export function mountChatChrome(ctx: WidgetChromeCtx): void {
  const titleHost = document.getElementById("bar-title-root")
  if (titleHost) {
    createRoot(titleHost).render(
      <Text as="span" className="bar-title">
        Luna
      </Text>,
    )
  }

  const collapseHost = document.getElementById("collapse-moon-btn-root")
  if (collapseHost) {
    createRoot(collapseHost).render(<CollapseMoonButton ctx={ctx} />)
  }
}
