/**
 * LabsService — public types (Phase 21).
 *
 * Minimal scientist-loop primitive. An experiment runs `iterations`
 * trials, scores each one, and aggregates results into an
 * ExperimentReport. Budget governance via CostAccountingService:
 * before each iteration, isBudgetExceeded(workflow, name) is checked
 * and an `ExperimentBudgetExceededError` is raised if true.
 *
 * What's deliberately deferred (per §14):
 *   - artifact storage / persistence
 *   - scenario bank
 *   - rubric engine / LLM judge
 *   - cross-experiment comparison
 */
import type { Effect } from "effect"
import type {
  ExperimentBudgetExceededError,
  ScoringError,
} from "../errors.js"

/** A single experiment specification. */
export interface ExperimentSpec<A> {
  /** Stable name; used as the workflow-dimension bucket key. */
  readonly name: string
  /** Plain-English hypothesis (carried into the report). */
  readonly hypothesis: string
  /** A trial: produces one observable result. */
  readonly trial: Effect.Effect<A>
  /** How many trials to run. Must be >= 1. */
  readonly iterations: number
  /** Score function applied to each trial result. Returns 0..1. */
  readonly scoreFn: (result: A, iteration: number) => number
  /**
   * Optional budget cap for this experiment (USD).
   * If omitted, no per-experiment budget is enforced (the
   * CostAccountingService default applies).
   */
  readonly budgetUsd?: number
}

export interface ExperimentTrialRecord {
  readonly iteration: number
  readonly score: number
  readonly ts: string
}

export interface ExperimentReport {
  readonly name: string
  readonly hypothesis: string
  readonly iterations: number
  readonly trials: ReadonlyArray<ExperimentTrialRecord>
  readonly meanScore: number
  readonly minScore: number
  readonly maxScore: number
  readonly startedAt: string
  readonly endedAt: string
  /**
   * If the experiment was cut short by budget exhaustion, the
   * iteration index at which it stopped (1-based).
   */
  readonly truncatedAtIteration?: number
}

export interface LabsConfig {
  readonly _reserved?: never
}

export type LabsError = ExperimentBudgetExceededError | ScoringError

export interface LabsApi {
  /**
   * Run an experiment to completion (or until the budget is exceeded).
   * Pull-based — emits NOTHING into ObservabilityService (per advisor
   * verdict, Phase 21 stays out of §16's event schema).
   */
  readonly runExperiment: <A>(
    spec: ExperimentSpec<A>,
  ) => Effect.Effect<ExperimentReport, LabsError>
}
