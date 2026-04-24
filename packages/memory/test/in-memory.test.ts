/**
 * InMemoryBackend Tier-1 tests — basic keyed-store contract.
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream } from "effect"
import { InMemoryBackend } from "../src/backends/in-memory.js"
import { makeRecord } from "../src/types.js"

const run = <A, E>(eff: Effect.Effect<A, E, InMemoryBackend>) =>
  Effect.runPromise(eff.pipe(Effect.provide(InMemoryBackend.Default)))

describe("InMemoryBackend", () => {
  it("put + get roundtrip", async () => {
    const out = await run(
      Effect.gen(function* () {
        const be = yield* InMemoryBackend
        yield* be.put(
          makeRecord({ id: "a", namespace: "n", kind: "k", content: { v: 1 } }),
        )
        return yield* be.get("a")
      }),
    )
    expect(out?.id).toBe("a")
    expect((out?.content as { v: number }).v).toBe(1)
  })

  it("query filters by namespace, kind, tag, since, limit", async () => {
    const out = await run(
      Effect.gen(function* () {
        const be = yield* InMemoryBackend
        yield* be.put(
          makeRecord({
            id: "1",
            namespace: "ns-a",
            kind: "note",
            content: {},
            tags: ["x"],
            now: 100,
          }),
        )
        yield* be.put(
          makeRecord({
            id: "2",
            namespace: "ns-a",
            kind: "note",
            content: {},
            tags: ["y"],
            now: 200,
          }),
        )
        yield* be.put(
          makeRecord({
            id: "3",
            namespace: "ns-b",
            kind: "fact",
            content: {},
            now: 300,
          }),
        )
        const r1 = yield* Stream.runCollect(be.query({ namespace: "ns-a" }))
        const r2 = yield* Stream.runCollect(be.query({ kind: "fact" }))
        const r3 = yield* Stream.runCollect(be.query({ tag: "y" }))
        const r4 = yield* Stream.runCollect(be.query({ since: 150 }))
        const r5 = yield* Stream.runCollect(be.query({ limit: 1 }))
        return {
          byNs: Array.from(r1).map((r) => r.id),
          byKind: Array.from(r2).map((r) => r.id),
          byTag: Array.from(r3).map((r) => r.id),
          since: Array.from(r4).map((r) => r.id),
          limited: Array.from(r5).length,
        }
      }),
    )
    expect(out.byNs.sort()).toEqual(["1", "2"])
    expect(out.byKind).toEqual(["3"])
    expect(out.byTag).toEqual(["2"])
    expect(out.since.sort()).toEqual(["2", "3"])
    expect(out.limited).toBe(1)
  })

  it("delete removes by id", async () => {
    const out = await run(
      Effect.gen(function* () {
        const be = yield* InMemoryBackend
        yield* be.put(makeRecord({ id: "x", namespace: "n", kind: "k", content: {} }))
        const d1 = yield* be.delete("x")
        const d2 = yield* be.delete("missing")
        const g = yield* be.get("x")
        return { d1, d2, gone: g === null }
      }),
    )
    expect(out).toEqual({ d1: true, d2: false, gone: true })
  })

  it("exportAll + importAll roundtrip preserves records", async () => {
    const out = await run(
      Effect.gen(function* () {
        const be = yield* InMemoryBackend
        yield* be.put(
          makeRecord({ id: "a", namespace: "n", kind: "k", content: "hello" }),
        )
        yield* be.put(
          makeRecord({ id: "b", namespace: "n", kind: "k", content: 42 }),
        )
        const env = yield* be.exportAll()
        yield* be.delete("a")
        yield* be.delete("b")
        const n = yield* be.importAll(env)
        const a = yield* be.get("a")
        const b = yield* be.get("b")
        return { n, aContent: a?.content, bContent: b?.content }
      }),
    )
    expect(out.n).toBe(2)
    expect(out.aContent).toBe("hello")
    expect(out.bContent).toBe(42)
  })
})
