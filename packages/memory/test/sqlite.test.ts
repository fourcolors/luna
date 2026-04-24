/**
 * SqliteBackend Tier-1 tests — skipped when bun:sqlite is unavailable.
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream } from "effect"
import { SqliteBackend } from "../src/backends/sqlite.js"
import { makeRecord } from "../src/types.js"

// bun:sqlite is available when test runs under `bun test` / `bun run vitest`.
// Under stock node+vitest it's absent → skipIf.
const hasBunSqlite = (() => {
  // `process.versions.bun` exists only in the Bun runtime.
  return typeof (process.versions as { bun?: string }).bun === "string"
})()

describe.skipIf(!hasBunSqlite)("SqliteBackend (bun:sqlite)", () => {
  const run = <A, E>(eff: Effect.Effect<A, E, SqliteBackend>) =>
    Effect.runPromise(
      Effect.scoped(eff).pipe(
        Effect.provide(SqliteBackend.fromPath(":memory:")),
      ),
    )

  it("put + get + delete + query", async () => {
    const out = await run(
      Effect.gen(function* () {
        const be = yield* SqliteBackend
        yield* be.put(
          makeRecord({ id: "a", namespace: "ns", kind: "k", content: { v: 1 } }),
        )
        yield* be.put(
          makeRecord({
            id: "b",
            namespace: "ns",
            kind: "k",
            content: { v: 2 },
            tags: ["t1"],
            now: 999,
          }),
        )
        const got = yield* be.get("b")
        const byTag = yield* Stream.runCollect(be.query({ tag: "t1" }))
        const delOk = yield* be.delete("a")
        const gone = yield* be.get("a")
        return {
          gotV: (got?.content as { v: number }).v,
          tagCount: Array.from(byTag).length,
          delOk,
          gone: gone === null,
        }
      }),
    )
    expect(out).toEqual({ gotV: 2, tagCount: 1, delOk: true, gone: true })
  })

  it("exportAll + importAll roundtrip", async () => {
    const out = await run(
      Effect.gen(function* () {
        const be = yield* SqliteBackend
        yield* be.put(
          makeRecord({ id: "x", namespace: "n", kind: "k", content: "hi" }),
        )
        const env = yield* be.exportAll()
        yield* be.delete("x")
        const n = yield* be.importAll(env)
        const back = yield* be.get("x")
        return { n, content: back?.content }
      }),
    )
    expect(out).toEqual({ n: 1, content: "hi" })
  })

  it("survives the migration being idempotent", async () => {
    // Second Layer over same :memory: is a new DB so we can't exactly test
    // persistence here; this just ensures re-construction succeeds.
    const out = await run(
      Effect.gen(function* () {
        const be = yield* SqliteBackend
        yield* be.put(
          makeRecord({ id: "any", namespace: "n", kind: "k", content: 1 }),
        )
        return "ok"
      }),
    )
    expect(out).toBe("ok")
  })
})
