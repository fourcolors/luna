import { SyntaxStyle } from "@opentui/core"

// The MarkdownRenderable requires a SyntaxStyle for code-fence highlighting.
// SyntaxStyle.create() reads the native render lib, which is only initialized
// once a renderer is active — so we create it lazily on first render (always
// inside an active renderer) and memoize it for reuse across all blocks.
//
// ASSUMPTION: a single renderer lives for the whole process (the CLI runs one
// `render()` then exits). The cached style latches to that renderer's native
// lib; if a *new* renderer were ever created in the same process (e.g. a
// re-mount), this pointer would be stale and <markdown> would fail. Reset
// cachedStyle if that lifecycle ever changes.
let cachedStyle: SyntaxStyle | undefined
const getSyntaxStyle = (): SyntaxStyle => {
  if (cachedStyle === undefined) cachedStyle = SyntaxStyle.create()
  return cachedStyle
}

export type AssistantBlockProps = { text: string }

export const AssistantBlock = (props: AssistantBlockProps) => {
  return <markdown content={props.text} syntaxStyle={getSyntaxStyle()} />
}
