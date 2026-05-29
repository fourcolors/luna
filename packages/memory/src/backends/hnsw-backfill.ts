/**
 * hnsw-backfill — shared HNSW v-table population helper.
 *
 * Vectorlite v-tables created without `index_file_path` are memory-only:
 * the SQLite schema persists across process restarts AND across separate
 * `bun:sqlite` `Database` connections, but the in-memory HNSW graph does
 * NOT. Any connection that opens the DB sees an empty index — and the
 * existing AFTER INSERT trigger only populates rows inserted via THIS
 * connection during ITS lifetime.
 *
 * `backfillHnswIfEmpty` is the recovery: open a connection, detect an
 * empty HNSW v-table by self-probing with any stored embedding, and if
 * empty, INSERT every `memory_vectors` row into the v-table to rebuild
 * the in-memory graph.
 *
 * Called by:
 *   - `SqliteVectorBackend.make` after creating the v-table and triggers
 *     (covers chat-server boot and any process that holds the backend).
 *   - `openDb` in `sqlite-vector-maintenance.ts` so `memory status` and
 *     `memory reembed` see an accurate, populated HNSW view rather than
 *     reporting `indexedCount: 0` on every diagnostic invocation.
 *
 * Idempotent: if the probe returns ≥1 hit, no backfill runs. Safe to
 * call on every connection open. Throws if the v-table doesn't exist or
 * the extension isn't loaded — callers gate on `hnswEnabled` /
 * `vlInit.ok` upstream.
 */

interface MinimalDb {
  readonly run: (sql: string) => void
  readonly query: (sql: string) => {
    readonly get: (...p: unknown[]) => unknown
    readonly all: (...p: unknown[]) => unknown[]
  }
}

/**
 * Returns `true` when a backfill was performed, `false` when the index
 * was already populated (or there were no source rows to back-fill).
 *
 * Probing strategy: take any one `memory_vectors` row matching the
 * embedder's dimension and ask HNSW to `knn_search` for it with k=1.
 * If the result set is empty, the v-table holds no entries for that
 * dimension — backfill is required.
 */
export function backfillHnswIfEmpty(
  db: MinimalDb,
  dimension: number,
): boolean {
  const sample = db
    .query(
      `SELECT embedding FROM memory_vectors
        WHERE dimension = ${dimension} LIMIT 1`,
    )
    .get() as { embedding: Uint8Array } | null | undefined
  if (sample?.embedding == null) {
    // No source rows at this dimension — nothing to backfill.
    return false
  }
  let isEmpty: boolean
  try {
    const hits = db
      .query(
        `SELECT rowid FROM memory_vectors_hnsw
          WHERE knn_search(embedding, knn_param(?, 1))`,
      )
      .all(sample.embedding) as Array<{ rowid: number }>
    isEmpty = hits.length === 0
  } catch {
    // Probe failed (e.g. extension half-loaded). Treat as empty and
    // attempt backfill; if that also throws, the caller's try/catch
    // takes over.
    isEmpty = true
  }
  if (!isEmpty) return false
  db.run(
    `INSERT INTO memory_vectors_hnsw(rowid, embedding)
       SELECT rowid, embedding FROM memory_vectors
        WHERE dimension = ${dimension}`,
  )
  return true
}
