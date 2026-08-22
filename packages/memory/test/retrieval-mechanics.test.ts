/**
 * Retrieval mechanics — deterministic tests that the search pipeline behaves
 * correctly under the stub embedder. These tests validate *mechanics* (topK,
 * namespace isolation, idempotency, telemetry emission) — NOT paraphrase
 * recall quality. The stub embedder's hash-based 64-d sketch cannot validate
 * semantic paraphrases; for that, see packages/memory/bench/paraphrase-recall.ts
 * (Tier 2, requires Ollama).
 */
import { describe, expect, it } from "vitest"
import { Chunk, Effect, Fiber, Layer, Stream } from "effect"
import {
  Clock,
  ObservabilityService,
  StubEmbedderLayer,
  type ObsEvent,
} from "@luna/core"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../src/backends/vectorlite-bootstrap.js"
import { MemoryLayer } from "../src/layer.js"
import { MemoryRouterTag } from "../src/router.js"
import { makeRecord } from "../src/types.js"

const hasBunSqlite = (() =>
  typeof (process.versions as { bun?: string }).bun === "string")()

describe.skipIf(!hasBunSqlite)("retrieval mechanics (stub embedder)", () => {
  // Build a full layer stack with ObservabilityService so we can also assert
  // telemetry emission. ObservabilityService.Default needs Clock under it.
  const supportLayer = Layer.mergeAll(
    ObservabilityService.Default.pipe(Layer.provide(Clock.Default)),
    StubEmbedderLayer,
    Clock.Default,
    LunaSqliteBootstrapLive,
  )

  const buildLayer = () =>
    Layer.unwrapEffect(
      Effect.gen(function* () {
        const backend = yield* SqliteVectorBackend
        return MemoryLayer({ rules: [{ pattern: "*", backend }] })
      }),
    ).pipe(
      Layer.provideMerge(SqliteVectorBackend.fromPath(":memory:")),
      Layer.provideMerge(supportLayer),
    )

  const run = <A, E>(eff: Effect.Effect<A, E, never>) =>
    Effect.runPromise(Effect.scoped(eff))

  it("topK is enforced — search returns no more than topK results", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        for (let i = 0; i < 10; i++) {
          yield* router.put(
            makeRecord({
              id: `doc_${i}`,
              namespace: "k",
              kind: "n",
              content: { text: `record number ${i} apple orange banana` },
            }),
          )
        }
        return yield* Stream.runCollect(
          router.search({ queryText: "apple", namespace: "k", topK: 3 }),
        )
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(Array.from(hits).length).toBeLessThanOrEqual(3)
  })

  it("empty corpus returns empty stream cleanly (no error)", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        return yield* Stream.runCollect(
          router.search({ queryText: "nothing here", namespace: "k", topK: 5 }),
        )
      }).pipe(Effect.provide(buildLayer())),
    )
    expect(Array.from(hits).length).toBe(0)
  })

  it("idempotent — same query yields same ranking on re-run", async () => {
    const layer = buildLayer()
    const seedAndQuery = Effect.gen(function* () {
      const router = yield* MemoryRouterTag
      for (let i = 0; i < 5; i++) {
        yield* router.put(
          makeRecord({
            id: `r_${i}`,
            namespace: "k",
            kind: "n",
            content: { text: `alpha beta gamma item ${i}` },
          }),
        )
      }
      const once = yield* Stream.runCollect(
        router.search({ queryText: "alpha gamma", namespace: "k", topK: 5 }),
      )
      const twice = yield* Stream.runCollect(
        router.search({ queryText: "alpha gamma", namespace: "k", topK: 5 }),
      )
      return [Array.from(once), Array.from(twice)] as const
    })
    const [first, second] = await run(seedAndQuery.pipe(Effect.provide(layer)))
    expect(first.map((h) => h.record.id)).toEqual(second.map((h) => h.record.id))
  })

  it("namespace isolation — records in namespace A don't leak into namespace B searches", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        // Identical text, different namespaces.
        yield* router.put(
          makeRecord({
            id: "a1",
            namespace: "ns_a",
            kind: "n",
            content: { text: "unique-token-zeta" },
          }),
        )
        yield* router.put(
          makeRecord({
            id: "b1",
            namespace: "ns_b",
            kind: "n",
            content: { text: "unique-token-zeta" },
          }),
        )
        return yield* Stream.runCollect(
          router.search({
            queryText: "unique-token-zeta",
            namespace: "ns_a",
            topK: 10,
          }),
        )
      }).pipe(Effect.provide(buildLayer())),
    )
    const ids = Array.from(hits).map((h) => h.record.id)
    expect(ids).toContain("a1")
    expect(ids).not.toContain("b1")
  })

  it("hybrid mode produces results ranked by descending score", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        for (let i = 0; i < 6; i++) {
          yield* router.put(
            makeRecord({
              id: `h_${i}`,
              namespace: "k",
              kind: "n",
              content: { text: `keyword-${i} common context tokens` },
            }),
          )
        }
        return yield* Stream.runCollect(
          router.search({
            queryText: "keyword-2 context",
            namespace: "k",
            mode: "hybrid",
            topK: 6,
          }),
        )
      }).pipe(Effect.provide(buildLayer())),
    )
    const scores = Array.from(hits).map((h) => h.score)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!)
    }
  })

  it("emits exactly one RetrievalCallEvent per search() call with correct fields", async () => {
    const layer = buildLayer()
    const collected = await run(
      // obs.subscribeEvents acquires a scoped subscription (unsubscribes on
      // scope close) - Effect.scoped here discharges that Scope requirement
      // before Effect.provide(layer), matching run()'s R = never contract.
      Effect.scoped(
        Effect.gen(function* () {
          const obs = yield* ObservabilityService
          const router = yield* MemoryRouterTag
          // Eagerly subscribe BEFORE the search so we don't miss the event.
          const stream = yield* obs.subscribeEvents
          const fiber = yield* Effect.forkChild(
            stream.pipe(
              Stream.filter((ev): ev is ObsEvent & { kind: "RetrievalCall" } =>
                ev.kind === "RetrievalCall",
              ),
              Stream.take(1),
              Stream.runCollect,
            ),
          )
          yield* router.put(
            makeRecord({
              id: "t1",
              namespace: "k",
              kind: "n",
              content: { text: "telemetry probe target" },
            }),
          )
          yield* Stream.runDrain(
            router.search({
              queryText: "telemetry probe",
              namespace: "k",
              topK: 5,
              mode: "hybrid",
            }),
          )
          return yield* Fiber.join(fiber)
        }),
      ).pipe(Effect.provide(layer)),
    )

    expect(collected).toHaveLength(1)
    const ev = collected[0]!
    expect(ev.kind).toBe("RetrievalCall")
    expect(ev.mode).toBe("hybrid")
    expect(ev.namespace).toBe("k")
    expect(ev.embedderProvider).toBe("stub")
    expect(ev.embedderModel).toBe("stub")
    expect(ev.embedderDimension).toBe(64)
    expect(ev.queryDigest).toMatch(/^[0-9a-f]{16}$/)
    expect(ev.status).toBe("success")
    expect(ev.candidateCount).toBeGreaterThanOrEqual(1)
    expect(ev.durationMs).toBeGreaterThanOrEqual(0)
    expect(ev.topScore).toBeGreaterThan(0)
  })
})
