/**
 * jev-reranker.ts - TypeSafe Jev as the MemoryReranker (opt-in).
 *
 * Selected with LUNA_RERANK_ENGINE=jev; needs the operator's own
 * TYPESAFE_API_KEY, resolved like every other server secret (Luna vault,
 * Keychain or environment, by vault mode - never the repo). Every rerank call
 * sends the query and the candidate memories' text (each capped at
 * JEV_MAX_MEMORY_CHARS) to api.typesafe.ai, so configuring it is the
 * operator's decision to share memory text with TypeSafe.
 *
 * Requests are built by @luna/core's jevRerankRequest, the exact request the
 * LongMemEval held-out comparison measured (85.5% of evidence in the top 5 at
 * depth 40, vs 76.2% for the local cross-encoder and 44.0% without a judge;
 * ~0.2 s per warm call). The score is Jev's probability of relevance x 100,
 * unrounded, so production orders candidates exactly as the benchmark did.
 *
 * Declared defaults (each overridable by env): judge the top 40 candidates,
 * threshold 0 (reorder, never drop - the measured setup; a gate is a separate
 * decision: on the tuning set a threshold of 40, the cross-encoder's,
 * dropped 13 of 85 evidence turns from the top 5), and rerank both
 * memory_search and per-turn recall unless their flag is "0". Any failure
 * (no key, timeout, HTTP error, malformed answer) is a typed RerankError;
 * callers degrade to retrieval order and log once per lane and error type.
 */
import { Effect, Layer } from "effect"
import {
  JEV_MODEL,
  JEV_URL,
  MemoryReranker,
  RerankError,
  jevRequestBatches,
  jevRerankRequest,
  parseJevRerankAnswers,
  type MemoryRerankerApi,
} from "@luna/core"

/**
 * memory_search has no outer deadline, and the first call after an idle
 * spell has measured 9-19 s (TypeSafe-side cold start; warm calls ~0.2 s), so
 * its budget outlasts one. Per-turn recall passes its own smaller budget.
 */
export const DEFAULT_JEV_TIMEOUT_MS = 25_000

/** Held-out validated depth: 40 beat 20 (28 / 5 questions, p = 7e-5). */
export const JEV_DEFAULT_MAX_CANDIDATES = 40

/** Queries are capped like per-turn recall caps them (memory_search's is agent-written and unbounded). */
const MAX_QUERY_CHARS = 2_000

export interface JevRerankerOptions {
  /** The resolved TYPESAFE_API_KEY; missing or empty = every call fails with op "acquire". */
  readonly apiKey?: string
  readonly model?: string
  readonly timeoutMs?: number
  readonly threshold?: number
  readonly fetch?: typeof fetch
  /** Send one tiny, data-free request when the layer is built, so the first real call is not the cold one (default true). */
  readonly warmUp?: boolean
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")

export function JevRerankerLayer(opts: JevRerankerOptions = {}): Layer.Layer<MemoryReranker> {
  const apiKey = opts.apiKey?.trim()
  const model = opts.model ?? (process.env["LUNA_JEV_MODEL"]?.trim() || JEV_MODEL)
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS
  const doFetch = opts.fetch ?? fetch

  /** One request; probabilities in the order of `memories`. */
  const requestOnce = async (query: string, memories: ReadonlyArray<string>, signal: AbortSignal): Promise<ReadonlyArray<number>> => {
    const res = await doFetch(JEV_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(jevRerankRequest(query, memories, model)),
      signal,
    })
    if (!res.ok) {
      // Auth failures: status only (the body can echo request details); others: a short body for diagnosis.
      const detail = res.status === 401 || res.status === 403 ? "" : `: ${(await res.text()).slice(0, 200)}`
      throw new RerankError({ op: "stream", message: `jev HTTP ${res.status}${detail}` })
    }
    let json: unknown
    try {
      json = await res.json()
    } catch (cause) {
      if (isTimeout(cause)) throw cause
      throw new RerankError({ op: "parse", message: "jev reply is not JSON", cause })
    }
    try {
      return parseJevRerankAnswers(json, memories.length).probabilities
    } catch (cause) {
      throw new RerankError({ op: "parse", message: cause instanceof Error ? cause.message : String(cause), cause })
    }
  }

  const rerank: MemoryRerankerApi["rerank"] = (args) => {
    if (args.candidates.length === 0) return Effect.succeed([])
    if (!apiKey) {
      return Effect.fail(new RerankError({ op: "acquire", message: "LUNA_RERANK_ENGINE=jev needs TYPESAFE_API_KEY (Luna vault or environment)" }))
    }
    const budgetMs = args.timeoutMs !== undefined && args.timeoutMs > 0 ? args.timeoutMs : defaultTimeoutMs
    const query = args.queryText.slice(0, MAX_QUERY_CHARS)
    const texts = args.candidates.map((c) => c.text)
    return Effect.tryPromise({
      try: async (signal) => {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)])
        // Usually one request; more only when the text would exceed Jev's per-request token budget
        // (e.g. 40 long CJK memories). Questions are independent, so splitting does not change scores.
        const batches = jevRequestBatches(texts)
        const results = await Promise.all(batches.map((idx) => requestOnce(query, idx.map((i) => texts[i]!), combined)))
        const probabilities: number[] = new Array(texts.length)
        batches.forEach((idx, b) => idx.forEach((i, k) => (probabilities[i] = results[b]![k]!)))
        return probabilities
      },
      catch: (cause) => {
        if (cause instanceof RerankError) return cause
        return isTimeout(cause)
          ? new RerankError({ op: "timeout", message: `jev exceeded the per-call budget of ${budgetMs}ms (${args.candidates.length} candidates)`, cause })
          : new RerankError({ op: "stream", message: `jev request failed: ${String(cause)}`, cause })
      },
    }).pipe(
      Effect.map((probabilities) =>
        args.candidates.map((c, i) => ({ id: c.id, llmScore: Math.max(0, Math.min(100, probabilities[i]! * 100)) })),
      ),
    )
  }

  const api: MemoryRerankerApi = {
    rerank,
    engine: "jev",
    defaults: { maxCandidates: JEV_DEFAULT_MAX_CANDIDATES, threshold: opts.threshold ?? 0, enabled: true },
  }
  if (opts.warmUp === false || !apiKey) return Layer.succeed(MemoryReranker, api)
  return Layer.effect(
    MemoryReranker,
    Effect.gen(function* () {
      // Fire-and-forget, no user data: a failure here only means the first real call may be cold.
      yield* Effect.forkDetach(
        Effect.ignore(rerank({ queryText: "warm-up", candidates: [{ id: "warm-up", text: "warm-up", retrievalScore: 0 }], timeoutMs: 30_000 })),
      )
      return api
    }),
  )
}
