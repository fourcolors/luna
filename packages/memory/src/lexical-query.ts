/**
 * Builds FTS5 MATCH expressions for the lexical (BM25) arm of memory search,
 * and holds the fusion knobs for the `hybrid-weighted` mode.
 *
 * Pure and deterministic: no DB, no I/O. The SQL side (FTS5 `bm25()` over the
 * `porter unicode61` index) does the ranking; this module only decides WHICH
 * words go into the MATCH and escapes them so user text can never become
 * FTS5 syntax.
 *
 * Why stopwords: FTS5 has none built in, so an OR-of-terms query built from a
 * natural question ("what did I say about the dog") lets a shared filler
 * word make an unrelated memory a lexical "hit". Stopwords are dropped on the
 * raw lower-cased word, before FTS5's porter stemmer sees it (porter maps
 * "was" to "wa"). Whether question words should also go is measured by the
 * `question` set, not assumed.
 * Plan: docs/superpowers/plans/2026-09-22-memory-lexical-fusion-and-query-expansion.md
 */

/** Lucene/Elasticsearch `_english_` stop set (33 words). */
export const STOPWORDS_LUCENE: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
  "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
  "their", "then", "there", "these", "they", "this", "to", "was", "will",
  "with",
])

/**
 * Lucene plus first/second-person pronouns and common auxiliaries: the
 * filler of conversational questions ("did I", "do you", "have my").
 * Still keeps what/when/where/who/why/how.
 */
export const STOPWORDS_EXTENDED: ReadonlySet<string> = new Set([
  ...STOPWORDS_LUCENE,
  "i", "me", "my", "mine", "we", "us", "our", "you", "your", "he", "she",
  "him", "her", "his", "its", "them", "do", "does", "did", "have", "has",
  "had", "am", "were", "been", "being", "can", "could", "would", "should",
  "shall", "may", "might", "must", "about", "from", "so", "any", "some",
])

/** Extended plus the question words, to MEASURE whether keeping them helps. */
export const STOPWORDS_QUESTION: ReadonlySet<string> = new Set([
  ...STOPWORDS_EXTENDED,
  "what", "when", "where", "who", "whom", "whose", "why", "how", "which",
])

export type StopwordSet = "none" | "lucene" | "extended" | "question"

const STOPWORD_SETS: Record<StopwordSet, ReadonlySet<string>> = {
  none: new Set(),
  lucene: STOPWORDS_LUCENE,
  extended: STOPWORDS_EXTENDED,
  question: STOPWORDS_QUESTION,
}

/**
 * Word tokens as FTS5's unicode61 tokenizer would split them: runs of
 * letters, combining marks and digits (any script; without \p{M}, scripts
 * like Devanagari would split into fragments). Underscore and apostrophe
 * separate, matching unicode61's defaults, so "don't" -> "don", "t" on both
 * sides. Text is NFKC-normalized first (full-width forms, ligatures).
 * unicode61 keeps a CJK run as ONE token, so CJK matching stays weak
 * without a trigram index.
 */
const WORD = /[\p{L}\p{M}\p{N}]+/gu

/** Upper bound on OR terms per arm: per-turn recall queries are whole chat messages. */
export const MAX_LEXICAL_TERMS = 32

/**
 * Lower-cased content words of `text`, stopwords removed, de-duplicated in
 * first-seen order, capped at `maxTerms`.
 */
export function extractTerms(
  text: string,
  stopwords: StopwordSet = "none",
  maxTerms: number = MAX_LEXICAL_TERMS,
): string[] {
  const stop = STOPWORD_SETS[stopwords]
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.normalize("NFKC").toLowerCase().matchAll(WORD)) {
    const w = m[0]
    if (stop.has(w) || seen.has(w)) continue
    seen.add(w)
    out.push(w)
    if (out.length >= maxTerms) break
  }
  return out
}

/** An unpaired UTF-16 surrogate half (an emoji cut in two by a string slice). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * FTS5 string literal: wrap in double quotes, doubling any embedded quote.
 * NUL and lone surrogate halves are replaced first: FTS5 rejects both with
 * "unterminated string", and per-turn recall slices messages at 2000
 * characters, which can cut an emoji in half (the whole search then failed,
 * so that turn got no recall context).
 */
export function quoteFts(s: string): string {
  const clean = s.replace(/\u0000/g, " ").replace(LONE_SURROGATE, "\uFFFD")
  return `"${clean.replace(/"/g, '""')}"`
}

/**
 * OR of single quoted terms, or "" when nothing survives (caller must then
 * skip the lexical arm rather than MATCH an empty string).
 */
export function termsMatch(terms: ReadonlyArray<string>): string {
  return terms.map(quoteFts).join(" OR ")
}

/** Terms considered when requiring a minimum match: C(12, 2) = 66 AND-pairs at most. */
export const MAX_MIN_MATCH_TERMS = 12

