/**
 * MemoryBackend — extracted from in-memory + file + sqlite intersection.
 *
 * Per advisor verdict: interface comes AFTER concrete backends work, not
 * before. Each concrete backend (InMemoryBackend/FileBackend/SqliteBackend)
 * is a valid `MemoryBackend` by structural typing; the interface here is
 * the canonical shape for router consumers.
 *
 * Capability split:
 *   - `MemoryBackend`       — keyed (put/get/query/delete/export/import)
 *   - `MemoryVectorBackend` — adds `search(queryText, topK)` (vector store)
 *
 * A backend may implement both; the router asks for capabilities at
 * dispatch time.
 */
import type { Effect, Stream } from "effect"
import type { MemoryBackendError, MemorySearchMode } from "@luna/core"
import type { LexicalFusionOptions } from "./lexical-query.js"
import type {
  MemoryExport,
  MemoryQuery,
  MemoryRecord,
  MemoryScopeQuery,
} from "./types.js"

export interface MemoryBackend {
  readonly backendName: string
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
}

/** Arguments to a memory vector search; shared by backends and the router. */
export interface MemorySearchArgs {
  readonly queryText: string
  readonly topK?: number
  readonly namespace?: string
  readonly mode?: MemorySearchMode
  readonly scope?: MemoryScopeQuery
  /** If true, records superseded by a newer record are included. */
  readonly includeSuperseded?: boolean
  /**
   * Query expansion: extra keywords (synonyms, entities, alternate
   * phrasings), typically written by the calling agent. They feed ONLY the
   * lexical arm, never the query embedding, so they cannot pull the vector
   * search off-topic. ONLY `hybrid-weighted` uses them, as their own
   * lexical arm weighted below the query's (FTS5 sums repeated terms, so
   * mixing them into the query's OR would let them dominate). Every other
   * mode ignores them, which keeps production `hybrid` byte-identical.
   */
  readonly expansionTerms?: ReadonlyArray<string>
  /** Overrides for `hybrid-weighted` (bench sweeps); production omits it. */
  readonly fusion?: Partial<LexicalFusionOptions>
}

export interface MemoryVectorBackend extends MemoryBackend {
  /**
   * Vector search.
   *
   * `mode`:
   *   - `"vec"` (default) — pure cosine ranking over the backend's vectors.
   *   - `"hybrid"` — backends fuse BM25 (FTS5) with vector ranking via RRF.
   *     Backends that do not support hybrid MUST fail with
   *     `MemoryBackendError`, not silently fall back to vec-only.
   *   - `"bm25"` - pure lexical FTS5 ranking, no embedding call. Backends
   *     without FTS5 in scope MUST fail with `MemoryBackendError`.
   *   - `"hybrid-terms"` / `"hybrid-weighted"` - see `MemorySearchMode`.
   */
  readonly search: (args: MemorySearchArgs) => Stream.Stream<
    { readonly record: MemoryRecord; readonly score: number },
    MemoryBackendError
  >
}

export function hasVectorSearch(
  b: MemoryBackend,
): b is MemoryVectorBackend {
  return typeof (b as Partial<MemoryVectorBackend>).search === "function"
}
