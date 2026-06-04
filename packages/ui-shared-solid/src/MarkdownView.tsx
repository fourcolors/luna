/**
 * MarkdownView (Solid port) — renders assistant message text as GFM
 * markdown with Shiki-highlighted fenced code blocks. Mirrors
 * packages/ui-shared/src/MarkdownView.tsx (React).
 *
 * Streaming policy: used for BOTH finalized assistant messages AND the
 * in-flight bubble (ChatPanel.tsx). Callers rendering in-flight text
 * should run it through `closeOpenFences()` from `@luna/ui-shared/core`
 * first, so an unbalanced ``` opener doesn't flicker the rest of the
 * message between code and prose as fences open/close. Inline emphasis
 * is short and self-balancing, so we tolerate the keystroke-window of
 * raw `**foo` characters rather than over-engineering.
 */
import { type Component } from "solid-js"
import { SolidMarkdown } from "solid-markdown"
import remarkGfm from "remark-gfm"
import { CodeBlock, CodeBlockFallback, canonLang } from "./CodeBlock.jsx"

interface Props {
  readonly text: string
}

export const MarkdownView: Component<Props> = (props) => {
  return (
    <div class="markdown">
      <SolidMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: (codeProps) => {
            // Solid uses `class` (not React's `className`); solid-markdown
            // forwards the `language-xxx` class on fenced blocks here.
            const cls = codeProps.class ?? ""
            const match = /language-([\w-]+)/.exec(cls)
            const raw = match?.[1]
            const lang = canonLang(raw)
            // solid-markdown passes `children` as a Solid component getter,
            // not a plain string — extracting source text from it produces
            // "function () { [native code] }". Instead, read the raw text
            // from the hast node that solid-markdown always passes as `node`.
            // For inline code the hast node is an element whose first child
            // is a text node; for fenced blocks it is a `code` element whose
            // first child carries the raw source. `node` is typed as a hast
            // `Element` whose children are `Comment | Element | Text`; only
            // the text node carries `value`, so narrow on `type` before read.
            const first = codeProps.node.children?.[0]
            const source = (first?.type === "text" ? first.value : "").replace(
              /\n$/,
              "",
            )
            // Inline code (no class) → render as <code>
            if (!cls) {
              return <code>{source}</code>
            }
            if (lang) return <CodeBlock lang={lang} source={source} />
            // Fenced block with disallowed/unknown lang → plain <pre>.
            return <CodeBlockFallback source={source} />
          },
        }}
      >
        {props.text}
      </SolidMarkdown>
    </div>
  )
}
