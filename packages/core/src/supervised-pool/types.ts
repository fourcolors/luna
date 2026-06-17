// @internal — not exported from packages/core/src/index.ts. Phase 11.5a.
/**
 * SupervisedPool types — Phase 11.5a helper extraction.
 *
 * A generic, internal primitive that packages the FiberSet + LIFO finalizer +
 * capacity semaphore + Ref-shadow-size supervision pattern from the original V1
 * JobScheduler (since removed) into a reusable helper. Intentionally decoupled
 * from the `Job*` types in `packages/core/src/jobs/`.
 *
 * Deviations from the original V1 JobScheduler's public surface (advisor-locked):
 *   - `submit` returns a `SubmitOutcome` discriminated union — no errors
 *     raised. Consumers (e.g. TeamBroker) map the
 *     outcome to their own tagged errors as needed (§6.3 additive).
 *   - `results: Stream<PoolResult>` replaces the `onJobDone?` callback;
 *     consumers tap/filter at will.
 *   - `make` is `Effect<..., never, Scope>`; pool lifetime = caller's Scope
 *     (§3.1). Closing that Scope triggers the cascade (§3.4 #4).
 */
import type { Effect, Exit, Scope, Stream } from "effect"

export interface PoolJob {
  readonly id: string
  readonly run: Effect.Effect<unknown, unknown, Scope.Scope>
}

export interface PoolResult {
  readonly id: string
  readonly exit: Exit.Exit<unknown, unknown>
}

export type PoolPolicy = "block" | "drop-newest" | "drop-oldest"

export interface SupervisedPoolConfig {
  readonly capacity: number
  readonly policy: PoolPolicy
}

export type SubmitOutcome =
  | { readonly _tag: "accepted"; readonly id: string }
  | { readonly _tag: "rejected-full"; readonly id: string }
  | { readonly _tag: "rejected-shutdown"; readonly id: string }
  | {
      readonly _tag: "evicted"
      readonly evictedId: string
      readonly acceptedId: string
    }

export interface SupervisedPool {
  readonly submit: (job: PoolJob) => Effect.Effect<SubmitOutcome, never>
  readonly size: Effect.Effect<number, never>
  readonly shutdown: Effect.Effect<void, never>
  readonly results: Stream.Stream<PoolResult, never>
}
