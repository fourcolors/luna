/**
 * CostAccountingService — tests (Phase 15).
 *
 * Tests accumulation of CostAccrued events, budget caps, and query API.
 */
import { describe, expect, it } from "vitest"
import {
  Duration,
  Effect,
  Layer,
} from "effect"
import { Clock } from "../src/clock.js"
import { ObservabilityService } from "../src/observability/index.js"
import { CostAccountingService } from "../src/cost-accounting/index.js"

const makeFullLayer = () => {
  const clockL = Clock.Default
  const obsL = ObservabilityService.makeLayer({ logToConsole: false }).pipe(
    Layer.provide(clockL),
  )
  const costL = CostAccountingService.makeLayer({}).pipe(
    Layer.provide(obsL),
    Layer.provide(clockL),
  )
  return Layer.mergeAll(costL, obsL, clockL)
}

const run = <A, E>(
  prog: Effect.Effect<A, E, CostAccountingService | ObservabilityService | Clock>,
) =>
  Effect.runPromise(
    Effect.scoped(
      prog.pipe(Effect.provide(makeFullLayer())),
    ),
  )

describe("CostAccountingService", () => {
  it("(1) accumulates session cost from CostAccrued events", async () => {
    const result = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const cost = yield* CostAccountingService

        // Subscribe eagerly before emitting

        yield* obs.recordCost({
          sessionId: "s-1",
          tokensIn: 1_000,
          tokensOut: 500,
          pricePerMillionInputTokens: 3.0,
          pricePerMillionOutputTokens: 15.0,
        })
        // Second event for same session
        yield* obs.recordCost({
          sessionId: "s-1",
          tokensIn: 2_000,
          tokensOut: 1_000,
          pricePerMillionInputTokens: 3.0,
          pricePerMillionOutputTokens: 15.0,
        })
        yield* Effect.sleep(Duration.millis(30))

        return yield* cost.getBucket("session", "s-1")
      }),
    )
    expect(result).not.toBeNull()
    if (result !== null) {
      expect(result.tokensIn).toBe(3_000)
      expect(result.tokensOut).toBe(1_500)
      // ($3 * 3000 + $15 * 1500) / 1_000_000 = 0.009 + 0.0225 = 0.0315
      expect(result.estimatedUsd).toBeCloseTo(0.0315, 4)
      expect(result.eventCount).toBe(2)
    }
  })

  it("(2) accumulates separate buckets for session, team, workflow", async () => {
    const result = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const cost = yield* CostAccountingService

        yield* obs.recordCost({
          sessionId: "s-2",
          teamName: "team-A",
          workflowId: "wf-1",
          tokensIn: 100,
          tokensOut: 50,
          pricePerMillionInputTokens: 3.0,
          pricePerMillionOutputTokens: 15.0,
        })
        yield* Effect.sleep(Duration.millis(30))

        const sessionBucket = yield* cost.getBucket("session", "s-2")
        const teamBucket = yield* cost.getBucket("team", "team-A")
        const wfBucket = yield* cost.getBucket("workflow", "wf-1")
        return { sessionBucket, teamBucket, wfBucket }
      }),
    )
    expect(result.sessionBucket).not.toBeNull()
    expect(result.teamBucket).not.toBeNull()
    expect(result.wfBucket).not.toBeNull()
    // All three should have same USD (same event)
    expect(result.sessionBucket?.estimatedUsd).toBeCloseTo(
      result.teamBucket?.estimatedUsd ?? -1,
      6,
    )
    expect(result.sessionBucket?.estimatedUsd).toBeCloseTo(
      result.wfBucket?.estimatedUsd ?? -1,
      6,
    )
  })

  it("(3) getBucket returns null for unknown key", async () => {
    const result = await run(
      Effect.gen(function* () {
        const cost = yield* CostAccountingService
        return yield* cost.getBucket("session", "unknown-session")
      }),
    )
    expect(result).toBeNull()
  })

  it("(4) listBuckets returns all buckets, filtered by dimension", async () => {
    const result = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const cost = yield* CostAccountingService

        yield* obs.recordCost({ sessionId: "s-a", tokensIn: 100, tokensOut: 50 })
        yield* obs.recordCost({ sessionId: "s-b", tokensIn: 200, tokensOut: 100 })
        yield* obs.recordCost({ teamName: "t-1", tokensIn: 50, tokensOut: 25 })
        yield* Effect.sleep(Duration.millis(30))

        const allBuckets = yield* cost.listBuckets()
        const sessionBuckets = yield* cost.listBuckets("session")
        const teamBuckets = yield* cost.listBuckets("team")
        return { allBuckets, sessionBuckets, teamBuckets }
      }),
    )
    expect(result.allBuckets.length).toBeGreaterThanOrEqual(3)
    expect(result.sessionBuckets.length).toBeGreaterThanOrEqual(2)
    expect(result.teamBuckets.length).toBeGreaterThanOrEqual(1)
    expect(result.sessionBuckets.every((b) => b.dimension === "session")).toBe(true)
    expect(result.teamBuckets.every((b) => b.dimension === "team")).toBe(true)
  })

  it("(5) budget cap: isBudgetExceeded and remainingBudget", async () => {
    const result = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const cost = yield* CostAccountingService

        yield* cost.setBudget({ dimension: "session", key: "s-budget", budgetUsd: 0.001 })

        yield* obs.recordCost({
          sessionId: "s-budget",
          tokensIn: 1_000_000, // $3 at $3/M
          tokensOut: 0,
          pricePerMillionInputTokens: 3.0,
          pricePerMillionOutputTokens: 15.0,
        })
        yield* Effect.sleep(Duration.millis(30))

        const exceeded = yield* cost.isBudgetExceeded("session", "s-budget")
        const remaining = yield* cost.remainingBudget("session", "s-budget")
        return { exceeded, remaining }
      }),
    )
    expect(result.exceeded).toBe(true)
    expect(result.remaining).toBe(0)
  })

  it("(6) no budget set: isBudgetExceeded = false, remainingBudget = Infinity", async () => {
    const result = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const cost = yield* CostAccountingService

        yield* obs.recordCost({ sessionId: "s-no-budget", tokensIn: 1_000_000, tokensOut: 500_000 })
        yield* Effect.sleep(Duration.millis(30))

        const exceeded = yield* cost.isBudgetExceeded("session", "s-no-budget")
        const remaining = yield* cost.remainingBudget("session", "s-no-budget")
        return { exceeded, remaining }
      }),
    )
    expect(result.exceeded).toBe(false)
    expect(result.remaining).toBe(Infinity)
  })

  it("(7) reset clears all buckets and budgets", async () => {
    const result = await run(
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const cost = yield* CostAccountingService

        yield* obs.recordCost({ sessionId: "s-reset", tokensIn: 100, tokensOut: 50 })
        yield* cost.setBudget({ dimension: "session", key: "s-reset", budgetUsd: 10 })
        yield* Effect.sleep(Duration.millis(30))

        const beforeReset = yield* cost.getBucket("session", "s-reset")
        yield* cost.reset
        const afterReset = yield* cost.getBucket("session", "s-reset")
        const remaining = yield* cost.remainingBudget("session", "s-reset")
        return { beforeReset, afterReset, remaining }
      }),
    )
    expect(result.beforeReset).not.toBeNull()
    expect(result.afterReset).toBeNull()
    expect(result.remaining).toBe(Infinity) // budget cleared too
  })
})
