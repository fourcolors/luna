/**
 * telegram-format.ts — markdown → Telegram HTML converter.
 *
 * Luna's assistant output is GitHub-flavored markdown; Telegram's HTML parse
 * mode accepts only a small tag subset and HARD-REJECTS anything else (the
 * whole sendMessage/editMessageText call fails with 400 "can't parse
 * entities"). So this module purpose-builds a DOWNGRADING converter rather
 * than using a general markdown→HTML renderer (which would emit <h1>, <ul>,
 * <p>, <table> and break every send):
 *
 *   headers   → <b>bold</b>
 *   bullets   → "• " text (indentation preserved)
 *   tables    → <pre> monospace block
 *   fences    → <pre><code class="language-x"> (auto-closed when the stream
 *               cut mid-fence — partial deliveries must stay parseable)
 *   > quote   → <blockquote>
 *   >! quote  → <blockquote expandable>  (INTERNAL channels convention: the
 *               delivery layer marks collapsed step summaries with ">! " so
 *               this adapter can render Telegram's expandable quote, Bot API
 *               7.4+. Not standard markdown — see delivery.ts buildTurnSummary.)
 *   inline    → **b** → <b>, *i* → <i>, ~~s~~ → <s>, `c` → <code>,
 *               [t](url) → <a href>
 *
 * Underscore emphasis (_i_, __b__) is DELIBERATELY unsupported: Luna's tool
 * names and identifiers (mcp__web__search, snake_case) would otherwise turn
 * into accidental italics. Claude output uses asterisk emphasis.
 *
 * Telegram counts the 4096-char message limit AFTER entity parsing (tags do
 * not count), so converting a ≤4096-char markdown chunk can never overflow —
 * chunking stays upstream in delivery.ts on the raw markdown.
 *
 * Escaping: every non-tag `& < >` must arrive as an entity. All source text
 * is escaped FIRST; tags are introduced only by this converter afterwards.
 */

/* -------------------------------------------------------------------------- */
/* Escaping                                                                    */
/* -------------------------------------------------------------------------- */

