/**
 * MemoryRouter.search() tests — Phase 25 Scenario 8.
 *
 * Covers router-level vector dispatch: pattern matching, capability check,
 * fan-out when no namespace is provided. Skipped under stock node.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { EmbedderService, StubEmbedderLayer } from "@luna/core"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../src/backends/vectorlite-bootstrap.js"
import { InMemoryBackend } from "../src/backends/in-memory.js"
import { makeRouter } from "../src/router.js"
import { makeRecord } from "../src/types.js"

const hasBunSqlite = (() => {
  return typeof (process.versions as { bun?: string }).bun === "string"
})()

describe.skipIf(!hasBunSqlite)("MemoryRouter.search()", () => {
  // InMemoryBackend is an Effect.Tag class (like SqliteVectorBackend) - its
  // implementation comes from `.Default`, obtained via `yield* InMemoryBackend`
  // inside an Effect, never `new InMemoryBackend()` (that constructs a bare
  // Tag identity, not a MemoryBackend-shaped object).
  const layer = Layer.mergeAll(
    Layer.provideMerge(
      SqliteVectorBackend.fromPath(":memory:"),
      Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
    ),
    InMemoryBackend.Default,
  )

  const run = <A, E>(
    eff: Effect.Effect<A, E, SqliteVectorBackend | EmbedderService | InMemoryBackend>,
  ) => Effect.runPromise(Effect.scoped(eff).pipe(Effect.provide(layer)))

  it("dispatches to vector backend by namespace pattern", async () => {
    const out = await run(
      Effect.gen(function* () {
        const vec = yield* SqliteVectorBackend
        const keyed = yield* InMemoryBackend
        const router = makeRouter([
          { pattern: "notes:*", backend: vec },
          { pattern: "*", backend: keyed },
        ])
        // Insert through the router → routes to vec by namespace.
        yield* router.put(
          makeRecord({
            id: "n1",
            namespace: "notes:work",
            kind: "note",
            content: { text: "deploy on Friday" },
          }),
        )
        return yield* Stream.runCollect(
          router.search({
            queryText: "deploy",
            namespace: "notes:work",
            topK: 5,
          }),
        )
      }),
    )
    const arr = Array.from(out)
    expect(arr.length).toBe(1)
    expect(arr[0]!.record.id).toBe("n1")
  })

  it("fails cleanly when matched backend lacks vector capability", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const vec = yield* SqliteVectorBackend
          const keyed = yield* InMemoryBackend
          const router = makeRouter([
            { pattern: "notes:*", backend: vec },
            { pattern: "*", backend: keyed },
          ])
          return yield* Stream.runCollect(
            router.search({
              queryText: "x",
              namespace: "tmp:foo", // matches "*" → keyed-only
            }),
          )
        }),
      ).pipe(Effect.provide(layer), Effect.either),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect((result.left as { backend: string; op: string }).backend).toBe(
        "router",
      )
      expect((result.left as { op: string }).op).toBe("search")
    }
  })

  it("fan-out: search with no namespace hits every vector backend", async () => {
    const out = await run(
      Effect.gen(function* () {
        const vec = yield* SqliteVectorBackend
        const keyed = yield* InMemoryBackend
        const router = makeRouter([
          { pattern: "notes:*", backend: vec },
          { pattern: "*", backend: keyed },
        ])
        yield* router.put(
          makeRecord({
            id: "x",
            namespace: "notes:any",
            kind: "note",
            content: { text: "fan out" },
          }),
        )
        return yield* Stream.runCollect(
          router.search({ queryText: "fan", topK: 5 }),
        )
      }),
    )
    expect(Array.from(out).length).toBeGreaterThan(0)
  })

  it("Phase 26: hybrid mode passes through router to sqlite-vector backend", async () => {
    const out = await run(
      Effect.gen(function* () {
        const vec = yield* SqliteVectorBackend
        const keyed = yield* InMemoryBackend
        const router = makeRouter([
          { pattern: "notes:*", backend: vec },
          { pattern: "*", backend: keyed },
        ])
        yield* router.put(
          makeRecord({
            id: "h1",
            namespace: "notes:hybrid",
            kind: "note",
            content: { text: "rare-token-abc123 plus context" },
          }),
        )
        return yield* Stream.runCollect(
          router.search({
            queryText: "rare-token-abc123",
            namespace: "notes:hybrid",
            mode: "hybrid",
            topK: 5,
          }),
        )
      }),
    )
    const arr = Array.from(out)
    expect(arr.map((r) => r.record.id)).toContain("h1")
  })

  it("filters private vector hits by observer and subject scope", async () => {
    const out = await run(
      Effect.gen(function* () {
        const vec = yield* SqliteVectorBackend
        const router = makeRouter([{ pattern: "*", backend: vec }])
        for (const [id, observerId, subjectId, visibility] of [
          ["mine", "luna", "operator", "private"],
          ["other-observer", "helper", "operator", "private"],
          ["other-subject", "luna", "teammate", "private"],
          ["shared", "shared", "operator", "shared"],
        ] as const) {
          yield* router.put(
            makeRecord({
              id,
              namespace: "notes",
              kind: "semantic",
              content: { text: `release checklist ${id}` },
              scope: { observerId, subjectId, visibility },
            }),
          )
        }
        return yield* Stream.runCollect(
          router.search({
            queryText: "release checklist",
            namespace: "notes",
            mode: "hybrid",
            topK: 10,
            scope: { observerId: "luna", subjectId: "operator" },
          }),
        )
      }),
    )
    expect(Array.from(out).map((hit) => hit.record.id).sort()).toEqual([
      "mine",
      "shared",
    ])
  })

  it("fan-out fails cleanly when no vector backends are registered", async () => {
    const keyed = Effect.runSync(
      Effect.provide(InMemoryBackend, InMemoryBackend.Default),
    )
    const router = makeRouter([{ pattern: "*", backend: keyed }])
    const result = await Effect.runPromise(
      Stream.runCollect(router.search({ queryText: "x" })).pipe(Effect.either),
    )
    expect(result._tag).toBe("Left")
  })
})
