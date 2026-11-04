/**
 * MemoryRouter fan-out caps — each backend applies `limit`/`topK` to its
 * own results, so the router must cap the MERGED stream at the requested
 * total, not return limit-per-backend. These tests use stub backends that
 * apply their own per-backend cap exactly like the real backends do, so
 * the tests isolate the router's merge logic.
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream } from "effect"
import { makeRouter } from "../src/router.js"
import type { MemorySearchArgs, MemoryVectorBackend } from "../src/backend.js"
import {
  MEMORY_ENVELOPE_VERSION,
  makeRecord,
  matchesQuery,
  type MemoryRecord,
} from "../src/types.js"

function stubBackend(ids: string[]): MemoryVectorBackend {
  const store = new Map<string, MemoryRecord>(
    ids.map((id) => [
      id,
      makeRecord({
        id,
        namespace: "ns",
        kind: "note",
        content: { text: `record ${id}` },
      }),
    ]),
  )
  return {
    backendName: "stub-vec",
    put: (rec) => Effect.sync(() => { store.set(rec.id, rec) }),
    get: (id) => Effect.sync(() => store.get(id) ?? null),
    query: (q) => {
      const matches = Array.from(store.values()).filter((r) =>
        matchesQuery(r, q),
      )
      const limited = q.limit ? matches.slice(0, q.limit) : matches
      return Stream.fromIterable(limited)
    },
    delete: (id) => Effect.sync(() => store.delete(id)),
    exportAll: () =>
      Effect.sync(() => ({
        backend: "stub-vec",
        envelopeVersion: MEMORY_ENVELOPE_VERSION,
        exportedAt: Date.now(),
        records: Array.from(store.values()),
      })),
    importAll: (env) =>
      Effect.sync(() => {
        for (const r of env.records) store.set(r.id, r)
        return env.records.length
      }),
    search: (args: MemorySearchArgs) => {
      const k = args.topK ?? 10
      const hits = Array.from(store.values())
        .slice(0, k)
        .map((record, i) => ({ record, score: 1 - i * 0.1 }))
      return Stream.fromIterable(hits)
    },
  }
}

describe("MemoryRouter fan-out caps", () => {
  it("query with no namespace returns at most limit rows in total", async () => {
    const router = makeRouter([
      { pattern: "a:*", backend: stubBackend(["a1", "a2", "a3"]) },
      { pattern: "*", backend: stubBackend(["b1", "b2", "b3"]) },
    ])
    const out = await Effect.runPromise(
      Stream.runCollect(router.query({ limit: 2 })),
    )
    expect(Array.from(out).length).toBe(2)
  })

  it("query with no namespace and no limit returns every row", async () => {
    const router = makeRouter([
      { pattern: "a:*", backend: stubBackend(["a1", "a2"]) },
      { pattern: "*", backend: stubBackend(["b1", "b2"]) },
    ])
    const out = await Effect.runPromise(
      Stream.runCollect(router.query({})),
    )
    expect(Array.from(out).map((r) => r.id).sort()).toEqual([
      "a1",
      "a2",
      "b1",
      "b2",
    ])
  })

  it("search with no namespace returns at most topK hits in total", async () => {
    const router = makeRouter([
      { pattern: "a:*", backend: stubBackend(["a1", "a2", "a3"]) },
      { pattern: "*", backend: stubBackend(["b1", "b2", "b3"]) },
    ])
    const out = await Effect.runPromise(
      Stream.runCollect(router.search({ queryText: "record", topK: 2 })),
    )
    expect(Array.from(out).length).toBe(2)
  })

  it("search with no namespace and default topK does not over-trim", async () => {
    const router = makeRouter([
      { pattern: "a:*", backend: stubBackend(["a1", "a2", "a3"]) },
      { pattern: "*", backend: stubBackend(["b1", "b2", "b3"]) },
    ])
    const out = await Effect.runPromise(
      Stream.runCollect(router.search({ queryText: "record" })),
    )
    expect(Array.from(out).length).toBe(6)
  })
})

// Ranked stubs: each backend orders its own results exactly like the real
// backends do (query newest-first, search best-score-first) and applies its
// own per-backend cap. The router's merged cap must then select by the
// global rank, not by which backend emits first.
function rankedBackend(
  entries: ReadonlyArray<{ id: string; now: number; score: number }>,
): MemoryVectorBackend {
  const store = new Map<string, MemoryRecord>(
    entries.map((e) => [
      e.id,
      makeRecord({
        id: e.id,
        namespace: "ns",
        kind: "note",
        content: { text: `record ${e.id}` },
        now: e.now,
      }),
    ]),
  )
  const scoreOf = new Map(entries.map((e) => [e.id, e.score]))
  return {
    backendName: "stub-vec",
    put: (rec) => Effect.sync(() => { store.set(rec.id, rec) }),
    get: (id) => Effect.sync(() => store.get(id) ?? null),
    query: (q) => {
      const sorted = Array.from(store.values()).sort(
        (a, b) => b.updatedAt - a.updatedAt,
      )
      const limited = q.limit ? sorted.slice(0, q.limit) : sorted
      return Stream.fromIterable(limited)
    },
    delete: (id) => Effect.sync(() => store.delete(id)),
    exportAll: () =>
      Effect.sync(() => ({
        backend: "stub-vec",
        envelopeVersion: MEMORY_ENVELOPE_VERSION,
        exportedAt: Date.now(),
        records: Array.from(store.values()),
      })),
    importAll: (env) =>
      Effect.sync(() => {
        for (const r of env.records) store.set(r.id, r)
        return env.records.length
      }),
    search: (args: MemorySearchArgs) => {
      const k = args.topK ?? 10
      const hits = Array.from(store.values())
        .map((record) => ({ record, score: scoreOf.get(record.id) ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
      return Stream.fromIterable(hits)
    },
  }
}

describe("MemoryRouter fan-out cap selection", () => {
  it("query limit keeps the newest records across backends, not first arrivals", async () => {
    const router = makeRouter([
      { pattern: "a:*", backend: rankedBackend([{ id: "old", now: 100, score: 0 }]) },
      { pattern: "*", backend: rankedBackend([{ id: "new", now: 200, score: 0 }]) },
    ])
    const out = await Effect.runPromise(
      Stream.runCollect(router.query({ limit: 1 })),
    )
    expect(Array.from(out).map((r) => r.id)).toEqual(["new"])
  })

  it("search topK keeps the best-scored hits across backends, not first arrivals", async () => {
    const router = makeRouter([
      { pattern: "a:*", backend: rankedBackend([{ id: "low", now: 100, score: 0.2 }]) },
      {
        pattern: "*",
        backend: rankedBackend([
          { id: "mid", now: 150, score: 0.5 },
          { id: "high", now: 200, score: 0.9 },
        ]),
      },
    ])
    const out = await Effect.runPromise(
      Stream.runCollect(router.search({ queryText: "record", topK: 2 })),
    )
    expect(Array.from(out).map((h) => h.record.id)).toEqual(["high", "mid"])
  })
})
