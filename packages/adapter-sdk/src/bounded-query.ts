/**
 * bounded-query.ts — run one `sdk.query()` agent turn under a wall-clock
 * deadline, with a hard subprocess kill on expiry.
 *
 * WHY THIS EXISTS: the V2 ticker dispatches workers INLINE on a single fiber
 * (`job-ticker.ts`), so any agent turn with no deadline can wedge EVERY other
 * V2 job. Three call sites run agent turns the same way — the workflow prompt
 * step, the prompt worker (daily-brief), and the dream reasoner — and each used
 * the identical, timeout-less `Stream.fromAsyncIterable(query).runFold`. This
 * module is the ONE place that consumption + its interruption handling lives,
 * so a fix or audit happens once, not three times.
 *
 * THE LANDMINE (why this isn't a one-line `Effect.timeout`): interrupting a
 * direct `Stream.fromAsyncIterable` consumption deadlocks. Effect's interrupt
 * path awaits the async iterator's `.return()`, which a wedged turn never
 * settles — so `Effect.timeout` blocks forever instead of firing. (Proven: an
 * earlier direct-Stream attempt hung a 50ms-deadline test to its 10s ceiling.)
 *
 * THE FIX (mirrors `adapter.ts`): detach the SDK's `for await` into a bare
 * Promise (the producer) that pushes frames onto an Effect Queue. The consumer
 * reads via `Queue.take`, which IS cleanly interruptible — so `timeoutOption`
 * fires instantly. On timeout we abort the `AbortController` wired into the
 * query options (the SDK honors it by killing its subprocess), and the wedged
 * producer is orphaned + GC'd. Without the abort, a timed-out agent keeps
 * running headless and could still mutate state after we've moved on.
 *
 * RESIDUAL (accepted, inherited from adapter.ts): the abort-honoring assumption
 * is the linchpin. If the SDK does NOT honor `options.abortController`, the
 * orphaned producer + its queue are retained until process exit — one bounded
 * leak per timed-out turn. The ticker still unblocks (this helper returns
 * regardless), so the single-fiber-stall goal holds even then.
 */
import { Duration, Effect, Option, Queue } from "effect"
import type { QueryParams, SDKClientService, SDKMessage } from "./sdk-client.js"

/**
 * Default wall-clock ceiling for an agent turn that doesn't specify its own.
 *
 * 10 min comfortably clears a real `max_turns` run yet bounds the worst-case
 * stall of the single-fiber ticker. Callers with a long-running turn (e.g.
 * media generation) should pass an explicit, larger `timeoutMs`.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 10 * 60 * 1000 // 10 min

/** Whole-turn token totals lifted off the SDK result frame (same field names
 * the chat adapter's B4 usage report reads). Lets broker-acquired callers
 * (wake/dream reasoners) meter their turns against the spend meter. */
interface BoundedQueryUsage {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /**
   * The model that ACTUALLY served the turn, lifted from the result frame's
   * `modelUsage` map — but only when it reports exactly ONE model. Lane
   * strings can be aliases ("default", "opus") that price at a tier default;
   * the real id prices exactly. Multi-model turns (subagents) stay undefined
   * rather than mispricing the whole turn at one model's rate.
   */
  readonly model?: string
}

/**
 * The terminal outcomes of a bounded turn. Each caller maps these onto
 * its own contract (a step result, a `WorkerError`, a `DreamError`, …).
 */
export type BoundedQueryOutcome =
  | {
      readonly _tag: "result"
      readonly text: string
      /**
       * Present when the result frame carried a `structured_output` payload —
       * i.e. the caller passed `options.outputFormat: { type: "json_schema" }`
       * and the SDK schema-validated the model's output. Callers that requested
       * structured output should prefer this over re-parsing `text`. Absent for
       * every plain (non-`outputFormat`) turn, so existing callers are unaffected.
       */
      readonly structuredOutput?: unknown
      /** Present when the result frame carried `.usage` token totals. */
      readonly usage?: BoundedQueryUsage
    }
  /** Stream ended with no `type:"result"`/`subtype:"success"` message. */
  | { readonly _tag: "empty" }
  /**
   * Stream ended with a terminal `type:"result"` frame whose subtype was NOT
   * "success" (e.g. `error_max_turns`, `error_max_budget_usd`) — a
   * deterministic SDK-reported ceiling, distinct from `"empty"` (no result
   * frame at all) so callers can tell "the SDK told us why it stopped" from
   * "the stream just ended". Only surfaced when no success frame preceded it
   * (see the fold: a success frame always wins).
   */
  | { readonly _tag: "result_error"; readonly subtype: string; readonly numTurns?: number }
  /** Deadline hit; the subprocess was aborted. */
  | { readonly _tag: "timeout"; readonly timeoutMs: number }
  /** The producer's `for await` threw (subprocess/stream error). */
  | { readonly _tag: "error"; readonly cause: unknown }

