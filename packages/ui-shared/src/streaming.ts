/**
 * Helpers for rendering markdown while it is still streaming in.
 *
 * The naive approach — feed the partial text straight to a markdown
 * renderer on every delta — produces two visible bugs:
 *
 *   1. **Fence flicker.** An unbalanced ```` ``` ```` opener swallows every
 *      character after it into a code block; the moment the closer arrives
 *      the same characters re-flow as prose. The user sees the message
 *      visibly snap between "code" and "prose" as fences open/close.
 *   2. **Code-block content rendered as raw markdown.** A partial fence
 *      (no closer yet) is just a `` ``` `` line and a bunch of plain text
 *      to most parsers, so the body of an in-progress code block shows up
 *      as paragraphs/lists/etc. — wrong syntax tree, wrong styling.
 *
 * The fix is a tiny pre-processor that "completes" the partial source
 * before parsing so the parser always sees a balanced document. We don't
 * try to be clever about partial inline emphasis (`**foo` etc.) — those
 * are short, self-balancing, and look fine as raw characters for the
 * one-keystroke window they're unclosed.
 *
 * Used by both the Solid chat panel (in-flight bubble) and Luna Moon's
 * `renderMarkdownStreaming` wrapper.
 */

/**
 * If `src` contains an odd number of ```` ``` ```` fence markers, append a
 * synthetic closing fence so a downstream markdown parser sees a complete
 * code block. No-op when fences are already balanced or absent.
 *
 * Pure / referentially transparent — safe to call on every keystroke.
 */
export const closeOpenFences = (src: string): string => {
  if (!src) return src
  const matches = src.match(/```/g)
  if (!matches) return src
  if (matches.length % 2 === 0) return src
  // Odd count → one fence is still open. Append a newline if the source
  // doesn't already end with one, then the closing fence.
  return src.endsWith("\n") ? `${src}\`\`\`` : `${src}\n\`\`\``
}
