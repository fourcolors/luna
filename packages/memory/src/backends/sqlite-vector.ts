/**
 * SqliteVectorBackend — sqlite-backed memory backend with vector search.
 *
 * Phase 25 (advisor verdict ⚠️ MODIFY):
 *   - Owns BOTH `memory_keyed` and `memory_vectors` tables in one DB.
 *   - Auto-embeds on `put()` ONLY when `rec.content.text` is a string.
 *     Records without text are keyed-only (no row in memory_vectors).
 *   - Naive ranking: SELECT all vectors → JS cosine → topK in-process.
 *     Sterling's `sqlite-vec-scaling` skill puts the practical wall at
 *     ~1k records / 372ms p95 for sqlite-vec; we expect parity for naive.
 *     Phase 2 trigger: >100ms @ 5k → swap to sqlite-vec or migrate to
 *     PGlite+pgvector HNSW (372× speedup at N=1k per Sterling's bench).
 *   - search() honors namespace filter via SQL `WHERE namespace = ?`.
 *   - search() supports `mode: "vec" | "hybrid"`. `"hybrid"` (Phase 26)
 *     fuses BM25 (FTS5 over `text`) with cosine vector ranking via
 *     Reciprocal Rank Fusion (k=60). Backends that don't have FTS5 in
 *     scope MUST fail; we never silently degrade.
 *
 * Schema (DESIGN.md §5.1 reserved this; we add the indexes):
 *
 *   CREATE TABLE memory_vectors (
 *     id            TEXT PRIMARY KEY REFERENCES memory_keyed(id) ON DELETE CASCADE,
 *     namespace     TEXT NOT NULL,
 *     embedding     BLOB NOT NULL,
 *     dimension     INTEGER NOT NULL,
 *     text          TEXT NOT NULL,
 *     ts            INTEGER NOT NULL
 *   );
 *   CREATE INDEX idx_vectors_ns ON memory_vectors(namespace);
 *
 * Tests skip-if when not running under bun (same pattern as SqliteBackend).
 */
import { Effect, Layer, Stream } from "effect"
import {
  EmbedderService,
  MemoryBackendError,
  bufferToFloat32,
  cosineSimilarity,
  float32ToBuffer,
} from "@luna/core"
import {
  MEMORY_ENVELOPE_VERSION,
  matchesQuery,
  type MemoryExport,
  type MemoryQuery,
  type MemoryRecord,
} from "../types.js"

export interface SqliteVectorBackendApi {
  readonly backendName: "sqlite-vector"
  readonly put: (rec: MemoryRecord) => Effect.Effect<void, MemoryBackendError>
  readonly get: (
    id: string,
  ) => Effect.Effect<MemoryRecord | null, MemoryBackendError>
  readonly query: (q: MemoryQuery) => Stream.Stream<MemoryRecord, MemoryBackendError>
  readonly delete: (id: string) => Effect.Effect<boolean, MemoryBackendError>
  readonly exportAll: () => Effect.Effect<MemoryExport, MemoryBackendError>
  readonly importAll: (
    env: MemoryExport,
  ) => Effect.Effect<number, MemoryBackendError>
  readonly search: (args: {
    readonly queryText: string
    readonly topK?: number
    readonly namespace?: string
    readonly mode?: "vec" | "hybrid"
  }) => Stream.Stream<
    { readonly record: MemoryRecord; readonly score: number },
    MemoryBackendError
  >
  readonly close: () => Effect.Effect<void>
}

interface DbRow {
  id: string
  namespace: string
  kind: string
  content_json: string
  schema_version: number
  created_at: number
  updated_at: number
  tags_json: string
}

interface VecRow {
  id: string
  namespace: string
  embedding: Uint8Array | Buffer
  dimension: number
  text: string
}

function rowToRecord(row: DbRow): MemoryRecord {
  return {
    id: row.id,
    namespace: row.namespace,
    kind: row.kind,
    content: JSON.parse(row.content_json),
    schemaVersion: row.schema_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags_json) as ReadonlyArray<string>,
  }
}

function asError(op: string, cause: unknown): MemoryBackendError {
  return new MemoryBackendError({ backend: "sqlite-vector", op, cause })
}

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

