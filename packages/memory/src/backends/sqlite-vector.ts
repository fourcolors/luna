/**
 * SqliteVectorBackend — sqlite-backed memory backend with vector search.
 *
 * Phase 25 (advisor verdict ⚠️ MODIFY):
 *   - Owns BOTH `memory_keyed` and `memory_vectors` tables in one DB.
 *   - Auto-embeds on `put()` ONLY when `rec.content.text` is a string.
 *     Records without text are keyed-only (no row in memory_vectors).
 *
 * Phase 27 (vector scale-up — Vectorlite HNSW):
 *   - On Layer build, attempt to load the Vectorlite SQLite extension via
 *     `vectorlite-init.ts` (process-wide one-shot — `Database.setCustomSQLite`
 *     must run before the first `new Database()`). On macOS this requires
 *     Homebrew's libsqlite3 (`/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`)
 *     because Apple's stock libsqlite3 ships with `SQLITE_OMIT_LOAD_EXTENSION`.
 *   - When the extension loads: create `memory_vectors_hnsw` (vectorlite v-table)
 *     and AFTER INSERT/DELETE/UPDATE triggers on `memory_vectors` keep it in
 *     sync. Idempotent backfill on open (`INSERT … SELECT … WHERE rowid NOT IN`)
 *     covers pre-Phase-27 dbs.
 *   - When the extension does NOT load (non-bun runtime, missing brew sqlite,
 *     missing prebuilt, init too late, etc.): warn ONCE and fall back to the
 *     naive `SELECT * → JS cosine → topK` ranker. Per §6.1 this is a graceful
 *     degradation — never raises a `MemoryBackendError`.
 *   - With HNSW active, ranking uses `knn_search(embedding, knn_param(?, K))`
 *     against the v-table. Vectorlite returns L2² distance; embeddings are
 *     L2-normalized upstream so we recover cosine similarity via
 *     `score = 1 - distance / 2`.
 *   - Naive cosine wall (pre-Phase-27 fallback path): ~1k records / 372ms p95
 *     per Operator's `sqlite-vec-scaling` skill. With HNSW: 0.037ms p95 @ 10k
 *     measured on arm64-darwin (same skill).
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
  LunaSqliteBootstrap,
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
import {
  ensureMemoryVectorSchema,
  formatMemoryQueryEmbeddingInput,
  formatMemoryRecordEmbeddingInput,
  hashEmbeddingInput,
} from "./sqlite-vector-maintenance.js"
import { backfillHnswIfEmpty } from "./hnsw-backfill.js"
import {
  deriveHnswSidecarPath,
  discardSidecar,
  secureSidecar,
} from "./hnsw-sidecar.js"

export interface SqliteVectorBackendApi {
  readonly backendName: "sqlite-vector"
  /**
   * True when the Vectorlite HNSW v-table loaded successfully on this DB
   * connection (Phase 27 fast path active). False when the backend fell back
   * to naive in-process cosine ranking (extension-load failure, non-bun
   * runtime, missing brew sqlite, etc.). Operators / tests can read this to
   * detect the dev-time race the Phase 27a bootstrap Layer was added to fix.
   */
  readonly hnswEnabled: boolean
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

