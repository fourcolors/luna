/**
 * retrieval-modes — three selectable retrieval strategies for the LoCoMo
 * harness's per-QA-pair search step, gated behind
 * `LUNA_LOCOMO_RETRIEVAL_MODE` (flat|decompose|hierarchical) in `run.ts`.
 *
 * Why these three, and why gated rather than swapped in as the new default:
 * a diagnosis pass (see PR body / obs_note ledger — re-ran retrieval at
 * topK up to 100 for category-1 multi-hop misses from the 840-QA-pair
 * run) found the DOMINANT failure mode is a result-COUNT budget problem,
 * not an embedding-quality problem: ~89% of evidence dia_ids missing from
 * a top-10 result set were already present in the SAME ranked candidate
 * list, just below rank 10 (most within rank 30-50) — the model/embedder
 * found the right turns, `topK=10` just didn't have enough slots to hold
 * them alongside noise. Category-1 questions need 2-19 (median ~2-3)
 * distinct evidence turns per question, 96% of which span MULTIPLE
 * sessions (different dates/topics), so a single flat top-10 list has to
 * serve several distinct sub-topics out of one shared budget.
 *
 * That diagnosis is a budget problem first, so the straightforward fix is
 * simply raising `LUNA_LOCOMO_TOPK` (already a supported env var, no code
 * change needed — see the "flat" mode below and the PR body for the
 * before/after numbers at topK=10 vs topK=30). `decompose` and
 * `hierarchical` are two independent, ADDITIONAL strategies for the same
 * root mechanism (many sub-topics sharing one budget), implemented and
 * gated separately so they're each independently measurable against the
 * `flat` baseline rather than asserted to help without evidence:
 *
 *   - `decompose`: split a literally-conjunctive multi-hop question
 *     ("What does X do, and what does Y do?") into its sub-questions and
 *     retrieve for each independently, merging/deduping results by
 *     record id (max score wins) before taking the final topK. This is a
 *     NARROW fix — only ~9.6% of this dataset's category-1 questions are
 *     literally splittable this way (most are single-clause enumeration
 *     questions like "What has Melanie painted?", which have nothing to
 *     split); for non-splittable questions `decomposeQuestion` returns the
 *     original question unchanged and this mode is a no-op identical to
 *     `flat`. Included because the task explicitly asks for it as a
 *     comparison point, not because the diagnosis strongly supports it as
 *     the dataset's primary failure mode — see PR body.
 *   - `hierarchical`: build a deterministic (zero-LLM-call) per-session
 *     summary at ingest time (session number + date + a truncated
 *     concatenation of that session's turn text — no synthesis, just a
 *     cheap "what was discussed" fingerprint), rank sessions by lexical
 *     term-overlap against the question, and reorder a WIDENED flat
 *     candidate pool (topK candidates pulled at a higher K than the final
 *     budget) to prioritize hits from the top-ranked sessions before
 *     falling back to the remaining top-scored hits. This directly
 *     targets the "evidence spans multiple sessions, one shared top-10
 *     budget" mechanism the diagnosis found, without needing any LLM call.
 *
 * All pure functions here (`decomposeQuestion`, `mergeHits`,
 * `buildSessionSummaries`, `rankSessions`, `prioritizeBySessions`,
 * `sessionNumFromTags`) are unit-tested directly — see
 * `test/locomo-eval.test.ts`. `run.ts` wires them to live `router.search()`
 * calls; this module has no Effect/router dependency so it stays testable
 * without any live services.
 */
import type { FlatTurn } from "./types.js"

export type RetrievalMode = "flat" | "decompose" | "hierarchical"

export function parseRetrievalMode(raw: string | undefined): RetrievalMode {
  const v = (raw ?? "flat").toLowerCase()
  if (v === "decompose" || v === "hierarchical") return v
  return "flat"
}

// ─── decompose ──────────────────────────────────────────────────────────

/**
 * Splits a question on conjunctions/enumerable separators ("and", "as well
 * as", commas) into candidate sub-questions. Returns `[question]` unchanged
 * (a single-element array) when no meaningful split point exists — callers
 * should treat that as "nothing to decompose, behave like flat mode" rather
 * than special-casing it. A fragment shorter than 3 words is treated as not
 * meaningful on its own (e.g. splitting "Melanie and her family" on "and"
 * yields "her family", 2 words, not a standalone question) — if fewer than
 * 2 meaningful fragments remain, the whole question is returned unsplit.
 */
export function decomposeQuestion(question: string): ReadonlyArray<string> {
  const trimmed = question.trim()
  const hasQ = trimmed.endsWith("?")
  const core = hasQ ? trimmed.slice(0, -1) : trimmed
  const SPLIT_RE = /\s+(?:and|as well as|,\s*and|,)\s+/i
  const rawParts = core
    .split(SPLIT_RE)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  const meaningful = rawParts.filter((p) => p.split(/\s+/).length >= 3)
  if (meaningful.length < 2) return [trimmed]
  return meaningful.map((p) => (p.endsWith("?") ? p : `${p}?`))
}

export interface ScoredRecord {
  readonly recordId: string
  readonly score: number
}

/**
 * Merges multiple ranked hit lists (one per sub-query) into one, deduping
 * by record id (keeping the MAX score seen across lists — a record that
 * shows up in two sub-query result sets is at least as relevant as its
 * best single-list rank suggests), then sorts descending and truncates to
 * `topK`. Generic over any `T extends ScoredRecord` so callers can pass the
 * full hit object (with `.record`/`.text` etc attached) through unchanged.
 */
