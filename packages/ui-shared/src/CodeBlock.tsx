/**
 * CodeBlock — Shiki-highlighted code, with a plain-<pre> fallback for
 * unknown languages or while the highlighter is still warming up.
 *
 * Extracted from MarkdownView so the artifact panel can reuse the same
 * pathway without forcing the markdown chunk to load. Shiki itself is
 * still lazy: the highlighter + WASM are loaded on first call via the
 * module-scoped `getHighlighter()` singleton, so importing this file
 * eagerly only adds the component shell to the bundle.
 *
 * Public surface:
 *   - <CodeBlock lang={lang} source={text} />     — highlighted block
 *   - canonLang(raw)  → string | null              — normalize a fence tag
 *   - <CodeBlockFallback source={text} />          — explicit plain-text
 *
 * The fallback path is used both internally (during async load) and
 * externally by ArtifactPanel when canonLang() returns null.
 */
import { memo, useEffect, useState } from "react"
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

/** Normalize a fence's lang tag to a canonical Shiki id. Returns null if
 *  the language isn't allowlisted — the caller should fall back to
 *  <CodeBlockFallback>. */
export const canonLang = (raw: string | null | undefined): string | null => {
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

/* ── Components ──────────────────────────────────────────────────────── */

export const CodeBlockFallback = memo(
  ({ source }: { source: string }) => (
    <pre className="code-fallback">
      <code>{source}</code>
    </pre>
  ),
)
CodeBlockFallback.displayName = "CodeBlockFallback"

interface CodeBlockProps {
  readonly lang: string
  readonly source: string
}

export const CodeBlock = memo(({ lang, source }: CodeBlockProps) => {
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
    return <CodeBlockFallback source={source} />
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
