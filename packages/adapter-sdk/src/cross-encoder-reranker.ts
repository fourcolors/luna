/**
 * cross-encoder-reranker.ts - Deterministic llama-server MemoryReranker.
 *
 * This implementation is additive beside MemoryRerankerDefault. It uses the
 * existing MemoryReranker contract so callers keep the same typed-failure
 * fallback to retrieval order.
 */
import { Effect, Layer, Ref } from "effect"
import {
  MemoryReranker,
  RerankError,
  type MemoryRerankerApi,
  type RerankArgs,
  type RerankScore,
} from "@luna/core"

export const DEFAULT_CROSS_ENCODER_URL = "http://127.0.0.1:8181"
// Measured on the reference sidecar (--ctx-size 16384 --parallel 4): a
// worst-case 20-candidate x 1,000-char request costs ~870ms end-to-end, so
// 2000ms clears that with headroom for ONE request in flight per slot. This
// assumes no server-side queueing: if the caller sends more concurrent
// requests than the sidecar has slots for, a queued request's real latency
// grows past this ceiling and looks identical to a broken/unreachable
// server, which is why callers that batch many rerank() calls (the bench
// harness) must cap their own concurrency well under the sidecar's
// --parallel count rather than relying on this timeout to absorb queueing.
export const DEFAULT_CROSS_ENCODER_TIMEOUT_MS = 2_000
export const DEFAULT_CROSS_ENCODER_MAX_INPUT_CHARS = 48_000

const CROSS_ENCODER_MODEL = "cross-encoder"
const HEALTH_TIMEOUT_MS = 500
const BUSY_RETRY_BACKOFF_MS = 500

export interface CrossEncoderRerankerOptions {
  readonly url?: string
  readonly timeoutMs?: number
}

export interface ProbeResult {
  readonly relevantRawScore: number
  readonly irrelevantRawScore: number
}

interface RawRerankScore extends RerankScore {
  readonly rawScore: number
}

function resolveUrl(explicit?: string): string {
  const configured = explicit ?? process.env["LUNA_RERANK_CE_URL"]
  return (configured?.trim() || DEFAULT_CROSS_ENCODER_URL).replace(/\/+$/, "")
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.min(Math.trunc(value), 2_147_483_647)
    : fallback
}

function resolveTimeoutMs(explicit?: number): number {
  if (explicit !== undefined) {
    return positiveTimeout(explicit, DEFAULT_CROSS_ENCODER_TIMEOUT_MS)
  }
  const raw = process.env["LUNA_RERANK_CE_TIMEOUT_MS"]?.trim()
  return positiveTimeout(raw ? Number(raw) : undefined, DEFAULT_CROSS_ENCODER_TIMEOUT_MS)
}

function resolveMaxInputChars(): number {
  const raw = process.env["LUNA_RERANK_CE_MAX_INPUT_CHARS"]?.trim()
  return positiveTimeout(raw ? Number(raw) : undefined, DEFAULT_CROSS_ENCODER_MAX_INPUT_CHARS)
}

/**
 * llama.cpp applies softmax to Qwen3 classification output under rank pooling,
 * so `/v1/rerank` returns an already-bounded probability and must not receive a
 * second sigmoid. Source: ggml-org/llama.cpp src/llama-graph.cpp,
 * `build_pooling`, `if (arch == LLM_ARCH_QWEN3) ggml_soft_max(...)`.
 */
export function normalizeCrossEncoderScore(rawScore: number): number {
  return Math.max(0, Math.min(100, Math.round(rawScore * 100)))
}

function parseResponse(
  raw: unknown,
  candidates: RerankArgs["candidates"],
): ReadonlyArray<RawRerankScore> {
  if (raw === null || typeof raw !== "object") {
    throw new Error("rerank response is not a JSON object")
  }
  const results = (raw as Record<string, unknown>)["results"]
  if (!Array.isArray(results)) {
    throw new Error("rerank response missing a `results` array")
  }
  if (candidates.length > 0 && results.length === 0) {
    throw new RerankError({
      op: "empty",
      message: "rerank server returned zero results for a non-empty request",
    })
  }

  return results.map((entry, resultIndex) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`rerank result ${resultIndex} is not an object`)
    }
    const result = entry as Record<string, unknown>
    const index = result["index"]
    const rawScore = result["relevance_score"]
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= candidates.length) {
      throw new Error(`rerank result ${resultIndex} has an invalid document index`)
    }
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
      throw new Error(`rerank result ${resultIndex} is missing a finite relevance_score`)
    }
    return {
      id: candidates[index as number]!.id,
      llmScore: normalizeCrossEncoderScore(rawScore),
      rawScore,
    }
  })
}

