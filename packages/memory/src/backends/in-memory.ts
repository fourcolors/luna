/**
 * In-memory MemoryBackend — ephemeral, fast, for tests and scratch.
 *
 * Storage: Map<id, MemoryRecord>. Not concurrency-safe across Effects
 * beyond single-threaded JS semantics; fine for Tier-1 testing.
 */
import { Effect, Layer, Stream } from "effect"
import { MemoryBackendError } from "@luna/core"
import {
  MEMORY_ENVELOPE_VERSION,
  matchesQuery,
  type MemoryExport,
  type MemoryQuery,
  type MemoryRecord,
} from "../types.js"

export interface InMemoryBackendApi {
  readonly backendName: "in-memory"
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

export class InMemoryBackend extends Effect.Tag(
  "luna/InMemoryBackend",
)<InMemoryBackend, InMemoryBackendApi>() {
  static readonly Default: Layer.Layer<InMemoryBackend> = Layer.sync(
    InMemoryBackend,
    () => {
      const store = new Map<string, MemoryRecord>()

      const put: InMemoryBackendApi["put"] = (rec) =>
        Effect.sync(() => {
          store.set(rec.id, { ...rec, updatedAt: rec.updatedAt })
        })

      const get: InMemoryBackendApi["get"] = (id) =>
        Effect.sync(() => store.get(id) ?? null)

      const query: InMemoryBackendApi["query"] = (q) => {
        const matches: MemoryRecord[] = []
        for (const rec of store.values()) {
          if (matchesQuery(rec, q)) matches.push(rec)
        }
        matches.sort((a, b) => b.updatedAt - a.updatedAt)
        const limited = q.limit ? matches.slice(0, q.limit) : matches
        return Stream.fromIterable(limited)
      }

      const del: InMemoryBackendApi["delete"] = (id) =>
        Effect.sync(() => store.delete(id))

      const exportAll: InMemoryBackendApi["exportAll"] = () =>
        Effect.sync(() => ({
          backend: "in-memory" as const,
          envelopeVersion: MEMORY_ENVELOPE_VERSION,
          exportedAt: Date.now(),
          records: Array.from(store.values()),
        }))

      const importAll: InMemoryBackendApi["importAll"] = (env) =>
        Effect.sync(() => {
          let n = 0
          for (const rec of env.records) {
            store.set(rec.id, rec)
            n++
          }
          return n
        })

      return {
        backendName: "in-memory" as const,
        put,
        get,
        query,
        delete: del,
        exportAll,
        importAll,
      }
    },
  )
}
