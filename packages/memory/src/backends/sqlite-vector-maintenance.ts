import { createHash } from "node:crypto"
import { Effect } from "effect"
import { MemoryBackendError, type EmbedderApi } from "@luna/core"
import { initVectorlite } from "./vectorlite-init.js"
import { probeHnswPopulation, backfillHnswRows } from "./hnsw-backfill.js"
import { deriveHnswSidecarPath, secureSidecar } from "./hnsw-sidecar.js"

type BunStatement = {
  readonly get: (...p: unknown[]) => unknown
  readonly all: (...p: unknown[]) => unknown[]
  readonly run: (...p: unknown[]) => { changes: number }
}

type BunDatabase = {
  readonly run: (sql: string) => void
  readonly query: (sql: string) => BunStatement
  readonly loadExtension?: (path: string) => void
  readonly close: () => void
}

interface TableInfoRow {
  readonly name: string
}

interface SqliteMasterRow {
  readonly sql: string | null
}

interface VectorAuditRow {
  readonly id: string
  readonly namespace: string
  readonly kind: string | null
  readonly content_json: string | null
  readonly tags_json: string | null
  readonly dimension: number
  readonly text: string
  readonly embedding_provider: string
  readonly embedding_model: string
  readonly embedding_format: string
  readonly embedding_input_hash: string
  readonly embedded_at: number
}

export interface MemoryVectorStatusGroup {
  readonly count: number
  readonly dimension: number
  readonly embeddingProvider: string
  readonly embeddingModel: string
  readonly embeddingFormat: string
  readonly compatible: boolean
}

export interface MemoryVectorStatusRow {
  readonly id: string
  readonly namespace: string
  readonly dimension: number
  readonly embeddingProvider: string
  readonly embeddingModel: string
  readonly embeddingFormat: string
  readonly embeddingInputHash: string
  readonly expectedInputHash: string
  readonly embeddedAt: number
  readonly stale: boolean
  readonly reasons: ReadonlyArray<string>
}

export interface MemoryVectorHnswStatus {
  readonly present: boolean
  readonly dimension: number | null
  readonly compatible: boolean | null
  /**
   * `null` when `present` is false (no v-table) or when the index is
   * unprobeable (compat mismatch / extension not loaded). Otherwise the
   * number of source rows the index can recall — measured by issuing
   * `knn_search` with `k = totalVectors` against any stored embedding.
   * Used to detect the memory-only-HNSW-after-restart failure mode
   * (schema persists, in-memory graph is empty).
   */
  readonly indexedCount: number | null
}

export interface MemoryVectorStatus {
  readonly active: {
    readonly provider: string
    readonly model: string
    readonly dimension: number
    readonly embeddingFormat: string
  }
  readonly totalVectors: number
  readonly staleVectors: number
  readonly hnsw: MemoryVectorHnswStatus
  readonly groups: ReadonlyArray<MemoryVectorStatusGroup>
  readonly rows: ReadonlyArray<MemoryVectorStatusRow>
}

export interface MemoryReembedRow {
  readonly id: string
  readonly namespace: string
  readonly reasons: ReadonlyArray<string>
  readonly action: "would-reembed" | "reembedded" | "skipped"
  readonly skipReason?: string
}

export interface MemoryReembedResult {
  readonly dryRun: boolean
  readonly scannedRows: number
  readonly staleRows: number
  readonly reembedded: number
  readonly skipped: number
  readonly rows: ReadonlyArray<MemoryReembedRow>
}

