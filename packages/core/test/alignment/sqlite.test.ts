import { describe, expect, it } from "vitest"
import { Effect, Layer, Scope } from "effect"
import { Clock } from "../../src/clock.js"
import { LunaSqliteBootstrap } from "../../src/db/sqlite-bootstrap.js"
import { AlignmentStore } from "../../src/alignment/alignment-store.js"
import type { AlignmentLogRowInput } from "../../src/alignment/types.js"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const d = isBun ? describe : describe.skip

const bootstrapStubL = Layer.succeed(LunaSqliteBootstrap, {
  ok: false,
  reason: "core test — bootstrap stub",
} as const)

const makeFullLayer = (dbPath: string) => {
  const clockL = Clock.Default
  const storeL = AlignmentStore.makeLayer(dbPath).pipe(
    Layer.provide(clockL),
    Layer.provide(bootstrapStubL),
  )
  return Layer.mergeAll(storeL, clockL)
}

const run = <A, E>(
  prog: Effect.Effect<A, E, AlignmentStore | Clock | Scope.Scope>,
  dbPath = ":memory:",
) =>
  Effect.runPromise(
    Effect.scoped(prog).pipe(Effect.provide(makeFullLayer(dbPath))) as Effect.Effect<A, E, never>,
  )

const row = (over: Partial<AlignmentLogRowInput> = {}): AlignmentLogRowInput => ({
  at: 50,
  signalKind: "task_quality",
  scoreDelta: 0.8,
  ewmaAfter: 0.6,
  ref: "task:1",
  ...over,
})

d("AlignmentStore (sqlite)", () => {
  it("appends and reads back rows", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const store = yield* AlignmentStore
        yield* store.append(row({ ref: "task:1" }))
        yield* store.append(row({ ref: "task:2", signalKind: "belief_validation", ewmaAfter: null }))
        return yield* store.list({})
      }),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.ref).toBe("task:1")
    expect(rows[1]?.signalKind).toBe("belief_validation")
    expect(rows[1]?.ewmaAfter).toBeNull()
  })

  it("INSERT OR IGNORE on (ref, signalKind, at) is idempotent", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* AlignmentStore
        const id1 = yield* store.append(row())
        const id2 = yield* store.append(row()) // same key → ignored
        const rows = yield* store.list({})
        return { id1, id2, rows }
      }),
    )
    expect(out.rows).toHaveLength(1)
    expect(out.id1).toBe(out.id2)
  })

  it("getEwma defaults to 0, setEwma persists, rebuildState folds eligible rows", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* AlignmentStore
        const cold = yield* store.getEwma
        yield* store.setEwma(0.5)
        const warm = yield* store.getEwma
        // now rebuild from log: add an eligible task_quality row + a non-eligible belief_validation row
        yield* store.append(row({ ref: "t", signalKind: "task_quality", ewmaAfter: 0.75 }))
        yield* store.append(row({ ref: "b", signalKind: "belief_validation", ewmaAfter: null }))
        const rebuilt = yield* store.rebuildState()
        const afterRebuild = yield* store.getEwma
        return { cold, warm, rebuilt, afterRebuild }
      }),
    )
    expect(out.cold).toBe(0)
    expect(out.warm).toBe(0.5)
    expect(out.rebuilt).toBe(0.75) // last EWMA-eligible row's ewmaAfter
    expect(out.afterRebuild).toBe(0.75)
  })
})
