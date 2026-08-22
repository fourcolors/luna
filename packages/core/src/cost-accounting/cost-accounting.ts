/**
 * CostAccountingService — Phase 15.
 *
 * Subscribes to ObservabilityService's CostAccrued event stream and maintains
 * per-session/team/workflow cost rollups in-memory.
 *
 * Architecture:
 *   - Uses obs.subscribeEvents() (eager subscription) so no CostAccrued
 *     events are missed after the layer is initialized.
 *   - Background fiber consumes the event stream and updates Ref<Map<...>>
 *     buckets atomically.
 *   - Budget rules stored in Ref<Map<...>>; checked on-demand (no reactive
 *     triggers — callers poll isBudgetExceeded).
 *   - forkDaemon: background fiber does not propagate failures to host.
 *   - Layer.effect: Scope close terminates the subscriber via Queue.shutdown
 *     (propagated by PubSub shutdown on ObservabilityService teardown).
 *
 * Invariants:
 *   - §3.4 #1 no cross-Scope refs: background fiber is daemon.
 *   - §3.4 #4 interruption: PubSub shutdown (from ObsService teardown)
 *     terminates the fromQueue stream, which exits runForEach cleanly.
 *   - §6.2 frozen errors: no new TaggedErrors — all operations are
 *     Effect<T, never, ...>; bad state returns null / Infinity gracefully.
 */
import { Context,
  Effect,
  Layer,
  Ref,
  Stream,
} from "effect"
import { Clock } from "../clock.js"
import { ObservabilityService } from "../observability/observability.js"
import type {
  BudgetRule,
  CostAccountingApi,
  CostAccountingConfig,
  CostBucket,
} from "./types.js"

type BucketKey = string // `${dimension}:${key}`
type BucketMap = ReadonlyMap<BucketKey, CostBucket>
type BudgetMap = ReadonlyMap<BucketKey, number> // → budgetUsd

const makeBucketKey = (dimension: CostBucket["dimension"], key: string): BucketKey =>
  `${dimension}:${key}`

export class CostAccountingService extends Context.Service<CostAccountingService, CostAccountingApi>()("luna/CostAccountingService") {
  static readonly Default: Layer.Layer<
    CostAccountingService,
    never,
    ObservabilityService | Clock
  > = CostAccountingService.makeLayer({})

  static makeLayer(
    config: CostAccountingConfig,
  ): Layer.Layer<CostAccountingService, never, ObservabilityService | Clock> {
    return Layer.effect(
      CostAccountingService,
      Effect.gen(function* () {
        const obs = yield* ObservabilityService
        const defaultBudget = config.defaultBudgetUsd ?? 0

        const bucketsRef = yield* Ref.make<BucketMap>(new Map())
        const budgetsRef = yield* Ref.make<BudgetMap>(new Map())

        // Eagerly subscribe to the event stream so no events are missed.
        const eventStream = yield* obs.subscribeEvents

        // Background fiber: consume CostAccrued events and update buckets.
        yield* Effect.forkDetach(
          eventStream.pipe(
            Stream.filter((e) => e.kind === "CostAccrued"),
            Stream.runForEach((ev) =>
              Effect.gen(function* () {
                if (ev.kind !== "CostAccrued") return

                // Update all applicable buckets (session, team, workflow).
                const updates: Array<{ dim: CostBucket["dimension"]; key: string }> = []
                if (ev.sessionId !== undefined) updates.push({ dim: "session", key: ev.sessionId })
                if (ev.teamName !== undefined) updates.push({ dim: "team", key: ev.teamName })
                if (ev.workflowId !== undefined) updates.push({ dim: "workflow", key: ev.workflowId })

                yield* Ref.update(bucketsRef, (m) => {
                  const next = new Map(m)
                  for (const { dim, key } of updates) {
                    const bk = makeBucketKey(dim, key)
                    const existing = next.get(bk)
                    if (existing === undefined) {
                      next.set(bk, {
                        key,
                        dimension: dim,
                        tokensIn: ev.tokensIn,
                        tokensOut: ev.tokensOut,
                        cacheRead: ev.cacheRead,
                        cacheWrite: ev.cacheWrite,
                        estimatedUsd: ev.estimatedUsd,
                        firstEventTs: ev.ts,
                        lastEventTs: ev.ts,
                        eventCount: 1,
                      })
                    } else {
                      next.set(bk, {
                        ...existing,
                        tokensIn: existing.tokensIn + ev.tokensIn,
                        tokensOut: existing.tokensOut + ev.tokensOut,
                        cacheRead: existing.cacheRead + ev.cacheRead,
                        cacheWrite: existing.cacheWrite + ev.cacheWrite,
                        estimatedUsd: existing.estimatedUsd + ev.estimatedUsd,
                        lastEventTs: ev.ts,
                        eventCount: existing.eventCount + 1,
                      })
                    }
                  }
                  return next
                })
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        )

        const getBucket: CostAccountingApi["getBucket"] = (dimension, key) =>
          Ref.get(bucketsRef).pipe(
            Effect.map((m) => m.get(makeBucketKey(dimension, key)) ?? null),
          )

        const listBuckets: CostAccountingApi["listBuckets"] = (dimension) =>
          Ref.get(bucketsRef).pipe(
            Effect.map((m) => {
              const all = Array.from(m.values())
              return dimension !== undefined
                ? all.filter((b) => b.dimension === dimension)
                : all
            }),
          )

        const setBudget: CostAccountingApi["setBudget"] = (rule: BudgetRule) =>
          Ref.update(budgetsRef, (m) => {
            const next = new Map(m)
            next.set(makeBucketKey(rule.dimension, rule.key), rule.budgetUsd)
            return next
          })

        const isBudgetExceeded: CostAccountingApi["isBudgetExceeded"] = (dimension, key) =>
          Effect.gen(function* () {
            const bk = makeBucketKey(dimension, key)
            const budgets = yield* Ref.get(budgetsRef)
            const cap = budgets.get(bk) ?? defaultBudget
            if (cap <= 0) return false // 0 = unlimited
            const bucket = (yield* Ref.get(bucketsRef)).get(bk)
            if (bucket === undefined) return false
            return bucket.estimatedUsd >= cap
          })

        const remainingBudget: CostAccountingApi["remainingBudget"] = (dimension, key) =>
          Effect.gen(function* () {
            const bk = makeBucketKey(dimension, key)
            const budgets = yield* Ref.get(budgetsRef)
            const cap = budgets.get(bk) ?? defaultBudget
            if (cap <= 0) return Infinity
            const bucket = (yield* Ref.get(bucketsRef)).get(bk)
            const spent = bucket?.estimatedUsd ?? 0
            return Math.max(0, cap - spent)
          })

        const reset: CostAccountingApi["reset"] = Ref.set(bucketsRef, new Map()).pipe(
          Effect.andThen(Ref.set(budgetsRef, new Map())),
        )

        return {
          getBucket,
          listBuckets,
          setBudget,
          isBudgetExceeded,
          remainingBudget,
          reset,
        } satisfies CostAccountingApi
      }),
    )
  }
}
