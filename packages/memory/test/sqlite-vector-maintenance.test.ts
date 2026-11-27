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
import { Effect, Layer, Stream } from "effect"
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
        extensionAvailable: true,
        // Phase 27d: status reports actual HNSW population. getHnswStatus
        // backfills its fresh maintenance connection's graph, so the v-table
        // mirrors the 1 row in memory_vectors.
        indexedCount: 1,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("status + reembed survive a failing per-connection extension load (HNSW-era DB)", async () => {
    // vlInit.ok can be true while the per-connection loadExtension() throws
    // (e.g. Homebrew sqlite ABI skew vs the vectorlite prebuilt on macOS).
    // openDb() called loadExtension unguarded, so the throw rejected the
    // whole status/reembed Effect (op status.open / reembed.open) even
    // though getHnswStatus is designed to report indexedCount null when
    // the extension is not loaded. Regression test: seed one row via the
    // backend (plants the HNSW v-table + sync triggers), stub
    // loadExtension to throw, and assert status + a real reembed still
    // succeed — the mutating reembed drops the stale sync triggers up
    // front (status and dry-run leave them alone; see the live-backend
    // test below), mirroring the backend's best-effort load path. (The
    // v-table itself cannot be dropped without the module registered, so
    // it stays behind as inert schema: present stays true, indexedCount
    // reports null, and the backend recreates the missing triggers on its
    // next open.)
    const initMod = await import("../src/backends/vectorlite-init.js")
    const probe = initMod.initVectorlite()
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.log(
        `[maintenance-load-fail] skipping — vectorlite unavailable: ${probe.reason}`,
      )
      return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-maint-load-fail-"))
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
                id: "maint-1",
                namespace: "notes",
                kind: "note",
                content: { text: "maintenance load failure row" },
              }),
            )
            return b.hnswEnabled
          }).pipe(Effect.provide(layer)),
        ),
      )
      if (!hnswEnabled) return

      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => unknown
      }
      const proto = (
        bunSqlite.Database as unknown as {
          prototype: { loadExtension: (p: string) => void }
        }
      ).prototype
      const origLoad = proto.loadExtension
      proto.loadExtension = () => {
        throw new Error("simulated loadExtension failure")
      }
      try {
        const status = await Effect.runPromise(
          getMemoryVectorStatus({ dbPath, embedder: replacementStub }),
        )
        expect(status.totalVectors).toBe(1)
        expect(status.staleVectors).toBe(1)
        // The v-table row survives (it cannot be dropped without the
        // module), but its probe degrades to null instead of crashing.
        expect(status.hnsw.present).toBe(true)
        expect(status.hnsw.indexedCount).toBeNull()

        const result = await Effect.runPromise(
          reembedMemoryVectors({
            dbPath,
            embedder: replacementStub,
            dryRun: false,
          }),
        )
        expect(result.reembedded).toBe(1)
        const after = await Effect.runPromise(
          getMemoryVectorStatus({ dbPath, embedder: replacementStub }),
        )
        expect(after.staleVectors).toBe(0)
      } finally {
        proto.loadExtension = origLoad
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a degraded status call leaves the shared HNSW triggers intact for a live backend", async () => {
    // Devin review on #843: openDb dropped the shared sync triggers even
    // for a read-only status call, so a healthy backend running against the
    // same file kept writing while nothing entered its HNSW graph — new
    // memories went missing from vector search until the backend restarted
    // (triggers are only recreated at open). Status and dry-run reembed
    // never write memory_vectors, so they must not mutate shared schema;
    // only the mutating reembed path drops stale triggers. Regression test:
    // keep a backend open through a degraded status call, then save a new
    // row through it and vector-search for it.
    const initMod = await import("../src/backends/vectorlite-init.js")
    const probe = initMod.initVectorlite()
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.log(
        `[maintenance-load-fail] skipping — vectorlite unavailable: ${probe.reason}`,
      )
      return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "luna-maint-live-"))
    const dbPath = path.join(dir, "memory.db")
    try {
      const layer = Layer.provideMerge(
        SqliteVectorBackend.fromPath(dbPath),
        Layer.merge(StubEmbedderLayer, LunaSqliteBootstrapLive),
      )
      // Dynamic import up front (a gen body cannot await): the stub is
      // installed inside the scoped effect, only AFTER the backend opened.
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          query: (sql: string) => {
            all: () => Array<{ name: string }>
          }
          close: () => void
        }
      }
      const proto = (
        bunSqlite.Database as unknown as {
          prototype: { loadExtension: (p: string) => void }
        }
      ).prototype
      const origLoad = proto.loadExtension
      const found = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const b = yield* SqliteVectorBackend
            yield* b.put(
              makeRecord({
                id: "live-1",
                namespace: "notes",
                kind: "note",
                content: { text: "live backend first row" },
              }),
            )
            if (!b.hnswEnabled) return false
            // Stub loadExtension only AFTER the backend opened: the stub
            // simulates a CLI process whose per-connection load fails while
            // this backend stays healthy on the same file.
            try {
              proto.loadExtension = () => {
                throw new Error("simulated loadExtension failure")
              }
              const status = yield* getMemoryVectorStatus({
                dbPath,
                embedder: replacementStub,
              })
              expect(status.totalVectors).toBe(1)
              expect(status.hnsw.present).toBe(true)
              expect(status.hnsw.indexedCount).toBeNull()
              // The shared sync triggers must survive the degraded call.
              const checkDb = new bunSqlite.Database(dbPath)
              try {
                const triggers = checkDb
                  .query(
                    `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_vectors_hnsw_%'`,
                  )
                  .all()
                  .map((row) => row.name)
                  .sort()
                expect(triggers).toEqual([
                  "memory_vectors_hnsw_ad",
                  "memory_vectors_hnsw_ai",
                  "memory_vectors_hnsw_au",
                ])
              } finally {
                checkDb.close()
              }
              // The live backend's next write must still enter the graph.
              yield* b.put(
                makeRecord({
                  id: "live-2",
                  namespace: "notes",
                  kind: "note",
                  content: { text: "live backend second row" },
                }),
              )
              const hits = yield* Stream.runCollect(
                b.search({
                  queryText: "live backend second row",
                  mode: "vec",
                  topK: 5,
                }),
              )
              return Array.from(hits).some(
                (hit) => hit.record.id === "live-2",
              )
            } finally {
              proto.loadExtension = origLoad
            }
          }).pipe(Effect.provide(layer)),
        ),
      )
      expect(found).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("degraded status reports the extension as unavailable when the table dimension mismatches", async () => {
    // Devin review on #843: with a stale 64-dim HNSW table and a 768-dim
    // embedder, the CLI preflight blocked reembed (even --dry-run) because
    // the status could not tell an inert persisted table from an active
    // index. The status must report extension availability separately so
    // the preflight can let the degraded path proceed.
    const initMod = await import("../src/backends/vectorlite-init.js")
    const probe = initMod.initVectorlite()
    if (!probe.ok) {
      // eslint-disable-next-line no-console
      console.log(
        `[maintenance-load-fail] skipping — vectorlite unavailable: ${probe.reason}`,
      )
      return
    }
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "luna-maint-ext-avail-"),
    )
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
                id: "avail-1",
                namespace: "notes",
                kind: "note",
                content: { text: "extension availability row" },
              }),
            )
            return b.hnswEnabled
          }).pipe(Effect.provide(layer)),
        ),
      )
      if (!hnswEnabled) return
      // Healthy connection: the extension loads, so the persisted table is
      // a live (if mismatched) index.
      const healthy = await Effect.runPromise(
        getMemoryVectorStatus({ dbPath, embedder: activeEmbeddingGemma }),
      )
      expect(healthy.hnsw.present).toBe(true)
      expect(healthy.hnsw.dimension).toBe(64)
      expect(healthy.hnsw.compatible).toBe(false)
      expect(healthy.hnsw.extensionAvailable).toBe(true)
      expect(healthy.hnsw.indexedCount).toBeNull()
      // Degraded connection: same table, but the extension cannot load, so
      // the table is inert schema, not an active index.
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => unknown
      }
      const proto = (
        bunSqlite.Database as unknown as {
          prototype: { loadExtension: (p: string) => void }
        }
      ).prototype
      const origLoad = proto.loadExtension
      proto.loadExtension = () => {
        throw new Error("simulated loadExtension failure")
      }
      try {
        const degraded = await Effect.runPromise(
          getMemoryVectorStatus({ dbPath, embedder: activeEmbeddingGemma }),
        )
        expect(degraded.hnsw.present).toBe(true)
        expect(degraded.hnsw.dimension).toBe(64)
        expect(degraded.hnsw.compatible).toBe(false)
        expect(degraded.hnsw.extensionAvailable).toBe(false)
        expect(degraded.hnsw.indexedCount).toBeNull()
      } finally {
        proto.loadExtension = origLoad
      }
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

  it("reembed backfill skips a row deleted since the scan", async () => {
    // Lost-update guard, backfill half, delete race: the missing-vector
    // snapshot is taken up front and the embedding calls are slow, so a
    // concurrent delete() can remove the keyed row between the scan and
    // the row's INSERT. INSERT OR IGNORE does NOT suppress foreign-key
    // violations (SQLite applies OR IGNORE only to UNIQUE/NOT NULL/CHECK
    // constraints), so without a guard the insert raises
    // SQLITE_CONSTRAINT_FOREIGNKEY and the whole reembed Effect fails.
    // The backfill must skip the row instead.
    //
    // Same missing-vector fixture as the concurrent-write test above.
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
                    // Simulate the concurrent deleter: the keyed row is
                    // removed while the reembed is busy embedding the
                    // backfill row.
                    yield* Effect.orDie(b.delete("legacy-1"))
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
        expect.objectContaining({
          id: "legacy-1",
          action: "skipped",
          skipReason: expect.stringContaining("deleted since the scan"),
        }),
      ])
    } finally {
      cleanup()
    }
  })

  it("reembed --limit caps the total rows processed across stale reembed and backfill", async () => {
    // Regression test: --limit is documented as "cap rows processed by
    // reembed" (apps/agent-cli/src/memory.ts), but reembedMemoryVectors
    // applied the limit to the stale list AND again to the missing-vector
    // backfill, so a run could process up to 2x the cap. The backfill
    // only gets the budget the stale rows did not use, in both the
    // dry-run and the mutating path.
    const { dbPath, cleanup } = await makeOldVectorDb()
    try {
      const bunSqlite = (await import("bun:sqlite" as string)) as {
        Database: new (p: string) => {
          run: (sql: string) => void
          query: (sql: string) => {
            run: (...p: unknown[]) => { changes: number }
          }
          close: () => void
        }
      }
      const raw = new bunSqlite.Database(dbPath)
      try {
        // Second stale row (64-dim vector vs the 768-dim active embedder).
        raw
          .query(
            `INSERT INTO memory_keyed
               (id, namespace, kind, content_json, schema_version, created_at, updated_at, tags_json)
             VALUES (?,?,?,?,?,?,?,?)`,
          )
          .run(
            "stale-2",
            "notes",
            "note",
            JSON.stringify({ text: "second stale memory" }),
            1,
            1,
            1,
            JSON.stringify([]),
          )
        raw
          .query(
            `INSERT INTO memory_vectors
               (id, namespace, embedding, dimension, text, ts)
             VALUES (?,?,?,?,?,?)`,
          )
          .run(
            "stale-2",
            "notes",
            float32ToBuffer(new Float32Array(64)),
            64,
            "second stale memory",
            1,
          )
        // Two keyed rows with no vector row at all (embedder-outage shape).
        for (const id of ["missing-1", "missing-2"]) {
          raw
            .query(
              `INSERT INTO memory_keyed
                 (id, namespace, kind, content_json, schema_version, created_at, updated_at, tags_json)
               VALUES (?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              "notes",
              "note",
              JSON.stringify({ text: `${id} memory` }),
              1,
              1,
              1,
              JSON.stringify([]),
            )
        }
      } finally {
        raw.close()
      }

      const dry = await Effect.runPromise(
        reembedMemoryVectors({
          dbPath,
          embedder: activeEmbeddingGemma,
          limit: 2,
          dryRun: true,
        }),
      )
      expect(dry.rows).toHaveLength(2)
      expect(dry.rows.map((row) => row.action)).toEqual([
        "would-reembed",
        "would-reembed",
      ])

      const result = await Effect.runPromise(
        reembedMemoryVectors({
          dbPath,
          embedder: activeEmbeddingGemma,
          limit: 2,
          dryRun: false,
        }),
      )
      expect(result.reembedded).toBe(2)
      expect(result.backfilled).toBe(0)
      expect(result.rows).toHaveLength(2)
    } finally {
      cleanup()
    }
  })
})