function requestScoreBatch(
  url: string,
  timeoutMs: number,
  args: RerankArgs,
): Effect.Effect<ReadonlyArray<RawRerankScore>, RerankError> {
  return Effect.gen(function* () {
    if (args.candidates.length === 0) return []

    const requestTimeoutMs = positiveTimeout(args.timeoutMs, timeoutMs)
    const signal = AbortSignal.timeout(requestTimeoutMs)
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${url}/v1/rerank`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: CROSS_ENCODER_MODEL,
            query: args.queryText,
            documents: args.candidates.map((candidate) => candidate.text),
            top_n: args.candidates.length,
          }),
          signal,
        }),
      catch: (cause) => {
        if (signal.aborted) {
          return new RerankError({
            op: "timeout",
            message: `cross-encoder request timed out after ${requestTimeoutMs}ms`,
            cause,
          })
        }
        return new RerankError({
          op: "acquire",
          message: `failed to reach cross-encoder server at ${url}: ${String(cause)}`,
          cause,
        })
      },
    })

    // The closed error vocabulary has no HTTP-status operation. A non-2xx
    // response is an unusable protocol response, so it shares `parse` with a
    // malformed response body rather than pretending the response never began.
    if (!response.ok) {
      return yield* Effect.fail(
        new RerankError({
          op: "parse",
          message: `cross-encoder server returned HTTP ${response.status}`,
        }),
      )
    }

    const json = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) =>
        new RerankError({
          op: "parse",
          message: `cross-encoder response was not valid JSON: ${String(cause)}`,
          cause,
        }),
    })

    return yield* Effect.try({
      try: () => parseResponse(json, args.candidates),
      catch: (cause) =>
        cause instanceof RerankError
          ? cause
          : new RerankError({
              op: "parse",
              message: `cross-encoder response shape was invalid: ${String(cause)}`,
              cause,
            }),
    })
  })
}

function splitCandidateBatches(
  queryText: string,
  candidates: RerankArgs["candidates"],
  maxInputChars: number,
): ReadonlyArray<RerankArgs["candidates"]> {
  const batches: Array<RerankArgs["candidates"]> = []
  let batch: RerankArgs["candidates"] = []
  let batchChars = queryText.length

  for (const candidate of candidates) {
    if (batch.length > 0 && batchChars + candidate.text.length > maxInputChars) {
      batches.push(batch)
      batch = []
      batchChars = queryText.length
    }

    // A pathological single memory can exceed the heuristic. Sending it by
    // itself preserves the no-truncation contract and avoids silently losing
    // a candidate, while still isolating it from every other document.
    batch = [...batch, candidate]
    batchChars += candidate.text.length
  }

  if (batch.length > 0) batches.push(batch)
  return batches
}

function requestScores(
  url: string,
  timeoutMs: number,
  maxInputChars: number,
  args: RerankArgs,
): Effect.Effect<ReadonlyArray<RawRerankScore>, RerankError> {
  return Effect.gen(function* () {
    if (args.candidates.length === 0) return []

    // Four characters per token is conservative for English prose. A 48,000
    // character default is about 12,000 input tokens, leaving about 4,384
    // tokens of a 16,384-token sidecar context for query, template, and special
    // token overhead. Keep this default aligned with .scratch/ce-server.sh.
    const batches = splitCandidateBatches(args.queryText, args.candidates, maxInputChars)
    const merged: RawRerankScore[] = []
    for (const candidates of batches) {
      // Sub-batches stay sequential so one logical rerank does not multiply
      // load on a sidecar that is already serving concurrent queries.
      const scores = yield* requestScoreBatch(url, timeoutMs, { ...args, candidates })
      merged.push(...scores)
    }
    return merged
  })
}

function probeHealth(url: string, timeoutMs: number): Effect.Effect<void, RerankError> {
  return Effect.gen(function* () {
    const healthTimeoutMs = Math.min(timeoutMs, HEALTH_TIMEOUT_MS)
    const signal = AbortSignal.timeout(healthTimeoutMs)
    const response = yield* Effect.tryPromise({
      try: () => fetch(`${url}/health`, { method: "GET", signal }),
      catch: (cause) =>
        new RerankError({
          op: "acquire",
          message: signal.aborted
            ? `cross-encoder health check timed out after ${healthTimeoutMs}ms at ${url}; server is unreachable`
            : `cross-encoder health check failed at ${url}; server is unreachable: ${String(cause)}`,
          cause,
        }),
    })

    if (!response.ok) {
      return yield* Effect.fail(
        new RerankError({
          op: "acquire",
          message: `cross-encoder health endpoint at ${url} returned HTTP ${response.status}; server is reachable but not healthy`,
        }),
      )
    }
  })
}

function probeWithTimeout(
  url: string,
  timeoutMs: number,
): Effect.Effect<ProbeResult, RerankError> {
  const queryText = "what port does the server use"
  const normalizedUrl = url.replace(/\/+$/, "")
  const args = {
    queryText,
    candidates: [
      { id: "relevant", text: "the server listens on port 4753", retrievalScore: 0 },
      { id: "irrelevant", text: "bananas are yellow", retrievalScore: 0 },
    ],
  } satisfies RerankArgs
  const calibrate = requestScores(normalizedUrl, timeoutMs, resolveMaxInputChars(), args)

  return probeHealth(normalizedUrl, timeoutMs).pipe(
    Effect.andThen(
      calibrate.pipe(
        Effect.catchIf(
          (error) => error.op === "timeout",
          () =>
            Effect.sleep(`${BUSY_RETRY_BACKOFF_MS} millis`).pipe(
              Effect.andThen(calibrate),
              Effect.mapError((error) =>
                error.op === "timeout"
                  ? new RerankError({
                      op: "timeout",
                      message: `cross-encoder server at ${normalizedUrl} is reachable but not responding to reranking requests within ${timeoutMs}ms after one retry`,
                      cause: error,
                    })
                  : error,
              ),
            ),
        ),
      ),
    ),
    Effect.flatMap((scores) => {
      const relevant = scores.find((score) => score.id === "relevant")
      const irrelevant = scores.find((score) => score.id === "irrelevant")
      if (
        relevant === undefined ||
        irrelevant === undefined ||
        relevant.rawScore <= irrelevant.rawScore ||
        relevant.llmScore <= 50
      ) {
        return Effect.fail(
          new RerankError({
            op: scores.length === 0 ? "empty" : "parse",
            message:
              "cross-encoder calibration failed; the GGUF may be broken or missing cls.output.weight (broken-GGUF trap)",
          }),
        )
      }
      return Effect.succeed({
        relevantRawScore: relevant.rawScore,
        irrelevantRawScore: irrelevant.rawScore,
      })
    }),
  )
}

export function probeCrossEncoder(url: string): Effect.Effect<ProbeResult, RerankError> {
  return probeWithTimeout(resolveUrl(url), resolveTimeoutMs())
}

export function CrossEncoderRerankerLayer(
  opts: CrossEncoderRerankerOptions = {},
): Layer.Layer<MemoryReranker, never, never> {
  return Layer.effect(
    MemoryReranker,
    Effect.gen(function* () {
      const url = resolveUrl(opts.url)
      const timeoutMs = resolveTimeoutMs(opts.timeoutMs)
      const maxInputChars = resolveMaxInputChars()
      const probePassed = yield* Ref.make(false)

      const rerank: MemoryRerankerApi["rerank"] = (args) =>
        Effect.gen(function* () {
          if (args.candidates.length === 0) return []

          if (!(yield* Ref.get(probePassed))) {
            yield* probeWithTimeout(url, timeoutMs)
            yield* Ref.set(probePassed, true)
          }

          // `/v1/rerank` has no sampling parameters. Identical inputs must
          // produce identical scores, which is the Phase 4 enable-blocker.
          const scores = yield* requestScores(url, timeoutMs, maxInputChars, args)
          return scores.map(({ id, llmScore }) => ({ id, llmScore }))
        })

      return { rerank }
    }),
  )
}
