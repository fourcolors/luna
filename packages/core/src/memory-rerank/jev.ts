/**
 * memory-rerank/jev.ts - the one definition of a Jev relevance-judging
 * request, shared by the production reranker (adapter-sdk's
 * JevRerankerLayer) and the eval judge (packages/memory
 * adapters/eval-common/judge.ts), so the wording, the per-memory cap and the
 * answer parsing that won the held-out comparison cannot drift apart.
 *
 * Jev (TypeSafe System One, docs.typesafe.ai) answers typed questions about
 * a `state`. One request per search: state = the query, one Noul (the
 * probability of "yes") per candidate memory. The input is framed as a
 * search QUERY, not a question: per-turn recall searches with the user's
 * message and agents search with phrases; framed as a question ("helps
 * answer"), Jev scored a verbatim match for a phrase query 0.21 and dropped
 * it from the top 10 (memory-suite q_verbatim_022), framed as a query 0.47.
 *
 * Evidence (LongMemEval S held-out questions 261-460, evidence turns in the
 * top 5, plan docs/superpowers/plans/2026-09-22-memory-lexical-fusion-and-
 * query-expansion.md): judging the top 40 hybrid hits lifts 44.0% (no judge)
 * to 85.5%, beating the local cross-encoder (76.2%, 31 / 6 questions,
 * p = 4e-5) and Haiku (79.2%, 28 / 7, p = 5e-4), at ~0.2 s per call.
 */

export const JEV_URL = "https://api.typesafe.ai/v1/systemone"

/** The version every held-out number was measured on. An alias like
 * "jev-latest" moves when TypeSafe ships a release (docs.typesafe.ai/models),
 * so production pins the id and moves on its own schedule. */
export const JEV_MODEL = "jev-1.13.0"

/** Per-memory text cap; 40 capped memories stay well inside Jev's 64k-token request budget. */
export const JEV_MAX_MEMORY_CHARS = 2_000

export const JEV_CRITERIA = {
  true: "The memory states facts that answer, match, or directly bear on what the query asks about or describes.",
  false: "The memory is about something else, or only shares words or a topic with the query.",
}

const TASK = "Is the `memory` relevant to the search `query` (in state): does it contain what the query asks about or describes?"

/**
 * Budget for one request's memory text, in estimated tokens. Jev allows 64k
 * tokens per request (docs.typesafe.ai/models); the query, the per-question
 * instructions and criteria (~70 tokens each) and a margin take the rest.
 */
export const JEV_REQUEST_TOKEN_BUDGET = 40_000

const cappedMemory = (text: string) => (text.length > JEV_MAX_MEMORY_CHARS ? text.slice(0, JEV_MAX_MEMORY_CHARS) : text)

/** Rough token count: ~4 characters per token for ASCII, ~1 per character otherwise (CJK). Deliberately high. */
export function estimateJevTokens(text: string): number {
  let ascii = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++
  return Math.ceil(ascii / 4) + (text.length - ascii)
}

/**
 * Candidate indices grouped into requests that each fit
 * JEV_REQUEST_TOKEN_BUDGET, in order. Forty English memories at the
 * 2,000-character cap (~20k tokens) are one request - the benchmarked shape;
 * long non-Latin memories split. Questions are scored independently, so
 * splitting does not change any score.
 */
export function jevRequestBatches(memories: ReadonlyArray<string>, budget: number = JEV_REQUEST_TOKEN_BUDGET): ReadonlyArray<ReadonlyArray<number>> {
  const batches: number[][] = []
  let current: number[] = []
  let used = 0
  memories.forEach((text, i) => {
    const cost = estimateJevTokens(cappedMemory(text)) + 70
    if (current.length > 0 && used + cost > budget) {
      batches.push(current)
      current = []
      used = 0
    }
    current.push(i)
    used += cost
  })
  if (current.length > 0) batches.push(current)
  return batches
}

/** Answer id for candidate i; Jev echoes it back under `answers`. */
export const jevAnswerId = (i: number) => `c${i}`

/** The request body judging `memories` against `query`, candidates in order. */
export function jevRerankRequest(query: string, memories: ReadonlyArray<string>, model: string = JEV_MODEL) {
  return {
    model,
    state: { query },
    questions: Object.fromEntries(
      memories.map((text, i) => [
        jevAnswerId(i),
        {
          type: "noul",
          instructions: { task: TASK, memory: cappedMemory(text) },
          criteria: JEV_CRITERIA,
        },
      ]),
    ),
  }
}

/**
 * Each candidate's probability of relevance (0..1), in candidate order.
 * Throws when any answer is missing or not a finite number in [0, 1]: a
 * judge that silently drops a candidate would bias the ranking.
 */
export function parseJevRerankAnswers(json: unknown, count: number): { readonly probabilities: ReadonlyArray<number>; readonly servedModel?: string } {
  const body = (json ?? {}) as { model?: unknown; answers?: Record<string, { noul?: unknown }> }
  const probabilities = Array.from({ length: count }, (_, i) => {
    const noul = body.answers?.[jevAnswerId(i)]?.noul
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
      throw new Error(`jev: missing or malformed answer ${jevAnswerId(i)}`)
    }
    return noul
  })
  return typeof body.model === "string" ? { probabilities, servedModel: body.model } : { probabilities }
}
