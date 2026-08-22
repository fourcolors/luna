/**
 * cross-encoder-reranker.ts - Deterministic llama-server MemoryReranker.
 *
 * This implementation is additive beside MemoryRerankerDefault. It uses the
 * existing MemoryReranker contract so callers keep the same typed-failure
 * fallback to retrieval order.
 */
import { Effect, Layer, Ref } from "effect"
import * as Semaphore from "effect/Semaphore"
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

  // Every candidate must get EXACTLY ONE score. A short response or a
  // duplicated index would leave some candidate unscored, and applyRerank
  // treats an unscored candidate as a coverage gap that survives the
  // injection gate ungated - so a partial/duplicated server response would
  // silently let junk bypass the >=threshold filter. Enforce a strict 1:1
  // index->candidate bijection; any deviation is a protocol violation the
  // caller must degrade on (fall back to retrieval order), not paper over.
  if (results.length !== candidates.length) {
    throw new Error(
      `rerank response returned ${results.length} results for ${candidates.length} candidates (expected 1:1)`,
    )
  }
  const seenIndices = new Set<number>()
  const scores = results.map((entry, resultIndex) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`rerank result ${resultIndex} is not an object`)
    }
    const result = entry as Record<string, unknown>
    const index = result["index"]
    const rawScore = result["relevance_score"]
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= candidates.length) {
      throw new Error(`rerank result ${resultIndex} has an invalid document index`)
    }
    if (seenIndices.has(index as number)) {
      throw new Error(`rerank response repeated document index ${index as number}`)
    }
    seenIndices.add(index as number)
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) {
      throw new Error(`rerank result ${resultIndex} is missing a finite relevance_score`)
    }
    return {
      id: candidates[index as number]!.id,
      llmScore: normalizeCrossEncoderScore(rawScore),
      rawScore,
    }
  })
  // Redundant given the bijection above, but a cheap invariant tripwire.
  if (seenIndices.size !== candidates.length) {
    throw new Error("rerank response did not cover every candidate index exactly once")
  }
  return scores
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
      // Arity-1 callback: `interrupt` is Effect's fiber-interruption signal.
      // AbortSignal.any aborts the socket when EITHER the per-request timeout
      // fires OR the caller's fiber is interrupted (e.g. recallForTurn's outer
      // recall deadline), so an interrupted rerank never leaves an orphaned
      // fetch holding a sidecar slot.
      try: (interrupt) =>
        fetch(`${url}/v1/rerank`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: CROSS_ENCODER_MODEL,
            query: args.queryText,
            documents: args.candidates.map((candidate) => candidate.text),
            top_n: args.candidates.length,
          }),
          signal: AbortSignal.any([signal, interrupt]),
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
      try: (interrupt) =>
        fetch(`${url}/health`, { method: "GET", signal: AbortSignal.any([signal, interrupt]) }),
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

