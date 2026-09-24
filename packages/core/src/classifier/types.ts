/**
 * classifier/types.ts - the Classifier Tag + question/answer types + wiring
 * doubles (SDK-free, like memory-rerank/types.ts).
 *
 * WHY THIS EXISTS
 * The `classifier` model-routing role reserves a cheap generative lane for
 * "message routing and general structured work". Decision-shaped work on that
 * lane - pick a route, gate yes/no, grade on a rubric - is exactly what
 * TypeSafe's System One models (Jev) are built for: a `state` plus typed
 * questions, answered with calibrated probabilities instead of generated
 * JSON. Jev is the measured better judge than a generative model asked for
 * JSON (packages/adapter-sdk/src/jev-reranker.ts has the evidence), and the
 * typed contract removes the parse surface entirely.
 *
 * This service is the seam decision-shaped call sites use: `ask()` takes a
 * state and typed questions and returns typed answers. Which ENGINE serves
 * it is a server boot-time decision (LUNA_CLASSIFIER_ENGINE): "jev" binds
 * adapter-sdk's JevClassifierLayer; "model" binds nothing here - the call
 * site falls back to the generative classifier lane, so non-decision work
 * (arbitrary JSON) is unaffected. Consumers resolve with
 * Effect.serviceOption(Classifier) - absent means "no dedicated engine".
 */

import { Context, Data, Effect, Layer } from "effect"

/* ------------------------------------------------------------------------ */
/* Question + answer types — System One's wire contract                      */
/* ------------------------------------------------------------------------ */

/** Content a question or state can carry: text, or a JSON-shaped map/list. */
export type ClassifierContent =
  | string
  | Readonly<Record<string, unknown>>
  | ReadonlyArray<unknown>

/** A yes/no judgment. The answer is the probability of "yes" (0..1). */
export interface NoulQuestion {
  readonly type: "noul"
  readonly instructions: ClassifierContent
  /** Optional descriptions of a yes and a no; Jev calibrates better with them. */
  readonly criteria?: { readonly true: string; readonly false: string }
}

/** Pick one option out of a defined set. `criteria` maps optionId -> what
 *  that option means; the answer's `choice` is one of the keys. */
export interface ChoiceQuestion {
  readonly type: "choice"
  readonly instructions: ClassifierContent
  readonly criteria: Readonly<Record<string, ClassifierContent>>
}

/** Grade the state on an ordered rubric. `criteria` lists level descriptions
 *  low -> high; the answer's `score` is the index of the winning level. */
export interface ScoreQuestion {
  readonly type: "score"
  readonly instructions: ClassifierContent
  readonly criteria: ReadonlyArray<ClassifierContent>
}

export type ClassifierQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

export interface NoulAnswer {
  readonly type: "noul"
  readonly noul: number
}

export interface ChoiceAnswer {
  readonly type: "choice"
  readonly choice: string
  readonly confidence?: number
  readonly probabilities?: Readonly<Record<string, number>>
}

export interface ScoreAnswer {
  readonly type: "score"
  readonly score: number
  readonly confidence?: number
  readonly legend?: Readonly<Record<string, string>>
  readonly probabilities?: Readonly<Record<string, number>>
}

export type ClassifierAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export interface AskArgs {
  /** The context every question is judged against (text or JSON-shaped). */
  readonly state: ClassifierContent
  /** id -> question; every question is evaluated against `state` in
   *  parallel, so one call can decide several things at once. */
  readonly questions: Readonly<Record<string, ClassifierQuestion>>
  /** Per-call wall-clock ceiling override (ms). */
  readonly timeoutMs?: number
}

/** The answers keyed by the caller's question ids — every question in the
 *  request MUST come back with a well-formed answer or the call fails; a
 *  classifier that silently drops a question would bias the decision. */
export type ClassifierAnswers = Readonly<Record<string, ClassifierAnswer>>

/* ------------------------------------------------------------------------ */
/* The service                                                               */
/* ------------------------------------------------------------------------ */

export interface ClassifierApi {
  /**
   * Judge `questions` against `state` and return one typed answer per
   * question id. Fails with ClassifierError on a whole-call failure
   * (timeout/transport/parse) — the caller's contract is to fall back to its
   * generative/heuristic path, never to crash the decision.
   */
  readonly ask: (args: AskArgs) => Effect.Effect<ClassifierAnswers, ClassifierError>
  /** Engine name for logs ("jev"). */
  readonly engine?: string
}

export class ClassifierError extends Data.TaggedError("ClassifierError")<{
  readonly op: "acquire" | "timeout" | "stream" | "parse" | "empty" | "defect"
  readonly message: string
  readonly cause?: unknown
}> {}

export class Classifier extends Context.Service<Classifier, ClassifierApi>()(
  "luna/Classifier",
) {}

/* ------------------------------------------------------------------------ */
/* Wiring doubles                                                            */
/* ------------------------------------------------------------------------ */

/** Test/wiring double — returns `answers` verbatim (defaults {} for ids not
 *  asked, so a fake can stay terse and still satisfy every question). */
export const FakeClassifier = {
  of: (answers: ClassifierAnswers): Layer.Layer<Classifier> =>
    Layer.succeed(Classifier, { ask: () => Effect.succeed(answers) }),
} as const
