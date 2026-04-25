/**
 * TrainingHarness — public types (Phase 20).
 *
 * Execution substrate for Labs (§2.1.10) and ad-hoc evals (§2.1.11).
 *
 * The harness is intentionally minimal: a runner abstraction (`Runner`)
 * and a `runEval` operation that turns a (prompt, expected) pair into
 * a `Score`. No persistence, no rubric engine, no LLM judge — those
 * are deferred per §14.
 *
 * Real Runner implementations bridge to the SDK adapter; tests inject
 * a stub Runner. The harness is storage-agnostic (a future ops adapter
 * can persist EvalRecord results from a stream/snapshot).
 */
import type { Effect } from "effect"

/** A producer of model output for a given prompt. */
export interface Runner {
  readonly run: (prompt: string) => Effect.Effect<string>
}

/** Result of a single eval run. */
export interface Score {
  readonly prompt: string
  readonly expected: string
  readonly actual: string
  /** 0..1 numeric score. Caller's scoreFn produces this. */
  readonly value: number
  readonly ts: string
}

/** Score function: compare actual vs expected → numeric in [0,1]. */
export type ScoreFn = (actual: string, expected: string) => number

/** Default scoreFn — exact-match (1.0) or 0.0. */
export const exactMatchScore: ScoreFn = (a, e) => (a === e ? 1.0 : 0.0)

export interface TrainingHarnessConfig {
  /** Score function applied if the caller doesn't supply one. Default: exactMatchScore. */
  readonly defaultScoreFn?: ScoreFn
}

export interface TrainingHarnessApi {
  /**
   * Run a single eval: invoke the runner with `prompt`, score the
   * result against `expected`. Returns a Score record.
   */
  readonly runEval: (
    prompt: string,
    expected: string,
    scoreFn?: ScoreFn,
  ) => Effect.Effect<Score>

  /**
   * Run multiple eval pairs sequentially. Returns all Score records.
   */
  readonly runBatch: (
    pairs: ReadonlyArray<{ prompt: string; expected: string }>,
    scoreFn?: ScoreFn,
  ) => Effect.Effect<ReadonlyArray<Score>>
}
