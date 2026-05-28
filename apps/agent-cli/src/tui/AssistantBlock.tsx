import { SyntaxStyle } from "@opentui/core"

// The MarkdownRenderable requires a SyntaxStyle for code-fence highlighting.
// SyntaxStyle.create() reads the native render lib, which is only initialized
// once a renderer is active — so we create it lazily on first render (always
// inside an active renderer) and memoize it for reuse across all blocks.
let cachedStyle: SyntaxStyle | undefined
const getSyntaxStyle = (): SyntaxStyle => {
  if (cachedStyle === undefined) cachedStyle = SyntaxStyle.create()
  return cachedStyle
}

export type AssistantBlockProps = { text: string }

export const AssistantBlock = (props: AssistantBlockProps) => {
  return <markdown content={props.text} syntaxStyle={getSyntaxStyle()} />
}
