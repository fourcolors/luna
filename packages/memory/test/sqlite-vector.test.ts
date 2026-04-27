/**
 * SqliteVectorBackend tests — Phase 25 BDD scenarios.
 * See test/sqlite-vector.scenarios.md for Given/When/Then.
 *
 * Skipped under stock node+vitest (bun:sqlite unavailable).
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream, Layer } from "effect"
import {
  EmbedderService,
  StubEmbedderLayer,
  bufferToFloat32,
} from "@luna/core"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { makeRecord } from "../src/types.js"

const hasBunSqlite = (() => {
  return typeof (process.versions as { bun?: string }).bun === "string"
})()

describe.skipIf(!hasBunSqlite)("SqliteVectorBackend (bun:sqlite + Stub embedder)", () => {
  const layer = Layer.provideMerge(
    SqliteVectorBackend.fromPath(":memory:"),
    StubEmbedderLayer,
  )

  const run = <A, E>(
    eff: Effect.Effect<A, E, SqliteVectorBackend | EmbedderService>,
  ) => Effect.runPromise(Effect.scoped(eff).pipe(Effect.provide(layer)))

  it("Scenario 1: stub-embedder ranking is monotonic in token overlap", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "a",
            namespace: "notes",
            kind: "note",
            content: { text: "cats and dogs" },
          }),
        )
        yield* b.put(
          makeRecord({
            id: "b",
            namespace: "notes",
            kind: "note",
            content: { text: "dogs and birds" },
          }),
        )
        yield* b.put(
          makeRecord({
            id: "c",
            namespace: "notes",
            kind: "note",
            content: { text: "submarines and torpedoes" },
          }),
        )
        return yield* Stream.runCollect(
          b.search({ queryText: "cats", topK: 3 }),
        )
      }),
    )
    const arr = Array.from(out)
    expect(arr.length).toBe(3)
    // The "cats and dogs" record must rank first.
    expect(arr[0]!.record.id).toBe("a")
    // Submarine record must rank last (no token overlap).
    expect(arr[2]!.record.id).toBe("c")
    // Top score must beat bottom score.
    expect(arr[0]!.score).toBeGreaterThan(arr[2]!.score)
  })

  it("Scenario 2: namespace filter is honored", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "p1",
            namespace: "notes:public",
            kind: "note",
            content: { text: "shared knowledge" },
          }),
        )
        yield* b.put(
          makeRecord({
            id: "s1",
            namespace: "notes:private",
            kind: "note",
            content: { text: "shared knowledge" },
          }),
        )
        return yield* Stream.runCollect(
          b.search({
            queryText: "shared",
            namespace: "notes:public",
            topK: 5,
          }),
        )
      }),
    )
    const arr = Array.from(out)
    expect(arr.length).toBe(1)
    expect(arr[0]!.record.namespace).toBe("notes:public")
  })

  it("Scenario 3: topK is enforced (returns at most K results)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        for (let i = 0; i < 50; i++) {
          yield* b.put(
            makeRecord({
              id: `r${i}`,
              namespace: "bulk",
              kind: "note",
              content: { text: `record number ${i} contains words` },
            }),
          )
        }
        return yield* Stream.runCollect(
          b.search({ queryText: "words", topK: 5, namespace: "bulk" }),
        )
      }),
    )
    const arr = Array.from(out)
    expect(arr.length).toBe(5)
    // Sorted by descending score.
    for (let i = 1; i < arr.length; i++) {
      expect(arr[i - 1]!.score).toBeGreaterThanOrEqual(arr[i]!.score)
    }
  })

  it("Scenario 4: put() with no content.text writes keyed-only", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "k-only",
            namespace: "notes",
            kind: "blob",
            content: { foo: "bar" },
          }),
        )
        const fetched = yield* b.get("k-only")
        const searchResults = yield* Stream.runCollect(
          b.search({ queryText: "anything", namespace: "notes", topK: 5 }),
        )
        return { fetched, searchResults: Array.from(searchResults) }
      }),
    )
    expect(out.fetched).not.toBeNull()
    expect(out.fetched!.id).toBe("k-only")
    // Record exists keyed-only — must NOT appear in vector search.
    expect(out.searchResults.find((r) => r.record.id === "k-only")).toBeUndefined()
  })

  it("Scenario 5: put() with content.text auto-embeds and writes both rows", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "with-text",
            namespace: "notes",
            kind: "note",
            content: { text: "hello world" },
          }),
        )
        return yield* Stream.runCollect(
          b.search({ queryText: "hello", namespace: "notes", topK: 5 }),
        )
      }),
    )
    const arr = Array.from(out)
    const found = arr.find((r) => r.record.id === "with-text")
    expect(found).toBeDefined()
    expect(found!.score).toBeGreaterThan(0)
  })

  it("Scenario 6: Float32 ↔ BLOB roundtrip preserves bytes (via search ranking)", async () => {
    // If the BLOB roundtrip were broken, scores would be NaN/garbage and
    // scenario 1 would already fail. But pin the property explicitly: a
    // record's self-similarity (query == text) must be ~1.0.
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "self",
            namespace: "ns",
            kind: "note",
            content: { text: "exact phrase" },
          }),
        )
        return yield* Stream.runCollect(
          b.search({ queryText: "exact phrase", namespace: "ns", topK: 1 }),
        )
      }),
    )
    const arr = Array.from(out)
    expect(arr[0]!.score).toBeGreaterThan(0.99)
  })

  it("Scenario 7: hybrid mode returns 'not implemented' error", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const b = yield* SqliteVectorBackend
          return yield* Stream.runCollect(
            b.search({ queryText: "x", mode: "hybrid" }),
          )
        }),
      ).pipe(Effect.provide(layer), Effect.either),
    )
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect((result.left as { op: string }).op).toBe("search.hybrid")
    }
  })

  it("delete cascades to memory_vectors (FK ON DELETE CASCADE)", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "del-me",
            namespace: "ns",
            kind: "note",
            content: { text: "to be deleted" },
          }),
        )
        const before = yield* Stream.runCollect(
          b.search({ queryText: "deleted", namespace: "ns", topK: 5 }),
        )
        const wasDeleted = yield* b.delete("del-me")
        const after = yield* Stream.runCollect(
          b.search({ queryText: "deleted", namespace: "ns", topK: 5 }),
        )
        return {
          beforeCount: Array.from(before).length,
          wasDeleted,
          afterCount: Array.from(after).length,
        }
      }),
    )
    expect(out.beforeCount).toBe(1)
    expect(out.wasDeleted).toBe(true)
    expect(out.afterCount).toBe(0)
  })
})

// Side test: prove the BLOB roundtrip helper doesn't drift bytes.
describe("Float32 ↔ BLOB roundtrip helper", () => {
  it("preserves all 4-byte float values exactly", () => {
    const orig = new Float32Array([0, 1, -1, Math.PI, 1e-30, 1e30, -0])
    const buf = new Uint8Array(
      orig.buffer,
      orig.byteOffset,
      orig.byteLength,
    )
    const back = bufferToFloat32(buf)
    expect(back.length).toBe(orig.length)
    for (let i = 0; i < orig.length; i++) {
      expect(back[i]).toBe(orig[i])
    }
  })
})
