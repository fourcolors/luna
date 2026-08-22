/**
 * LabsService — scientist loop (Phase 21).
 *
 * Run an experiment N iterations, scoring each trial. Optionally
 * gates on a per-experiment budget via CostAccountingService.
 *
 * Pull-based: results returned in the ExperimentReport. No §16 events
 * are emitted from this layer (advisor: keep storage-agnostic).
 */
import { Context, Effect, Layer } from "effect"
import { Clock } from "../clock.js"
import { CostAccountingService } from "../cost-accounting/index.js"
import {
  ExperimentBudgetExceededError,
  ScoringError,
} from "../errors.js"
import type {
  ExperimentReport,
  ExperimentSpec,
  ExperimentTrialRecord,
  LabsApi,
  LabsConfig,
} from "./types.js"

export class LabsService extends Context.Service<LabsService, LabsApi>()("luna/LabsService") {
  static makeLayer(
    _config?: LabsConfig,
  ): Layer.Layer<LabsService, never, Clock | CostAccountingService> {
    return Layer.effect(
      LabsService,
      Effect.gen(function* () {
        const clock = yield* Clock
        const costs = yield* CostAccountingService

        const runExperiment: LabsApi["runExperiment"] = <A>(
          spec: ExperimentSpec<A>,
        ): Effect.Effect<
          ExperimentReport,
          ExperimentBudgetExceededError | ScoringError
        > =>
          Effect.gen(function* () {
            // If a per-experiment budget is supplied, register it.
            if (spec.budgetUsd !== undefined) {
              yield* costs.setBudget({
                dimension: "workflow",
                key: spec.name,
                budgetUsd: spec.budgetUsd,
              })
            }

            const startedAt = yield* clock.nowIso()
            const trials: ExperimentTrialRecord[] = []
            let truncatedAtIteration: number | undefined

            for (let i = 1; i <= spec.iterations; i++) {
              // Pre-flight budget check.
              const exceeded = yield* costs.isBudgetExceeded(
                "workflow",
                spec.name,
              )
              if (exceeded) {
                truncatedAtIteration = i
                if (spec.budgetUsd !== undefined) {
                  return yield* Effect.fail(
                    new ExperimentBudgetExceededError({
                      experimentName: spec.name,
                      bucketKey: spec.name,
                      limitUsd: spec.budgetUsd,
                    }),
                  )
                }
                break
              }

              const result = yield* spec.trial
              const ts = yield* clock.nowIso()
              let score: number
              try {
                score = spec.scoreFn(result, i)
              } catch (e) {
                return yield* Effect.fail(
                  new ScoringError({
                    experimentName: spec.name,
                    iteration: i,
                    cause: e,
                  }),
                )
              }
              trials.push({ iteration: i, score, ts })
            }

            const endedAt = yield* clock.nowIso()
            const scores = trials.map((t) => t.score)
            const meanScore =
              scores.length === 0
                ? 0
                : scores.reduce((a, b) => a + b, 0) / scores.length
            const minScore = scores.length === 0 ? 0 : Math.min(...scores)
            const maxScore = scores.length === 0 ? 0 : Math.max(...scores)

            const report: ExperimentReport = {
              name: spec.name,
              hypothesis: spec.hypothesis,
              iterations: spec.iterations,
              trials,
              meanScore,
              minScore,
              maxScore,
              startedAt,
              endedAt,
              ...(truncatedAtIteration !== undefined
                ? { truncatedAtIteration }
                : {}),
            }
            return report
          })

        return { runExperiment } satisfies LabsApi
      }),
    )
  }
}
