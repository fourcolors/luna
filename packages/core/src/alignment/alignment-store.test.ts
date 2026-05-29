// packages/core/src/alignment/alignment-store.test.ts
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { Clock } from "../clock.js"
import { AlignmentStore } from "./alignment-store.js"
import type { AlignmentLogRowInput } from "./types.js"

const provide = <A, E>(eff: Effect.Effect<A, E, AlignmentStore | Clock>) =>
  eff.pipe(Effect.provide(AlignmentStore.Memory), Effect.provide(Clock.Test(1000)))

const row = (over: Partial<AlignmentLogRowInput> = {}): AlignmentLogRowInput => ({
  at: 1000, signalKind: "task_quality", scoreDelta: 0.1, ewmaAfter: 0.6, ref: "task:1", ...over,
})

describe("AlignmentStore (Memory)", () => {
  it("appends and lists rows", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          yield* s.append(row({ ref: "task:1" }))
          yield* s.append(row({ ref: "task:2", signalKind: "belief_validation", ewmaAfter: null }))
          return yield* s.list({})
        }),
      ),
    )
    expect(out).toHaveLength(2)
  })

  it("append is idempotent on (ref, signalKind, at)", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          yield* s.append(row())
          yield* s.append(row()) // same key → ignored
          return yield* s.list({})
        }),
      ),
    )
    expect(out).toHaveLength(1)
  })

  it("filters by signalKind", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          yield* s.append(row({ ref: "a", signalKind: "task_quality" }))
          yield* s.append(row({ ref: "b", signalKind: "belief_validation", ewmaAfter: null }))
          return yield* s.list({ signalKind: "belief_validation" })
        }),
      ),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.signalKind).toBe("belief_validation")
  })

  it("getEwma defaults to the dormant floor (0.0) and round-trips setEwma", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          const cold = yield* s.getEwma
          yield* s.setEwma(0.7)
          const warm = yield* s.getEwma
          return { cold, warm }
        }),
      ),
    )
    expect(out.cold).toBe(0) // §2.4 cold start
    expect(out.warm).toBe(0.7)
  })

  it("rebuildState folds only EWMA-eligible rows", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const s = yield* AlignmentStore
          // a task_quality row sets ewmaAfter 0.4; a belief_validation row has null
          yield* s.append(row({ ref: "t", signalKind: "task_quality", ewmaAfter: 0.4 }))
          yield* s.append(row({ ref: "b", signalKind: "belief_validation", ewmaAfter: null }))
          return yield* s.rebuildState()
        }),
      ),
    )
    // rebuild uses the last EWMA-eligible row's ewmaAfter
    expect(out).toBe(0.4)
  })
})

describe("getLastSurveyAt (derived, no migration — D-LOCK-2)", () => {
  it("cold start: returns 0 when no task_quality rows exist", async () => {
    const out = await Effect.runPromise(
      provide(Effect.gen(function* () {
        const s = yield* AlignmentStore
        return yield* s.getLastSurveyAt
      })),
    )
    expect(out).toBe(0)
  })

  it("returns MAX(at) of task_quality rows; ignores belief_validation rows", async () => {
    const out = await Effect.runPromise(
      provide(Effect.gen(function* () {
        const s = yield* AlignmentStore
        yield* s.append(row({ ref: "task:1", signalKind: "task_quality", at: 1000, ewmaAfter: 0.5 }))
        yield* s.append(row({ ref: "task:2", signalKind: "task_quality", at: 3000, ewmaAfter: 0.6 }))
        // a later belief_validation row must NOT count as a survey-completion marker
        yield* s.append(row({ ref: "b:1", signalKind: "belief_validation", at: 9000, ewmaAfter: null }))
        return yield* s.getLastSurveyAt
      })),
    )
    expect(out).toBe(3000)
  })
})
