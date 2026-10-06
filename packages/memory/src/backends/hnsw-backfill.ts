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
 * `fingerprintHnswSource` and `readDataVersion` support the sidecar trust
 * check (see hnsw-sidecar.ts): what the graph SHOULD contain, and whether
 * another connection committed to the database in the meantime.
 *
 * `MinimalDb` is a deliberately small structural type: `hnsw-backfill` is
 * imported BY `sqlite-vector-maintenance`, so it cannot import that module's
 * `BunDatabase` type without creating a cycle.
 */

import { createHash } from "node:crypto"

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

/**
 * Fingerprint of the rows an HNSW graph at `dimension` must hold: sha256
 * over (rowid, embedding bytes) in rowid order. Those two values are exactly
 * what `backfillHnswRows` copies into the graph, so any edit (DELETE +
 * INSERT, with or without rowid reuse), delete or add changes it, even when
 * the row count does not. Paged by rowid so a large table is never
 * materialised at once.
 */
export function fingerprintHnswSource(db: MinimalDb, dimension: number): string {
  const hash = createHash("sha256")
  hash.update(`dim=${dimension};`)
  const page = db.query(
    `SELECT rowid AS rid, embedding FROM memory_vectors
      WHERE dimension = ${dimension} AND rowid > ?
      ORDER BY rowid LIMIT 512`,
  )
  let after = -1
  for (;;) {
    const rows = page.all(after) as Array<{
      rid: number
      embedding: Uint8Array
    }>
    if (rows.length === 0) break
    for (const row of rows) {
      hash.update(`${row.rid}:${row.embedding.byteLength};`)
      hash.update(row.embedding)
      after = row.rid
    }
  }
  return hash.digest("hex")
}

/**
 * SQLite `PRAGMA data_version`: unchanged for this connection's own commits,
 * different after ANY other connection committed in the meantime. Lets the
 * backend notice that memory_vectors changed behind its in-memory graph.
 */
export function readDataVersion(db: MinimalDb): number {
  const row = db.query("PRAGMA data_version").get() as {
    data_version: number
  }
  return row.data_version
}
