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

export type MemoryVisibility = "private" | "shared"

/**
 * A memory is always about a subject and observed by an actor. `private`
 * records are visible only to that observer; `shared` records may be read by
 * any observer querying the same subject.
 */
export interface MemoryScope {
  readonly observerId: string
  readonly subjectId: string
  readonly visibility: MemoryVisibility
}

/** Scope selector used by keyed and vector reads. */
export interface MemoryScopeQuery {
  readonly observerId: string
  readonly subjectId: string
}

export type MemoryProvenanceSource =
  | "manual"
  | "turn-extraction"
  | "dream"
  | "migration"

export interface MemoryProvenance {
  readonly source: MemoryProvenanceSource
  readonly sessionId?: string
  readonly messageIds?: ReadonlyArray<string>
}

/** Compatibility scope for pre-scope records in the operator namespace. */
export const OPERATOR_MEMORY_SCOPE: MemoryScope = {
  observerId: "luna",
  subjectId: "operator",
  visibility: "private",
}

/** Compatibility scope for old general notes. */
export const SHARED_OPERATOR_MEMORY_SCOPE: MemoryScope = {
  observerId: "shared",
  subjectId: "operator",
  visibility: "shared",
}

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
  readonly scope?: MemoryScope
  readonly provenance?: MemoryProvenance
}

/** Filter spec for query(). All fields are conjunctive. */
export interface MemoryQuery {
  readonly namespace?: string
  readonly kind?: string
  readonly tag?: string
  readonly limit?: number
  /** If set, only records with `updatedAt >= since` are returned. */
  readonly since?: number
  readonly scope?: MemoryScopeQuery
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
  scope?: MemoryScope
  provenance?: MemoryProvenance
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
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  }
}

/**
 * Legacy records did not carry scope metadata. Operator/belief records are
 * Luna-private; general note records retain their historical shared behavior.
 */
export function effectiveMemoryScope(rec: MemoryRecord): MemoryScope {
  if (rec.scope !== undefined) return rec.scope
  return rec.namespace === "operator" || rec.kind === "belief"
    ? OPERATOR_MEMORY_SCOPE
    : SHARED_OPERATOR_MEMORY_SCOPE
}

export function matchesMemoryScope(
  rec: MemoryRecord,
  query: MemoryScopeQuery,
): boolean {
  const scope = effectiveMemoryScope(rec)
  if (scope.subjectId !== query.subjectId) return false
  return scope.visibility === "shared" || scope.observerId === query.observerId
}

/** In-memory filter — shared by backends that keep records in arrays. */
export function matchesQuery(rec: MemoryRecord, q: MemoryQuery): boolean {
  if (q.namespace !== undefined && rec.namespace !== q.namespace) return false
  if (q.kind !== undefined && rec.kind !== q.kind) return false
  if (q.tag !== undefined && !rec.tags.includes(q.tag)) return false
  if (q.since !== undefined && rec.updatedAt < q.since) return false
  if (q.scope !== undefined && !matchesMemoryScope(rec, q.scope)) return false
  return true
}
