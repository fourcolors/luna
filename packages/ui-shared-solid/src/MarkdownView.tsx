/**
 * MarkdownView (Solid port) — renders assistant message text as GFM
 * markdown with Shiki-highlighted fenced code blocks. Mirrors
 * packages/ui-shared/src/MarkdownView.tsx (React).
 *
 * Streaming policy (carried over from React version): the parent only
 * mounts MarkdownView for FINALIZED assistant messages. The in-flight
 * bubble keeps rendering plain text so high-frequency delta updates
 * don't churn Shiki tokenization or flicker between code/prose as
 * fences open.
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
            const source = String(codeProps.children).replace(/\n$/, "")
            // Inline code (no class) → render as <code>
            if (!cls) {
              return <code>{codeProps.children}</code>
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