export const MEMORY_VECTOR_SCHEMA_MIGRATION = `
  CREATE TABLE IF NOT EXISTS memory_keyed (
    id              TEXT PRIMARY KEY,
    namespace       TEXT NOT NULL,
    kind            TEXT NOT NULL,
    content_json    TEXT NOT NULL,
    schema_version  INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    tags_json       TEXT NOT NULL,
    scope_json      TEXT,
    provenance_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memory_ns ON memory_keyed(namespace);
  CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory_keyed(kind);
  CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_keyed(updated_at);

  CREATE TABLE IF NOT EXISTS memory_vectors (
    id                    TEXT PRIMARY KEY REFERENCES memory_keyed(id) ON DELETE CASCADE,
    namespace             TEXT NOT NULL,
    embedding             BLOB NOT NULL,
    dimension             INTEGER NOT NULL,
    text                  TEXT NOT NULL,
    ts                    INTEGER NOT NULL,
    embedding_provider    TEXT NOT NULL DEFAULT 'unknown',
    embedding_model       TEXT NOT NULL DEFAULT 'unknown',
    embedding_format      TEXT NOT NULL DEFAULT 'raw-v0',
    embedding_input_hash  TEXT NOT NULL DEFAULT '',
    embedded_at           INTEGER NOT NULL DEFAULT 0,
    enrichment            TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_vectors_ns ON memory_vectors(namespace);
`

// "enrichment" is a lexical-index-only signal (SIRA-style corpus enrichment,
// Experiment A): LLM-generated alias phrases that let bm25 match vocabulary
// the record's own text never uses. It is indexed as a second FTS5 column
// here but is NEVER fed to the embedder — vector search input stays
// text-only (see put() in sqlite-vector.ts).
//
// This is deliberately NOT part of MEMORY_VECTOR_SCHEMA_MIGRATION above:
// `memory_vectors.enrichment` must exist BEFORE this FTS (re)creation runs,
// or the 'rebuild' below (which reads both declared columns from the
// content table by name) fails against a legacy `memory_vectors` that
// hasn't been ALTERed yet. ensureMemoryVectorSchema() calls this only after
// every column-ALTER guard has run, so the ordering is enforced by
// construction, not by convention.
const MEMORY_FTS_SCHEMA = `
  CREATE VIRTUAL TABLE memory_fts
    USING fts5(text, enrichment, content='memory_vectors', content_rowid='rowid', tokenize='porter unicode61');

  CREATE TRIGGER memory_vectors_ai AFTER INSERT ON memory_vectors BEGIN
    INSERT INTO memory_fts(rowid, text, enrichment) VALUES (new.rowid, new.text, new.enrichment);
  END;

  CREATE TRIGGER memory_vectors_ad AFTER DELETE ON memory_vectors BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, text, enrichment) VALUES('delete', old.rowid, old.text, old.enrichment);
  END;

  CREATE TRIGGER memory_vectors_au AFTER UPDATE ON memory_vectors BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, text, enrichment) VALUES('delete', old.rowid, old.text, old.enrichment);
    INSERT INTO memory_fts(rowid, text, enrichment) VALUES (new.rowid, new.text, new.enrichment);
  END;

  INSERT INTO memory_fts(memory_fts) VALUES('rebuild');
`

const METADATA_COLUMNS = [
  {
    name: "embedding_provider",
    sql: "ALTER TABLE memory_vectors ADD COLUMN embedding_provider TEXT NOT NULL DEFAULT 'unknown'",
  },
  {
    name: "embedding_model",
    sql: "ALTER TABLE memory_vectors ADD COLUMN embedding_model TEXT NOT NULL DEFAULT 'unknown'",
  },
  {
    name: "embedding_format",
    sql: "ALTER TABLE memory_vectors ADD COLUMN embedding_format TEXT NOT NULL DEFAULT 'raw-v0'",
  },
  {
    name: "embedding_input_hash",
    sql: "ALTER TABLE memory_vectors ADD COLUMN embedding_input_hash TEXT NOT NULL DEFAULT ''",
  },
  {
    name: "embedded_at",
    sql: "ALTER TABLE memory_vectors ADD COLUMN embedded_at INTEGER NOT NULL DEFAULT 0",
  },
] as const

const ENRICHMENT_COLUMN = {
  name: "enrichment",
  sql: "ALTER TABLE memory_vectors ADD COLUMN enrichment TEXT NOT NULL DEFAULT ''",
} as const

const RECORD_METADATA_COLUMNS = [
  {
    name: "scope_json",
    sql: "ALTER TABLE memory_keyed ADD COLUMN scope_json TEXT",
  },
  {
    name: "provenance_json",
    sql: "ALTER TABLE memory_keyed ADD COLUMN provenance_json TEXT",
  },
] as const

