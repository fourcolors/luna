/**
 * CodeBlock (Solid port) — Shiki-highlighted code with a plain-<pre>
 * fallback. Mirrors packages/ui-shared/src/CodeBlock.tsx (React) — the
 * Shiki singleton, lang allowlist, and async load are identical; only
 * the component layer differs (createSignal/createEffect/onCleanup
 * vs useState/useEffect).
 *
 * Public surface (matches React version):
 *   - <CodeBlock lang={...} source={...} />     — highlighted block
 *   - canonLang(raw) → string | null            — normalize a fence tag
 *   - <CodeBlockFallback source={...} />        — explicit plain-text
 */
import { createSignal, createEffect, onCleanup, Show, type Component } from "solid-js"
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

export const CodeBlockFallback: Component<{ source: string }> = (props) => (
  <pre class="code-fallback">
    <code>{props.source}</code>
  </pre>
)

export interface CodeBlockProps {
  readonly lang: string
  readonly source: string
}

export const CodeBlock: Component<CodeBlockProps> = (props) => {
  const [html, setHtml] = createSignal<string | null>(null)

  // createEffect reruns automatically when props.lang or props.source
  // change — no dep array, no stale-closure footguns. The cancellation
  // flag handles "newer call started before older highlight resolved":
  // the older call's setHtml is gated behind !cancelled.
  createEffect(() => {
    const lang = props.lang
    const source = props.source
    let cancelled = false
    ;(async () => {
      try {
        const hl = await getHighlighter()
        await ensureLang(hl, lang)
        if (cancelled) return
        const out = hl.codeToHtml(source, { lang, theme: "github-dark" })
        if (!cancelled) setHtml(out)
      } catch {
        // Fall back to plain <pre> on any error.
        if (!cancelled) setHtml(null)
      }
    })()
    onCleanup(() => {
      cancelled = true
    })
  })

  return (
    <Show
      when={html()}
      fallback={<CodeBlockFallback source={props.source} />}
    >
      {(safeHtml) => (
        // Shiki returns a self-contained <pre><code>...</code></pre>.
        // Solid uses innerHTML (not dangerouslySetInnerHTML) — same
        // semantics, no React naming.
        <div class="shiki-wrap" innerHTML={safeHtml()} />
      )}
    </Show>
  )
}
