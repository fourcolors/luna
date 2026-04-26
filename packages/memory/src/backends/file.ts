/**
 * File MemoryBackend — append-only JSONL with in-memory index.
 *
 * Write path: one JSONL line per put (full record, latest wins by id).
 * Read path: on service construction, stream the file and populate the
 * id→record index; subsequent gets/queries hit the index.
 *
 * A periodic compact (not implemented here) would rewrite the file with
 * only latest-per-id records. For Phase 5 we optimize for correctness,
 * not throughput.
 *
 * Not concurrency-safe across processes. Use for single-process gateway
 * scenarios; the sqlite backend is the shared-process answer.
 */
import { Effect, Layer, Stream } from "effect"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { MemoryBackendError } from "@luna/core"
import {
  MEMORY_ENVELOPE_VERSION,
  matchesQuery,
  type MemoryExport,
  type MemoryQuery,
  type MemoryRecord,
} from "../types.js"

export interface FileBackendConfig {
  readonly filePath: string
}

export interface FileBackendApi {
  readonly backendName: "file"
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

/** Internal JSONL frame — `op:"del"` lines are tombstones. */
type Frame =
  | { readonly op: "put"; readonly rec: MemoryRecord }
  | { readonly op: "del"; readonly id: string }

function asBackendError(op: string, cause: unknown): MemoryBackendError {
  return new MemoryBackendError({ backend: "file", op, cause })
}

export class FileBackend extends Effect.Tag("luna/FileBackend")<
  FileBackend,
  FileBackendApi
>() {
  static fromPath(
    filePath: string,
  ): Layer.Layer<FileBackend, MemoryBackendError> {
    return Layer.effect(
      FileBackend,
      Effect.gen(function* () {
        // Ensure parent dir exists; create file if missing.
        yield* Effect.tryPromise({
          try: async () => {
            await fsp.mkdir(path.dirname(filePath), { recursive: true })
            if (!fs.existsSync(filePath)) {
              await fsp.writeFile(filePath, "", { flag: "wx" }).catch(() => {})
            }
          },
          catch: (cause) => asBackendError("init", cause),
        })

        // Load existing frames into an in-memory index.
        const index = new Map<string, MemoryRecord>()
        const raw = yield* Effect.tryPromise({
          try: () => fsp.readFile(filePath, "utf8"),
          catch: (cause) => asBackendError("load", cause),
        })
        for (const line of raw.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const frame = JSON.parse(trimmed) as Frame
            if (frame.op === "put") index.set(frame.rec.id, frame.rec)
            else if (frame.op === "del") index.delete(frame.id)
          } catch {
            // Skip malformed line — don't poison the whole file.
          }
        }

        const appendFrame = (frame: Frame): Effect.Effect<void, MemoryBackendError> =>
          Effect.tryPromise({
            try: () => fsp.appendFile(filePath, JSON.stringify(frame) + "\n"),
            catch: (cause) => asBackendError("append", cause),
          })

        const put: FileBackendApi["put"] = (rec) =>
          Effect.gen(function* () {
            yield* appendFrame({ op: "put", rec })
            index.set(rec.id, rec)
          })

        const get: FileBackendApi["get"] = (id) =>
          Effect.sync(() => index.get(id) ?? null)

        const query: FileBackendApi["query"] = (q) => {
          const matches: MemoryRecord[] = []
          for (const rec of index.values()) {
            if (matchesQuery(rec, q)) matches.push(rec)
          }
          matches.sort((a, b) => b.updatedAt - a.updatedAt)
          const limited = q.limit ? matches.slice(0, q.limit) : matches
          return Stream.fromIterable(limited)
        }

        const del: FileBackendApi["delete"] = (id) =>
          Effect.gen(function* () {
            const existed = index.has(id)
            if (!existed) return false
            yield* appendFrame({ op: "del", id })
            index.delete(id)
            return true
          })

        const exportAll: FileBackendApi["exportAll"] = () =>
          Effect.sync(() => ({
            backend: "file" as const,
            envelopeVersion: MEMORY_ENVELOPE_VERSION,
            exportedAt: Date.now(),
            records: Array.from(index.values()),
          }))

        const importAll: FileBackendApi["importAll"] = (env) =>
          Effect.gen(function* () {
            let n = 0
            for (const rec of env.records) {
              yield* appendFrame({ op: "put", rec })
              index.set(rec.id, rec)
              n++
            }
            return n
          })

        return {
          backendName: "file" as const,
          put,
          get,
          query,
          delete: del,
          exportAll,
          importAll,
        }
      }),
    )
  }
}
