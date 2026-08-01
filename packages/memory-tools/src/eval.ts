export interface EmbeddingEvalPreflight {
  readonly valid: boolean
  readonly activeDimension: number
  readonly storedDimensions: ReadonlyArray<number>
  readonly reason: string | null
}

/** Refuse quality scoring when the corpus/index was embedded incompatibly. */
export function checkEmbeddingEvalPreflight(input: {
  readonly activeDimension: number
  readonly storedDimensions: ReadonlyArray<number>
}): EmbeddingEvalPreflight {
  const storedDimensions = Array.from(new Set(input.storedDimensions)).sort(
    (a, b) => a - b,
  )
  const mismatched = storedDimensions.filter(
    (dimension) => dimension !== input.activeDimension,
  )
  return {
    valid: mismatched.length === 0,
    activeDimension: input.activeDimension,
    storedDimensions,
    reason:
      mismatched.length === 0
        ? null
        : `stored vector dimensions ${mismatched.join(",")} do not match active dimension ${input.activeDimension}; re-embed before scoring`,
  }
}

export interface RetrievalEvalResult {
  readonly caseId: string
  readonly relevantIds: ReadonlyArray<string>
  readonly forbiddenIds: ReadonlyArray<string>
  readonly returnedIds: ReadonlyArray<string>
  readonly packedChars?: number
  readonly truncated?: boolean
}

export interface RetrievalEvalMetrics {
  readonly cases: number
  readonly recallAtK: number
  readonly mrr: number
  readonly forbiddenHitRate: number
  readonly averagePackedChars: number
  readonly truncationRate: number
}

export function scoreRetrievalEval(
  results: ReadonlyArray<RetrievalEvalResult>,
): RetrievalEvalMetrics {
  if (results.length === 0) {
    return {
      cases: 0,
      recallAtK: 0,
      mrr: 0,
      forbiddenHitRate: 0,
      averagePackedChars: 0,
      truncationRate: 0,
    }
  }
  let recalled = 0
  let reciprocalRank = 0
  let forbiddenHits = 0
  let returned = 0
  let packedChars = 0
  let truncated = 0
  for (const result of results) {
    const relevant = new Set(result.relevantIds)
    const forbidden = new Set(result.forbiddenIds)
    const firstRelevant = result.returnedIds.findIndex((id) => relevant.has(id))
    if (firstRelevant >= 0) {
      recalled++
      reciprocalRank += 1 / (firstRelevant + 1)
    }
    forbiddenHits += result.returnedIds.filter((id) => forbidden.has(id)).length
    returned += result.returnedIds.length
    packedChars += result.packedChars ?? 0
    if (result.truncated === true) truncated++
  }
  return {
    cases: results.length,
    recallAtK: recalled / results.length,
    mrr: reciprocalRank / results.length,
    forbiddenHitRate: returned === 0 ? 0 : forbiddenHits / returned,
    averagePackedChars: packedChars / results.length,
    truncationRate: truncated / results.length,
  }
}
