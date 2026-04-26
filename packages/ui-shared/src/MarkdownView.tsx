/**
 * MarkdownView — renders assistant message text as GFM markdown with
 * Shiki-highlighted fenced code blocks.
 *
 * Loaded lazily (via React.lazy from the call site) so neither
 * react-markdown nor Shiki land in the initial bundle. The CodeBlock
 * component lives in its own module so the artifact panel (eager) can
 * reuse it without forcing the markdown chunk to load.
 *
 * Streaming policy: the parent only mounts MarkdownView for FINALIZED
 * assistant messages (post `assistant-done`). The in-flight bubble keeps
 * rendering plain text so the high-frequency delta updates don't churn
 * Shiki tokenization or flicker between code/prose as fences open.
 */
import { memo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { CodeBlock, CodeBlockFallback, canonLang } from "./CodeBlock.js"

interface Props {
  readonly text: string
}

const MarkdownView = memo(({ text }: Props) => {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...rest }) {
            const match = /language-([\w-]+)/.exec(className || "")
            const raw = match?.[1]
            const lang = canonLang(raw)
            const source = String(children).replace(/\n$/, "")
            // Inline code (no className) → render as <code>
            if (!className) {
              return <code {...rest}>{children}</code>
            }
            if (lang) return <CodeBlock lang={lang} source={source} />
            // Fenced block with disallowed/unknown lang → plain <pre>.
            return <CodeBlockFallback source={source} />
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
MarkdownView.displayName = "MarkdownView"

export default MarkdownView
