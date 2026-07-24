/**
 * widgetTitleReducer.ts - pure state/reducer for widget.html's title-bar text.
 *
 * Framework-agnostic on purpose (no DOM, no React) so it is trivially unit
 * testable and so the mounted title text consumes it via useMoonSelector
 * (src/state/store.ts) instead of a transport callback poking `#bar-title`'s
 * textContent directly - the vanilla content-area render() pipeline in
 * widget.html (kept byte-for-byte, see that file's module doc) now only
 * calls `window.__widgetChrome.setTitle(text)`; only this reducer + the
 * mounted React component (WidgetChrome.tsx) decide what actually renders.
 *
 * Mirrors the wire behavior of the superseded inline `barTitle.textContent =
 * titleText` assignment exactly: whatever string widget.html's render()
 * computes ("<title> · v<version>", "Loading…", "Unknown panel", etc.)
 * becomes the new title verbatim - this reducer applies no formatting of its
 * own.
 */

export const WIDGET_DEFAULT_TITLE = "Loading…"

export interface WidgetTitleState {
  readonly title: string
}

export type WidgetTitleAction = { readonly type: "set-title"; readonly title: string }

export function initialWidgetTitleState(): WidgetTitleState {
  return { title: WIDGET_DEFAULT_TITLE }
}

export function reduceWidgetTitle(
  state: WidgetTitleState,
  action: WidgetTitleAction,
): WidgetTitleState {
  switch (action.type) {
    case "set-title":
      return action.title === state.title ? state : { title: action.title }
    default:
      return state
  }
}
