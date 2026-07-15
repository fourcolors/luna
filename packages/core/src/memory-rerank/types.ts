/**
 * memory-rerank/types.ts - MemoryReranker Tag + fakes + the pure gating
 * helper (SDK-free).
 *
 * WHY HERE (not adapter-sdk): mirrors DreamReasoner (packages/core/src/dream/
 * reasoner.ts) - the Tag, its error type, and the test/wiring doubles stay
 * SDK-free in core so memory-tools (which depends on @luna/core + @luna/memory
 * but NOT @luna/adapter-sdk) can consume them without a forbidden
 * memory-tools → adapter-sdk → core cycle. The SDKClient-backed impl lives in
 * packages/adapter-sdk/src/memory-reranker.ts and exports
 * MemoryRerankerDefault, a Layer requiring SDKClient | AccountBroker.
 *
 * Bench provenance (packages/memory/bench/rerank-eval.ts, PR #332): a single
 * batched Haiku call scoring the top-20 hybrid candidates 0-100 lifted
 * recall@1 0.734 -> 0.878; a score>=75 gate rejected 97.5% of junk while
 * keeping 93.7% of good hits (holdout). This module is the production seam
 * for that result - `rerank()` scores candidates, `applyRerank()` gates them.
 */
import { Data, Effect, Layer } from "effect"

/** One retrieval candidate to be scored, as the caller (memory_search /
 * recallForTurn) already has it: id + text + the retrieval-stage score. */
export interface RerankCandidateInput {
  readonly id: string
  readonly text: string
  readonly retrievalScore: number
}

/** One scored candidate coming back from the reranker. Only candidates the
 * reranker actually managed to score appear here - see applyRerank's header
 * comment for how the caller must treat ids that never get a score back. */
export interface RerankScore {
  readonly id: string
  readonly llmScore: number
}

export interface RerankArgs {
  readonly queryText: string
  readonly candidates: ReadonlyArray<RerankCandidateInput>
  /** Per-call override of the SDK-backed impl's wall-clock ceiling. */
  readonly timeoutMs?: number
}

export interface MemoryRerankerApi {
  /**
   * Score `candidates` against `queryText`. Returns scores for whichever
   * candidates it could score - NOT guaranteed to cover every input id (a
   * partial model response is still useful; see applyRerank). Fails with
   * RerankError only on a whole-call failure (timeout/parse/SDK error) - the
   * caller's contract is to fall back to un-reranked order on failure, never
   * to crash recall.
   */
  readonly rerank: (
    args: RerankArgs,
  ) => Effect.Effect<ReadonlyArray<RerankScore>, RerankError>
}

export class RerankError extends Data.TaggedError("RerankError")<{
  readonly op: "acquire" | "timeout" | "stream" | "parse" | "empty"
  readonly message: string
  readonly cause?: unknown
}> {}

export class MemoryReranker extends Effect.Tag("luna/MemoryReranker")<
  MemoryReranker,
  MemoryRerankerApi
>() {}

/** Test/wiring double - returns a fixed score for every id present in
 * `scoresById`; candidates whose id is absent from the map come back
 * unscored (exercising applyRerank's missing-score tail behavior). */
export const FakeReranker = {
  of: (scoresById: Record<string, number>): Layer.Layer<MemoryReranker> =>
    Layer.succeed(MemoryReranker, {
      rerank: (args) =>
        Effect.succeed(
          args.candidates
            .filter((c) => c.id in scoresById)
            .map((c) => ({ id: c.id, llmScore: scoresById[c.id]! })),
        ),
    }),
} as const

/**
 * Default wiring double: echoes retrieval rank as a strictly-descending
 * integer score (candidates.length - index), so re-sorting by llmScore in
 * applyRerank reproduces the ORIGINAL retrieval order exactly. Useful as a
 * safe default MemoryReranker binding in tests/dev rigs that want the
 * rerank code path exercised without a real model call - NOT meant to
 * exercise threshold gating (its score range tracks candidate count, not a
 * calibrated 0-100 relevance scale).
 */
export const PassthroughReranker: Layer.Layer<MemoryReranker> = Layer.succeed(
  MemoryReranker,
  {
    rerank: (args) =>
      Effect.succeed(
        args.candidates.map((c, i) => ({
          id: c.id,
          llmScore: args.candidates.length - i,
        })),
      ),
  },
)

/** One candidate after gating, paired with its llmScore when the reranker
 * scored it (absent for candidates that fell through applyRerank's
 * missing-score tail - see below). */
export interface RerankedCandidate<C> {
  readonly candidate: C
  readonly llmScore?: number
}

export interface ApplyRerankResult<C> {
  /**
   * Final order: candidates the reranker scored AND that cleared the
   * threshold, sorted by llmScore descending (ties broken by original
   * retrieval-order index) - followed by any candidate the reranker did NOT
   * return a score for, in their original relative order.
   *
   * Missing scores are a reranker-coverage gap (a partial/failed model
   * response), not a relevance signal - treating "no score" as "score 0"
   * would silently drop candidates the reranker never actually judged. So
   * unscored candidates are NEVER gated by `threshold`; they always survive
   * into `kept`, appended after the scored-and-kept ones. Callers that slice
   * to a topN should be aware the tail of `kept` may be un-reranked.
   */
  readonly kept: ReadonlyArray<RerankedCandidate<C>>
  readonly keptCount: number
  /** Count of scored candidates dropped for falling below `threshold`.
   * Unscored candidates are never counted here (see `kept`'s doc). */
  readonly droppedCount: number
}

/**
 * Pure gate: order candidates by rerank score, drop scored-but-irrelevant
 * ones, and never silently discard a candidate the reranker didn't score.
 * SDK-free, deterministic - safe to unit-test exhaustively and to call from
 * both the MCP tool path and recallForTurn.
 */
export function applyRerank<C extends { readonly id: string }>(
  candidates: ReadonlyArray<C>,
  scores: ReadonlyArray<RerankScore>,
  options: { readonly threshold: number },
): ApplyRerankResult<C> {
  const scoreById = new Map(scores.map((s) => [s.id, s.llmScore]))
  const scored: Array<{ candidate: C; llmScore: number; origIndex: number }> = []
  const unscored: Array<{ candidate: C; origIndex: number }> = []

  candidates.forEach((candidate, origIndex) => {
    const llmScore = scoreById.get(candidate.id)
    if (llmScore === undefined) {
      unscored.push({ candidate, origIndex })
    } else {
      scored.push({ candidate, llmScore, origIndex })
    }
  })

  const aboveThreshold = scored.filter((s) => s.llmScore >= options.threshold)
  const droppedCount = scored.length - aboveThreshold.length
  aboveThreshold.sort((a, b) =>
    b.llmScore !== a.llmScore ? b.llmScore - a.llmScore : a.origIndex - b.origIndex,
  )

  const kept: ReadonlyArray<RerankedCandidate<C>> = [
    ...aboveThreshold.map((s) => ({ candidate: s.candidate, llmScore: s.llmScore })),
    ...unscored.map((s) => ({ candidate: s.candidate })),
  ]

  return { kept, keptCount: kept.length, droppedCount }
}