// Warn-once flag (process-scoped). The fallback path is fine; the operator
// just needs to know about it once so they can investigate if unexpected.
let _vectorliteFallbackWarned = false
function warnFallbackOnce(reason: string): void {
  if (_vectorliteFallbackWarned) return
  _vectorliteFallbackWarned = true
  // eslint-disable-next-line no-console
  console.warn(
    `[luna/sqlite-vector] Vectorlite HNSW unavailable (${reason}); ` +
      `falling back to naive in-process cosine ranking.`,
  )
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
  ): Layer.Layer<
    SqliteVectorBackend,
    MemoryBackendError,
    EmbedderService | LunaSqliteBootstrap
  > {
    return Layer.scoped(
      SqliteVectorBackend,
      Effect.gen(function* () {
        const embedder = yield* EmbedderService

        // Phase 27a: the process-wide `setCustomSQLite()` swap is now
        // owned by `LunaSqliteBootstrap` (Tag in @luna/core, Live Layer
        // in @luna/memory). Pulling the Tag here BEFORE the dynamic
        // `import("bun:sqlite")` makes ordering explicit in the type
        // system: any composition that wires this backend MUST also
        // provide `LunaSqliteBootstrapLive`, which runs first. Single
        // source of truth — no double init path.
        const vlInit = yield* LunaSqliteBootstrap

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
        // Wait for a contended write lock (e.g. a concurrent `luna memory`
        // maintenance connection) rather than failing fast with SQLITE_BUSY.
        db.run("PRAGMA busy_timeout = 5000")
        ensureMemoryVectorSchema(db)
        // Compute the HNSW sidecar path up-front so the close-time
        // chmod can see it (vectorlite writes the file on db.close()).
        // Null for in-memory / special-URI DBs — secureSidecar no-ops.
        const sidecarPath = deriveHnswSidecarPath(dbPath)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            db.close()
            if (sidecarPath !== null) secureSidecar(sidecarPath)
          }),
        )

        // Try to load the extension on this connection. Even if vlInit
        // succeeded earlier (process-wide setCustomSQLite), each Database
        // needs its own loadExtension() call.
        let hnswEnabled = false
        if (vlInit.ok) {
          try {
            ;(db as unknown as { loadExtension: (p: string) => void })
              .loadExtension(vlInit.path)
            // Sidecar policy (Phase 27e — persistent HNSW):
            //
            // Vectorlite's third CREATE-time argument is the
            // `index_file_path` — when provided, vectorlite loads the
            // graph from the file on connection open and rewrites it on
            // close. With persistence active the per-connection backfill
            // cost (O(N · log N · M) per open) becomes a one-time
            // construction cost amortized across every subsequent boot
            // and every short-lived maintenance connection.
            //
            // `sidecarPath` is hoisted above the finalizer so close-time
            // chmod can see it. It is null for in-memory / special-URI
            // DBs (`:memory:`, `""`, anything starting with `:`); the
            // legacy memory-only v-table is created in that case and
            // the backfill below still self-heals on every open. For
            // disk-backed DBs the sidecar lives next to the db file
            // (`memory.db.hnsw.bin`) so it's globbable for backup ops.

            // Drop-and-recreate trigger: a v-table from a prior boot
            // that doesn't match the current spec (different embedding
            // dimension, OR memory-only when we now want a sidecar, OR
            // wrong sidecar path) must be torn down before CREATE — the
            // `IF NOT EXISTS` clause turns CREATE into a no-op when the
            // table already exists, regardless of its parameters.
            const existingHnsw = db
              .query(
                `SELECT sql FROM sqlite_master
                  WHERE type='table' AND name='memory_vectors_hnsw'`,
              )
              .get() as { sql: string | null } | null | undefined
            const existingMatches = (sql: string): boolean => {
              if (!sql.includes(`float32[${embedder.dimension}]`)) return false
              if (sidecarPath === null) {
                // We want memory-only. Existing must not reference a path.
                return !/'[^']+'/.test(sql)
              }
              // We want a specific sidecar path. Existing must literally
              // include it (the path is stored verbatim in sqlite_master).
              return sql.includes(sidecarPath)
            }
            if (existingHnsw?.sql != null && !existingMatches(existingHnsw.sql)) {
              db.run(`DROP TRIGGER IF EXISTS memory_vectors_hnsw_ai`)
              db.run(`DROP TRIGGER IF EXISTS memory_vectors_hnsw_ad`)
              db.run(`DROP TRIGGER IF EXISTS memory_vectors_hnsw_au`)
              db.run(`DROP TABLE IF EXISTS memory_vectors_hnsw`)
            }

            // CREATE + corruption recovery.
            //
            // Vectorlite defers sidecar-file deserialization: CREATE
            // VIRTUAL TABLE succeeds even when the file is garbage, and
            // the deserialization error ("Failed to load index from
            // file: Index seems to be corrupted or unsupported") fires
            // on the first knn_search / INSERT against the v-table.
            // So we CREATE, then probe with knn_search(k=1) against any
            // stored embedding — that's where corruption surfaces. If
            // the probe throws AND we have a sidecar, we treat it as
            // corruption: drop everything, discard the sidecar, and
            // retry CREATE empty. The unconditional
            // `backfillHnswIfEmpty` call below rebuilds the graph from
            // `memory_vectors` (the canonical source of truth) and
            // vectorlite re-serializes a healthy sidecar on close.
            //
            // The retry is bounded to a single attempt — if recreating
            // also throws, the surrounding try/catch falls back to the
            // naive in-process cosine path.
            const createSql =
              sidecarPath !== null
                ? `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors_hnsw
                     USING vectorlite(embedding float32[${embedder.dimension}],
                                      hnsw(max_elements=100000),
                                      '${sidecarPath.replace(/'/g, "''")}')`
                : `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors_hnsw
                     USING vectorlite(embedding float32[${embedder.dimension}],
                                      hnsw(max_elements=100000))`
            db.run(createSql)

            // Sidecar corruption probe: only meaningful when we have a
            // sidecar AND at least one source row exists (otherwise
            // there's nothing to test the v-table with). With either
            // condition false, the unconditional backfill below covers
            // the legitimate empty case.
            if (sidecarPath !== null) {
              const probeRow = db
                .query(
                  `SELECT embedding FROM memory_vectors
                    WHERE dimension = ${embedder.dimension} LIMIT 1`,
                )
                .get() as { embedding: Uint8Array } | null | undefined
              if (probeRow?.embedding != null) {
                try {
                  db.query(
                    `SELECT rowid FROM memory_vectors_hnsw
                      WHERE knn_search(embedding, knn_param(?, 1))`,
                  ).all(probeRow.embedding)
                } catch (probeCause) {
                  warnFallbackOnce(
                    `HNSW sidecar appears corrupt; discarding and rebuilding from memory_vectors: ${String(probeCause)}`,
                  )
                  try {
                    db.run(`DROP TRIGGER IF EXISTS memory_vectors_hnsw_ai`)
                    db.run(`DROP TRIGGER IF EXISTS memory_vectors_hnsw_ad`)
                    db.run(`DROP TRIGGER IF EXISTS memory_vectors_hnsw_au`)
                    db.run(`DROP TABLE IF EXISTS memory_vectors_hnsw`)
                  } catch {
                    /* best-effort */
                  }
                  discardSidecar(sidecarPath)
                  db.run(createSql)
                }
              }
            }

            // AFTER triggers keep HNSW in sync with memory_vectors. The FTS5
            // triggers from MIGRATION fire independently — both run per row
            // mutation; vectorlite is happy inside trigger bodies (verified).
            db.run(`
              CREATE TRIGGER IF NOT EXISTS memory_vectors_hnsw_ai
                AFTER INSERT ON memory_vectors BEGIN
                  INSERT INTO memory_vectors_hnsw(rowid, embedding)
                    VALUES (new.rowid, new.embedding);
                END;
              CREATE TRIGGER IF NOT EXISTS memory_vectors_hnsw_ad
                AFTER DELETE ON memory_vectors BEGIN
                  DELETE FROM memory_vectors_hnsw WHERE rowid = old.rowid;
                END;
              CREATE TRIGGER IF NOT EXISTS memory_vectors_hnsw_au
                AFTER UPDATE ON memory_vectors BEGIN
                  DELETE FROM memory_vectors_hnsw WHERE rowid = old.rowid;
                  INSERT INTO memory_vectors_hnsw(rowid, embedding)
                    VALUES (new.rowid, new.embedding);
                END;
            `)
            // Backfill is now (a) the one-time first-boot population
            // and (b) the corruption-recovery rebuild — both no-ops on
            // a healthy persisted index, because `backfillHnswIfEmpty`
            // self-probes the v-table first and only writes when empty.
            // We keep this call unconditionally so the legacy
            // memory-only path (sidecar=null) and the new persistent
            // path share the same correctness guarantee.
            backfillHnswIfEmpty(db, embedder.dimension)

            // Tighten sidecar permissions to 0o600 so the persisted
            // graph inherits the same owner-only access posture as
            // memory.db. Vectorlite creates the file on first close, so
            // this chmod is best-effort — if the file doesn't exist
            // yet (no rows ever inserted, or the close that materializes
            // it hasn't happened), the helper silently no-ops. The
            // finalizer below also chmods on close.
            if (sidecarPath !== null) secureSidecar(sidecarPath)
            hnswEnabled = true
          } catch (cause) {
            // The extension loaded but v-table setup or the backfill failed
            // (e.g. max_elements exceeded, or an unreadable embedding). Tear
            // the half-built v-table down and fall back to naive cosine — a
            // correct, if slower, search path — rather than serve an
            // incomplete index. The cause string carries the specific error.
            warnFallbackOnce(
              `HNSW unavailable (extension load, v-table setup, or backfill failed); using naive cosine ranking: ${String(cause)}`,
            )
            // Best-effort cleanup so the half-created v-table + triggers
            // don't break subsequent put()s. If these fail (e.g. extension
            // never actually loaded), ignore — the next open will retry.
            try {
              db.run(`DROP TRIGGER IF EXISTS memory_vectors_hnsw_ai`)
              db.run(`DROP TRIGGER IF EXISTS memory_vectors_hnsw_ad`)
              db.run(`DROP TRIGGER IF EXISTS memory_vectors_hnsw_au`)
              db.run(`DROP TABLE IF EXISTS memory_vectors_hnsw`)
            } catch {
              /* best-effort */
            }
          }
        } else {
          warnFallbackOnce(vlInit.reason)
        }

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
             (id, namespace, embedding, dimension, text, ts,
              embedding_provider, embedding_model, embedding_format,
              embedding_input_hash, embedded_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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

        // Phase 27 HNSW prepared statements (only used when hnswEnabled).
        // Vectorlite returns L2² distance; embeddings are L2-normalized
        // upstream so cosine ≈ 1 - distance/2. We bind a Buffer (Float32
        // little-endian) and an integer K; the namespace filter happens on
        // the JOIN side (memory_vectors.namespace).
        const hnswByNsStmt = hnswEnabled
          ? db.query(
              `SELECT v.id AS id, h.distance AS distance
                 FROM memory_vectors_hnsw h
                 JOIN memory_vectors v ON v.rowid = h.rowid
                WHERE knn_search(h.embedding, knn_param(?, ?))
                  AND v.namespace = ?`,
            )
          : null
        const hnswAllStmt = hnswEnabled
          ? db.query(
              `SELECT v.id AS id, h.distance AS distance
                 FROM memory_vectors_hnsw h
                 JOIN memory_vectors v ON v.rowid = h.rowid
                WHERE knn_search(h.embedding, knn_param(?, ?))`,
            )
          : null

        // ─── put ────────────────────────────────────────────────────────
        // Atomicity (Phase 26 follow-up, advisor ⚠️ MODIFY):
        //   1. Embed FIRST (async, outside any txn) — if it fails we have
        //      not touched the DB yet.
        //   2. Wrap the keyed + vec writes in a single BEGIN IMMEDIATE
        //      transaction. Run inside Effect.uninterruptible so a Fiber
        //      interrupt mid-txn cannot leave the connection holding an
        //      open write lock (§3.4 rule 4).
        //   3. On any throw inside the txn, ROLLBACK before propagating
        //      the MemoryBackendError (§6.1: no other error type).
        const put: SqliteVectorBackendApi["put"] = (rec) =>
          Effect.gen(function* () {
            const text = extractText(rec.content)

            // Step 1: embed first (only if needed). No DB state mutated yet.
            let vecBuf: Uint8Array | null = null
            let embeddingInputHash: string | null = null
            let embeddedAt = 0
            if (text !== null) {
              const embeddingInput = formatMemoryRecordEmbeddingInput({
                namespace: rec.namespace,
                kind: rec.kind,
                tags: rec.tags,
                text,
              })
              const vec = yield* embedder.embed(embeddingInput).pipe(
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
              vecBuf = float32ToBuffer(vec)
              embeddingInputHash = hashEmbeddingInput(embeddingInput)
              embeddedAt = Date.now()
            }

            // Step 2+3: atomic keyed + vec writes under BEGIN IMMEDIATE.
            yield* Effect.uninterruptible(
              Effect.try({
                try: () => {
                  db.run("BEGIN IMMEDIATE")
                  try {
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
                    if (vecBuf === null) {
                      // No text → drop any stale vec row (idempotent).
                      delVecStmt.run(rec.id)
                    } else {
                      // DELETE+INSERT so AFTER DELETE + AFTER INSERT triggers
                      // both fire in order, keeping memory_fts in sync.
                      delVecStmt.run(rec.id)
                      insertVecStmt.run(
                        rec.id,
                        rec.namespace,
                        vecBuf,
                        embedder.dimension,
                        text!,
                        rec.updatedAt,
                        embedder.provider,
                        embedder.model,
                        embedder.embeddingFormat,
                        embeddingInputHash,
                        embeddedAt,
                      )
                    }
                    db.run("COMMIT")
                  } catch (txnErr) {
                    try {
                      db.run("ROLLBACK")
                    } catch {
                      /* rollback best-effort; original error wins */
                    }
                    throw txnErr
                  }
                },
                catch: (cause) => asError("put", cause),
              }),
            )
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
          // Fast path: Vectorlite HNSW. The namespace filter is applied on
          // the JOIN to memory_vectors. We over-fetch slightly when a
          // namespace is supplied (HNSW returns top-K globally before the
          // JOIN's WHERE prunes by namespace), then truncate to `limit`.
          if (hnswEnabled && hnswByNsStmt && hnswAllStmt) {
            const queryBuf = Buffer.from(
              queryVec.buffer,
              queryVec.byteOffset,
              queryVec.byteLength,
            )
            const k = namespace ? Math.max(limit * 4, 50) : limit
            const rows = (namespace
              ? hnswByNsStmt.all(queryBuf, k, namespace)
              : hnswAllStmt.all(queryBuf, k)) as {
              id: string
              distance: number
            }[]
            // L2² → cosine for L2-normalized embeddings. Clamp to [-1, 1]
            // to be safe for tiny floating-point overshoots.
            const scored = rows.map((r) => {
              const cos = 1 - r.distance / 2
              const clamped = cos > 1 ? 1 : cos < -1 ? -1 : cos
              return { id: r.id, score: clamped }
            })
            scored.sort((a, b) => b.score - a.score)
            return scored.slice(0, limit)
          }

          // Fallback: naive in-process cosine over all (or namespace-filtered)
          // memory_vectors rows. Hit when extension load failed or runtime
          // is non-bun.
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
              const queryVec = yield* embedder
                .embed(formatMemoryQueryEmbeddingInput(args.queryText))
                .pipe(
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
          hnswEnabled,
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
