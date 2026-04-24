/**
 * Memory record types — the portable shape every backend stores.
 *
 * Per advisor Phase 5 verdict: the `MemoryBackend` interface is NOT frozen
 * here. Two concrete backends (in-memory, file) are written first; a third
 * (sqlite) follows; the interface is extracted from their intersection in
 * a later commit. This file defines ONLY the data shape — the records.
 *
 * Capability split:
 *   - Keyed store  → put/get/query/delete (all backends)
 *   - Vector store → search(queryText, embedding?) (vector backend only)
 *
 * Migration envelope (§5.2): a whole-backend export is
 *   { backend, envelopeVersion, exportedAt, records[] }
 * so one backend can dump → another import regardless of storage.
 */

export const MEMORY_ENVELOPE_VERSION = 1 as const

/** Portable record shape. `content` is opaque to the memory layer. */
export interface MemoryRecord {
  readonly id: string
  readonly namespace: string
  readonly kind: string
  readonly content: unknown
  readonly schemaVersion: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly tags: ReadonlyArray<string>
}

/** Filter spec for query(). All fields are conjunctive. */
export interface MemoryQuery {
  readonly namespace?: string
  readonly kind?: string
  readonly tag?: string
  readonly limit?: number
  /** If set, only records with `updatedAt >= since` are returned. */
  readonly since?: number
}

/** Migration envelope — whole-backend export/import format. */
export interface MemoryExport {
  readonly backend: string
  readonly envelopeVersion: typeof MEMORY_ENVELOPE_VERSION
  readonly exportedAt: number
  readonly records: ReadonlyArray<MemoryRecord>
}

/**
 * Construct a fresh record with sensible defaults. The backend may override
 * timestamps when importing from an envelope (preserves original ts).
 */
export function makeRecord(input: {
  id: string
  namespace: string
  kind: string
  content: unknown
  schemaVersion?: number
  tags?: ReadonlyArray<string>
  now?: number
}): MemoryRecord {
  const ts = input.now ?? Date.now()
  return {
    id: input.id,
    namespace: input.namespace,
    kind: input.kind,
    content: input.content,
    schemaVersion: input.schemaVersion ?? 1,
    createdAt: ts,
    updatedAt: ts,
    tags: input.tags ?? [],
  }
}

/** In-memory filter — shared by backends that keep records in arrays. */
export function matchesQuery(rec: MemoryRecord, q: MemoryQuery): boolean {
  if (q.namespace !== undefined && rec.namespace !== q.namespace) return false
  if (q.kind !== undefined && rec.kind !== q.kind) return false
  if (q.tag !== undefined && !rec.tags.includes(q.tag)) return false
  if (q.since !== undefined && rec.updatedAt < q.since) return false
  return true
}
