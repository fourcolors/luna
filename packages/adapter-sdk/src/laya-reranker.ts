/**
 * laya-reranker.ts - Laya as the MemoryReranker (opt-in), the local answer to
 * the hosted Jev engine.
 *
 * Selected with LUNA_RERANK_ENGINE=laya. Laya (convaiinnovations/laya, Apache
 * 2.0) is a non-autoregressive System One classifier that runs as a local
 * Python sidecar (scripts/laya-rerank-server), so the operator gets the Jev
 * judge's single-forward-pass relevance scoring without memory text ever
 * leaving the machine: the reranker posts the SAME request body the held-out
 * Jev comparison measured (@luna/core jevRerankRequest) to 127.0.0.1 instead
 * of api.typesafe.ai, and the sidecar turns it into one Laya predict call.
 *
 * Same defaults as Jev because selecting the engine is the opt-in: judge the
 * top 40 candidates, threshold 0 (reorder, never drop), both lanes rerank
 * unless their flag is "0". Any failure (sidecar down, timeout, HTTP error,
 * malformed answer) is a typed RerankError; callers degrade to retrieval
 * order and log once per lane and error type.
 */
import { Effect, Layer } from "effect"
import {
  MemoryReranker,
  RerankError,
  jevRequestBatches,
  jevRerankRequest,
  parseJevRerankAnswers,
  type MemoryRerankerApi,
} from "@luna/core"

export const DEFAULT_LAYA_URL = "http://127.0.0.1:8182"

/** The sidecar's per-request latency is a forward pass (~33ms GPU, under a
 * second on CPU for a 40-candidate batch), not TypeSafe's cold-start-prone
 * remote call - but the first request after a lazy Router checkpoint load
 * can take seconds, so the budget stays generous. */
export const DEFAULT_LAYA_TIMEOUT_MS = 10_000

/** Held-out validated depth: Jev's 40 beat 20 (28 / 5 questions, p = 7e-5) on
 * the same request shape the sidecar replays. */
export const LAYA_DEFAULT_MAX_CANDIDATES = 40

/** The checkpoint selector the sidecar resolves; "auto" lets its Router pick
 * per request (English vs multilingual vs typed-decisions). */
export const DEFAULT_LAYA_MODEL = "auto"

/** Queries are capped like per-turn recall caps them (memory_search's is agent-written and unbounded). */
const MAX_QUERY_CHARS = 2_000

export interface LayaRerankerOptions {
  readonly url?: string
  readonly model?: string
  readonly timeoutMs?: number
  readonly threshold?: number
  readonly fetch?: typeof fetch
  /** Send one tiny, data-free request when the layer is built, so a lazy sidecar checkpoint load does not land on the first real call (default true). */
  readonly warmUp?: boolean
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")

function resolveUrl(explicit?: string): string {
  const configured = explicit ?? process.env["LUNA_LAYA_URL"]
  return (configured?.trim() || DEFAULT_LAYA_URL).replace(/\/+$/, "")
}

function resolveModel(explicit?: string): string {
  return explicit ?? (process.env["LUNA_LAYA_MODEL"]?.trim() || DEFAULT_LAYA_MODEL)
}

export function LayaRerankerLayer(opts: LayaRerankerOptions = {}): Layer.Layer<MemoryReranker> {
  const url = resolveUrl(opts.url)
  const model = resolveModel(opts.model)
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_LAYA_TIMEOUT_MS
  const doFetch = opts.fetch ?? fetch

  /** One request; probabilities in the order of `memories`. */
  const requestOnce = async (query: string, memories: ReadonlyArray<string>, signal: AbortSignal): Promise<ReadonlyArray<number>> => {
    const res = await doFetch(`${url}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(jevRerankRequest(query, memories, model)),
      signal,
    })
    if (!res.ok) {
      // Any error body may echo the query or private memory text. This error
      // reaches server logs, so keep the diagnostic data-free for every status.
      throw new RerankError({ op: "stream", message: `laya HTTP ${res.status}` })
    }
    let json: unknown
    try {
      json = await res.json()
    } catch (cause) {
      if (isTimeout(cause)) throw cause
      throw new RerankError({ op: "parse", message: "laya reply is not JSON", cause })
    }
    try {
      return parseJevRerankAnswers(json, memories.length).probabilities
    } catch (cause) {
      throw new RerankError({ op: "parse", message: cause instanceof Error ? cause.message : String(cause), cause })
    }
  }

  const rerank: MemoryRerankerApi["rerank"] = (args) => {
    if (args.candidates.length === 0) return Effect.succeed([])
    const budgetMs = args.timeoutMs !== undefined && args.timeoutMs > 0 ? args.timeoutMs : defaultTimeoutMs
    const query = args.queryText.slice(0, MAX_QUERY_CHARS)
    const texts = args.candidates.map((c) => c.text)
    return Effect.tryPromise({
      try: async (signal) => {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)])
        // Usually one request; more only when the text would exceed the per-request
        // token budget (e.g. 40 long CJK memories). Questions are independent, so
        // splitting does not change scores.
        const batches = jevRequestBatches(texts)
        const results = await Promise.all(batches.map((idx) => requestOnce(query, idx.map((i) => texts[i]!), combined)))
        const probabilities: number[] = new Array(texts.length)
        batches.forEach((idx, b) => idx.forEach((i, k) => (probabilities[i] = results[b]![k]!)))
        return probabilities
      },
      catch: (cause) => {
        if (cause instanceof RerankError) return cause
        return isTimeout(cause)
          ? new RerankError({ op: "timeout", message: `laya exceeded the per-call budget of ${budgetMs}ms (${args.candidates.length} candidates)`, cause })
          : new RerankError({ op: "stream", message: `laya request failed (${url}): ${String(cause)}`, cause })
      },
    }).pipe(
      Effect.map((probabilities) =>
        args.candidates.map((c, i) => ({ id: c.id, llmScore: Math.max(0, Math.min(100, probabilities[i]! * 100)) })),
      ),
    )
  }

  const api: MemoryRerankerApi = {
    rerank,
    engine: "laya",
    defaults: { maxCandidates: LAYA_DEFAULT_MAX_CANDIDATES, threshold: opts.threshold ?? 0, enabled: true },
  }
  if (opts.warmUp === false) return Layer.succeed(MemoryReranker, api)
  return Layer.effect(
    MemoryReranker,
    Effect.gen(function* () {
      // Fire-and-forget, no user data: a failure here only means the first real call may pay the checkpoint load.
      yield* Effect.forkDetach(
        Effect.ignore(rerank({ queryText: "warm-up", candidates: [{ id: "warm-up", text: "warm-up", retrievalScore: 0 }], timeoutMs: 30_000 })),
      )
      return api
    }),
  )
}
