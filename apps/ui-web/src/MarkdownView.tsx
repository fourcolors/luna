/**
 * MarkdownView — renders assistant message text as GFM markdown with
 * Shiki-highlighted fenced code blocks.
 *
 * Loaded lazily (via React.lazy from the call site) so neither
 * react-markdown nor Shiki land in the initial bundle. Languages are
 * loaded on demand the first time a fence with that lang appears; the
 * highlighter itself is module-scoped behind a Promise so we only ever
 * pay the WASM init cost once.
 *
 * Streaming policy: the parent only mounts MarkdownView for FINALIZED
 * assistant messages (post `assistant-done`). The in-flight bubble keeps
 * rendering plain text so the high-frequency delta updates don't churn
 * Shiki tokenization or flicker between code/prose as fences open.
 */
import { memo, useEffect, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { HighlighterCore } from "shiki/core"

/** Allowlisted languages — keep the lazy chunk tight. */
const LANG_ALLOWLIST = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "md",
  "bash",
  "sh",
  "python",
  "py",
  "rust",
  "rs",
  "go",
])

/** Normalize a fence's lang tag to a canonical Shiki id. */
const canonLang = (raw: string | undefined): string | null => {
  if (!raw) return null
  const l = raw.toLowerCase()
  if (!LANG_ALLOWLIST.has(l)) return null
  if (l === "py") return "python"
  if (l === "rs") return "rust"
  if (l === "sh") return "bash"
  return l
}

/* ── Highlighter singleton ───────────────────────────────────────────── */

let highlighterPromise: Promise<HighlighterCore> | null = null

const getHighlighter = (): Promise<HighlighterCore> => {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }, wasm] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/oniguruma"),
          import("shiki/wasm"),
        ])
      return createHighlighterCore({
        themes: [import("shiki/themes/github-dark.mjs")],
        langs: [], // loaded on demand
        engine: createOnigurumaEngine(wasm.default),
      })
    })()
  }
  return highlighterPromise
}

const loadingLangs = new Map<string, Promise<void>>()

const ensureLang = async (
  hl: HighlighterCore,
  lang: string,
): Promise<void> => {
  if (hl.getLoadedLanguages().includes(lang)) return
  let p = loadingLangs.get(lang)
  if (!p) {
    p = (async () => {
      const mod = await import(`shiki/langs/${lang}.mjs`)
      await hl.loadLanguage(mod.default ?? mod)
    })()
    loadingLangs.set(lang, p)
  }
  return p
}

/* ── Code block component ────────────────────────────────────────────── */

interface CodeBlockProps {
  readonly lang: string
  readonly source: string
}

const CodeBlock = memo(({ lang, source }: CodeBlockProps) => {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const hl = await getHighlighter()
      await ensureLang(hl, lang)
      if (cancelled) return
      const out = hl.codeToHtml(source, {
        lang,
        theme: "github-dark",
      })
      if (!cancelled) setHtml(out)
    })().catch(() => {
      // Fall back to plain <pre> on any error.
      if (!cancelled) setHtml(null)
    })
    return () => {
      cancelled = true
    }
  }, [lang, source])

  if (!html) {
    return (
      <pre className="code-fallback">
        <code>{source}</code>
      </pre>
    )
  }
  // Shiki returns a self-contained <pre><code>...</code></pre>
  return (
    <div
      className="shiki-wrap"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})
CodeBlock.displayName = "CodeBlock"

/* ── MarkdownView ────────────────────────────────────────────────────── */

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
            return (
              <pre className="code-fallback">
                <code>{source}</code>
              </pre>
            )
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
