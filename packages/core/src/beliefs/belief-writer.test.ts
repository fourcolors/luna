import { describe, expect, it } from "vitest"
import { Effect, Layer, Ref, Stream } from "effect"
import { Clock } from "../clock.js"
import { MemoryRouterTag } from "@luna/memory"
import type { MemoryQuery, MemoryRecord } from "@luna/memory"
import { BeliefWriter } from "./belief-writer.js"
import { makeBeliefRecord, readBelief, BELIEF_CAP } from "./types.js"

// Ref-backed memory router double with a working query (namespace/kind/since).
const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, MemoryRecord>>(
        new Map(initial.map((r) => [r.id, r])),
      )
      return {
        put: (rec: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(rec.id, rec)),
        get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
        delete: (id: string) =>
          Ref.modify(store, (m) => {
            const had = m.has(id)
            const next = new Map(m)
            next.delete(id)
            return [had, next]
          }),
        query: (q: MemoryQuery) =>
          Stream.unwrap(
            Ref.get(store).pipe(
              Effect.map((m) =>
                Stream.fromIterable(
                  Array.from(m.values()).filter(
                    (r) =>
                      (q.namespace === undefined || r.namespace === q.namespace) &&
                      (q.kind === undefined || r.kind === q.kind) &&
                      (q.since === undefined || r.updatedAt >= q.since),
                  ),
                ),
              ),
            ),
          ),
        search: () => { throw new Error("unused") },
      } as never
    }),
  )

const provide = <A, E>(eff: Effect.Effect<A, E, any>, mem: Layer.Layer<any>) =>
  eff.pipe(Effect.provide(BeliefWriter.Default), Effect.provide(mem), Effect.provide(Clock.Default))

describe("BeliefWriter", () => {
  it("activateBelief flips proposed → active", async () => {
    const b = makeBeliefRecord({ statement: "s", confidence: 0.7, domain: "d", status: "proposed", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const w = yield* BeliefWriter
          yield* w.activateBelief(b.id)
          const mem = yield* MemoryRouterTag
          return yield* mem.get(b.id)
        }),
        FakeMemory([b]),
      ),
    )
    expect(readBelief(out!).status).toBe("active")
  })

  it("retireBelief flips active → retired (record persists)", async () => {
    const b = makeBeliefRecord({ statement: "s", confidence: 0.7, domain: "d", status: "active", now: 0 })
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const w = yield* BeliefWriter
          yield* w.retireBelief(b.id)
          const mem = yield* MemoryRouterTag
          return yield* mem.get(b.id)
        }),
        FakeMemory([b]),
      ),
    )
    expect(readBelief(out!).status).toBe("retired")
  })

  it("activating a 21st belief evicts the weakest (cap on active only)", async () => {
    // 20 active beliefs with descending confidence (b00 strongest ... b19 weakest)
    const actives = Array.from({ length: BELIEF_CAP }, (_, i) =>
      makeBeliefRecord({ statement: `b${i}`, confidence: 0.9 - i * 0.01, domain: "d", status: "active", now: 0 }),
    )
    // a proposed 21st, stronger than the current weakest
    const newcomer = makeBeliefRecord({ statement: "newcomer", confidence: 0.95, domain: "d", status: "proposed", now: 0 })
    const weakest = actives[actives.length - 1]!

    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const w = yield* BeliefWriter
          yield* w.activateBelief(newcomer.id)
          const active = yield* w.listActive()
          const mem = yield* MemoryRouterTag
          const retired = yield* mem.get(weakest.id)
          return { activeCount: active.length, activeIds: active.map((r) => r.id), weakestStatus: readBelief(retired!).status }
        }),
        FakeMemory([...actives, newcomer]),
      ),
    )
    expect(out.activeCount).toBe(BELIEF_CAP) // still 20
    expect(out.activeIds).toContain(newcomer.id) // newcomer is in
    expect(out.weakestStatus).toBe("retired") // weakest evicted
  })

  it("stageProposed writes a proposed belief record", async () => {
    const out = await Effect.runPromise(
      provide(
        Effect.gen(function* () {
          const w = yield* BeliefWriter
          const rec = makeBeliefRecord({ statement: "x", confidence: 0.5, domain: "d", now: 0 })
          yield* w.stageProposed(rec)
          const mem = yield* MemoryRouterTag
          return yield* mem.get(rec.id)
        }),
        FakeMemory([]),
      ),
    )
    expect(out).not.toBeNull()
    expect(readBelief(out!).status).toBe("proposed")
  })
})