const MIGRATION = `
  CREATE TABLE IF NOT EXISTS memory_keyed (
    id              TEXT PRIMARY KEY,
    namespace       TEXT NOT NULL,
    kind            TEXT NOT NULL,
    content_json    TEXT NOT NULL,
    schema_version  INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    tags_json       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_ns ON memory_keyed(namespace);
  CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_keyed(kind);
  CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_keyed(updated_at);

  CREATE TABLE IF NOT EXISTS memory_vectors (
    id          TEXT PRIMARY KEY REFERENCES memory_keyed(id) ON DELETE CASCADE,
    namespace   TEXT NOT NULL,
    embedding   BLOB NOT NULL,
    dimension   INTEGER NOT NULL,
    text        TEXT NOT NULL,
    ts          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_vectors_ns ON memory_vectors(namespace);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
    USING fts5(text, content='memory_vectors', content_rowid='rowid', tokenize='porter unicode61');

  CREATE TRIGGER IF NOT EXISTS memory_vectors_ai AFTER INSERT ON memory_vectors BEGIN
    INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_vectors_ad AFTER DELETE ON memory_vectors BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_vectors_au AFTER UPDATE ON memory_vectors BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  -- Backfill: rebuild the FTS index from the external content table. This
  -- is the canonical idempotent op for content='memory_vectors' FTS5
  -- tables (handles pre-Phase-26 dbs whose vector rows have no FTS entry).
  -- Cheap when FTS is already in sync; reads the same rowids it would emit.
  INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
`

export class SqliteVectorBackend extends Effect.Tag("luna/SqliteVectorBackend")<
  SqliteVectorBackend,
  SqliteVectorBackendApi
