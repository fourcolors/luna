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
import type { MemoryBackendError } from "@experiment-agent/core"
import type {
  MemoryExport,
  MemoryQuery,
  MemoryRecord,
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

export interface MemoryVectorBackend extends MemoryBackend {
  readonly search: (args: {
    readonly queryText: string
    readonly topK?: number
    readonly namespace?: string
  }) => Stream.Stream<
    { readonly record: MemoryRecord; readonly score: number },
    MemoryBackendError
  >
}

export function hasVectorSearch(
  b: MemoryBackend,
): b is MemoryVectorBackend {
  return typeof (b as Partial<MemoryVectorBackend>).search === "function"
}
