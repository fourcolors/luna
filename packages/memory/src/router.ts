/**
 * MemoryRouter — dispatches reads/writes across backends by namespace rule.
 *
 * Registration: `{ pattern, backend }` pairs. `pattern` is a glob-ish
 * string supporting `*` suffix wildcard (e.g. `"session:*"`). The first
 * matching rule wins; a default rule with pattern `"*"` is required.
 *
 * Writes: route by `rec.namespace`. Reads by `id` fall through all
 * backends in registration order (the router doesn't know ahead of time
 * which backend owns a given id — backends should namespace their ids
 * to avoid collisions, but the router is tolerant).
 */
import { Effect, Stream } from "effect"
import { MemoryBackendError } from "@experiment-agent/core"
import type { MemoryBackend } from "./backend.js"
import type {
  MemoryExport,
  MemoryQuery,
  MemoryRecord,
} from "./types.js"

export interface Rule {
  readonly pattern: string
  readonly backend: MemoryBackend
}

function matchesPattern(pattern: string, namespace: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1) // keep the ":"
    return namespace === pattern.slice(0, -2) || namespace.startsWith(prefix)
  }
  return pattern === namespace
}

export interface MemoryRouter {
  readonly put: (rec: MemoryRecord) => Effect.Effect<void, MemoryBackendError>
  readonly get: (
    id: string,
  ) => Effect.Effect<MemoryRecord | null, MemoryBackendError>
  readonly query: (q: MemoryQuery) => Stream.Stream<MemoryRecord, MemoryBackendError>
  readonly delete: (id: string) => Effect.Effect<boolean, MemoryBackendError>
  readonly backendFor: (namespace: string) => MemoryBackend
  readonly exportAll: () => Effect.Effect<
    ReadonlyArray<MemoryExport>,
    MemoryBackendError
  >
}

export function makeRouter(rules: ReadonlyArray<Rule>): MemoryRouter {
  if (rules.length === 0) {
    throw new Error("MemoryRouter: at least one rule required")
  }
  if (!rules.some((r) => r.pattern === "*")) {
    throw new Error("MemoryRouter: a default rule (pattern:'*') is required")
  }

  const backendFor = (namespace: string): MemoryBackend => {
    for (const rule of rules) {
      if (matchesPattern(rule.pattern, namespace)) return rule.backend
    }
    // Unreachable because "*" is required, but TS wants it.
    throw new Error(`MemoryRouter: no backend matched namespace ${namespace}`)
  }

  const put: MemoryRouter["put"] = (rec) => backendFor(rec.namespace).put(rec)

  const get: MemoryRouter["get"] = (id) =>
    Effect.gen(function* () {
      for (const rule of rules) {
        const hit = yield* rule.backend.get(id)
        if (hit) return hit
      }
      return null
    })

  const query: MemoryRouter["query"] = (q) => {
    if (q.namespace !== undefined) {
      return backendFor(q.namespace).query(q)
    }
    // No namespace filter → fan out across all backends and merge.
    const streams = rules.map((r) => r.backend.query(q))
    return Stream.mergeAll(streams, { concurrency: rules.length })
  }

  const del: MemoryRouter["delete"] = (id) =>
    Effect.gen(function* () {
      for (const rule of rules) {
        const hit = yield* rule.backend.delete(id)
        if (hit) return true
      }
      return false
    })

  const exportAll: MemoryRouter["exportAll"] = () =>
    Effect.gen(function* () {
      const out: MemoryExport[] = []
      for (const rule of rules) {
        const env = yield* rule.backend.exportAll()
        out.push(env)
      }
      return out
    })

  return { put, get, query, delete: del, backendFor, exportAll }
}
