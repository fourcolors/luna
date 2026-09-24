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

/** One judge call: wall time (retries and waits included), the part of it spent waiting to start, and attempts. */
export interface JudgeTiming {
  readonly ms: number
  readonly waitMs: number
  readonly attempts: number
}

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
    /** Called once per judge call with its timing and attempts, for per-call latency. */
    readonly onJudgeCall?: (timing: JudgeTiming) => void
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
    const t0 = performance.now()
    const call = yield* Effect.tryPromise({
      try: () => judge.score(args.queryText, pool.map((h) => recordText(h.record))),
      catch: (cause) => new JudgeError({ judge: judge.name, cause }),
    })
    args.onJudgeCall?.({ ms: performance.now() - t0, waitMs: call.waitMs, attempts: call.attempts })
    const scores = call.scores
    // Checked here, not only inside each judge: a short, long, or NaN score
    // list would otherwise sort as ties and quietly keep the search's order.
    if (scores.length !== pool.length || !scores.every(Number.isFinite)) {
      return yield* Effect.fail(
        new JudgeError({
          judge: judge.name,
          cause: new Error(`judge returned ${scores.length} scores for ${pool.length} candidates, or a non-finite score`),
        }),
      )
    }
    // Stable: equal judge scores keep the search's own order.
    const reranked = pool
      .map((h, i) => ({ record: h.record, score: scores[i]!, i }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map(({ record, score }) => ({ record, score }))
    return [...reranked, ...hits.slice(depth)].slice(0, args.topK)
  })
}

/**
 * Per-call judge latency summary. Percentiles are nearest-rank over the
 * judge's own time (wall time minus waitMs, i.e. with a warm process ready
 * and no rate-limit queue); `waited` and `retried` count the calls where
 * that adjustment or a retry happened, so neither can hide. Undefined when
 * the config made no judge calls.
 */
export function judgeLatency(calls: ReadonlyArray<JudgeTiming>) {
  if (calls.length === 0) return undefined
  const sorted = calls.map((c) => c.ms - c.waitMs).sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
  return {
    calls: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1]!,
    over2500: sorted.filter((x) => x > 2500).length,
    waited: calls.filter((c) => c.waitMs > 50).length,
    maxWaitMs: Math.max(...calls.map((c) => c.waitMs)),
    retried: calls.filter((c) => c.attempts > 1).length,
  }
}