>() {
  /**
   * Build a sqlite-vector-backed Layer. Requires `EmbedderService` from
   * environment. `dbPath` can be `":memory:"` for ephemeral databases.
   */
  static fromPath(
    dbPath: string,
  ): Layer.Layer<SqliteVectorBackend, MemoryBackendError, EmbedderService> {
    return Layer.scoped(
      SqliteVectorBackend,
      Effect.gen(function* () {
        const embedder = yield* EmbedderService

        const bunSqliteSpec = "bun:sqlite"
        const mod = yield* Effect.tryPromise({
          try: () =>
            (import(/* @vite-ignore */ bunSqliteSpec) as Promise<unknown>),
          catch: (cause) => asError("import", cause),
        })
        const Database = (mod as { default?: unknown; Database?: unknown })
          .Database as new (p: string) => {
            run: (sql: string) => void
            query: (sql: string) => {
              get: (...p: unknown[]) => unknown
              all: (...p: unknown[]) => unknown[]
              run: (...p: unknown[]) => { changes: number }
            }
            close: () => void
          }

        if (!Database) {
          yield* Effect.fail(
            asError(
              "import",
              new Error("bun:sqlite has no Database export"),
            ),
          )
        }

        const db = new Database(dbPath)
        db.run("PRAGMA foreign_keys = ON")
        db.run(MIGRATION)
        yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

        // Prepared statements
        const putKeyedStmt = db.query(
          `INSERT OR REPLACE INTO memory_keyed
             (id, namespace, kind, content_json, schema_version,
              created_at, updated_at, tags_json)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        // Explicit DELETE + INSERT (rather than INSERT OR REPLACE) so the
        // FTS5 sync triggers fire predictably: the AFTER DELETE trigger
        // removes the old `memory_fts` index entry (using OLD.text), and
        // the AFTER INSERT trigger reinserts with NEW.text. INSERT OR
        // REPLACE in bun:sqlite was observed to leave a stale FTS row in
        // some scenarios, so we sequence the two operations ourselves.
        const insertVecStmt = db.query(
          `INSERT INTO memory_vectors
             (id, namespace, embedding, dimension, text, ts)
           VALUES (?,?,?,?,?,?)`,
        )
        const delVecStmt = db.query(`DELETE FROM memory_vectors WHERE id = ?`)
        const getStmt = db.query(`SELECT * FROM memory_keyed WHERE id = ?`)
        const delStmt = db.query(`DELETE FROM memory_keyed WHERE id = ?`)
        const selectAllStmt = db.query(
          `SELECT * FROM memory_keyed ORDER BY updated_at DESC`,
        )
        const selectVecAllStmt = db.query(
          `SELECT id, namespace, embedding, dimension, text FROM memory_vectors`,
        )
        const selectVecByNsStmt = db.query(
          `SELECT id, namespace, embedding, dimension, text
             FROM memory_vectors WHERE namespace = ?`,
        )
        // FTS5 hybrid: BM25-ranked candidates from memory_fts joined back to
        // memory_vectors for namespace filter + id resolution. The FTS table
        // has no namespace column; join through memory_vectors.rowid.
        const ftsByNsStmt = db.query(
          `SELECT v.id AS id
             FROM memory_vectors v
             JOIN memory_fts f ON f.rowid = v.rowid
            WHERE memory_fts MATCH ?
              AND v.namespace = ?
            ORDER BY bm25(memory_fts)
            LIMIT ?`,
        )
        const ftsAllStmt = db.query(
          `SELECT v.id AS id
             FROM memory_vectors v
             JOIN memory_fts f ON f.rowid = v.rowid
            WHERE memory_fts MATCH ?
            ORDER BY bm25(memory_fts)
            LIMIT ?`,
        )

        // ─── put ────────────────────────────────────────────────────────
        const put: SqliteVectorBackendApi["put"] = (rec) =>
          Effect.gen(function* () {
            // 1. Always write the keyed row.
            yield* Effect.try({
              try: () => {
                putKeyedStmt.run(
                  rec.id,
                  rec.namespace,
                  rec.kind,
                  JSON.stringify(rec.content),
                  rec.schemaVersion,
                  rec.createdAt,
                  rec.updatedAt,
                  JSON.stringify(rec.tags),
                )
              },
              catch: (cause) => asError("put.keyed", cause),
            })

            // 2. If content.text exists, embed and write the vector row.
            //    Otherwise drop any stale vector row (idempotent rewrite).
            const text = extractText(rec.content)
            if (text === null) {
              yield* Effect.try({
                try: () => delVecStmt.run(rec.id),
                catch: (cause) => asError("put.vec-cleanup", cause),
              })
              return
            }

            const vec = yield* embedder.embed(text).pipe(
              Effect.mapError((cause) => asError("put.embed", cause)),
            )
            if (vec.length !== embedder.dimension) {
              yield* Effect.fail(
                asError(
                  "put.embed",
                  new Error(
                    `dimension mismatch: got ${vec.length} expected ${embedder.dimension}`,
                  ),
                ),
              )
            }
            yield* Effect.try({
              try: () => {
                // DELETE-then-INSERT so AFTER DELETE + AFTER INSERT triggers
                // both fire in order, keeping memory_fts in sync on rewrites.
                delVecStmt.run(rec.id)
                insertVecStmt.run(
                  rec.id,
                  rec.namespace,
                  float32ToBuffer(vec),
                  embedder.dimension,
                  text,
                  rec.updatedAt,
                )
              },
              catch: (cause) => asError("put.vec", cause),
            })
          })

        // ─── get / delete / query / export / import (keyed) ─────────────
        const get: SqliteVectorBackendApi["get"] = (id) =>
          Effect.try({
            try: () => {
              const row = getStmt.get(id) as DbRow | null | undefined
              return row ? rowToRecord(row) : null
            },
            catch: (cause) => asError("get", cause),
          })

        const query: SqliteVectorBackendApi["query"] = (q) => {
          try {
            const rows = selectAllStmt.all() as DbRow[]
            const matches = rows
              .map(rowToRecord)
              .filter((r) => matchesQuery(r, q))
            const limited = q.limit ? matches.slice(0, q.limit) : matches
            return Stream.fromIterable(limited)
          } catch (cause) {
            return Stream.fail(asError("query", cause))
          }
        }

        const del: SqliteVectorBackendApi["delete"] = (id) =>
          Effect.try({
            try: () => delStmt.run(id).changes > 0,
            catch: (cause) => asError("delete", cause),
          })

        const exportAll: SqliteVectorBackendApi["exportAll"] = () =>
          Effect.try({
            try: () => {
              const rows = selectAllStmt.all() as DbRow[]
              return {
                backend: "sqlite-vector" as const,
                envelopeVersion: MEMORY_ENVELOPE_VERSION,
                exportedAt: Date.now(),
                records: rows.map(rowToRecord),
              }
            },
            catch: (cause) => asError("exportAll", cause),
          })

        const importAll: SqliteVectorBackendApi["importAll"] = (env) =>
          Effect.gen(function* () {
            let n = 0
            for (const rec of env.records) {
              yield* put(rec)
              n++
            }
            return n
          })

        // ─── search ─────────────────────────────────────────────────────
        // Compute vec-only ranking for query against namespace-scoped rows.
        // Returned ids are sorted by descending cosine score, truncated to
        // `limit`. Shared by mode:"vec" and mode:"hybrid".
        const rankByVec = (
          queryVec: Float32Array,
          namespace: string | undefined,
          limit: number,
        ): { id: string; score: number }[] => {
          const vecRows = (namespace
            ? selectVecByNsStmt.all(namespace)
            : selectVecAllStmt.all()) as VecRow[]
          const scored: { id: string; score: number }[] = []
          for (const vr of vecRows) {
            if (vr.dimension !== queryVec.length) continue
            const candidate = bufferToFloat32(vr.embedding as Uint8Array)
            scored.push({
              id: vr.id,
              score: cosineSimilarity(queryVec, candidate),
            })
          }
          scored.sort((a, b) => b.score - a.score)
          return scored.slice(0, limit)
        }

        // BM25 ranking via FTS5. Returns ids ordered best-first.
        // FTS5 MATCH syntax is sensitive to special chars (-, :, etc.); wrap
        // the user-supplied query as a single quoted phrase so arbitrary
        // text is treated as a literal phrase query. Tokens within the
        // phrase are still tokenized by porter+unicode61 internally.
        const rankByBm25 = (
          queryText: string,
          namespace: string | undefined,
          limit: number,
        ): string[] => {
          // Escape embedded double-quotes per FTS5 quoting rules ("" = ").
          const phrase = `"${queryText.replace(/"/g, '""')}"`
          const rows = (namespace
            ? ftsByNsStmt.all(phrase, namespace, limit)
            : ftsAllStmt.all(phrase, limit)) as { id: string }[]
          return rows.map((r) => r.id)
        }

        const search: SqliteVectorBackendApi["search"] = (args) => {
          const mode = args.mode ?? "vec"
          const topK = args.topK ?? 10

          return Stream.unwrap(
            Effect.gen(function* () {
              // 1. Embed the query text (needed by both modes; hybrid still
              //    uses vec ranking as one of the two fused signals).
              const queryVec = yield* embedder.embed(args.queryText).pipe(
                Effect.mapError((cause) => asError("search.embed", cause)),
              )

              if (mode === "vec") {
                const top = yield* Effect.try({
                  try: () => rankByVec(queryVec, args.namespace, topK),
                  catch: (cause) => asError("search.scan", cause),
                })
                const out: { record: MemoryRecord; score: number }[] = []
                for (const s of top) {
                  const row = getStmt.get(s.id) as DbRow | null | undefined
                  if (row)
                    out.push({ record: rowToRecord(row), score: s.score })
                }
                return Stream.fromIterable(out)
              }

              // mode === "hybrid"
              // Pull max(topK, 50) candidates per side; fuse via RRF (k=60).
              const candidateLimit = Math.max(topK, 50)

              const vecRanked = yield* Effect.try({
                try: () => rankByVec(queryVec, args.namespace, candidateLimit),
                catch: (cause) => asError("search.hybrid.vec", cause),
              })
              const bm25Ranked = yield* Effect.try({
                try: () =>
                  rankByBm25(args.queryText, args.namespace, candidateLimit),
                catch: (cause) => asError("search.hybrid.bm25", cause),
              })

              // RRF: score = sum(1 / (k + rank)) over rankings the id appears in.
              const RRF_K = 60
              const fused = new Map<string, number>()
              vecRanked.forEach((entry, idx) => {
                fused.set(
                  entry.id,
                  (fused.get(entry.id) ?? 0) + 1 / (RRF_K + idx + 1),
                )
              })
              bm25Ranked.forEach((id, idx) => {
                fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + idx + 1))
              })

              const top = Array.from(fused.entries())
                .map(([id, score]) => ({ id, score }))
                .sort((a, b) => b.score - a.score)
                .slice(0, topK)

              const out: { record: MemoryRecord; score: number }[] = []
              for (const s of top) {
                const row = getStmt.get(s.id) as DbRow | null | undefined
                if (row)
                  out.push({ record: rowToRecord(row), score: s.score })
              }
              return Stream.fromIterable(out)
            }),
          )
        }

        return {
          backendName: "sqlite-vector" as const,
          put,
          get,
          query,
          delete: del,
          exportAll,
          importAll,
          search,
          close: () => Effect.sync(() => db.close()),
        }
      }),
    )
  }
}