export function mergeHits<T extends ScoredRecord>(
  hitLists: ReadonlyArray<ReadonlyArray<T>>,
  topK: number,
): ReadonlyArray<T> {
  const best = new Map<string, T>()
  for (const list of hitLists) {
    for (const hit of list) {
      const existing = best.get(hit.recordId)
      if (!existing || hit.score > existing.score) best.set(hit.recordId, hit)
    }
  }
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

// ─── hierarchical ───────────────────────────────────────────────────────

export interface SessionSummary {
  readonly sessionNum: number
  readonly date: string
  readonly summary: string
}

const SESSION_SUMMARY_CHAR_CAP = 800

/**
 * Deterministic (no LLM call), computed at ingest time from the same turns
 * `ingest.ts` writes to the store: one summary per session, the session's
 * date plus a capped concatenation of its turns' raw text. This is a
 * fingerprint for LEXICAL matching (`rankSessions` below), not a synthesis
 * product — no summarization, just enough raw text to term-match against.
 */
export function buildSessionSummaries(turns: ReadonlyArray<FlatTurn>): ReadonlyArray<SessionSummary> {
  const bySession = new Map<number, { date: string; texts: string[] }>()
  for (const t of turns) {
    const entry = bySession.get(t.sessionNum) ?? { date: t.sessionDateTime, texts: [] }
    entry.texts.push(t.text)
    bySession.set(t.sessionNum, entry)
  }
  return Array.from(bySession.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([sessionNum, { date, texts }]) => ({
      sessionNum,
      date,
      summary: texts.join(" ").slice(0, SESSION_SUMMARY_CHAR_CAP),
    }))
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "did", "do", "does", "what",
  "when", "where", "who", "whom", "which", "how", "in", "on", "at", "to",
  "of", "for", "and", "or", "has", "have", "had", "that", "this", "with",
  "her", "his", "their", "she", "he", "they", "them", "it", "its", "be",
  "been", "being", "as", "by", "from", "about",
])

function tokenize(text: string): ReadonlyArray<string> {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(
    (w) => w.length > 2 && !STOPWORDS.has(w),
  )
}

/**
 * Scores every session's lexical overlap against the question (fraction of
 * the question's distinct content-word vocabulary present in that
 * session's summary) and returns the top `topN` session numbers, highest
 * first. Pure term-overlap, not embedding similarity — cheap, deterministic,
 * zero LLM/embedder calls; this is what makes `hierarchical` mode free to
 * compute relative to an extra embedding pass.
 */
export function rankSessions(
  question: string,
  sessions: ReadonlyArray<SessionSummary>,
  topN: number,
): ReadonlyArray<number> {
  const qTokens = new Set(tokenize(question))
  if (qTokens.size === 0 || sessions.length === 0) return []
  const scored = sessions.map((s) => {
    const sTokens = new Set(tokenize(s.summary))
    let hits = 0
    for (const t of qTokens) if (sTokens.has(t)) hits++
    return { sessionNum: s.sessionNum, score: hits / qTokens.size }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topN).map((s) => s.sessionNum)
}

/** Extracts the `session:<N>` tag ingest.ts attaches to every turn, or null. */
export function sessionNumFromTags(tags: ReadonlyArray<string>): number | null {
  for (const t of tags) {
    const m = /^session:(\d+)$/.exec(t)
    if (m) return Number(m[1])
  }
  return null
}

export interface SessionTaggedRecord {
  readonly sessionNum: number | null
}

/**
 * Reorders a WIDENED candidate hit list (pulled at a higher K than the
 * final answer-model budget) to give hits from `prioritySessions` a
 * BOUNDED boost — at most half of `topK` slots — preserving `hits`'s
 * original score order within both the boosted and remaining groups, then
 * fills the rest with the next-highest-scored hits from ANY session
 * (including priority-session overflow beyond the cap). This is the
 * "widened pool alongside the existing flat top-K" strategy from the task
 * brief. The cap matters: an earlier uncapped version (all priority-session
 * hits first, unconditionally) was measured to REGRESS retrieval — when
 * the lexical session ranker mis-ranks (picks sessions that don't actually
 * hold the answer), an unbounded boost can fill the entire topK budget with
 * wrong-session turns and crowd out correctly-ranked hits from other
 * sessions entirely. Capping the boost at half of topK guarantees at least
 * half the final list is always filled by ordinary score-ranked hits
 * regardless of how good or bad the session ranking is — see PR body for
 * the measured before/after (uncapped: 33.0% evidence coverage, worse than
 * the 58.5% flat baseline on the same QA pairs; this is not yet re-measured
 * post-fix, see PR body for the honest caveat).
 */
export function prioritizeBySessions<T extends SessionTaggedRecord>(
  hits: ReadonlyArray<T>,
  prioritySessions: ReadonlySet<number>,
  topK: number,
): ReadonlyArray<T> {
  const maxBoostSlots = Math.ceil(topK / 2)
  const boosted: T[] = []
  const remainder: T[] = []
  for (const h of hits) {
    if (h.sessionNum !== null && prioritySessions.has(h.sessionNum) && boosted.length < maxBoostSlots) {
      boosted.push(h)
    } else {
      remainder.push(h)
    }
  }
  return [...boosted, ...remainder].slice(0, topK)
}
