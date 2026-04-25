/**
 * CostAccountingService — public types (Phase 15).
 *
 * Thin rollup layer above ObservabilityService. Subscribes to CostAccrued
 * events and maintains per-session/team/workflow running totals. Also
 * supports optional budget caps that Labs / Training Harness use for
 * experiment governance.
 *
 * Architecture note: in-memory only (Phase 15). SQL persistence is
 * deferred to the database-migration phase when @effect/sql lands.
 * The DESIGN §5.1 `cost_events` table schema is the target.
 */
import type { Effect } from "effect"

/** Accumulated cost for one "bucket" (session, team, or workflow). */
export interface CostBucket {
  /** The dimension key: session id, team name, or workflow id. */
  readonly key: string
  /** Dimension type. */
  readonly dimension: "session" | "team" | "workflow"
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly estimatedUsd: number
  /** Timestamp of first CostAccrued event for this bucket. */
  readonly firstEventTs: string
  /** Timestamp of most recent CostAccrued event for this bucket. */
  readonly lastEventTs: string
  readonly eventCount: number
}

/** A budget cap. If `budgetUsd` is exceeded, isBudgetExceeded returns true. */
export interface BudgetRule {
  readonly dimension: "session" | "team" | "workflow"
  readonly key: string
  readonly budgetUsd: number
}

export interface CostAccountingConfig {
  /**
   * Default budget cap applied to ALL sessions/teams/workflows.
   * A cap of 0 means unlimited. Default: 0 (unlimited).
   */
  readonly defaultBudgetUsd?: number
}

export interface CostAccountingApi {
  /**
   * Returns the cost bucket for the given dimension+key, or null if no
   * CostAccrued events have been received for it.
   */
  readonly getBucket: (
    dimension: "session" | "team" | "workflow",
    key: string,
  ) => Effect.Effect<CostBucket | null>

  /**
   * Lists all cost buckets, optionally filtered by dimension.
   */
  readonly listBuckets: (
    dimension?: "session" | "team" | "workflow",
  ) => Effect.Effect<CostBucket[]>

  /**
   * Sets a budget cap for a specific dimension+key.
   */
  readonly setBudget: (rule: BudgetRule) => Effect.Effect<void>

  /**
   * Returns true if the bucket's estimatedUsd exceeds its budget cap
   * (or the default budget cap). Always false if no cap is set.
   */
  readonly isBudgetExceeded: (
    dimension: "session" | "team" | "workflow",
    key: string,
  ) => Effect.Effect<boolean>

  /**
   * Returns the remaining budget in USD for the given dimension+key.
   * Returns Infinity if no budget cap is set.
   */
  readonly remainingBudget: (
    dimension: "session" | "team" | "workflow",
    key: string,
  ) => Effect.Effect<number>

  /**
   * Resets all accumulated cost data. Useful for tests.
   */
  readonly reset: Effect.Effect<void>
}
