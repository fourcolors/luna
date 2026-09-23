/**
 * One search under one search-config label, shared by every eval harness so
 * "what a config means" lives in exactly one place: router.search with the
 * config's mode / fusion / expansion keywords, then (for `rr=<judge>@<n>`)
 * the top n re-ordered by the judge's relevance scores. Latency measured
 * around this call includes the judge, as it would in production.
 */
import { Data, Effect, Stream } from "effect"
import type { MemoryBackendError } from "@luna/core"
import type { MemoryRouter } from "../../router.js"
import type { SearchConfig } from "../../search-config.js"
import type { MemoryRecord } from "../../types.js"
import type { Judge, JudgeName } from "./judge.js"

export class JudgeError extends Data.TaggedError("JudgeError")<{ readonly judge: string; readonly cause: unknown }> {}

export interface ConfigHit {
  readonly record: MemoryRecord
  /** Fused search score, or the judge's relevance score for reranked hits. */
  readonly score: number
}

export function recordText(record: MemoryRecord): string {
  const c = record.content as unknown
  if (c !== null && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
    return (c as { text: string }).text
  }
  return JSON.stringify(c)
}

export function searchWithConfig(
  router: MemoryRouter,
  config: SearchConfig,
  args: {
    readonly queryText: string
    readonly topK: number
    readonly namespace?: string
    readonly expansionTerms?: ReadonlyArray<string>
  },
  judges: ReadonlyMap<JudgeName, Judge>,
): Effect.Effect<ReadonlyArray<ConfigHit>, MemoryBackendError | JudgeError> {
  return Effect.gen(function* () {
    const depth = config.rerank?.depth ?? 0
    const hits = Array.from(
      yield* Stream.runCollect(
        router.search({
          queryText: args.queryText,
          topK: Math.max(args.topK, depth),
          mode: config.mode,
          ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
          ...(config.fusion !== undefined ? { fusion: config.fusion } : {}),
          ...(args.expansionTerms !== undefined ? { expansionTerms: args.expansionTerms } : {}),
        }),
      ),
    )
    if (config.rerank === undefined) return hits.slice(0, args.topK)
    const judge = judges.get(config.rerank.judge)
    if (judge === undefined) {
      return yield* Effect.fail(new JudgeError({ judge: config.rerank.judge, cause: new Error("judge not configured") }))
    }
    const pool = hits.slice(0, depth)
    const scores = yield* Effect.tryPromise({
      try: () => judge.score(args.queryText, pool.map((h) => recordText(h.record))),
      catch: (cause) => new JudgeError({ judge: judge.name, cause }),
    })
    // Stable: equal judge scores keep the search's own order.
    const reranked = pool
      .map((h, i) => ({ record: h.record, score: scores[i]!, i }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map(({ record, score }) => ({ record, score }))
    return [...reranked, ...hits.slice(depth)].slice(0, args.topK)
  })
}