function asError(op: string, cause: unknown): MemoryBackendError {
  return new MemoryBackendError({ backend: "sqlite-vector", op, cause })
}

export function formatMemoryRecordEmbeddingInput(input: {
  readonly namespace: string
  readonly kind: string
  readonly tags: ReadonlyArray<string>
  readonly text: string
}): string {
  return `title: ${input.namespace}/${input.kind} tags:${input.tags.join(",")} | text: ${input.text}`
}

export function formatMemoryQueryEmbeddingInput(query: string): string {
  return `task: search result | query: ${query}`
}

export function hashEmbeddingInput(input: string): string {
  return createHash("sha256").update(input).digest("hex")
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

function parseTags(raw: string | null): ReadonlyArray<string> {
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
      ? parsed
      : []
  } catch {
    return []
  }
}

function expectedHashForRow(row: VectorAuditRow): string {
  const fromKeyed = keyedTextForRow(row)
  const text = fromKeyed ?? row.text
  return hashEmbeddingInput(
    formatMemoryRecordEmbeddingInput({
      namespace: row.namespace,
      kind: row.kind ?? "unknown",
      tags: parseTags(row.tags_json),
      text,
    }),
  )
}

function keyedTextForRow(row: VectorAuditRow): string | null {
  if (row.content_json === null) return null
  try {
    return extractText(JSON.parse(row.content_json))
  } catch {
    return null
  }
}

/**
 * Guarded (re)creation of `memory_fts`. Handles two cases with the same
 * check, since both leave `memory_fts` without an "enrichment" column:
 *   - Fresh / pre-FTS DB: `memory_fts` doesn't exist yet (PRAGMA table_info
 *     returns nothing) — DROP is a no-op, CREATE builds the final 2-column
 *     shape directly, and 'rebuild' seeds it from whatever rows already
 *     exist in `memory_vectors` (zero for a truly fresh DB).
 *   - Legacy DB: `memory_fts` exists with only "text" — must be dropped and
 *     recreated (FTS5 has no ALTER ADD COLUMN), then repopulated via
 *     'rebuild' from `memory_vectors` (the canonical source).
 * Callers MUST ensure `memory_vectors.enrichment` already exists before
 * calling this — 'rebuild' reads both declared columns from the content
 * table by name and fails if either is missing.
 * Old triggers are DROPped (not `CREATE TRIGGER IF NOT EXISTS`, which would
 * silently keep stale single-column trigger bodies) and recreated to write
 * both columns.
 */
function ensureMemoryFtsSchema(db: BunDatabase): void {
  const ftsCols = new Set(
    (db.query("PRAGMA table_info(memory_fts)").all() as TableInfoRow[]).map(
      (row) => row.name,
    ),
  )
  if (ftsCols.has("enrichment")) return // already final shape — no-op

  db.run(`
    DROP TRIGGER IF EXISTS memory_vectors_ai;
    DROP TRIGGER IF EXISTS memory_vectors_ad;
    DROP TRIGGER IF EXISTS memory_vectors_au;
    DROP TABLE IF EXISTS memory_fts;
  `)
  db.run(MEMORY_FTS_SCHEMA)
}

export function ensureMemoryVectorSchema(db: BunDatabase): void {
  db.run(MEMORY_VECTOR_SCHEMA_MIGRATION)
  const keyedCols = new Set(
    (db.query("PRAGMA table_info(memory_keyed)").all() as TableInfoRow[]).map(
      (row) => row.name,
    ),
  )
  for (const col of RECORD_METADATA_COLUMNS) {
    if (!keyedCols.has(col.name)) db.run(col.sql)
  }
  const cols = new Set(
    (db.query("PRAGMA table_info(memory_vectors)").all() as TableInfoRow[]).map(
      (row) => row.name,
    ),
  )
  for (const col of METADATA_COLUMNS) {
    if (!cols.has(col.name)) db.run(col.sql)
  }
  // Enrichment column must land on memory_vectors BEFORE memory_fts is
  // (re)created below — see ensureMemoryFtsSchema's doc comment.
  if (!cols.has(ENRICHMENT_COLUMN.name)) db.run(ENRICHMENT_COLUMN.sql)
  ensureMemoryFtsSchema(db)
}

