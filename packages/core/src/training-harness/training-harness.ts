/**
 * TrainingHarness — execution substrate (Phase 20).
 *
 * Wraps a `Runner` (caller-supplied; usually an SDK-adapter bridge or
 * stub) and produces Score records. Layer.effect — no Scope-attached
 * resources beyond what the Runner itself owns.
 */
import { Context, Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import {
  exactMatchScore,
  type Runner,
  type Score,
  type ScoreFn,
  type TrainingHarnessApi,
  type TrainingHarnessConfig,
} from "./types.js"

export class TrainingHarness extends Context.Service<TrainingHarness, TrainingHarnessApi>()("luna/TrainingHarness") {
  /**
   * Construct a Layer that provides TrainingHarness using the given
   * Runner. The Runner is treated as an externally-managed resource.
   */
  static makeLayer(
    runner: Runner,
    config?: TrainingHarnessConfig,
  ): Layer.Layer<TrainingHarness, never, Clock> {
    const defaultScoreFn = config?.defaultScoreFn ?? exactMatchScore
    return Layer.effect(
      TrainingHarness,
      Effect.gen(function* () {
        const clock = yield* Clock

        const runEval: TrainingHarnessApi["runEval"] = (
          prompt,
          expected,
          scoreFn,
        ) =>
          Effect.gen(function* () {
            const fn = scoreFn ?? defaultScoreFn
            const actual = yield* runner.run(prompt)
            const ts = yield* clock.nowIso()
            const score: Score = {
              prompt,
              expected,
              actual,
              value: fn(actual, expected),
              ts,
            }
            return score
          })

        const runBatch: TrainingHarnessApi["runBatch"] = (pairs, scoreFn) =>
          Effect.gen(function* () {
            const out: Score[] = []
            for (const { prompt, expected } of pairs) {
              const s = yield* runEval(prompt, expected, scoreFn)
              out.push(s)
            }
            return out
          })

        return {
          runEval,
          runBatch,
        } satisfies TrainingHarnessApi
      }),
    )
  }
}
