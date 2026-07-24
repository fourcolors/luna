/**
 * WidgetChrome.tsx - React 19 + Astryx port of widget.html's title-bar
 * CHROME only: the `.bar-title` text and the `.collapse-moon-btn` glyph.
 *
 * `CollapseMoonButton` is also reused as-is by chat.html's title bar (see
 * ../chat/chat-chrome-mount.tsx) - the collapse-into-moon affordance and its
 * `WidgetChromeCtx` contract are identical on both pages, not a
 * widget-specific behavior, so chat.html imports this module rather than
 * forking a duplicate component.
 *
 * SCOPE (see recon notes on the conversion task): widget.html's
 * `#content-area` renders agent/user-controlled artifact content through the
 * FROZEN sandbox pipeline (renderWidget/renderMcpApp/renderHtmlDoc/
 * renderMarkdownDoc/renderCode in widget.html's own inline <script>, backed
 * by the hand-vendored widget-sandbox.js IIFE whose behavior is enforced
 * byte-for-byte against packages/ui-shared/src/widget-sandbox.ts by
 * widget-sandbox.parity.test.ts) - none of that moves to React, and no
 * Astryx component is ever mounted inside the sandboxed iframe or the
 * markdown/code panes it shares content-area with. Astryx only reaches the
 * surrounding window-envelope chrome: this file.
 *
 * VISUAL PARITY: `.title-bar`/`.bar-start`/`.bar-end`/`.bar-title`'s CSS
 * (vendor/moon-theme.css) stays completely untouched and still governs
 * layout/skin/typography - React renders INSIDE those existing classed
 * elements, not instead of them. Every rule in moon-theme.css is unlayered;
 * Astryx's own component CSS ships entirely inside `@layer astryx-base` (see
 * astryx-moon-bridge.css's module doc) - per the CSS cascade-layers spec,
 * unlayered rules always win over layered ones regardless of selector
 * specificity or source order. So applying the original `bar-title` /
 * `collapse-moon-btn` class names to the Astryx-rendered elements below
 * reuses moon-theme.css's existing rules verbatim and wins every visual
 * property Astryx would otherwise set (font, color, size, background,
 * border, radius) - pixel parity with the pre-conversion markup, for free,
 * while the components underneath still bring Astryx's real behavior
 * (focus-visible outline, aria-disabled handling, keyboard activation).
 *
 * `<Text as="span" className="bar-title">` mounts NESTED one level inside
 * widget.html's original `#bar-title-root` span, which itself keeps the
 * `bar-title` class (and its "Loading…" pre-mount fallback text) - it is
 * still the real `.bar-title` flex item (flex/ellipsis properties only apply
 * to a DIRECT child of `.title-bar`'s flex box). Font/color/size/
 * letter-spacing are CSS-inherited properties, so they would reach a plain
 * text child either way; Text's className additionally repeats `bar-title`
 * on its own rendered span purely so the same unlayered rule wins there too,
 * with no visual difference (an inline span has no truncation box of its
 * own - the outer span's `overflow:hidden`/`text-overflow:ellipsis` is what
 * actually clips). `.bar-end` has no such nesting concern: it already only
 * lays out its own children via `justify-content:flex-end`, so the Button
 * mounts as a normal child of the (real, boxed) `.bar-end` host.
 */
import { Button, Text } from "../astryx-kit"
import { useMoonSelector, type MoonStore } from "../state/store"
import type { WidgetTitleAction, WidgetTitleState } from "./widgetTitleReducer"

/** The slice of widget.html's inline-script ctx the chrome needs. */
export interface WidgetChromeCtx {
  /**
   * Invoke a Tauri command. Off-Tauri (browser dev / jsdom / no __TAURI__)
   * this rejects - the collapse handler swallows that, matching the
   * superseded inline listener's `.catch(function () {})`.
   */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
}

function CollapseMoonGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      <path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a6.5 6.5 0 1 1-7.54-7.54A9.05 9.05 0 0 0 12 3z" />
    </svg>
  )
}

/** Renders into widget.html's `#bar-title-root` (a `display:contents` host). */
export function WidgetTitleText({
  store,
}: {
  store: MoonStore<WidgetTitleState, WidgetTitleAction>
}) {
  const title = useMoonSelector(store, (state) => state.title)
  return (
    <Text as="span" className="bar-title">
      {title}
    </Text>
  )
}

/**
 * Renders into widget.html's `#bar-end-root` (the real `.bar-end` div).
 * Collapse-into-moon is a Luna-specific workspace action, intentionally
 * separate from the native yellow button's per-window minimize behavior.
 */
export function CollapseMoonButton({ ctx }: { ctx: WidgetChromeCtx }) {
  return (
    <Button
      label="Collapse into the moon"
      variant="ghost"
      size="sm"
      isIconOnly
      className="collapse-moon-btn"
      icon={<CollapseMoonGlyph />}
      onClick={() => {
        ctx.invoke("collapse_to_moon").catch(() => {
          /* best-effort, matches the superseded inline listener */
        })
      }}
    />
  )
}