function parseHnswDimension(sql: string | null | undefined): number | null {
  if (sql === null || sql === undefined) return null
  const match = sql.match(/float32\[(\d+)\]/)
  return match ? Number.parseInt(match[1]!, 10) : null
}

function getHnswStatus(db: BunDatabase, embedder: EmbedderApi): MemoryVectorHnswStatus {
  const row = db
    .query(
      `SELECT sql FROM sqlite_master
        WHERE type='table' AND name='memory_vectors_hnsw'`,
    )
    .get() as SqliteMasterRow | null | undefined
  if (row === null || row === undefined) {
    return {
      present: false,
      dimension: null,
      compatible: null,
      indexedCount: null,
    }
  }
  const dimension = parseHnswDimension(row.sql)
  const compatible = dimension === embedder.dimension
  // Report how many active-dimension rows the HNSW graph holds. The v-table
  // is float32[dim] and can only contain rows at the embedder's dimension, so
  // the denominator a caller compares against is the active-dimension count —
  // never totalVectors (which spans other, un-indexable dimensions).
  //
  // This maintenance connection is separate from the long-lived backend, so
  // its in-memory graph starts empty. Populate it from the source rows (the
  // same recovery the backend runs on open), then report the population. A
  // probe/backfill failure (extension not loaded, capacity exceeded, or a busy
  // DB after the busy_timeout) is reported as null = "unknown" rather than
  // crashing diagnostics.
  let indexedCount: number | null = null
  if (compatible) {
    try {
      const expected = (
        db
          .query(
            `SELECT count(*) AS c FROM memory_vectors WHERE dimension = ${embedder.dimension}`,
          )
          .get() as { c: number }
      ).c
      if (expected === 0) {
        indexedCount = 0
      } else {
        let population = probeHnswPopulation(db, embedder.dimension, expected)
        if (population === 0) {
          backfillHnswRows(db, embedder.dimension)
          population = expected
        }
        indexedCount = population
      }
    } catch {
      indexedCount = null
    }
  }
  return {
    present: true,
    dimension,
    compatible,
    indexedCount,
  }
}

function selectAuditRows(
  db: BunDatabase,
  namespace?: string,
): ReadonlyArray<VectorAuditRow> {
  const sql = `SELECT
       v.id,
       v.namespace,
       k.kind AS kind,
       k.content_json AS content_json,
       k.tags_json AS tags_json,
       v.dimension,
       v.text,
       v.embedding_provider,
       v.embedding_model,
       v.embedding_format,
       v.embedding_input_hash,
       v.embedded_at
     FROM memory_vectors v
     LEFT JOIN memory_keyed k ON k.id = v.id
     ${namespace !== undefined ? "WHERE v.namespace = ?" : ""}
     ORDER BY v.namespace, v.id`
  return (namespace !== undefined
    ? db.query(sql).all(namespace)
    : db.query(sql).all()) as VectorAuditRow[]
}

function auditRow(row: VectorAuditRow, embedder: EmbedderApi): MemoryVectorStatusRow {
  const reasons: string[] = []
  if (row.dimension !== embedder.dimension) reasons.push("dimension")
  if (row.embedding_provider !== embedder.provider) {
    reasons.push("embedding_provider")
  }
  if (row.embedding_model !== embedder.model) reasons.push("embedding_model")
  if (row.embedding_format !== embedder.embeddingFormat) {
    reasons.push("embedding_format")
  }
  const expectedInputHash = expectedHashForRow(row)
  if (row.embedding_input_hash !== expectedInputHash) {
    reasons.push("embedding_input_hash")
  }
  return {
    id: row.id,
    namespace: row.namespace,
    dimension: row.dimension,
    embeddingProvider: row.embedding_provider,
    embeddingModel: row.embedding_model,
    embeddingFormat: row.embedding_format,
    embeddingInputHash: row.embedding_input_hash,
    expectedInputHash,
    embeddedAt: row.embedded_at,
    stale: reasons.length > 0,
    reasons,
  }
}

