/**
 * hnsw-backfill — shared HNSW v-table probe + population helpers.
 *
 * Vectorlite v-tables created without `index_file_path` are memory-only:
 * the SQLite schema persists across process restarts AND across separate
 * `bun:sqlite` `Database` connections, but the in-memory HNSW graph does
 * NOT. Any connection that opens the DB sees an empty index — and the
 * existing AFTER INSERT trigger only populates rows inserted via THIS
 * connection during ITS lifetime.
 *
 * Two primitives are shared by the backend (`sqlite-vector.ts`) and the
 * maintenance/status path (`sqlite-vector-maintenance.ts`) so the probe SQL
 * lives in exactly one place:
 *   - `probeHnswPopulation` — how many rows the graph recalls for a dimension.
 *   - `backfillHnswRows` — copy every source row at a dimension into the graph.
 * `backfillHnswIfEmpty` composes them for the common "rebuild if empty" case.
 *
 * `MinimalDb` is a deliberately small structural type: `hnsw-backfill` is
 * imported BY `sqlite-vector-maintenance`, so it cannot import that module's
 * `BunDatabase` type without creating a cycle.
 */

interface MinimalDb {
  readonly run: (sql: string) => void
  readonly query: (sql: string) => {
    readonly get: (...p: unknown[]) => unknown
    readonly all: (...p: unknown[]) => unknown[]
  }
}

/**
 * How many rows the in-memory HNSW graph can recall for `dimension`, measured
 * by knn_search-ing any one stored embedding for the top `k`. Returns 0 when
 * there are no source rows at this dimension.
 *
 * vectorlite forces `ef = max(ef_, k)`, so passing `k = (active-dimension row
 * count)` makes recall exhaustive — the result length is the exact count of
 * rows the graph holds for this dimension, not an approximate sample.
 *
 * THROWS if the v-table is absent or the extension is not loaded; callers
 * decide how to treat that (the backend disables HNSW; status reports null).
 */
export function probeHnswPopulation(
  db: MinimalDb,
  dimension: number,
  k: number,
): number {
  const sample = db
    .query(
      `SELECT embedding FROM memory_vectors WHERE dimension = ${dimension} LIMIT 1`,
    )
    .get() as { embedding: Uint8Array } | null | undefined
  if (sample?.embedding == null) return 0
  const hits = db
    .query(
      `SELECT rowid FROM memory_vectors_hnsw
        WHERE knn_search(embedding, knn_param(?, ?))`,
    )
    .all(sample.embedding, Math.max(1, k)) as Array<{ rowid: number }>
  return hits.length
}

/**
 * INSERT every `memory_vectors` row at `dimension` into the HNSW v-table,
 * rebuilding the in-memory graph from the persisted source side. Vectorlite
 * v-tables don't support generic SELECT, so we read the source and copy
 * rowid + embedding across. THROWS on an already-present rowid or when the
 * index `max_elements` cap is exceeded.
 */
export function backfillHnswRows(db: MinimalDb, dimension: number): void {
  db.run(
    `INSERT INTO memory_vectors_hnsw(rowid, embedding)
       SELECT rowid, embedding FROM memory_vectors
        WHERE dimension = ${dimension}`,
  )
}

/**
 * Returns `true` when a backfill was performed, `false` when the index was
 * already populated. Detects emptiness with a cheap `k=1` probe; a probe
 * error is treated as empty (best-effort recovery — if the backfill INSERT
 * also throws, the caller's try/catch takes over).
 *
 * NOTE: this detects emptiness, not completeness — a partially populated
 * graph (≥1 row) is treated as populated. A single INSERT…SELECT is atomic,
 * so partial population is only reachable via a `max_elements` overflow;
 * `luna memory status` surfaces that case via its `indexed=N/M` banner.
 */
export function backfillHnswIfEmpty(db: MinimalDb, dimension: number): boolean {
  let population: number
  try {
    population = probeHnswPopulation(db, dimension, 1)
  } catch {
    // Probe failed (e.g. extension half-loaded). Treat as empty and attempt
    // the backfill; if that also throws, the caller's try/catch handles it.
    population = 0
  }
  if (population > 0) return false
  backfillHnswRows(db, dimension)
  return true
}
