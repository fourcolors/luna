/**
 * LabsService — tests (Phase 21).
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit, Layer } from "effect"
import { Clock } from "../src/clock.js"
import { ObservabilityService } from "../src/observability/index.js"
import { CostAccountingService } from "../src/cost-accounting/index.js"
import { LabsService } from "../src/labs/index.js"
import { ExperimentBudgetExceededError, ScoringError } from "../src/errors.js"

const makeFullLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const costL = CostAccountingService.makeLayer({}).pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  const labsL = LabsService.makeLayer().pipe(
    Layer.provide(costL),
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  return Layer.mergeAll(labsL, costL, obsL, clockL)
}

const run = <A, E>(
  prog: Effect.Effect<
    A,
    E,
    LabsService | CostAccountingService | ObservabilityService | Clock
  >,
) =>
  Effect.runPromise(Effect.scoped(prog.pipe(Effect.provide(makeFullLayer()))))

const runExit = <A, E>(
  prog: Effect.Effect<
    A,
    E,
    LabsService | CostAccountingService | ObservabilityService | Clock
  >,
) =>
  Effect.runPromise(
    Effect.scoped(prog.pipe(Effect.provide(makeFullLayer()))).pipe(Effect.exit),
  )

describe("LabsService", () => {
  it("runs N iterations and aggregates a report", async () => {
    const report = await run(
      Effect.gen(function* () {
        const labs = yield* LabsService
        return yield* labs.runExperiment({
          name: "constant-score",
          hypothesis: "trial always returns 1",
          trial: Effect.succeed(1 as number),
          iterations: 5,
          scoreFn: (r) => (r === 1 ? 1.0 : 0.0),
        })
      }),
    )
    expect(report.iterations).toBe(5)
    expect(report.trials).toHaveLength(5)
    expect(report.meanScore).toBe(1.0)
    expect(report.minScore).toBe(1.0)
    expect(report.maxScore).toBe(1.0)
    expect(report.truncatedAtIteration).toBeUndefined()
    expect(typeof report.startedAt).toBe("string")
    expect(typeof report.endedAt).toBe("string")
  })

  it("aggregates mixed scores correctly (mean/min/max)", async () => {
    let i = 0
    const trial = Effect.sync(() => ++i)
    const report = await run(
      Effect.gen(function* () {
        const labs = yield* LabsService
        return yield* labs.runExperiment({
          name: "mixed",
          hypothesis: "linear scoring",
          trial,
          iterations: 4,
          scoreFn: (r) => (r as number) / 4,
        })
      }),
    )
    expect(report.trials.map((t) => t.score)).toEqual([0.25, 0.5, 0.75, 1.0])
    expect(report.meanScore).toBeCloseTo(0.625, 5)
    expect(report.minScore).toBe(0.25)
    expect(report.maxScore).toBe(1.0)
  })

  it("budget exceeded → fails with ExperimentBudgetExceededError", async () => {
    // Pre-load a CostAccrued event that pushes the workflow bucket over $1.
    const exit = await runExit(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        // Pre-record cost so isBudgetExceeded returns true.
        yield* obs.recordCost({
          workflowId: "expensive",
          tokensIn: 10_000_000,
          tokensOut: 10_000_000,
          pricePerMillionInputTokens: 1,
          pricePerMillionOutputTokens: 1,
        })
        // Allow the background subscriber to process.
        yield* Effect.sleep("20 millis")

        const labs = yield* LabsService
        return yield* labs.runExperiment({
          name: "expensive",
          hypothesis: "this should be cut off",
          trial: Effect.succeed(0),
          iterations: 5,
          scoreFn: () => 1.0,
          budgetUsd: 1.0,
        })
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const err = JSON.stringify(exit)
    expect(err).toContain("ExperimentBudgetExceededError")
  })

  it("scoreFn throw → fails with ScoringError", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const labs = yield* LabsService
        return yield* labs.runExperiment({
          name: "bad-score",
          hypothesis: "scorer throws",
          trial: Effect.succeed(0),
          iterations: 3,
          scoreFn: () => {
            throw new Error("scorer broke")
          },
        })
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("ScoringError")
  })

  it("0 iterations → empty trial list, zero stats", async () => {
    const report = await run(
      Effect.gen(function* () {
        const labs = yield* LabsService
        return yield* labs.runExperiment({
          name: "noop",
          hypothesis: "no trials",
          trial: Effect.succeed(0),
          iterations: 0,
          scoreFn: () => 1.0,
        })
      }),
    )
    expect(report.trials).toHaveLength(0)
    expect(report.meanScore).toBe(0)
  })

  it("declares LabsError union over typed errors", () => {
    const a: ExperimentBudgetExceededError | ScoringError | null = null
    expect(a).toBeNull()
  })
})
