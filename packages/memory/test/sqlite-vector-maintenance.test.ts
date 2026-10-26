/**
 * Operator maintenance checks for sqlite-vector memory databases.
 *
 * These tests create old on-disk DB shapes directly with bun:sqlite, then
 * exercise the audit/re-embed API the `luna memory` CLI uses. They are
 * Bun-gated because the production store is bun:sqlite-backed.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  StubEmbedderLayer,
  makeStubEmbedderLayer,
  float32ToBuffer,
  type EmbedderApi,
} from "@luna/core"
import { SqliteVectorBackend } from "../src/backends/sqlite-vector.js"
import { LunaSqliteBootstrapLive } from "../src/backends/vectorlite-bootstrap.js"
import {
  getMemoryVectorStatus,
  reembedMemoryVectors,
} from "../src/backends/sqlite-vector-maintenance.js"
import { readHnswMeta, writeHnswMeta } from "../src/backends/hnsw-sidecar.js"
import { makeRecord } from "../src/types.js"

const hasBunSqlite = (() => {
  return typeof (process.versions as { bun?: string }).bun === "string"
})()

const d = hasBunSqlite ? describe : describe.skip

const activeEmbeddingGemma: EmbedderApi = {
  provider: "ollama",
  model: "embeddinggemma",
  dimension: 768,
  embeddingFormat: "memory-note-v1",
  embed: () => Effect.succeed(new Float32Array(768)),
}

const replacementStub: EmbedderApi = {
  provider: "replacement",
  model: "replacement",
  dimension: 64,
  embeddingFormat: "memory-note-v1",
  embed: () => Effect.succeed(new Float32Array(64).fill(1 / 8)),
}

async function makeOldVectorDb(): Promise<{
  readonly dbPath: string
  readonly cleanup: () => void
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-old-memory-"))
  const dbPath = path.join(dir, "memory.db")
  const bunSqlite = (await import("bun:sqlite" as string)) as {
    Database: new (p: string) => {
      run: (sql: string) => void
      query: (sql: string) => {
        run: (...p: unknown[]) => { changes: number }
        all: (...p: unknown[]) => unknown[]
      }
      close: () => void
    }
  }
  const db = new bunSqlite.Database(dbPath)
  try {
    db.run(`
      CREATE TABLE memory_keyed (
        id              TEXT PRIMARY KEY,
        namespace       TEXT NOT NULL,
        kind            TEXT NOT NULL,
        content_json    TEXT NOT NULL,
        schema_version  INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        tags_json       TEXT NOT NULL
      );
      CREATE TABLE memory_vectors (
        id          TEXT PRIMARY KEY REFERENCES memory_keyed(id) ON DELETE CASCADE,
        namespace   TEXT NOT NULL,
        embedding   BLOB NOT NULL,
        dimension   INTEGER NOT NULL,
        text        TEXT NOT NULL,
        ts          INTEGER NOT NULL
      );
    `)
    db.query(
      `INSERT INTO memory_keyed
         (id, namespace, kind, content_json, schema_version, created_at, updated_at, tags_json)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      "legacy-1",
      "notes",
      "note",
      JSON.stringify({ text: "legacy stub-vector memory" }),
      1,
      1,
      1,
      JSON.stringify(["fixture"]),
    )
    db.query(
      `INSERT INTO memory_vectors
         (id, namespace, embedding, dimension, text, ts)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      "legacy-1",
      "notes",
      float32ToBuffer(new Float32Array(64)),
      64,
      "legacy stub-vector memory",
      1,
    )
  } finally {
    db.close()
  }

  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

d("sqlite-vector maintenance", () => {
  it("opens an old DB, migrates metadata columns, and reports stale vector identity", async () => {
    const fixture = await makeOldVectorDb()
    try {
      const status = await Effect.runPromise(
        getMemoryVectorStatus({
          dbPath: fixture.dbPath,
          embedder: activeEmbeddingGemma,
        }),
      )

      expect(status.totalVectors).toBe(1)
      expect(status.staleVectors).toBe(1)
      expect(status.groups).toEqual([
        {
          count: 1,
          dimension: 64,
          embeddingProvider: "unknown",
          embeddingModel: "unknown",
          embeddingFormat: "raw-v0",
          compatible: false,
        },
      ])
      expect(status.rows).toEqual([
        expect.objectContaining({
          id: "legacy-1",
          namespace: "notes",
          stale: true,
          reasons: expect.arrayContaining([
            "dimension",
            "embedding_provider",
            "embedding_model",
            "embedding_format",
            "embedding_input_hash",
          ]),
        }),
      ])
    } finally {
      fixture.cleanup()
    }
  })

  it("re-embeds rows in a DB with an existing HNSW table", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-hnsw-reembed-"))
    const dbPath = path.join(dir, "memory.db")
    try {
      const layer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      const hnswEnabled = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            yield* b.put(
              makeRecord({
                id: "hnsw-stale",
                namespace: "notes",
                kind: "note",
                content: { text: "memory row with hnsw trigger" },
              }),
            )
            return b.hnswEnabled
          }).pipe(Effect.provide(layer)),
        ),
      )
      if (!hnswEnabled) return

      const result = await Effect.runPromise(
        reembedMemoryVectors({
          dbPath,
          embedder: replacementStub,
          dryRun: false,
        }),
      )

      expect(result.reembedded).toBe(1)
      const status = await Effect.runPromise(
        getMemoryVectorStatus({ dbPath, embedder: replacementStub }),
      )
      expect(status.staleVectors).toBe(0)
      expect(status.hnsw).toEqual({
        present: true,
        dimension: 64,
        compatible: true,
        // Phase 27d: status reports actual HNSW population. getHnswStatus
        // backfills its fresh maintenance connection's graph, so the v-table
        // mirrors the 1 row in memory_vectors.
        indexedCount: 1,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports HNSW indexedCount for multiple active-dimension rows (not pinned at N=1)", async () => {
    // Guards the N=1 blind spot: a fresh maintenance connection's graph starts
    // empty, so getHnswStatus must backfill and recall ALL active-dimension
    // rows, not a fixed 1.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-hnsw-count-"))
    const dbPath = path.join(dir, "memory.db")
    try {
      const layer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      const hnswEnabled = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            for (let i = 0; i < 3; i++) {
              yield* b.put(
                makeRecord({
                  id: `row-${i}`,
                  namespace: "notes",
                  kind: "note",
                  content: { text: `memory row ${i}` },
                }),
              )
            }
            return b.hnswEnabled
          }).pipe(Effect.provide(layer)),
        ),
      )
      if (!hnswEnabled) return

      const status = await Effect.runPromise(
        // replacementStub is dim 64 — compatible with the float32[64] v-table.
        getMemoryVectorStatus({ dbPath, embedder: replacementStub }),
      )
      expect(status.totalVectors).toBe(3)
      expect(status.hnsw.present).toBe(true)
      expect(status.hnsw.indexedCount).toBe(3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("status invalidates the backend's sidecar provenance record on close", async () => {
    // A maintenance connection rewrites the sidecar from its own graph when it
    // closes, so whatever the backend last vouched for no longer describes the
    // file. The record must be dropped so the next backend open rebuilds.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-hnsw-meta-"))
    const dbPath = path.join(dir, "memory.db")
    try {
      const layer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      // No hnswEnabled gate: the invalidation does not depend on whether
      // vectorlite loaded in this process, only on the derived sidecar path.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            yield* b.put(
              makeRecord({
                id: "meta-1",
                namespace: "notes",
                kind: "note",
                content: { text: "provenance record" },
              }),
            )
          }).pipe(Effect.provide(layer)),
        ),
      )

      const sidecar = `${dbPath}.hnsw.bin`
      writeHnswMeta(sidecar, { dimension: 64, sidecar: "x", source: "y" })
      expect(readHnswMeta(sidecar)).not.toBeNull()

      await Effect.runPromise(
        getMemoryVectorStatus({ dbPath, embedder: replacementStub }),
      )
      expect(readHnswMeta(sidecar)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reembed refreshes the FTS enrichment column from current keyed content", async () => {
    // Guards the rebuild contract: reembedMemoryVectors rebuilds the vector
    // row from the CURRENT keyed content, so the enrichment column (and the
    // FTS index fed by its trigger) must track content.enrichmentPhrases —
    // not keep whatever the row was written with.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-reembed-enrich-"))
    const dbPath = path.join(dir, "memory.db")
    try {
      const layer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            yield* b.put(
              makeRecord({
                id: "enrich-row",
                namespace: "notes",
                kind: "note",
                content: {
                  text: "memory row with enrichment",
                  enrichmentPhrases: ["first-alias"],
                },
              }),
            )
          }).pipe(Effect.provide(layer)),
        ),
      )

      // Out-of-band content edit + stale provider tag: the audit must flag
      // the row, and the reembed must rebuild enrichment from keyed content.
      // Load the extension on the raw connection — the backend's AFTER
      // triggers reference the vectorlite v-table.
      const { initVectorlite } = await import(
        "../src/backends/vectorlite-init.js"
      )
      const vl = initVectorlite()
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          run: (sql: string) => void
          query: (sql: string) => {
            get: (...p: unknown[]) => unknown
            run: (...p: unknown[]) => { changes: number }
          }
          loadExtension: (p: string) => void
          close: () => void
        }
      }
      const raw = new bunSqlite.Database(dbPath)
      try {
        if (vl.ok) raw.loadExtension(vl.path)
        raw.run(
          "UPDATE memory_vectors SET embedding_provider = 'legacy-provider'",
        )
        const keyed = raw
          .query("SELECT content_json FROM memory_keyed WHERE id = 'enrich-row'")
          .get() as { content_json: string }
        const content = JSON.parse(keyed.content_json) as Record<
          string,
          unknown
        >
        content.enrichmentPhrases = ["second-alias"]
        raw
          .query("UPDATE memory_keyed SET content_json = ? WHERE id = 'enrich-row'")
          .run(JSON.stringify(content))
      } finally {
        raw.close()
      }

      const result = await Effect.runPromise(
        reembedMemoryVectors({
          dbPath,
          embedder: replacementStub,
          dryRun: false,
        }),
      )
      expect(result.reembedded).toBe(1)

      const check = new bunSqlite.Database(dbPath)
      try {
        if (vl.ok) check.loadExtension(vl.path)
        const vec = check
          .query("SELECT enrichment FROM memory_vectors WHERE id = 'enrich-row'")
          .get() as { enrichment: string }
        expect(vec.enrichment).toBe("second-alias")
        const ftsNew = check
          .query(
            `SELECT count(*) AS c FROM memory_fts WHERE memory_fts MATCH '"second-alias"'`,
          )
          .get() as { c: number }
        expect(ftsNew.c).toBe(1)
        const ftsOld = check
          .query(
            `SELECT count(*) AS c FROM memory_fts WHERE memory_fts MATCH '"first-alias"'`,
          )
          .get() as { c: number }
        expect(ftsOld.c).toBe(0)
      } finally {
        check.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reembed skips a row whose keyed content changed since the scan", async () => {
    // Lost-update guard: the candidate snapshot is taken up front and the
    // embedding calls are slow, so a concurrent put() can land between the
    // scan and a row's UPDATE. The reembed must not overwrite the fresh
    // vectors with the stale scan snapshot (stale text/embedding/hash with
    // a fresh embedded_at); it must skip the row instead.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-reembed-race-"))
    const dbPath = path.join(dir, "memory.db")
    try {
      const layer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      // The replacement provider makes the row stale; the racing embedder's
      // side effect puts fresh text for the same id mid-run. The embedder
      // closes over the backend so its Effect needs no environment channel.
      const { result, raced } = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            yield* b.put(
              makeRecord({
                id: "race-1",
                namespace: "notes",
                kind: "note",
                content: { text: "stale text" },
              }),
            )
            let raced = false
            const racingEmbedder: EmbedderApi = {
              provider: "replacement",
              model: "replacement",
              dimension: 64,
              embeddingFormat: "memory-note-v1",
              embed: (_input) =>
                Effect.gen(function* () {
                  if (!raced) {
                    raced = true
                    // Simulate the concurrent writer: a fresh put() lands
                    // while the reembed is busy embedding the stale snapshot.
                    yield* Effect.orDie(
                      b.put(
                        makeRecord({
                          id: "race-1",
                          namespace: "notes",
                          kind: "note",
                          content: { text: "concurrent fresh text" },
                        }),
                      ),
                    )
                  }
                  return new Float32Array(64).fill(1 / 8)
                }),
            }
            const result = yield* reembedMemoryVectors({
              dbPath,
              embedder: racingEmbedder,
              dryRun: false,
            })
            return { result, raced }
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(raced).toBe(true)
      expect(result.reembedded).toBe(0)
      expect(result.skipped).toBe(1)
      expect(result.rows).toEqual([
        expect.objectContaining({ id: "race-1", action: "skipped" }),
      ])

      // The fresh put's vectors must survive: no clobber by the stale scan.
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          query: (sql: string) => { get: (...p: unknown[]) => unknown }
          close: () => void
        }
      }
      const check = new bunSqlite.Database(dbPath)
      try {
        const vec = check
          .query("SELECT text FROM memory_vectors WHERE id = 'race-1'")
          .get() as { text: string }
        expect(vec.text).toBe("concurrent fresh text")
      } finally {
        check.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reembed skips a row whose vector metadata changed since the scan (dimension-only rewrite)", async () => {
    // The lost-update guard must also catch a concurrent put() that
    // re-embeds UNCHANGED content with a different model: the keyed fields
    // and the embedding input hash (which covers only
    // namespace/kind/tags/text) are untouched, but dimension/provider/model/
    // format/embedded_at move. Without the metadata comparison the guard
    // misses the rewrite and the stale scan snapshot clobbers the fresh
    // vector with an incompatible dimension.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-reembed-dim-race-"))
    const dbPath = path.join(dir, "memory.db")
    try {
      const layer64 = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      // The racing writer uses a 128-dim model on the same db file.
      const layer128 = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(
          makeStubEmbedderLayer({ dimension: 128 }),
          LunaSqliteBootstrapLive,
        ),
      )
      const { result, raced } = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            yield* b.put(
              makeRecord({
                id: "dim-race-1",
                namespace: "notes",
                kind: "note",
                content: { text: "same text" },
              }),
            )
            let raced = false
            const racingEmbedder: EmbedderApi = {
              provider: "replacement",
              model: "replacement",
              dimension: 64,
              embeddingFormat: "memory-note-v1",
              embed: (_input) =>
                Effect.gen(function* () {
                  if (!raced) {
                    raced = true
                    // Simulate the concurrent writer: a fresh put() of the
                    // SAME content with a different-dimension model lands
                    // while the reembed is busy embedding the stale
                    // snapshot. Keyed fields and the input hash do not move.
                    yield* Effect.orDie(
                      Effect.promise(() =>
                        Effect.runPromise(
                          Effect.scoped(
                            Effect.gen(function* () {
                              const b2 = yield* SqliteVectorBackend
                              yield* b2.put(
                                makeRecord({
                                  id: "dim-race-1",
                                  namespace: "notes",
                                  kind: "note",
                                  content: { text: "same text" },
                                }),
                              )
                            }).pipe(Effect.provide(layer128)),
                          ),
                        ),
                      ),
                    )
                  }
                  return new Float32Array(64).fill(1 / 8)
                }),
            }
            const result = yield* reembedMemoryVectors({
              dbPath,
              embedder: racingEmbedder,
              dryRun: false,
            })
            return { result, raced }
          }).pipe(Effect.provide(layer64)),
        ),
      )
      expect(raced).toBe(true)
      expect(result.reembedded).toBe(0)
      expect(result.skipped).toBe(1)
      expect(result.rows).toEqual([
        expect.objectContaining({ id: "dim-race-1", action: "skipped" }),
      ])

      // The concurrent writer's 128-dim vector must survive: no clobber by
      // the stale 64-dim scan snapshot.
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          query: (sql: string) => { get: (...p: unknown[]) => unknown }
          close: () => void
        }
      }
      const check = new bunSqlite.Database(dbPath)
      try {
        const vec = check
          .query(
            "SELECT dimension, embedding_model FROM memory_vectors WHERE id = 'dim-race-1'",
          )
          .get() as { dimension: number; embedding_model: string }
        expect(vec.dimension).toBe(128)
        expect(vec.embedding_model).toBe("stub")
      } finally {
        check.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reembed backfill skips a row whose vector was written since the scan", async () => {
    // Lost-update guard, backfill half: the missing-vector snapshot is
    // taken up front and the embedding calls are slow, so a concurrent
    // put() can land between the scan and a row's INSERT. The plain
    // INSERT then hits UNIQUE constraint failed and the whole reembed
    // Effect fails. The backfill must skip the row instead: the
    // concurrent writer already stored the correct vector.
    //
    // Plant the missing-vector shape with the old-schema fixture (a
    // keyed row with no vector row, as left by an embedder outage or a
    // pre-extraction write). The vector row is deleted BEFORE any
    // backend connection opens, so no connection holds a stale in-memory
    // HNSW graph for the row.
    const { dbPath, cleanup } = await makeOldVectorDb()
    try {
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          run: (sql: string) => void
          query: (sql: string) => {
            all: (...p: unknown[]) => unknown[]
          }
          close: () => void
        }
      }
      const raw = new bunSqlite.Database(dbPath)
      try {
        raw.run("DELETE FROM memory_vectors WHERE id = 'legacy-1'")
      } finally {
        raw.close()
      }
      const layer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      const { result, raced } = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            let raced = false
            const racingEmbedder: EmbedderApi = {
              provider: "replacement",
              model: "replacement",
              dimension: 64,
              embeddingFormat: "memory-note-v1",
              embed: (_input) =>
                Effect.gen(function* () {
                  if (!raced) {
                    raced = true
                    // Simulate the concurrent writer: a fresh put() lands
                    // while the reembed is busy embedding the backfill row.
                    yield* Effect.orDie(
                      b.put(
                        makeRecord({
                          id: "legacy-1",
                          namespace: "notes",
                          kind: "note",
                          content: { text: "concurrent fresh text" },
                        }),
                      ),
                    )
                  }
                  return new Float32Array(64).fill(1 / 8)
                }),
            }
            const result = yield* reembedMemoryVectors({
              dbPath,
              embedder: racingEmbedder,
              dryRun: false,
            })
            return { result, raced }
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(raced).toBe(true)
      expect(result.backfilled).toBe(0)
      expect(result.skipped).toBe(1)
      expect(result.rows).toEqual([
        expect.objectContaining({ id: "legacy-1", action: "skipped" }),
      ])

      // The concurrent writer's vector must survive: no clobber by the
      // stale scan snapshot, and no duplicate row.
      const check = new bunSqlite.Database(dbPath)
      try {
        const vecs = check
          .query(
            "SELECT text FROM memory_vectors WHERE id = 'legacy-1'",
          )
          .all() as { text: string }[]
        expect(vecs).toHaveLength(1)
        expect(vecs[0]?.text).toBe("concurrent fresh text")
      } finally {
        check.close()
      }
    } finally {
      cleanup()
    }
  })
})