async function openDb(dbPath: string): Promise<BunDatabase> {
  const vlInit = initVectorlite()
  const bunSqlite = (await import("bun:sqlite" as string)) as {
    Database: new (p: string) => BunDatabase
  }
  const db = new bunSqlite.Database(dbPath)
  db.run("PRAGMA foreign_keys = ON")
  // The status path writes (getHnswStatus backfills the HNSW graph in order to
  // count it) and may run while the long-lived backend holds a write lock on
  // the same file. Wait for the lock instead of failing fast with SQLITE_BUSY
  // and misreporting a populated index as empty.
  db.run("PRAGMA busy_timeout = 5000")
  if (vlInit.ok) {
    db.loadExtension?.(vlInit.path)
  }
  return db
}

/**
 * Close a maintenance connection and re-tighten the HNSW sidecar to 0o600.
 *
 * The v-table's `index_file_path` is baked into its `sqlite_master` schema by
 * the backend, so a maintenance connection that touches `memory_vectors_hnsw`
 * (status probe/backfill, reembed's trigger-driven mutations) makes vectorlite
 * REWRITE the sidecar on close — at the process umask (typically 0644), which
 * would silently undo the backend's owner-only posture. Re-chmod after close so
 * `luna memory status`/`reembed` can't loosen the persisted graph's perms.
 */
function closeAndSecureSidecar(db: BunDatabase, dbPath: string): void {
  db.close()
  const sidecar = deriveHnswSidecarPath(dbPath)
  if (sidecar !== null) secureSidecar(sidecar)
}

export function getMemoryVectorStatus(args: {
  readonly dbPath: string
  readonly embedder: EmbedderApi
}): Effect.Effect<MemoryVectorStatus, MemoryBackendError> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => openDb(args.dbPath),
      catch: (cause) => asError("status.open", cause),
    }),
    (db) =>
      Effect.try({
        try: () => {
          ensureMemoryVectorSchema(db)
          const rawRows = selectAuditRows(db)
          const rows = rawRows.map((row) => auditRow(row, args.embedder))
          const groupsByKey = new Map<string, MemoryVectorStatusGroup>()
          for (const row of rows) {
            const key = [
              row.dimension,
              row.embeddingProvider,
              row.embeddingModel,
              row.embeddingFormat,
            ].join("\u0000")
            const existing = groupsByKey.get(key)
            const compatible =
              row.dimension === args.embedder.dimension &&
              row.embeddingProvider === args.embedder.provider &&
              row.embeddingModel === args.embedder.model &&
              row.embeddingFormat === args.embedder.embeddingFormat
            groupsByKey.set(key, {
              count: (existing?.count ?? 0) + 1,
              dimension: row.dimension,
              embeddingProvider: row.embeddingProvider,
              embeddingModel: row.embeddingModel,
              embeddingFormat: row.embeddingFormat,
              compatible,
            })
          }
          return {
            active: {
              provider: args.embedder.provider,
              model: args.embedder.model,
              dimension: args.embedder.dimension,
              embeddingFormat: args.embedder.embeddingFormat,
            },
            totalVectors: rows.length,
            staleVectors: rows.filter((row) => row.stale).length,
            hnsw: getHnswStatus(db, args.embedder),
            groups: Array.from(groupsByKey.values()).sort(
              (a, b) =>
                a.dimension - b.dimension ||
                a.embeddingProvider.localeCompare(b.embeddingProvider) ||
                a.embeddingModel.localeCompare(b.embeddingModel) ||
                a.embeddingFormat.localeCompare(b.embeddingFormat),
            ),
            rows,
          } satisfies MemoryVectorStatus
        },
        catch: (cause) => asError("status", cause),
      }),
    (db) => Effect.sync(() => closeAndSecureSidecar(db, args.dbPath)),
  )
}

