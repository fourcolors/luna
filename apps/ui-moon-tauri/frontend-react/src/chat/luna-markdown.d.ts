/**
 * luna-markdown.d.ts - ambient type for `window.LunaMarkdown`, the vendored
 * markdown-render pipeline chat.html loads as a classic <script> (Moon's
 * vendor/ tree has no bundler - see moon-markdown.js's own header comment).
 *
 * Declares EXACTLY the five members the IIFE attaches at
 * apps/ui-moon-tauri/frontend/vendor/moon-markdown.js:341-347 - nothing
 * more, nothing less. luna-markdown.parity.test.ts loads that file at test
 * time and fails if the vendor script and this declaration ever disagree on
 * that set.
 *
 * moon-markdown.js is FROZEN (Operator hard rule): this is a type
 * declaration only, never a port or a wrapper.
 */

/**
 * Streaming-render coalescer - schedules one rAF-batched innerHTML swap per
 * bubble no matter how many `append()` calls land between frames. `bubble`
 * is the message DOM element the streamed text renders into.
 */
export interface LunaStreamRenderApi {
  schedule: (bubble: HTMLElement | null | undefined) => void
  cancel: (bubble: HTMLElement | null | undefined) => void
  append: (bubble: HTMLElement | null | undefined, delta: string) => void
  reset: (bubble: HTMLElement | null | undefined, text: string) => void
  finalize: (bubble: HTMLElement | null | undefined, finalText: string) => void
}

/** The exact shape `window.LunaMarkdown` carries - see the file header. */
export interface LunaMarkdownApi {
  /** Renders complete markdown source to sanitized HTML. */
  renderMarkdown: (src: string) => string
  /** Appends a synthetic closing fence when `src` has an unbalanced ``` opener. */
  closeOpenFences: (src: string) => string
  /** `renderMarkdown(closeOpenFences(src))` - safe to call on partial/streaming text. */
  renderMarkdownStreaming: (src: string) => string
  /** Decorates freshly-rendered `.code-block` elements with syntax highlight + copy button. */
  enhanceCodeBlocks: (root: Element | DocumentFragment | null | undefined) => void
  StreamRender: LunaStreamRenderApi
}

declare global {
  interface Window {
    /**
     * Attached by the vendor IIFE at parse time (a synchronous classic
     * <script>), but widened `undefined` on purpose: off-Tauri static
     * analysis / any module evaluated before that script tag runs must not
     * assume it is set.
     */
    LunaMarkdown?: LunaMarkdownApi
  }
}
