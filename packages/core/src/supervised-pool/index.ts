// @internal — not exported from packages/core/src/index.ts. Phase 11.5a barrel.
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
