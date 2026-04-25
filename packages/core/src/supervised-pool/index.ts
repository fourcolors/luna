// @internal — not exported from packages/core/src/index.ts. Phase 11.5a barrel.
import type { Effect, Scope } from "effect"
import type { SupervisedPool, SupervisedPoolConfig } from "./types.js"
import { makeSupervisedPool } from "./supervised-pool.js"

export type {
  PoolJob,
  PoolPolicy,
  PoolResult,
  SubmitOutcome,
  SupervisedPool,
  SupervisedPoolConfig,
} from "./types.js"
export { makeSupervisedPool }

/**
 * Advisor-locked API shape:
 *   `SupervisedPoolNs.make(config) → Effect<SupervisedPool, never, Scope>`
 *
 * Named `SupervisedPoolNs` (not `SupervisedPool`) because the type+value
 * declaration-merge with a re-exported type alias hits TS2323. Callers can
 * use either `SupervisedPoolNs.make(...)` or the direct `makeSupervisedPool`.
 */
export const SupervisedPoolNs: {
  readonly make: (
    config: SupervisedPoolConfig,
  ) => Effect.Effect<SupervisedPool, never, Scope.Scope>
} = {
  make: makeSupervisedPool,
}
