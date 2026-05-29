/**
 * SqliteVectorBackend tests — Phase 25 BDD scenarios.
 * See test/sqlite-vector.scenarios.md for Given/When/Then.
 *
 * Skipped under stock node+vitest (bun:sqlite unavailable).
 */
import { describe, expect, it } from "vitest"
import { Effect, Stream, Layer } from "effect"
import {
  EmbedderError,
  EmbedderService,
  LunaSqliteBootstrap,
  StubEmbedderLayer,
  bufferToFloat32,
} from "@luna/core"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../src/backends/vectorlite-bootstrap.js"
import { makeRecord } from "../src/types.js"

const hasBunSqlite = (() => {
  return typeof (process.versions as { bun?: string }).bun === "string"
})()

describe.skipIf(!hasBunSqlite)("SqliteVectorBackend (bun:sqlite + Stub embedder)", () => {
  // Phase 27a: SqliteVectorBackend now declares `LunaSqliteBootstrap` in
  // its `R`. Provide the Live Layer here so the backend can build under
  // test. (Same fixture pattern chat-server uses.)
  const layer = Layer.provideMerge(
    SqliteVectorBackend.fromPath(":memory:"),
    Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
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
            content: { text: "cats felines whiskers" },
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
          b.search({ queryText: "cats felines whiskers", topK: 3 }),
        )
      }),
    )
    const arr = Array.from(out)
    expect(arr.length).toBe(3)
    // The "cats and dogs" record must rank first.
    expect(arr[0]!.record.id).toBe("a")
    // Top score must beat the zero-overlap records. Their relative order is
    // intentionally not asserted because formatted vector inputs add common
    // structural tokens that can make unrelated rows tie.
    expect(arr[0]!.score).toBeGreaterThan(arr[1]!.score)
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

  it("Scenario 5b: formats record/query embedding input while preserving raw FTS text", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-format-input-"))
    const dbPath = path.join(tmp, "memory.db")
    const embeddedInputs: string[] = []
    const CapturingEmbedderLayer = Layer.succeed(EmbedderService, {
      provider: "capture",
      model: "unit-test",
      dimension: 4,
      embeddingFormat: "memory-note-v1",
      embed: (text: string) =>
        Effect.sync(() => {
          embeddedInputs.push(text)
          return new Float32Array([1, 0, 0, 0])
        }),
    })
    const NoVectorliteLayer = Layer.succeed(LunaSqliteBootstrap, {
      ok: false as const,
      reason: "test disables vectorlite",
    })
    const localLayer = Layer.provideMerge(
      SqliteVectorBackend.fromPath(dbPath),
      Layer.merge(CapturingEmbedderLayer, NoVectorliteLayer),
    )
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            yield* b.put(
              makeRecord({
                id: "formatted",
                namespace: "notes",
                kind: "note",
                content: { text: "raw memory text" },
                tags: ["alpha", "beta"],
              }),
            )
            yield* Stream.runCollect(
              b.search({
                queryText: "raw memory",
                namespace: "notes",
                topK: 1,
              }),
            )
          }).pipe(Effect.provide(localLayer)),
        ),
      )

      expect(embeddedInputs).toEqual([
        "title: notes/note tags:alpha,beta | text: raw memory text",
        "task: search result | query: raw memory",
      ])

      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          query: (sql: string) => { get: (...p: unknown[]) => unknown }
          close: () => void
        }
      }
      const db = new bunSqlite.Database(dbPath)
      try {
        const row = db
          .query(
            `SELECT text, embedding_provider, embedding_model, embedding_format, embedding_input_hash, embedded_at
               FROM memory_vectors WHERE id = ?`,
          )
          .get("formatted") as
          | {
              text: string
              embedding_provider: string
              embedding_model: string
              embedding_format: string
              embedding_input_hash: string
              embedded_at: number
            }
          | null
        expect(row).not.toBeNull()
        expect(row!.text).toBe("raw memory text")
        expect(row!.embedding_provider).toBe("capture")
        expect(row!.embedding_model).toBe("unit-test")
        expect(row!.embedding_format).toBe("memory-note-v1")
        expect(row!.embedding_input_hash).toMatch(/^[a-f0-9]{64}$/)
        expect(row!.embedded_at).toBeGreaterThan(0)
      } finally {
        db.close()
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
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
    // Record and query embedding inputs are formatted differently in
    // memory-note-v1, so exact raw text no longer means cosine ~= 1. The
    // BLOB roundtrip still must yield a finite positive score for self lookup.
    expect(arr[0]!.score).toBeGreaterThan(0)
  })

  it("Scenario 7: hybrid finds an exact-term match that vec ranks weakly", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        // Pad with distractors that share many tokens with the query phrase
        // so the rare-token record is not also vec's top hit by accident.
        for (let i = 0; i < 10; i++) {
          yield* b.put(
            makeRecord({
              id: `pad-${i}`,
              namespace: "rare",
              kind: "note",
              content: { text: `padding distractor record number ${i} contains common tokens` },
            }),
          )
        }
        yield* b.put(
          makeRecord({
            id: "rare",
            namespace: "rare",
            kind: "note",
            content: { text: "x7y9z3-rare-token appears here exactly once" },
          }),
        )
        const hybrid = yield* Stream.runCollect(
          b.search({
            queryText: "x7y9z3-rare-token",
            mode: "hybrid",
            namespace: "rare",
            topK: 5,
          }),
        )
        return Array.from(hybrid).map((r) => r.record.id)
      }),
    )
    expect(out).toContain("rare")
  })

  it("Scenario 7b: hybrid keeps semantic recall when keywords miss", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "feline",
            namespace: "sem",
            kind: "note",
            content: { text: "cat feline pet" },
          }),
        )
        yield* b.put(
          makeRecord({
            id: "unrelated",
            namespace: "sem",
            kind: "note",
            content: { text: "submarine torpedo" },
          }),
        )
        const hybrid = yield* Stream.runCollect(
          b.search({
            queryText: "cat",
            mode: "hybrid",
            namespace: "sem",
            topK: 5,
          }),
        )
        return Array.from(hybrid).map((r) => r.record.id)
      }),
    )
    // The "feline" record (which contains "cat") should surface via either
    // FTS or vec; the unrelated record should NOT outrank it.
    expect(out).toContain("feline")
    expect(out[0]).toBe("feline")
  })

  it("Scenario 7c: RRF ranks an id appearing in BOTH lists above singletons", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        // Three records:
        //  C — contains the exact query term AND high vec overlap
        //  A — exact query term but low vec overlap
        //  B — high vec overlap but no exact-term match
        yield* b.put(
          makeRecord({
            id: "C",
            namespace: "rrf",
            kind: "note",
            content: { text: "alpha beta gamma delta epsilon" },
          }),
        )
        yield* b.put(
          makeRecord({
            id: "A",
            namespace: "rrf",
            kind: "note",
            content: { text: "alpha unrelated topic submarine" },
          }),
        )
        yield* b.put(
          makeRecord({
            id: "B",
            namespace: "rrf",
            kind: "note",
            content: { text: "beta gamma delta epsilon" },
          }),
        )
        const hybrid = yield* Stream.runCollect(
          b.search({
            queryText: "alpha beta gamma delta epsilon",
            mode: "hybrid",
            namespace: "rrf",
            topK: 3,
          }),
        )
        return Array.from(hybrid).map((r) => r.record.id)
      }),
    )
    expect(out.length).toBe(3)
    // C — the only record present in both rankings — must rank first.
    expect(out[0]).toBe("C")
  })

  it("Scenario 7d: namespace filter is honored on hybrid", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "pub",
            namespace: "ns:public",
            kind: "note",
            content: { text: "shared knowledge" },
          }),
        )
        yield* b.put(
          makeRecord({
            id: "priv",
            namespace: "ns:private",
            kind: "note",
            content: { text: "shared knowledge" },
          }),
        )
        const arr = yield* Stream.runCollect(
          b.search({
            queryText: "shared",
            mode: "hybrid",
            namespace: "ns:public",
            topK: 5,
          }),
        )
        return Array.from(arr).map((r) => r.record.namespace)
      }),
    )
    expect(out.every((ns) => ns === "ns:public")).toBe(true)
    expect(out.length).toBe(1)
  })

  it("Scenario 7e: INSERT OR REPLACE updates FTS row (trigger sync)", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-fts-update-"))
    const dbPath = path.join(tmp, "memory.db")
    const NoVectorliteLayer = Layer.succeed(LunaSqliteBootstrap, {
      ok: false as const,
      reason: "test disables vectorlite",
    })
    const localLayer = Layer.provideMerge(
      SqliteVectorBackend.fromPath(dbPath),
      Layer.merge(StubEmbedderLayer, NoVectorliteLayer),
    )
    try {
      const out = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            yield* b.put(
              makeRecord({
                id: "swap",
                namespace: "swp",
                kind: "note",
                content: { text: "alphaorig zztokenuniq11" },
              }),
            )
            const beforeAlpha = yield* Stream.runCollect(
              b.search({
                queryText: "zztokenuniq11",
                mode: "hybrid",
                namespace: "swp",
                topK: 3,
              }),
            )
            yield* b.put(
              makeRecord({
                id: "swap",
                namespace: "swp",
                kind: "note",
                content: { text: "betarep yytokenuniq22" },
              }),
            )
            const afterBeta = yield* Stream.runCollect(
              b.search({
                queryText: "yytokenuniq22",
                mode: "hybrid",
                namespace: "swp",
                topK: 3,
              }),
            )
            return {
              beforeAlpha: Array.from(beforeAlpha).map((r) => r.record.id),
              afterBeta: Array.from(afterBeta).map((r) => r.record.id),
            }
          }).pipe(Effect.provide(localLayer)),
        ),
      )

      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          query: (sql: string) => { all: (...p: unknown[]) => unknown[] }
          close: () => void
        }
      }
      const db = new bunSqlite.Database(dbPath)
      try {
        const oldFts = db
          .query(
            `SELECT v.id AS id
               FROM memory_vectors v
               JOIN memory_fts f ON f.rowid = v.rowid
              WHERE memory_fts MATCH ?`,
          )
          .all('"zztokenuniq11"') as { id: string }[]
        const newFts = db
          .query(
            `SELECT v.id AS id
               FROM memory_vectors v
               JOIN memory_fts f ON f.rowid = v.rowid
              WHERE memory_fts MATCH ?`,
          )
          .all('"yytokenuniq22"') as { id: string }[]

        expect(out.beforeAlpha).toContain("swap")
        expect(oldFts.map((r) => r.id)).not.toContain("swap")
        expect(newFts.map((r) => r.id)).toContain("swap")
        expect(out.afterBeta).toContain("swap")
      } finally {
        db.close()
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("Scenario 7f: DELETE cascades to FTS row", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "del-fts",
            namespace: "delfts",
            kind: "note",
            content: { text: "uniqueword-zzz12345" },
          }),
        )
        const before = yield* Stream.runCollect(
          b.search({
            queryText: "uniqueword-zzz12345",
            mode: "hybrid",
            namespace: "delfts",
            topK: 5,
          }),
        )
        yield* b.delete("del-fts")
        const after = yield* Stream.runCollect(
          b.search({
            queryText: "uniqueword-zzz12345",
            mode: "hybrid",
            namespace: "delfts",
            topK: 5,
          }),
        )
        return {
          before: Array.from(before).map((r) => r.record.id),
          after: Array.from(after).map((r) => r.record.id),
        }
      }),
    )
    expect(out.before).toContain("del-fts")
    expect(out.after).not.toContain("del-fts")
  })

  it("Scenario 7g: mode:'vec' (default) regression — unchanged behavior", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "v1",
            namespace: "vreg",
            kind: "note",
            content: { text: "cats and dogs" },
          }),
        )
        yield* b.put(
          makeRecord({
            id: "v2",
            namespace: "vreg",
            kind: "note",
            content: { text: "submarines and torpedoes" },
          }),
        )
        // Explicit mode:"vec"
        const explicit = yield* Stream.runCollect(
          b.search({
            queryText: "cats",
            mode: "vec",
            namespace: "vreg",
            topK: 5,
          }),
        )
        // Default mode (omitted)
        const defaulted = yield* Stream.runCollect(
          b.search({ queryText: "cats", namespace: "vreg", topK: 5 }),
        )
        return {
          explicit: Array.from(explicit).map((r) => r.record.id),
          defaulted: Array.from(defaulted).map((r) => r.record.id),
        }
      }),
    )
    expect(out.explicit[0]).toBe("v1")
    expect(out.defaulted[0]).toBe("v1")
    expect(out.explicit).toEqual(out.defaulted)
  })

  it("Scenario 7h: hybrid skips records without text content", async () => {
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        yield* b.put(
          makeRecord({
            id: "blob-only",
            namespace: "blob",
            kind: "blob",
            content: { foo: "bar" },
          }),
        )
        const arr = yield* Stream.runCollect(
          b.search({
            queryText: "anything",
            mode: "hybrid",
            namespace: "blob",
            topK: 5,
          }),
        )
        return Array.from(arr).map((r) => r.record.id)
      }),
    )
    // Consistent with vec behavior: a keyed-only record (no FTS, no vec)
    // is invisible to hybrid search.
    expect(out).not.toContain("blob-only")
  })

  it("Scenario 7i: backfill populates FTS for rows that pre-date the FTS table", async () => {
    // Simulate a pre-Phase-26 database: open the DB directly via bun:sqlite
    // WITHOUT the FTS table or triggers, insert a memory_vectors row, close.
    // Then open via SqliteVectorBackend (MIGRATION runs → creates FTS +
    // backfills). Hybrid search must find the row.
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-fts-backfill-"))
    const dbPath = path.join(tmp, "vectors.db")

    try {
      // Phase: build a "pre-Phase-26" DB manually.
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          run: (sql: string) => void
          query: (sql: string) => {
            run: (...p: unknown[]) => { changes: number }
          }
          close: () => void
        }
      }
      const pre = new bunSqlite.Database(dbPath)
      pre.run("PRAGMA foreign_keys = ON")
      // Just the keyed + vectors tables — NO FTS, NO triggers.
      pre.run(`
        CREATE TABLE memory_keyed (
          id TEXT PRIMARY KEY, namespace TEXT NOT NULL, kind TEXT NOT NULL,
          content_json TEXT NOT NULL, schema_version INTEGER NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          tags_json TEXT NOT NULL
        );
        CREATE TABLE memory_vectors (
          id TEXT PRIMARY KEY REFERENCES memory_keyed(id) ON DELETE CASCADE,
          namespace TEXT NOT NULL, embedding BLOB NOT NULL,
          dimension INTEGER NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL
        );
      `)
      // Insert a row directly. Embedding bytes don't matter for FTS lookup
      // (we'll search by exact phrase via BM25 leg of hybrid).
      const fakeEmbedding = new Uint8Array(8 * 4) // 8-dim Float32 zeros
      pre.query(
        `INSERT INTO memory_keyed VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        "legacy-1",
        "legacyns",
        "note",
        JSON.stringify({ text: "legacy-pre-phase-26 marker" }),
        1,
        Date.now(),
        Date.now(),
        JSON.stringify([]),
      )
      pre.query(
        `INSERT INTO memory_vectors VALUES (?,?,?,?,?,?)`,
      ).run(
        "legacy-1",
        "legacyns",
        fakeEmbedding,
        8,
        "legacy-pre-phase-26 marker",
        Date.now(),
      )
      pre.close()

      // Now open via SqliteVectorBackend (MIGRATION runs, backfill should
      // populate memory_fts for legacy-1).
      const fileLayer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      const ids = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            const arr = yield* Stream.runCollect(
              b.search({
                queryText: "legacy-pre-phase-26 marker",
                mode: "hybrid",
                namespace: "legacyns",
                topK: 5,
              }),
            )
            return Array.from(arr).map((r) => r.record.id)
          }),
        ).pipe(Effect.provide(fileLayer)),
      )
      expect(ids).toContain("legacy-1")
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  // ───────────────────────── Phase 26 follow-up ────────────────────────
  // Atomicity: put() embeds FIRST, then writes (keyed + vec) inside a single
  // BEGIN IMMEDIATE transaction wrapped in Effect.uninterruptible. A failed
  // embed must leave the DB completely untouched — no half-state.

  it("Scenario 7j: HNSW backfill repopulates on reopen when v-table is empty", async () => {
    // Regression for the memory-only-HNSW-after-restart failure mode
    // (vectorlite without `index_file_path` keeps schema across restarts
    // but wipes the in-memory graph). Prior to the fix, the backfill was
    // gated on `hnswExisted` (schema presence in sqlite_master), so any
    // record written in a previous process was silently invisible to
    // vec search after restart — hybrid degraded to BM25-only and the
    // RRF score collapsed to 1/(60+1) ≈ 0.0164.
    //
    // This test only runs when vectorlite is actually wired up on the
    // machine; if init failed (no extension), naive cosine takes the
    // search path and the bug doesn't apply.
    const initMod = await import("../src/backends/vectorlite-init.js")
    const probe = initMod.initVectorlite()
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.log(`[hnsw-reopen] skipping — vectorlite unavailable: ${probe.reason}`)
      return
    }

    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-hnsw-reopen-"))
    const dbPath = path.join(tmp, "vectors.db")

    try {
      // Phase 1: open backend, insert records, close. The HNSW v-table
      // gets populated via the AFTER INSERT trigger in this process.
      const layer1 = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            for (let i = 0; i < 3; i++) {
              yield* b.put(
                makeRecord({
                  id: `restart-${i}`,
                  namespace: "rs",
                  kind: "note",
                  content: { text: `payload ${i} keyword echo` },
                }),
              )
            }
          }),
        ).pipe(Effect.provide(layer1)),
      )

      // Phase 2: simulate the post-restart state. The v-table SCHEMA
      // persists in sqlite_master but the in-memory HNSW graph does not.
      // We model that by opening the file directly and DROPping +
      // recreating the v-table (without triggers being available to
      // re-populate). The next backend boot must detect the emptiness
      // and backfill from memory_vectors.
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          run: (sql: string) => void
          query: (sql: string) => {
            get: () => unknown
            all: (...p: unknown[]) => unknown[]
            run: (...p: unknown[]) => { changes: number }
          }
          loadExtension: (p: string) => void
          close: () => void
        }
      }
      const direct = new bunSqlite.Database(dbPath)
      direct.loadExtension(probe.path)
      // Drop triggers + v-table to clear the in-memory HNSW state, then
      // recreate empty (matching the post-restart situation: schema
      // present, graph empty, triggers also re-created by backend init).
      direct.run("DROP TRIGGER IF EXISTS memory_vectors_hnsw_ai")
      direct.run("DROP TRIGGER IF EXISTS memory_vectors_hnsw_ad")
      direct.run("DROP TRIGGER IF EXISTS memory_vectors_hnsw_au")
      direct.run("DROP TABLE IF EXISTS memory_vectors_hnsw")
      // Match StubEmbedderLayer's dimension (64) — see core embedder.ts.
      direct.run(
        `CREATE VIRTUAL TABLE memory_vectors_hnsw
           USING vectorlite(embedding float32[64], hnsw(max_elements=100000))`,
      )
      // Sanity: v-table is empty.
      const sample = direct
        .query(`SELECT embedding FROM memory_vectors LIMIT 1`)
        .get() as { embedding: Uint8Array } | null
      if (sample) {
        const hits = direct
          .query(
            `SELECT rowid FROM memory_vectors_hnsw
              WHERE knn_search(embedding, knn_param(?, 1))`,
          )
          .all(sample.embedding) as Array<{ rowid: number }>
        expect(hits.length).toBe(0)
      }
      direct.close()

      // Phase 3: reopen via SqliteVectorBackend. The new emptiness-aware
      // backfill must populate HNSW so vec search recalls all 3 rows.
      const layer2 = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      const ids = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            const arr = yield* Stream.runCollect(
              b.search({
                queryText: "payload 0 keyword echo",
                namespace: "rs",
                topK: 10,
                mode: "vec",
              }),
            )
            return Array.from(arr).map((r) => r.record.id).sort()
          }),
        ).pipe(Effect.provide(layer2)),
      )
      expect(ids).toEqual(["restart-0", "restart-1", "restart-2"])
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it("Scenario 7k: HNSW v-table persists across connection close via sidecar file", async () => {
    // Phase 27e: with index_file_path, vectorlite writes the graph to disk
    // on db.close() and loads it on the next open — no backfill required.
    // This scenario asserts the persistence contract: insert N records,
    // close, reopen WITHOUT clearing the v-table, and verify
    // `backfillHnswIfEmpty` returns false on reopen (probe finds rows
    // already there). Pre-Phase-27e this would have returned true on
    // every reopen because the in-memory graph was wiped.
    const initMod = await import("../src/backends/vectorlite-init.js")
    const probe = initMod.initVectorlite()
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.log(`[hnsw-persist] skipping — vectorlite unavailable: ${probe.reason}`)
      return
    }

    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-hnsw-persist-"))
    const dbPath = path.join(tmp, "vectors.db")
    const sidecar = `${dbPath}.hnsw.bin`

    try {
      // Phase 1: open + populate + close. The finalizer runs db.close(),
      // which makes vectorlite flush the HNSW graph to the sidecar.
      const layer1 = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            for (let i = 0; i < 3; i++) {
              yield* b.put(
                makeRecord({
                  id: `persist-${i}`,
                  namespace: "ps",
                  kind: "note",
                  content: { text: `payload ${i} sidecar persistence` },
                }),
              )
            }
          }),
        ).pipe(Effect.provide(layer1)),
      )

      // The sidecar must now exist and have non-zero size.
      expect(fs.existsSync(sidecar)).toBe(true)
      expect(fs.statSync(sidecar).size).toBeGreaterThan(0)
      // Permissions tightened to owner-only.
      expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600)

      // Phase 2: open a direct connection, load vectorlite, and probe the
      // v-table. With persistence active, the v-table should be populated
      // immediately — no backfill yet.
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          run: (sql: string) => void
          query: (sql: string) => {
            get: (...p: unknown[]) => unknown
            all: (...p: unknown[]) => unknown[]
            run: (...p: unknown[]) => { changes: number }
          }
          loadExtension: (p: string) => void
          close: () => void
        }
      }
      const direct = new bunSqlite.Database(dbPath)
      direct.loadExtension(probe.path)
      const sample = direct
        .query(`SELECT embedding FROM memory_vectors LIMIT 1`)
        .get() as { embedding: Uint8Array } | null
      if (sample == null) throw new Error("no source rows")
      const hits = direct
        .query(
          `SELECT rowid FROM memory_vectors_hnsw
            WHERE knn_search(embedding, knn_param(?, 10))`,
        )
        .all(sample.embedding) as Array<{ rowid: number }>
      // The persisted graph round-tripped — all 3 rows visible BEFORE the
      // backend's own backfill could re-run.
      expect(hits.length).toBe(3)
      direct.close()

      // Phase 3: reopen via the backend. Vec search must work directly.
      const layer2 = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      const ids = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            const arr = yield* Stream.runCollect(
              b.search({
                queryText: "payload 0 sidecar persistence",
                namespace: "ps",
                topK: 10,
                mode: "vec",
              }),
            )
            return Array.from(arr).map((r) => r.record.id).sort()
          }),
        ).pipe(Effect.provide(layer2)),
      )
      expect(ids).toEqual(["persist-0", "persist-1", "persist-2"])
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it("Scenario 7l: migration drops a legacy memory-only v-table and recreates with sidecar", async () => {
    // Phase 27e: existing DBs in the wild have a memory-only v-table
    // (created prior to the sidecar fix). On first boot under the new
    // code, the existingMatches() check must detect the missing path,
    // drop the legacy v-table, recreate with sidecar, and backfill from
    // memory_vectors. We assert the sidecar materialises and the
    // memory_vectors_hnsw entry in sqlite_master now mentions the path.
    const initMod = await import("../src/backends/vectorlite-init.js")
    const probe = initMod.initVectorlite()
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.log(`[hnsw-migrate] skipping — vectorlite unavailable: ${probe.reason}`)
      return
    }

    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-hnsw-migrate-"))
    const dbPath = path.join(tmp, "vectors.db")
    const sidecar = `${dbPath}.hnsw.bin`

    try {
      // Build a "pre-sidecar" DB: open via backend, then drop+recreate the
      // v-table without the path so it matches what's on disk for legacy
      // installs. (We rely on the backend to put memory_vectors rows
      // first, then mutate the v-table behind its back.)
      const layerSeed = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            for (let i = 0; i < 2; i++) {
              yield* b.put(
                makeRecord({
                  id: `legacy-${i}`,
                  namespace: "lg",
                  kind: "note",
                  content: { text: `legacy ${i} pre-sidecar marker` },
                }),
              )
            }
          }),
        ).pipe(Effect.provide(layerSeed)),
      )

      // Remove the sidecar we just created and rewrite the v-table as
      // memory-only — mimicking a legacy on-disk DB.
      try {
        fs.unlinkSync(sidecar)
      } catch {
        /* ignore */
      }
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          run: (sql: string) => void
          query: (sql: string) => { get: () => unknown }
          loadExtension: (p: string) => void
          close: () => void
        }
      }
      const direct = new bunSqlite.Database(dbPath)
      direct.loadExtension(probe.path)
      direct.run("DROP TRIGGER IF EXISTS memory_vectors_hnsw_ai")
      direct.run("DROP TRIGGER IF EXISTS memory_vectors_hnsw_ad")
      direct.run("DROP TRIGGER IF EXISTS memory_vectors_hnsw_au")
      direct.run("DROP TABLE IF EXISTS memory_vectors_hnsw")
      direct.run(
        `CREATE VIRTUAL TABLE memory_vectors_hnsw
           USING vectorlite(embedding float32[64], hnsw(max_elements=100000))`,
      )
      direct.close()
      expect(fs.existsSync(sidecar)).toBe(false)

      // Now reopen via the backend — migration must drop+recreate with
      // the sidecar, backfill, and search must recall both legacy rows.
      const layerMigrate = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      const ids = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            const arr = yield* Stream.runCollect(
              b.search({
                queryText: "legacy 0 pre-sidecar marker",
                namespace: "lg",
                topK: 10,
                mode: "vec",
              }),
            )
            return Array.from(arr).map((r) => r.record.id).sort()
          }),
        ).pipe(Effect.provide(layerMigrate)),
      )
      expect(ids).toEqual(["legacy-0", "legacy-1"])

      // Sidecar should now exist with the migrated graph.
      expect(fs.existsSync(sidecar)).toBe(true)
      expect(fs.statSync(sidecar).size).toBeGreaterThan(0)
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it("Scenario 7m: corrupted sidecar is discarded and rebuilt from memory_vectors", async () => {
    // Phase 27e corruption-recovery guarantee. If the sidecar is
    // truncated or partially flushed (e.g. process killed -9 mid-close),
    // vectorlite's CREATE throws when loading the file. The backend
    // catches, calls discardSidecar, retries CREATE, and falls through
    // to backfillHnswIfEmpty — so the canonical source of truth
    // (`memory_vectors`) regenerates the graph rather than the backend
    // silently degrading to BM25-only.
    const initMod = await import("../src/backends/vectorlite-init.js")
    const probe = initMod.initVectorlite()
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.log(`[hnsw-corrupt] skipping — vectorlite unavailable: ${probe.reason}`)
      return
    }

    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "luna-hnsw-corrupt-"))
    const dbPath = path.join(tmp, "vectors.db")
    const sidecar = `${dbPath}.hnsw.bin`

    try {
      // Phase 1: populate.
      const layer1 = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            for (let i = 0; i < 3; i++) {
              yield* b.put(
                makeRecord({
                  id: `corrupt-${i}`,
                  namespace: "cor",
                  kind: "note",
                  content: { text: `recovery ${i} marker` },
                }),
              )
            }
          }),
        ).pipe(Effect.provide(layer1)),
      )
      expect(fs.existsSync(sidecar)).toBe(true)
      const originalSize = fs.statSync(sidecar).size

      // Phase 2: corrupt the sidecar by overwriting it with garbage bytes.
      fs.writeFileSync(sidecar, Buffer.from([0xff, 0x00, 0xde, 0xad, 0xbe, 0xef]))
      expect(fs.statSync(sidecar).size).toBeLessThan(originalSize)

      // Phase 3: reopen. The backend must recover.
      const layer2 = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      const ids = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            const arr = yield* Stream.runCollect(
              b.search({
                queryText: "recovery 0 marker",
                namespace: "cor",
                topK: 10,
                mode: "vec",
              }),
            )
            return Array.from(arr).map((r) => r.record.id).sort()
          }),
        ).pipe(Effect.provide(layer2)),
      )
      expect(ids).toEqual(["corrupt-0", "corrupt-1", "corrupt-2"])

      // After recovery the sidecar should have been rebuilt — size back
      // to non-trivial.
      expect(fs.existsSync(sidecar)).toBe(true)
      expect(fs.statSync(sidecar).size).toBeGreaterThan(100)
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

      it("Atomicity #1: embed failure leaves no keyed row (put fails before any DB write)", async () => {
    const FailEmbedderLayer = Layer.succeed(EmbedderService, {
      provider: "fail",
      model: "fail",
      dimension: 64,
      embeddingFormat: "memory-note-v1",
      embed: () =>
        Effect.fail(
          new EmbedderError({
            provider: "fail",
            op: "embed",
            cause: new Error("forced embedder failure"),
          }),
        ),
    })
    const failLayer = Layer.provideMerge(
      SqliteVectorBackend.fromPath(":memory:"),
      Layer.merge(FailEmbedderLayer, LunaSqliteBootstrapLive),
    )
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const b = yield* SqliteVectorBackend
          const result = yield* Effect.either(
            b.put(
              makeRecord({
                id: "atomic-1",
                namespace: "atom",
                kind: "note",
                content: { text: "should never persist" },
              }),
            ),
          )
          const fetched = yield* b.get("atomic-1")
          return { failed: result._tag === "Left", fetched }
        }),
      ).pipe(Effect.provide(failLayer)),
    )
    expect(out.failed).toBe(true)
    // Critical: keyed row MUST NOT exist (embed failed before any DB write).
    expect(out.fetched).toBeNull()
  })

  it("Atomicity #2: failed re-put preserves prior keyed + vec + FTS rows", async () => {
    // Build a "flaky" embedder layer: succeeds for the first put, fails for
    // the second. Use a closure-scoped counter inside Layer.effect.
    // Fails ONLY for embed calls whose text contains the poison marker. This
    // way put() #1 and any search() embeds work fine; only the second put()
    // (which carries the poison text) fails — exactly the scenario we want.
    // Poison marker only present in the put() text, not in any search query.
    const POISON = "ZZZ-POISON-MARKER-INTERNAL-ONLY"
    const FlakyEmbedderLayer = Layer.succeed(EmbedderService, {
      provider: "flaky",
      model: "flaky",
      dimension: 64,
      embeddingFormat: "memory-note-v1",
      embed: (text: string) =>
        Effect.suspend(() => {
          if (text.includes(POISON)) {
            return Effect.fail(
              new EmbedderError({
                provider: "flaky",
                op: "embed",
                cause: new Error("poisoned text rejected"),
              }),
            )
          }
          // Deterministic lexical-sketch vector.
          const v = new Float32Array(64)
          for (let i = 0; i < text.length; i++) {
            v[text.charCodeAt(i) % 64]! += 1
          }
          let n = 0
          for (let i = 0; i < 64; i++) n += v[i]! * v[i]!
          n = Math.sqrt(n) || 1
          for (let i = 0; i < 64; i++) v[i] = v[i]! / n
          return Effect.succeed(v)
        }),
    })
    const flakyLayer = Layer.provideMerge(
      SqliteVectorBackend.fromPath(":memory:"),
      Layer.merge(FlakyEmbedderLayer, LunaSqliteBootstrapLive),
    )
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const b = yield* SqliteVectorBackend
          // First put — succeeds.
          yield* b.put(
            makeRecord({
              id: "swap",
              namespace: "atom2",
              kind: "note",
              content: { text: "original-uniqtoken-aa11" },
            }),
          )
          const beforeSearch = yield* Stream.runCollect(
            b.search({
              queryText: "original-uniqtoken-aa11",
              mode: "hybrid",
              namespace: "atom2",
              topK: 5,
            }),
          )
          // Second put with SAME id — embed fails, txn must roll back.
          const result = yield* Effect.either(
            b.put(
              makeRecord({
                id: "swap",
                namespace: "atom2",
                kind: "note",
                content: { text: "rewrite-should-fail-bb22 " + POISON },
              }),
            ),
          )
          const fetched = yield* b.get("swap")
          // Hybrid search by ORIGINAL token — must still find the row, proving
          // FTS + vec + keyed rows survived the failed re-put intact.
          const afterSearch = yield* Stream.runCollect(
            b.search({
              queryText: "original-uniqtoken-aa11",
              mode: "hybrid",
              namespace: "atom2",
              topK: 5,
            }),
          )
          return {
            beforeIds: Array.from(beforeSearch).map((r) => r.record.id),
            failed: result._tag === "Left",
            fetched,
            afterIds: Array.from(afterSearch).map((r) => r.record.id),
          }
        }),
      ).pipe(Effect.provide(flakyLayer)),
    )
    expect(out.beforeIds).toContain("swap")
    expect(out.failed).toBe(true)
    // Original keyed row content survives unchanged.
    expect(out.fetched).not.toBeNull()
    expect((out.fetched!.content as { text: string }).text).toBe(
      "original-uniqtoken-aa11",
    )
    // FTS still indexed under the original token (proves the FTS row was
    // not rewritten — the AFTER DELETE trigger from the failed re-put would
    // have nuked the FTS row if the txn weren't rolled back).
    expect(out.afterIds).toContain("swap")
  })

  it("Atomicity #3: dimension-mismatch failure is treated like embed failure (no DB write)", async () => {
    const WrongDimEmbedderLayer = Layer.succeed(EmbedderService, {
      provider: "wrongdim",
      model: "wrongdim",
      dimension: 64, // declared
      embeddingFormat: "memory-note-v1",
      embed: () => Effect.succeed(new Float32Array(8)), // returns 8 ≠ 64
    })
    const wrongLayer = Layer.provideMerge(
      SqliteVectorBackend.fromPath(":memory:"),
      Layer.merge(WrongDimEmbedderLayer, LunaSqliteBootstrapLive),
    )
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const b = yield* SqliteVectorBackend
          const result = yield* Effect.either(
            b.put(
              makeRecord({
                id: "wrong-dim",
                namespace: "wd",
                kind: "note",
                content: { text: "won't persist" },
              }),
            ),
          )
          const fetched = yield* b.get("wrong-dim")
          return { failed: result._tag === "Left", fetched }
        }),
      ).pipe(Effect.provide(wrongLayer)),
    )
    expect(out.failed).toBe(true)
    expect(out.fetched).toBeNull()
  })

  // ───────────────────────── Phase 27: Vectorlite HNSW ─────────────────
  // Active path checks. These run under `bun test` (the bun:sqlite gate),
  // and rely on Vectorlite loading successfully on this machine. If the
  // extension isn't installed (e.g. Homebrew sqlite missing), the tests
  // skipif via the same hasBunSqlite gate; the graceful-fallback case is
  // covered separately via LUNA_DISABLE_VECTORLITE.

  it("HNSW #1: memory_vectors_hnsw exists and gets a row per put-with-text", async () => {
    // Use the ESM `import("bun:sqlite" as string)` shape used elsewhere in
    // this file; that lets us peek at the underlying tables via raw SQL.
    const out = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        for (let i = 0; i < 3; i++) {
          yield* b.put(
            makeRecord({
              id: `hnsw-${i}`,
              namespace: "hn",
              kind: "note",
              content: { text: `entry ${i} hnsw test` },
            }),
          )
        }
        // One keyed-only record (no text) — must NOT appear in HNSW.
        yield* b.put(
          makeRecord({
            id: "hnsw-blob",
            namespace: "hn",
            kind: "blob",
            content: { foo: "bar" },
          }),
        )
        return yield* Stream.runCollect(
          b.search({ queryText: "entry 0 hnsw test", namespace: "hn", topK: 5 }),
        )
      }),
    )
    const arr = Array.from(out)
    // Three text-bearing records visible to vector search; the blob isn't.
    expect(arr.length).toBe(3)
    expect(arr.find((r) => r.record.id === "hnsw-blob")).toBeUndefined()
  })

  it("Performance #1: HNSW search p95 < 50ms at N=1000 (skipif HNSW unavailable)", async () => {
    // Probe whether vectorlite is wired up on this machine WITHOUT resetting
    // the cache (resetting after a Database has been opened would fail
    // setCustomSQLite). If init never succeeded in this process, skip — the
    // graceful fallback path is covered by HNSW #2.
    const initMod = await import("../src/backends/vectorlite-init.js")
    const probe = initMod.initVectorlite()
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.log(`[perf] skipping — vectorlite unavailable: ${probe.reason}`)
      return
    }

    const N = 1000
    const QUERIES = 30
    const latencies = await run(
      Effect.gen(function* () {
        const b = yield* SqliteVectorBackend
        for (let i = 0; i < N; i++) {
          yield* b.put(
            makeRecord({
              id: `perf-${i}`,
              namespace: "perf",
              kind: "note",
              content: {
                text: `record ${i} payload alpha beta gamma ${i % 17} delta`,
              },
            }),
          )
        }
        const lats: number[] = []
        for (let q = 0; q < QUERIES; q++) {
          const t0 = performance.now()
          yield* Stream.runCollect(
            b.search({
              queryText: `record ${q * 7} payload`,
              namespace: "perf",
              topK: 10,
            }),
          )
          lats.push(performance.now() - t0)
        }
        return lats
      }),
    )
    latencies.sort((a, b) => a - b)
    const p50 = latencies[Math.floor(latencies.length * 0.5)]!
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!
    // eslint-disable-next-line no-console
    console.log(`[perf] N=${N} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`)
    expect(p95).toBeLessThan(50)
  }, 30_000)

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

  // Last in the describe so resetting the init cache cannot disturb earlier
  // tests' Database state. Resetting after a Database has been opened in this
  // process means a subsequent setCustomSQLite would fail; that's exactly the
  // graceful-fallback path we're testing.
  it("HNSW #2 (graceful fallback): LUNA_DISABLE_VECTORLITE forces naive path", async () => {
    const initMod = await import("../src/backends/vectorlite-init.js")
    initMod._resetVectorliteInitForTests()
    const prev = process.env.LUNA_DISABLE_VECTORLITE
    process.env.LUNA_DISABLE_VECTORLITE = "1"
    try {
      const fallbackLayer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(":memory:"),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      const arr = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            yield* b.put(
              makeRecord({
                id: "fb-1",
                namespace: "fb",
                kind: "note",
                content: { text: "naive cosine still works" },
              }),
            )
            yield* b.put(
              makeRecord({
                id: "fb-2",
                namespace: "fb",
                kind: "note",
                content: { text: "submarines and torpedoes" },
              }),
            )
            const results = yield* Stream.runCollect(
              b.search({ queryText: "naive cosine", namespace: "fb", topK: 5 }),
            )
            return Array.from(results).map((r) => r.record.id)
          }),
        ).pipe(Effect.provide(fallbackLayer)),
      )
      expect(arr).toContain("fb-1")
      expect(arr[0]).toBe("fb-1")
    } finally {
      if (prev === undefined) delete process.env.LUNA_DISABLE_VECTORLITE
      else process.env.LUNA_DISABLE_VECTORLITE = prev
      initMod._resetVectorliteInitForTests()
    }
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