// 3,445 chars / ~860 tokens (at the 4-chars/token heuristic) of realistic
// prose - safely past the 512-token clamp. In rerank/embedding mode
// llama-server clamps the physical batch to n_ubatch and forces both to 512
// when misconfigured, so any single (query + document) pair over ~512 tokens
// returns HTTP 500. Real memories are frequently this long; a short-only probe
// would PASS against a batch-512 server and then silently 500-and-fall-back on
// every long memory in production (found in Phase 5 real-data calibration).
// Including this long probe document forces that failure to surface at
// calibration. (The single sentence is repeated; JS precedence binds .repeat
// to the last operand only, so this is one literal.)
const PROBE_LONGFORM_DOC =
  "The deployment runbook covers how updates reach the stable environment, long-lived memories in this store frequently exceed two thousand characters because they capture full incident write-ups, architecture decisions, and operator preferences with their rationale. ".repeat(
    13,
  )

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
      // Batch-capacity probe: if the server can't process this long pair it
      // 500s, and the remap below points at the batch size rather than
      // letting the misconfiguration hide until real long memories arrive.
      { id: "longform", text: PROBE_LONGFORM_DOC, retrievalScore: 0 },
    ],
  } satisfies RerankArgs
  // A large fixed split budget (not the caller's LUNA_RERANK_CE_MAX_INPUT_CHARS)
  // so the longform batch-capacity doc is always sent as ONE request - the
  // whole point is to make the server process a long single pair, which
  // splitting would defeat.
  // Probe latency floor is a one-time startup cost, and an ~860-token doc on
  // a CPU-only sidecar can take several seconds - well past the per-CALL
  // DEFAULT_CROSS_ENCODER_TIMEOUT_MS (2000ms). Give calibration a generous
  // floor so a correct-but-slow server isn't misdiagnosed as broken. The floor
  // is env-tunable (also lets tests drive fast timeouts).
  const probeFloorMs = positiveTimeout(
    Number(process.env["LUNA_RERANK_CE_PROBE_TIMEOUT_MS"]),
    30_000,
  )
  const probeTimeoutMs = Math.max(timeoutMs, probeFloorMs)
  const calibrate = requestScores(normalizedUrl, probeTimeoutMs, 1_000_000, args).pipe(
    Effect.mapError((error) =>
      error.op === "parse" && /HTTP 500/.test(error.message)
        ? new RerankError({
            op: "parse",
            message: `cross-encoder returned HTTP 500 on an ~860-token calibration document. Most likely the sidecar's physical batch is too small (rerank mode clamps n_batch=n_ubatch to 512 unless started with --batch-size --ubatch-size >= the longest memory's tokens), which would make long memories silently fall back to un-reranked order; a 500 can also mean an out-of-memory or an unrelated server error, so check the sidecar log`,
            cause: error,
          })
        : error,
    ),
  )

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
                      message: `cross-encoder server at ${normalizedUrl} is reachable but not responding to reranking requests within ${probeTimeoutMs}ms after one retry`,
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
      // Scale check: normalizeCrossEncoderScore assumes /v1/rerank returns a
      // bounded [0,1] probability (Qwen3 rank-pooling softmax). A GGUF/server
      // that returns raw LOGITS instead would separate relevant>irrelevant
      // and clear llmScore>50 above, yet the clamp in normalize would collapse
      // the whole scale to near-0/near-100, degenerating the threshold gate to
      // sign(logit) and mis-scoring every mid-relevance memory. Reject any raw
      // score outside a small tolerance around [0,1] so a scale mismatch fails
      // loudly at calibration instead of silently corrupting the gate.
      if (relevant.rawScore > 1.05 || irrelevant.rawScore < -0.05) {
        return Effect.fail(
          new RerankError({
            op: "parse",
            message: `cross-encoder returned out-of-[0,1] scores (relevant=${relevant.rawScore}, irrelevant=${irrelevant.rawScore}); the server appears to emit raw logits, not softmax probabilities, so score normalization and the injection gate would be invalid`,
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
      // Single-flight guard for the lazy calibration probe: without it, N
      // concurrent first rerank() calls each read false and each run the full
      // health + calibrate (+ retry) sequence, multiplying first-wave load on
      // a sidecar the header warns is queue-sensitive. The semaphore serializes
      // the check-and-run so exactly one fiber probes while the rest await; a
      // failed probe leaves probePassed false so the next call retries.
      const probeGate = yield* Semaphore.make(1)

      const ensureProbed = probeGate.withPermits(1)(
        Effect.gen(function* () {
          if (yield* Ref.get(probePassed)) return
          yield* probeWithTimeout(url, timeoutMs)
          yield* Ref.set(probePassed, true)
        }),
      )

      const rerank: MemoryRerankerApi["rerank"] = (args) => {
        if (args.candidates.length === 0) return Effect.succeed([])
        // args.timeoutMs is the per-CALL scoring budget. It bounds ONLY the
        // post-probe scoring request, NOT the one-time calibration probe: the
        // probe is a startup cost with its own health/calibrate/retry deadlines
        // (and its own 30s floor for slow CPU sidecars), so wrapping it in the
        // 2s scoring budget would kill a correct-but-slow first calibration and
        // never let probePassed flip (Codex review: reproduced a 2.5s probe
        // dying at 2000ms). The per-fetch AbortSignal.timeout still aborts
        // individual sockets, and interruption propagates via AbortSignal.any.
        const budgetMs = positiveTimeout(args.timeoutMs, timeoutMs)
        return Effect.gen(function* () {
          yield* ensureProbed
          // `/v1/rerank` has no sampling parameters. Identical inputs must
          // produce identical scores, which is the Phase 4 enable-blocker.
          const scores = yield* requestScores(url, timeoutMs, maxInputChars, args).pipe(
            Effect.timeoutOrElse({
              duration: `${budgetMs} millis`,
              orElse: () =>
                Effect.fail(
                  new RerankError({
                    op: "timeout",
                    message: `cross-encoder scoring exceeded the per-call budget of ${budgetMs}ms (${args.candidates.length} candidates)`,
                  }),
                ),
            }),
          )
          return scores.map(({ id, llmScore }) => ({ id, llmScore }))
        })
      }

      return { rerank }
    }),
  )
}
