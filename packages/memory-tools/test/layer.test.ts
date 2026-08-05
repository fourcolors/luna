/**
 * §10.6 makeMemoryRouterLayer - generic backend injection.
 *
 * Proves the router wiring point (packages/memory-tools/src/layer.ts) is
 * generic, not hardcoded to sqlite - see that file's `makeMemoryRouterLayer`
 * docstring for why the `BackendApi extends MemoryVectorBackend` constraint
 * exists at all:
 *
 *   1. `makeMemoryRouterLayer(backendLayer, backendTag)` composes a working
 *      MemoryRouter with a completely different, search-capable backend
 *      (the test-only `TestVectorBackend`) and leaks no sqlite-specific
 *      requirement into the router Layer's R-channel - no
 *      LunaSqliteBootstrap is provided anywhere in these tests, and they
 *      still build.
 *   2. `MemoryRouterLayer(dbPath)` (the sqlite convenience wrapper) is
 *      behaviorally identical to the direct composition it replaced: put/get
 *      and vector `search` still roundtrip through a `:memory:` db.
 *   3. A search-less backend (`InMemoryBackend`) no longer satisfies that
 *      constraint - a compile-time proof (the module-scope statement below
 *      the `describe` block), not a runtime assertion. See DESIGN.md §10.6
 *      for how far that proof is (and isn't) CI-gated today.
 *
 * Group 1 needs no bun:sqlite (TestVectorBackend is pure JS); group 2 is
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
import { TestVectorBackend } from "../../memory/test/backend-contract.js"
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
  it("swaps in TestVectorBackend and roundtrips put/get with no LunaSqliteBootstrap provided", async () => {
    const routerL = makeMemoryRouterLayer(
      TestVectorBackend.Default,
      TestVectorBackend,
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
      TestVectorBackend.Default,
      TestVectorBackend,
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

// Compile-time proof: a search-less backend fails makeMemoryRouterLayer's
// constraint. Module-scope, not inside an `it`, so a passing suite never
// reads as this having been runtime-asserted - the only thing that can fail
// here is `tsc` on the line below.
// @ts-expect-error - InMemoryBackendApi has no `search`, so it does not
// satisfy `MemoryVectorBackend` (rationale: this file's header and
// layer.ts's makeMemoryRouterLayer docstring).
const _searchLessBackendRejected = makeMemoryRouterLayer(InMemoryBackend.Default, InMemoryBackend)

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
