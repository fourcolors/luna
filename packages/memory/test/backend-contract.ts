/**
 * Shared MemoryBackend conformance contract + a test-only MemoryVectorBackend.
 *
 * `runMemoryBackendContract(label, makeLayer)` is the mechanical proof that a
 * different backend satisfies the same semantics through the router: it
 * covers the exact `MemoryBackend` surface declared at
 * packages/memory/src/backend.ts:25-37 (backendName/put/get/query/delete/
 * exportAll/importAll, plus scope filtering). Run against InMemoryBackend
 * (in-memory.test.ts), SqliteVectorBackend (sqlite-vector.test.ts), and
 * TestVectorBackend (packages/memory-tools/test/router-swap.test.ts) against
 * the identical assertions. Deliberately breaking one backend's `delete()`
 * fails only that backend's contract run.
 *
 * `TestVectorBackend` is a second, test-only `MemoryVectorBackend` - its
 * keyed half (put/get/query/delete/exportAll/importAll) is InMemoryBackend's
 * own implementation, wrapped to add `search` - used by
 * packages/memory-tools/test/layer.test.ts and router-swap.test.ts to prove
 * the router/tools seam accepts a DIFFERENT vector-capable backend with zero
 * production source changes. `search` honors `mode` per the MUST at
 * packages/memory/src/backend.ts:45-49: `"vec"` and `"bm25"` each rank by
 * one signal (a Jaccard-like overlap ratio and a raw token-overlap count,
 * respectively), `"hybrid"` fuses those two signals via RRF, and
 * `"hybrid-terms"` is not implemented and fails with `MemoryBackendError`
 * rather than silently answering with a mode it wasn't asked for. `search`
 * does not filter by `scope` - neither does SqliteVectorBackend's today (see
 * packages/memory/src/backends/sqlite-vector.ts), so this is parity, not a
 * regression, but it means neither backend's `search` path is covered by the
 * scope-filtering assertions `query()` gets in the shared contract below.
 * TestVectorBackend stays out of production wiring (NEXT.md decision 2
 * forbids a second production backend with one consumer).
 */
import { describe, expect, it } from "vitest"
import { Context, Effect, Layer, Stream } from "effect"
import { MemoryBackendError } from "@luna/core"
import type { MemoryBackend, MemoryVectorBackend } from "../src/backend.js"
import { InMemoryBackend } from "../src/backends/in-memory.js"
import { makeRecord, type MemoryRecord } from "../src/types.js"

/**
 * Shared Tag every `makeLayer` factory targets. Exported so callers build
 * their backend's Layer wiring as `Layer.effect(BackendUnderTest, TheTag).pipe(Layer.provide(TheTag.Default))`.
 */
export const BackendUnderTest = Context.GenericTag<MemoryBackend>(
  "luna/memory/test/BackendUnderTest",
)

/**
 * Run the shared MemoryBackend contract against a backend built fresh (no
 * shared state) for every assertion. `makeLayer` must return a fully
 * resolved Layer (R = never) - callers compose their backend's own Layer
 * requirements (e.g. EmbedderService, LunaSqliteBootstrap) before handing it
 * over, exactly the pattern `makeMemoryRouterLayer` expects at a call site.
 */