/** Escape text content for Telegram HTML (& < > — the required set). */
export const escapeTelegramHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Escape an attribute value (adds `"` on top of the text escapes). */
const escapeAttr = (s: string): string => escapeTelegramHtml(s).replace(/"/g, "&quot;")

/* -------------------------------------------------------------------------- */
/* Inline markdown                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Apply inline markdown to a single already-HTML-escaped line.
 *
 * Order matters: code spans and links are converted first and stashed behind
 * NUL-delimited placeholders so bold/italic passes can never rewrite their
 * contents (a URL containing `*`, code containing `**`, …). Input text has
 * NUL characters stripped upstream, so the placeholder alphabet is safe.
 */
const applyInline = (escaped: string): string => {
  const stash: string[] = []
  const put = (html: string): string => {
    stash.push(html)
    return `\x00${stash.length - 1}\x00`
  }
  /** Resolve placeholders in `s` to their PLAIN text (tags stripped). */
  const resolvePlain = (s: string): string =>
    s.replace(/\x00(\d+)\x00/g, (_m, i: string) =>
      (stash[Number(i)] ?? "").replace(/<[^>]+>/g, ""),
    )

  let out = escaped

  // Code spans first — their contents are opaque to every later pass.
  // Double-backtick (CommonMark's literal-backtick escape) before single,
  // trimming the one optional padding space from each end per spec.
  out = out.replace(/``((?:(?!``)[^\n])+?)``/g, (_m, code: string) => {
    const trimmed =
      code.startsWith(" ") && code.endsWith(" ") && code.trim().length > 0
        ? code.slice(1, -1)
        : code
    return put(`<code>${trimmed}</code>`)
  })
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => put(`<code>${code}</code>`))

  // Links: [text](http…). The whole anchor is stashed — emphasis inside link
  // text is sacrificed for the guarantee that URLs are never rewritten, and
  // any code span already stashed inside the text is resolved to plain text
  // (nesting <code> inside <a> is not reliably accepted by Telegram, and
  // one-pass restoration could never reach it anyway).
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text: string, url: string) =>
      put(`<a href="${url.replace(/"/g, "&quot;")}">${resolvePlain(text)}</a>`),
  )

  // Emphasis passes. The content patterns enforce two properties that keep
  // the output WELL-FORMED for any input (Telegram 400-rejects mis-nested
  // tags): content edges are never "*" (so runs like "******" can't pair
  // into overlapping empty spans), and content never contains raw < or >
  // (so a pass can never open inside a tag pair an earlier pass inserted
  // and close outside it — legitimate text has no raw <> after escaping).
  // ***bold italic*** before ** and * so the trailing star can't orphan.
  // The lookarounds demand EXACTLY three stars: inside longer runs (e.g.
  // "**A****B**", where "****" is close+open of two bold segments) a triple
  // match would steal stars across segment boundaries.
  out = out.replace(
    /(?<!\*)\*{3}(?!\*)([^*<>\n](?:[^<>\n]*?[^*<>\n])??)(?<!\*)\*{3}(?!\*)/g,
    "<b><i>$1</i></b>",
  )
  // **bold** — the lazy optional group (??) prefers the SHORTEST content,
  // so "**A****B**" pairs as two segments instead of one spanning "A****B".
  out = out.replace(/\*\*([^*<>\n](?:[^<>\n]*?[^*<>\n])??)\*\*/g, "<b>$1</b>")
  // *italic* — content edges must be non-whitespace, so "2 * 3 * 4" and
  // other bare-asterisk math never italicizes.
  out = out.replace(/\*([^\s*<>\n](?:[^*<>\n]*?[^\s*<>\n])??)\*/g, "<i>$1</i>")
  // ~~strikethrough~~
  out = out.replace(/~~((?:(?!~~)[^<>\n])+?)~~/g, "<s>$1</s>")

  // Restore stashed code spans and anchors. Loop until clean: a stash entry
  // can itself reference an earlier entry (String.replace never re-scans
  // replacement text), bounded to the stash depth.
  for (let pass = 0; pass < 8 && out.includes("\x00"); pass++) {
    out = out.replace(/\x00(\d+)\x00/g, (_m, i: string) => stash[Number(i)] ?? "")
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Block-level conversion                                                      */
/* -------------------------------------------------------------------------- */

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*(\S*)/
const BLOCKQUOTE_RE = /^>(!?)\s?(.*)$/
const HEADING_RE = /^\s*#{1,6}\s+(.*)$/
const HR_RE = /^\s*([-*_])\1{2,}\s*$/
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/
const TABLE_ROW_RE = /^\s*\|/

/** Sanitize a fence info string into a language-… class token. */
const fenceLang = (info: string): string => info.replace(/[^A-Za-z0-9+#._-]/g, "").slice(0, 32)

/**
 * Convert markdown to Telegram-safe HTML. Total: never throws. Output uses
 * only Telegram-supported tags; all other structure is downgraded to text.
 */
export const markdownToTelegramHtml = (md: string): string => {
  // NUL is the applyInline placeholder alphabet; strip it from input so a
  // hostile/binary payload can't collide with stashed spans.
  const lines = md.replace(/\x00/g, "").split("\n")
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ""

    // Fenced code block. The closing fence may be missing when a streaming
    // partial cut mid-block — treat end-of-input as an implicit close so the
    // HTML always parses.
    const fence = line.match(FENCE_RE)
    if (fence !== null) {
      const marker = (fence[1] ?? "```").slice(0, 3)
      const lang = fenceLang(fence[2] ?? "")
      const buf: string[] = []
      i++
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
        buf.push(lines[i] ?? "")
        i++
      }
      if (i < lines.length) i++ // consume the closing fence when present
      const code = escapeTelegramHtml(buf.join("\n"))
      out.push(
        lang.length > 0
          ? `<pre><code class="language-${escapeAttr(lang)}">${code}</code></pre>`
          : `<pre>${code}</pre>`,
      )
      continue
    }

    // Blockquote runs — "> " (regular) and ">! " (expandable, internal
    // convention) group into one tag each; the two kinds never merge.
    const bq = line.match(BLOCKQUOTE_RE)
    if (bq !== null) {
      const expandable = bq[1] === "!"
      const buf: string[] = [applyInline(escapeTelegramHtml(bq[2] ?? ""))]
      i++
      while (i < lines.length) {
        const next = (lines[i] ?? "").match(BLOCKQUOTE_RE)
        if (next === null || (next[1] === "!") !== expandable) break
        buf.push(applyInline(escapeTelegramHtml(next[2] ?? "")))
        i++
      }
      out.push(`<blockquote${expandable ? " expandable" : ""}>${buf.join("\n")}</blockquote>`)
      continue
    }

    // Table block — Telegram has no table markup; monospace keeps alignment.
    if (TABLE_ROW_RE.test(line)) {
      const buf: string[] = []
      while (i < lines.length && TABLE_ROW_RE.test(lines[i] ?? "")) {
        buf.push(lines[i] ?? "")
        i++
      }
      out.push(`<pre>${escapeTelegramHtml(buf.join("\n"))}</pre>`)
      continue
    }

    // Horizontal rule BEFORE bullets: "---"/"***" are rules, not list items.
    if (HR_RE.test(line)) {
      out.push("──────────")
      i++
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading !== null) {
      out.push(`<b>${applyInline(escapeTelegramHtml(heading[1] ?? ""))}</b>`)
      i++
      continue
    }

    const bullet = line.match(BULLET_RE)
    if (bullet !== null) {
      out.push(`${bullet[1] ?? ""}• ${applyInline(escapeTelegramHtml(bullet[2] ?? ""))}`)
      i++
      continue
    }

    // Numbered lists and plain paragraphs pass through with inline styling.
    out.push(applyInline(escapeTelegramHtml(line)))
    i++
  }

  return out.join("\n")
}

/* -------------------------------------------------------------------------- */
/* Plain-text fallback                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fallback content when Telegram rejects the HTML ("can't parse entities"):
 * the raw markdown, minus the internal ">! " expandable marker (which would
 * read as noise). Raw markdown is imperfect but always deliverable — the
 * plain text is never longer than the markdown that already passed chunking.
 */
export const toPlainTextFallback = (md: string): string => md.replace(/^>!\s?/gm, "> ")