// NOTE: budget-ceiling classification lives in @luna/core's worker-registry,
// next to the `WorkerError.reason` union it feeds, so BOTH the SDK workers
// here and core's own `define-worker` boundary (which wraps the reasoner
// lanes) share one definition. See `isBudgetCeilingCause`.

/** A frame in the detached producer→consumer channel. */
type Frame =
  | { readonly _tag: "msg"; readonly msg: SDKMessage }
  | { readonly _tag: "end" }
  | { readonly _tag: "error"; readonly cause: unknown }

const abortQuietly = (ac: AbortController): void => {
  try {
    ac.abort()
  } catch {
    /* already aborted */
  }
}

/**
 * Run `sdk.query(params)` to its `result` message under a `timeoutMs` deadline.
 *
 * Every caller-supplied option is preserved EXCEPT `abortController`: this helper
 * injects and SOLELY OWNS the kill switch, so any caller-supplied one is ignored.
 * Never fails — the outcome (including stream errors and timeouts) is returned in
 * the success channel for the caller to map.
 */
export function runBoundedQuery(
  sdk: SDKClientService,
  params: QueryParams,
  timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS,
): Effect.Effect<BoundedQueryOutcome, never> {
  return Effect.gen(function* () {
    const abort = new AbortController()

    // Inject the kill-switch while keeping the caller's prompt + every option
    // (maxTurns, model, allowedTools, pathToClaudeCodeExecutable, …).
    const query = yield* sdk.query({
      ...params,
      options: { ...(params.options ?? {}), abortController: abort },
    })

    // Detached producer: the SDK's `for await` lives in a bare Promise, NOT an
    // Effect fiber, so the consumer's `Queue.take` can be interrupted INSTANTLY
    // on timeout instead of deadlocking on the iterator's `.return()` cleanup.
    const queue = yield* Queue.unbounded<Frame>()
    // Offers to an UNBOUNDED queue resolve synchronously and never reject, so
    // the success-path offers need no `.catch`; the error path keeps one purely
    // as belt-and-suspenders. The producer is detached (`void runProducer()`),
    // so even a hypothetical rejection could only surface as an unhandled
    // rejection — it can never stall the consumer or the ticker.
    const runProducer = async () => {
      try {
        for await (const msg of query as AsyncIterable<SDKMessage>) {
          await Effect.runPromise(Queue.offer(queue, { _tag: "msg", msg }))
        }
        await Effect.runPromise(Queue.offer(queue, { _tag: "end" }))
      } catch (cause) {
        await Effect.runPromise(
          Queue.offer(queue, { _tag: "error", cause }),
        ).catch(() => {})
      }
    }
    void runProducer()

    const foldQueue = Effect.gen(function* () {
      let acc: {
        text: string
        usage?: BoundedQueryUsage
        structuredOutput?: unknown
      } | null = null
      // Captures the first non-success terminal `result` frame seen (e.g.
      // `error_max_turns`). Only consulted at the end if `acc` never got set
      // — a later success frame (there shouldn't be one after a terminal
      // result, but the loop doesn't assume that) always wins, matching the
      // "a success frame always wins" contract above.
      let resultError: { subtype: string; numTurns?: number } | null = null
      while (true) {
        const frame = yield* Queue.take(queue)
        if (frame._tag === "end") return { acc, resultError }
        if (frame._tag === "error") return yield* Effect.fail(frame.cause)
        const m = frame.msg as {
          type?: string
          subtype?: string
          result?: string
          /**
           * Schema-validated payload, present only when the turn was issued with
           * `options.outputFormat: { type: "json_schema" }`. Lifted alongside
           * (not instead of) `result` so non-structured turns are untouched.
           */
          structured_output?: unknown
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_creation_input_tokens?: number
            cache_read_input_tokens?: number
          }
          modelUsage?: Record<string, unknown>
          num_turns?: number
        }
        // A success result frame counts when it carries EITHER a text result
        // (today's path) OR a structured_output payload (the SDK may omit the
        // text `result` when an outputFormat schema is enforced). Requiring only
        // a string result — as before — would drop a valid structured frame.
        const resultText = typeof m.result === "string" ? m.result : undefined
        const hasStructured = m.structured_output !== undefined
        if (
          m.type === "result" &&
          m.subtype === "success" &&
          (resultText !== undefined || hasStructured)
        ) {
          // Single-model turn → surface the REAL model id for exact pricing
          // (alias lanes like "default"/"opus" otherwise price at a tier
          // default). Multi-model turns stay undefined — see BoundedQueryUsage.
          const muKeys = m.modelUsage ? Object.keys(m.modelUsage) : []
          const realModel = muKeys.length === 1 ? muKeys[0] : undefined
          acc = {
            // `text` stays populated for every back-compat caller: the model's
            // text when present, else a JSON serialization of the structured
            // payload so `outcome.text` is never empty on a structured turn.
            text:
              resultText ??
              (hasStructured ? JSON.stringify(m.structured_output) : ""),
            ...(hasStructured
              ? { structuredOutput: m.structured_output }
              : {}),
            ...(m.usage
              ? {
                  usage: {
                    tokensIn: m.usage.input_tokens ?? 0,
                    tokensOut: m.usage.output_tokens ?? 0,
                    cacheRead: m.usage.cache_read_input_tokens ?? 0,
                    cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
                    ...(realModel !== undefined ? { model: realModel } : {}),
                  },
                }
              : {}),
          }
        } else if (m.type === "result" && m.subtype !== "success") {
          // Terminal result frame reporting a non-success subtype (e.g. the
          // SDK's `error_max_turns` / `error_max_budget_usd` ceilings). Keep
          // consuming — do NOT fail or break — so a success frame arriving
          // later (if the stream is not actually done) still wins per the
          // "a success frame always wins" contract.
          resultError = {
            subtype: m.subtype ?? "unknown",
            ...(typeof m.num_turns === "number" ? { numTurns: m.num_turns } : {}),
          }
        }
      }
    })

    const outcome = yield* foldQueue.pipe(
      // `None` on timeout: the consumer is interrupted but the OUTER effect
      // succeeds, so we abort the subprocess explicitly below.
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      // Covers an OUTER interruption (e.g. the ticker scope is torn down).
      Effect.onInterrupt(() => Effect.sync(() => abortQuietly(abort))),
      Effect.result,
    )

    if (outcome._tag === "Failure") {
      abortQuietly(abort)
      return { _tag: "error", cause: outcome.failure } satisfies BoundedQueryOutcome
    }
    const opt = outcome.success // Option<{acc: {...} | null, resultError: {...} | null}>
    if (Option.isNone(opt)) {
      abortQuietly(abort)
      return { _tag: "timeout", timeoutMs } satisfies BoundedQueryOutcome
    }
    const { acc, resultError } = opt.value
    if (acc !== null) {
      // A success frame always wins, even if a non-success result frame was
      // also seen (shouldn't happen on a well-formed stream, but the fold
      // doesn't assume it can't).
      return {
        _tag: "result",
        text: acc.text,
        ...(acc.structuredOutput !== undefined
          ? { structuredOutput: acc.structuredOutput }
          : {}),
        ...(acc.usage ? { usage: acc.usage } : {}),
      } satisfies BoundedQueryOutcome
    }
    if (resultError !== null) {
      return {
        _tag: "result_error",
        subtype: resultError.subtype,
        ...(resultError.numTurns !== undefined
          ? { numTurns: resultError.numTurns }
          : {}),
      } satisfies BoundedQueryOutcome
    }
    return { _tag: "empty" } satisfies BoundedQueryOutcome
  })
}