export function runMemoryBackendContract(
  label: string,
  makeLayer: () => Layer.Layer<MemoryBackend, unknown, never>,
): void {
  const run = <A, E>(f: (be: MemoryBackend) => Effect.Effect<A, E>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const be = yield* BackendUnderTest
        return yield* f(be)
      }).pipe(Effect.provide(makeLayer())),
    )

  describe(`MemoryBackend contract: ${label}`, () => {
    it("backendName is a non-empty string", async () => {
      const name = await run((be) => Effect.succeed(be.backendName))
      expect(typeof name).toBe("string")
      expect(name.length).toBeGreaterThan(0)
    })

    it("put + get roundtrip", async () => {
      const out = await run((be) =>
        Effect.gen(function* () {
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
      const out = await run((be) =>
        Effect.gen(function* () {
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
      const out = await run((be) =>
        Effect.gen(function* () {
          yield* be.put(makeRecord({ id: "x", namespace: "n", kind: "k", content: {} }))
          const d1 = yield* be.delete("x")
          const d2 = yield* be.delete("missing")
          const g = yield* be.get("x")
          return { d1, d2, gone: g === null }
        }),
      )
      expect(out).toEqual({ d1: true, d2: false, gone: true })
    })

    it("applies compatibility scope to legacy records without metadata", async () => {
      const out = await run((be) =>
        Effect.gen(function* () {
          yield* be.put(
            makeRecord({
              id: "legacy-note",
              namespace: "notes",
              kind: "semantic",
              content: { text: "shared legacy note" },
            }),
          )
          yield* be.put(
            makeRecord({
              id: "legacy-belief",
              namespace: "operator",
              kind: "belief",
              content: { statement: "private legacy belief" },
            }),
          )
          const luna = yield* Stream.runCollect(
            be.query({ scope: { observerId: "luna", subjectId: "operator" } }),
          )
          const helper = yield* Stream.runCollect(
            be.query({ scope: { observerId: "helper", subjectId: "operator" } }),
          )
          return {
            luna: Array.from(luna, (record) => record.id).sort(),
            helper: Array.from(helper, (record) => record.id).sort(),
          }
        }),
      )
      expect(out.luna).toEqual(["legacy-belief", "legacy-note"])
      expect(out.helper).toEqual(["legacy-note"])
    })

    it("exportAll + importAll roundtrip preserves records", async () => {
      const out = await run((be) =>
        Effect.gen(function* () {
          yield* be.put(
            makeRecord({ id: "a", namespace: "n", kind: "k", content: "hello" }),
          )
          yield* be.put(makeRecord({ id: "b", namespace: "n", kind: "k", content: 42 }))
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
}

// ─── TestVectorBackend ──────────────────────────────────────────────────

function extractText(content: unknown): string | null {
  if (
    content !== null &&
    typeof content === "object" &&
    "text" in content &&
    typeof (content as { text: unknown }).text === "string"
  ) {
    return (content as { text: string }).text
  }
  return null
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Raw token-overlap count - the `"bm25"` (lexical-only) signal. */
function lexicalScore(recTokens: readonly string[], queryTokens: ReadonlySet<string>): number {
  let n = 0
  for (const t of recTokens) if (queryTokens.has(t)) n++
  return n
}

/**
 * Jaccard similarity over token sets - the `"vec"` signal. Deliberately a
 * different formula from `lexicalScore` (ratio of a *set* intersection over
 * a union, not a raw count over the record's own length) so `"hybrid"`
 * fuses two genuinely distinct rankings rather than the same number twice.
 */
function vectorScore(recTokens: readonly string[], queryTokens: ReadonlySet<string>): number {
  if (recTokens.length === 0) return 0
  const recSet = new Set(recTokens)
  let intersection = 0
  for (const t of recSet) if (queryTokens.has(t)) intersection++
  const union = new Set([...recSet, ...queryTokens]).size
  return union === 0 ? 0 : intersection / union
}

export interface TestVectorBackendApi extends MemoryVectorBackend {
  readonly backendName: "test-vector"
}

export class TestVectorBackend extends Effect.Tag(
  "luna/memory/test/TestVectorBackend",
)<TestVectorBackend, TestVectorBackendApi>() {
  // Keyed half (put/get/query/delete/exportAll/importAll) is InMemoryBackend
  // itself, decorated with `search` and a distinct `backendName` - the
  // subject under test is the router/tools seam, not the keyed storage
  // logic, so reusing InMemoryBackend proves the same swappability with no
  // second copy of that logic to drift out of sync.
  static readonly Default: Layer.Layer<TestVectorBackend> = Layer.effect(
    TestVectorBackend,
    Effect.gen(function* () {
      const inMemory = yield* InMemoryBackend

      const search: TestVectorBackendApi["search"] = (args) => {
        const mode = args.mode ?? "vec"

        // "hybrid-terms" is not implemented by this test double. Per the
        // MUST at packages/memory/src/backend.ts:45-49, an unsupported mode
        // fails loudly rather than silently answering with a different one.
        if (mode === "hybrid-terms") {
          return Stream.fail(
            new MemoryBackendError({
              backend: "test-vector",
              op: "search",
              cause: new Error(`TestVectorBackend does not implement mode "${mode}"`),
            }),
          )
        }

        const topK = args.topK ?? 10
        const queryTokens = new Set(tokenize(args.queryText))

        return Stream.unwrap(
          Effect.map(
            Stream.runCollect(
              inMemory.query(args.namespace !== undefined ? { namespace: args.namespace } : {}),
            ),
            (records) => {
              const candidates: { record: MemoryRecord; recTokens: string[] }[] = []
              for (const record of records) {
                const text = extractText(record.content)
                if (text === null) continue
                const recTokens = tokenize(text)
                if (recTokens.length === 0) continue
                candidates.push({ record, recTokens })
              }

              if (mode === "bm25") {
                const hits = candidates
                  .map((c) => ({ record: c.record, score: lexicalScore(c.recTokens, queryTokens) }))
                  .filter((h) => h.score > 0)
                hits.sort((a, b) => b.score - a.score)
                return Stream.fromIterable(hits.slice(0, topK))
              }

              if (mode === "vec") {
                const hits = candidates
                  .map((c) => ({ record: c.record, score: vectorScore(c.recTokens, queryTokens) }))
                  .filter((h) => h.score > 0)
                hits.sort((a, b) => b.score - a.score)
                return Stream.fromIterable(hits.slice(0, topK))
              }

              // mode === "hybrid": RRF fusion (k=60) of the lexical and
              // vector rankings above - same strategy MemoryVectorBackend
              // documents at packages/memory/src/backend.ts:45-47, over two
              // distinct signals rather than one score counted twice.
              const RRF_K = 60
              const lexRanked = candidates
                .map((c) => ({ id: c.record.id, score: lexicalScore(c.recTokens, queryTokens) }))
                .filter((c) => c.score > 0)
                .sort((a, b) => b.score - a.score)
              const vecRanked = candidates
                .map((c) => ({ id: c.record.id, score: vectorScore(c.recTokens, queryTokens) }))
                .filter((c) => c.score > 0)
                .sort((a, b) => b.score - a.score)
              const fused = new Map<string, number>()
              lexRanked.forEach((c, i) =>
                fused.set(c.id, (fused.get(c.id) ?? 0) + 1 / (RRF_K + i + 1)),
              )
              vecRanked.forEach((c, i) =>
                fused.set(c.id, (fused.get(c.id) ?? 0) + 1 / (RRF_K + i + 1)),
              )
              const byId = new Map(candidates.map((c) => [c.record.id, c.record] as const))
              const hits = Array.from(fused.entries())
                .map(([id, score]) => ({ record: byId.get(id)!, score }))
                .sort((a, b) => b.score - a.score)
              return Stream.fromIterable(hits.slice(0, topK))
            },
          ),
        )
      }

      return {
        ...inMemory,
        backendName: "test-vector" as const,
        exportAll: () =>
          Effect.map(inMemory.exportAll(), (env) => ({ ...env, backend: "test-vector" as const })),
        search,
      }
    }),
  ).pipe(Layer.provide(InMemoryBackend.Default))
}