/**
 * MATCH requiring at least `minMatch` (1 or 2) DISTINCT query terms in a
 * record. 1 is the plain OR. 2 is an OR of AND-pairs, evaluated by FTS5
 * itself so porter stemming still applies: a record sharing ONE casual word
 * with the question ("app", "get") can no longer be a lexical hit, while a
 * record matching several content words still ranks by bm25(). Queries with
 * a single content term fall back to that term. Only the first
 * MAX_MIN_MATCH_TERMS terms are paired.
 */
export function minMatchTermsMatch(terms: ReadonlyArray<string>, minMatch: number): string {
  if (minMatch <= 1 || terms.length < 2) return termsMatch(terms)
  if (minMatch !== 2) throw new Error(`minMatch ${minMatch} unsupported (1 or 2)`)
  const t = terms.slice(0, MAX_MIN_MATCH_TERMS).map(quoteFts)
  const pairs: string[] = []
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) pairs.push(`(${t[i]} AND ${t[j]})`)
  }
  return pairs.join(" OR ")
}

/** Caps on expansion keywords: FTS5 sums repeated/overlapping terms, so volume = weight. */
export const MAX_EXPANSION_PHRASES = 8
export const MAX_EXPANSION_PHRASE_WORDS = 6

/**
 * Expansion keywords (agent-supplied synonyms, entities, alternate
 * phrasings) as an OR of quoted PHRASES: a multi-word keyword keeps its word
 * order ("apple pie" does not match a memory that merely mentions apples and
 * pie). Keywords are tokenized the same way as queries, so FTS5 syntax inside
 * them is inert. Stopwords are NOT removed inside a phrase (that would break
 * adjacency: "museum of modern art" must stay a 4-word phrase); a keyword made
 * only of stopwords is dropped. A single-word keyword already among
 * `queryTerms` is dropped: restating the query would double-count it (FTS5
 * has no per-term boost and sums repeats); pass no `queryTerms` when the query
 * arm is off. At most MAX_EXPANSION_PHRASES phrases; longer keywords keep
 * their first MAX_EXPANSION_PHRASE_WORDS words.
 */
export function expansionMatch(
  keywords: ReadonlyArray<string>,
  stopwords: StopwordSet = "none",
  queryTerms: ReadonlyArray<string> = [],
): string {
  const stop = STOPWORD_SETS[stopwords]
  const phrases: string[] = []
  const seen = new Set<string>(queryTerms)
  for (const kw of keywords) {
    // Order-preserving, no de-dupe inside a phrase ("new new york" stays as written).
    const words = Array.from(kw.normalize("NFKC").toLowerCase().matchAll(WORD), (m) => m[0]).slice(
      0,
      MAX_EXPANSION_PHRASE_WORDS,
    )
    if (words.length === 0 || words.every((w) => stop.has(w))) continue
    const phrase = words.join(" ")
    if (seen.has(phrase)) continue
    seen.add(phrase)
    phrases.push(phrase)
    if (phrases.length >= MAX_EXPANSION_PHRASES) break
  }
  return phrases.map(quoteFts).join(" OR ")
}

/** Knobs for `hybrid-weighted`. Bench-tuned defaults live in HYBRID_WEIGHTED_DEFAULTS. */
export interface LexicalFusionOptions {
  /** RRF weight of the BM25 arm over the query's own words (vector arm = 1). */
  readonly lexicalWeight: number
  /** RRF weight of the BM25 arm over expansion keywords, when any are given. */
  readonly expansionWeight: number
  readonly stopwords: StopwordSet
  /** Distinct query terms a record must contain to be a query-arm hit (1 or 2). */
  readonly minMatch: number
}

/**
 * Defaults for `hybrid-weighted`, an EXPERIMENTAL mode no production caller
 * uses. These are the plan's locked "vector + agent keywords" config
 * (w=0, e=0.5, s=lucene): with no keywords it ranks like vector search, and
 * the held-out test found it safe but not proven better. The sweep that
 * refuted every w > 0 setting on vocabulary-mismatch queries is recorded in
 * docs/superpowers/plans/2026-09-22-memory-lexical-fusion-and-query-expansion.md.
 */
export const HYBRID_WEIGHTED_DEFAULTS: LexicalFusionOptions = {
  lexicalWeight: 0,
  expansionWeight: 0.5,
  stopwords: "lucene",
  minMatch: 1,
}

/** RRF constant (Cormack et al.; every major engine's default). */
export const RRF_K = 60

/**
 * Weighted Reciprocal Rank Fusion: sum over lists of weight / (k + rank),
 * rank 1-based. Ties keep first-seen order (Map insertion), which puts the
 * first list's ordering first.
 */
export function weightedRrf(
  lists: ReadonlyArray<{ readonly ids: ReadonlyArray<string>; readonly weight: number }>,
  k: number = RRF_K,
): Array<{ readonly id: string; readonly score: number }> {
  const fused = new Map<string, number>()
  for (const { ids, weight } of lists) {
    if (weight <= 0) continue
    ids.forEach((id, idx) => {
      fused.set(id, (fused.get(id) ?? 0) + weight / (k + idx + 1))
    })
  }
  return Array.from(fused, ([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
}
