/**
 * jev-classifier.ts - TypeSafe Jev as the Classifier (decision engine).
 *
 * Bound when the classifier engine resolves to "jev" (LUNA_CLASSIFIER_ENGINE;
 * "auto" picks Jev when TYPESAFE_API_KEY resolves and no explicit classifier
 * model is bound — see provider-settings resolver). Needs the operator's own
 * TYPESAFE_API_KEY, resolved like every other server secret (Luna vault,
 * Keychain or environment, by vault mode - never the repo). Every ask() call
 * sends the caller's state (message/decision text) to api.typesafe.ai, so
 * configuring it is the operator's decision to share that text with TypeSafe.
 *
 * Requests are built by @luna/core's jevClassifierRequest: caller-shaped
 * state + typed questions (noul/choice/score), answered with typed
 * probabilities instead of generated JSON — calibrated, and without the
 * parse surface a chat model's "please emit JSON" has. Any failure (no key,
 * timeout, HTTP error, malformed answer) is a typed ClassifierError; callers
 * fall back to their generative/heuristic path, never crash the decision.
 *
 * The model defaults to JEV_MODEL and is overridable per deployment via
 * LUNA_JEV_MODEL (shared with the reranker: both are the same System One
 * endpoint) or opts.model — that is the swap point as Jev versions land.
 */
import { Effect, Layer } from "effect"
import {
  Classifier,
  ClassifierError,
  JEV_MODEL,
  JEV_URL,
  jevClassifierRequest,
  parseJevClassifierAnswers,
  type AskArgs,
  type ClassifierApi,
} from "@luna/core"

/** Decision calls are a handful of questions, but the first call after an
 *  idle spell has measured 9-19 s (TypeSafe-side cold start; warm calls
 *  ~0.2 s), so the default budget outlasts one cold call. */
export const DEFAULT_JEV_CLASSIFIER_TIMEOUT_MS = 25_000

export interface JevClassifierOptions {
  /** The resolved TYPESAFE_API_KEY; missing or empty = every call fails with op "acquire". */
  readonly apiKey?: string
  readonly model?: string
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
  /** Send one tiny, data-free request when the layer is built, so the first real call is not the cold one (default true). */
  readonly warmUp?: boolean
}

const isTimeout = (e: unknown) => e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")

export function JevClassifierLayer(opts: JevClassifierOptions = {}): Layer.Layer<Classifier> {
  const apiKey = opts.apiKey?.trim()
  const model = opts.model ?? (process.env["LUNA_JEV_MODEL"]?.trim() || JEV_MODEL)
  const defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_JEV_CLASSIFIER_TIMEOUT_MS
  const doFetch = opts.fetch ?? fetch

  const ask: ClassifierApi["ask"] = (args: AskArgs) => {
    if (Object.keys(args.questions).length === 0) return Effect.succeed({})
    if (!apiKey) {
      return Effect.fail(
        new ClassifierError({
          op: "acquire",
          message: "classifier engine jev needs TYPESAFE_API_KEY (Luna vault or environment)",
        }),
      )
    }
    const budgetMs = args.timeoutMs !== undefined && args.timeoutMs > 0 ? args.timeoutMs : defaultTimeoutMs
    return Effect.tryPromise({
      try: async (signal) => {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)])
        const res = await doFetch(JEV_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(jevClassifierRequest(args.state, args.questions, model)),
          signal: combined,
        })
        if (!res.ok) {
          // Any error body may echo the state (private message/decision
          // text). This error reaches server logs, so keep the diagnostic
          // data-free for every status.
          throw new ClassifierError({ op: "stream", message: `jev HTTP ${res.status}` })
        }
        let json: unknown
        try {
          json = await res.json()
        } catch (cause) {
          if (isTimeout(cause)) throw cause
          throw new ClassifierError({ op: "parse", message: "jev reply is not JSON", cause })
        }
        try {
          return parseJevClassifierAnswers(json, args.questions).answers
        } catch (cause) {
          throw new ClassifierError({
            op: "parse",
            message: cause instanceof Error ? cause.message : String(cause),
            cause,
          })
        }
      },
      catch: (cause) => {
        if (cause instanceof ClassifierError) return cause
        return isTimeout(cause)
          ? new ClassifierError({
              op: "timeout",
              message: `jev exceeded the per-call budget of ${budgetMs}ms (${Object.keys(args.questions).length} questions)`,
              cause,
            })
          : new ClassifierError({ op: "stream", message: `jev request failed: ${String(cause)}`, cause })
      },
    })
  }

  const api: ClassifierApi = { ask, engine: "jev" }
  if (opts.warmUp === false || !apiKey) return Layer.succeed(Classifier, api)
  return Layer.effect(
    Classifier,
    Effect.gen(function* () {
      // Fire-and-forget, no user data: a failure here only means the first real call may be cold.
      yield* Effect.forkDetach(
        Effect.ignore(
          ask({
            state: "warm-up",
            questions: { w: { type: "noul", instructions: "Reply yes." } },
            timeoutMs: 30_000,
          }),
        ),
      )
      return api
    }),
  )
}