export function reembedMemoryVectors(args: {
  readonly dbPath: string
  readonly embedder: EmbedderApi
  readonly dryRun: boolean
  readonly namespace?: string
  readonly limit?: number
}): Effect.Effect<MemoryReembedResult, MemoryBackendError> {
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => openDb(args.dbPath),
      catch: (cause) => asError("reembed.open", cause),
    }),
    (db) =>
      Effect.gen(function* () {
        const candidates = yield* Effect.try({
          try: () => {
            ensureMemoryVectorSchema(db)
            const rawRows = selectAuditRows(db, args.namespace)
            const stale = rawRows
              .map((raw) => ({ raw, audit: auditRow(raw, args.embedder) }))
              .filter((entry) => entry.audit.stale)
            return {
              scannedRows: rawRows.length,
              stale: args.limit !== undefined ? stale.slice(0, args.limit) : stale,
              staleTotal: stale.length,
            }
          },
          catch: (cause) => asError("reembed.scan", cause),
        })

        if (args.dryRun) {
          return {
            dryRun: true,
            scannedRows: candidates.scannedRows,
            staleRows: candidates.staleTotal,
            reembedded: 0,
            skipped: 0,
            rows: candidates.stale.map(({ audit }) => ({
              id: audit.id,
              namespace: audit.namespace,
              reasons: audit.reasons,
              action: "would-reembed" as const,
            })),
          }
        }

        const rows: MemoryReembedRow[] = []
        let reembedded = 0
        let skipped = 0
        for (const candidate of candidates.stale) {
          const text = keyedTextForRow(candidate.raw)
          if (text === null) {
            skipped++
            rows.push({
              id: candidate.audit.id,
              namespace: candidate.audit.namespace,
              reasons: candidate.audit.reasons,
              action: "skipped",
              skipReason: "missing content.text in memory_keyed",
            })
            continue
          }
          const embeddingInput = formatMemoryRecordEmbeddingInput({
            namespace: candidate.raw.namespace,
            kind: candidate.raw.kind ?? "unknown",
            tags: parseTags(candidate.raw.tags_json),
            text,
          })
          const vec = yield* args.embedder.embed(embeddingInput).pipe(
            Effect.mapError((cause) => asError("reembed.embed", cause)),
          )
          if (vec.length !== args.embedder.dimension) {
            return yield* Effect.fail(
              asError(
                "reembed.embed",
                new Error(
                  `dimension mismatch: got ${vec.length} expected ${args.embedder.dimension}`,
                ),
              ),
            )
          }
          const embeddingBuf = new Uint8Array(
            vec.buffer,
            vec.byteOffset,
            vec.byteLength,
          )
          const embeddedAt = Date.now()
          const inputHash = hashEmbeddingInput(embeddingInput)
          yield* Effect.try({
            try: () => {
              db.run("BEGIN IMMEDIATE")
              try {
                db.query(
                  `UPDATE memory_vectors
                      SET embedding = ?,
                          dimension = ?,
                          text = ?,
                          ts = ?,
                          embedding_provider = ?,
                          embedding_model = ?,
                          embedding_format = ?,
                          embedding_input_hash = ?,
                          embedded_at = ?
                    WHERE id = ?`,
                ).run(
                  embeddingBuf,
                  args.embedder.dimension,
                  text,
                  embeddedAt,
                  args.embedder.provider,
                  args.embedder.model,
                  args.embedder.embeddingFormat,
                  inputHash,
                  embeddedAt,
                  candidate.raw.id,
                )
                db.run("COMMIT")
              } catch (txnErr) {
                try {
                  db.run("ROLLBACK")
                } catch {
                  /* original error wins */
                }
                throw txnErr
              }
            },
            catch: (cause) => asError("reembed.update", cause),
          })
          reembedded++
          rows.push({
            id: candidate.audit.id,
            namespace: candidate.audit.namespace,
            reasons: candidate.audit.reasons,
            action: "reembedded",
          })
        }

        return {
          dryRun: false,
          scannedRows: candidates.scannedRows,
          staleRows: candidates.staleTotal,
          reembedded,
          skipped,
          rows,
        }
      }),
    (db) => Effect.sync(() => closeAndSecureSidecar(db, args.dbPath)),
  )
}
