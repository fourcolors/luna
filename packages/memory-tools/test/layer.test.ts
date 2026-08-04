/**
 * §10.6 makeMemoryRouterLayer - generic backend injection.
 *
 * The router only ever sees `MemoryBackend` (DESIGN §10.2), but
 * `MemoryRouterLayer` hardcoded SqliteVectorBackend at the wiring point.
 * This proves the wiring point itself is generic:
 *
 *   1. `makeMemoryRouterLayer(backendLayer, backendTag)` composes a working
 *      MemoryRouter with a completely different backend (InMemoryBackend)
 *      and leaks no sqlite-specific requirement into the router Layer's
 *      R-channel - no LunaSqliteBootstrap is provided anywhere in these
 *      tests, and they still build.
 *   2. `MemoryRouterLayer(dbPath)` (the sqlite convenience wrapper) is
 *      behaviorally identical to the direct composition it replaced: put/get
 *      and vector `search` still roundtrip through a `:memory:` db.
 *
 * Group 1 needs no bun:sqlite (InMemoryBackend is pure JS); group 2 is
 * gated the same way the rest of the sqlite-vector suite is.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, Stream } from "effect"
import { Clock, ObservabilityService, StubEmbedderLayer } from "@luna/core"
import {
  InMemoryBackend,
  LunaSqliteBootstrapLive,
  MemoryRouterTag,
  makeRecord,
} from "@luna/memory"
import { makeMemoryRouterLayer, MemoryRouterLayer } from "../src/layer.js"

const hasBunSqlite = (() =>
  typeof (process.versions as { bun?: string }).bun === "string")()

// MemoryLayer (not the backend) always needs these three - matches
// packages/memory/test/layer.test.ts's supportLayer.
const supportLayer = Layer.mergeAll(
  ObservabilityService.Default.pipe(Layer.provide(Clock.Default)),
  StubEmbedderLayer,
  Clock.Default,
)

describe("makeMemoryRouterLayer - generic backend injection", () => {
  it("swaps in InMemoryBackend and roundtrips put/get with no LunaSqliteBootstrap provided", async () => {
    const routerL = makeMemoryRouterLayer(
      InMemoryBackend.Default,
      InMemoryBackend,
    ).pipe(Layer.provide(supportLayer))

    const got = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        yield* router.put(
          makeRecord({
            id: "s03-inmem",
            namespace: "anything",
            kind: "k",
            content: { hello: "world" },
          }),
        )
        return yield* router.get("s03-inmem")
      }).pipe(Effect.provide(routerL)),
    )

    expect(got?.id).toBe("s03-inmem")
    expect((got?.content as { hello: string }).hello).toBe("world")
  })

  it("dispatches delete through the generically-typed backend too, not just put/get", async () => {
    const routerL = makeMemoryRouterLayer(
      InMemoryBackend.Default,
      InMemoryBackend,
    ).pipe(Layer.provide(supportLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const router = yield* MemoryRouterTag
        yield* router.put(
          makeRecord({
            id: "s03-del",
            namespace: "anything",
            kind: "k",
            content: 1,
          }),
        )
        const deleted = yield* router.delete("s03-del")
        const after = yield* router.get("s03-del")
        return { deleted, after }
      }).pipe(Effect.provide(routerL)),
    )

    expect(result.deleted).toBe(true)
    expect(result.after).toBeNull()
  })
})

describe.skipIf(!hasBunSqlite)(
  "MemoryRouterLayer - sqlite convenience wrapper stays behaviorally identical",
  () => {
    it("put/get/search roundtrip through a :memory: SqliteVectorBackend", async () => {
      const routerL = MemoryRouterLayer(":memory:").pipe(
        Layer.provide(StubEmbedderLayer),
        Layer.provide(LunaSqliteBootstrapLive),
        Layer.provide(supportLayer),
      )

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const router = yield* MemoryRouterTag
          yield* router.put(
            makeRecord({
              id: "s03-sqlite",
              namespace: "knowledge:test",
              kind: "semantic",
              content: { text: "the quarterly review happened on Tuesday" },
            }),
          )
          const gotRecord = yield* router.get("s03-sqlite")
          const hits = yield* Stream.runCollect(
            router.search({ queryText: "quarterly review" }),
          )
          return { gotRecord, hits: Array.from(hits) }
        }).pipe(Effect.provide(routerL)),
      )

      expect(result.gotRecord?.id).toBe("s03-sqlite")
      expect(result.hits.map((h) => h.record.id)).toContain("s03-sqlite")
    })
  },
)
