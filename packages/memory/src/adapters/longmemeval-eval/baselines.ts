/**
 * Chance baselines for the retrieval metrics.
 *
 * The oracle split's haystack holds ONLY evidence sessions, and a typical
 * question has ~20 turns against topK=10. A measured recall means nothing
 * until it is compared with what a uniformly random pick of topK turns
 * would score on the same haystack - so run.ts prints both side by side.
 */
import type { FlatTurn } from "./types.js"

/**
 * P(a fixed group of `groupSize` turns gets at least one turn drawn) when
 * `k` of `total` turns are drawn uniformly without replacement:
 * 1 - C(total - groupSize, k) / C(total, k), computed as a running product
 * so large haystacks never overflow.
 */
export function probAnyDrawn(total: number, groupSize: number, k: number): number {
  const draws = Math.min(k, total)
  if (groupSize <= 0 || draws <= 0) return 0
  if (groupSize + draws > total) return 1
  let missAll = 1
  for (let j = 0; j < draws; j++) {
    missAll *= (total - groupSize - j) / (total - j)
  }
  return 1 - missAll
}

export interface RandomRetrievalBaseline {
  /** Expected number of `has_answer` turns in a random topK draw. */
  readonly evidenceHit: number
  /** Expected number of answer sessions with >= 1 turn in the draw. */
  readonly answerSessionHit: number
}

export function randomRetrievalBaseline(
  turns: ReadonlyArray<FlatTurn>,
  answerSessionIds: ReadonlyArray<string>,
  topK: number,
): RandomRetrievalBaseline {
  const total = turns.length
  const draws = Math.min(topK, total)
  const evidence = turns.filter((t) => t.hasAnswer).length
  const evidenceHit = total > 0 ? (evidence * draws) / total : 0
  const answerSessionHit = answerSessionIds.reduce((acc, id) => {
    const size = turns.filter((t) => t.sessionId === id).length
    return acc + probAnyDrawn(total, size, draws)
  }, 0)
  return { evidenceHit, answerSessionHit }
}
