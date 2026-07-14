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
import { Context, Effect, Stream } from "effect"
import { createHash } from "node:crypto"
import {
  MemoryBackendError,
  type Clock,
  type ObservabilityApi,
} from "@luna/core"
import { hasVectorSearch, type MemoryBackend } from "./backend.js"
import type {
  MemoryExport,
  MemoryQuery,
  MemoryRecord,
  MemoryScopeQuery,
} from "./types.js"
import { matchesMemoryScope } from "./types.js"

export interface Rule {
  readonly pattern: string
  readonly backend: MemoryBackend
}

/**
 * Optional instrumentation hooks for `makeRouter`. When provided, every
 * `search()` call emits a `RetrievalCallEvent` to ObservabilityService when
 * the stream terminates (success, error, or empty). Captured at construction
 * — no Tag plumbing in the hot path. Mirrors the cost-store-sqlite pattern.
 */
export interface RouterOptions {
  readonly observability: ObservabilityApi
  readonly clock: Clock
  readonly embedderInfo: {
    readonly provider: string
    readonly model: string
    readonly dimension: number
  }
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
  /**
   * Vector search across the namespace's matched backend. If the backend
   * isn't vector-capable, the stream fails with MemoryBackendError("router",
   * "no vector backend for namespace X"). If no namespace is provided, the
   * router fans out to ALL vector-capable backends (Stream.mergeAll); if
   * none are registered, fails with the same error.
   *
   * `mode: "vec"` (default) does pure cosine ranking. `"hybrid"` (Phase 26)
   * fuses BM25 (FTS5) with vec ranking via Reciprocal Rank Fusion on
   * backends that support it (currently `SqliteVectorBackend`). Backends
   * that don't support hybrid fail with `MemoryBackendError`; the router
   * does not silently fall back to vec-only.
   */
  readonly search: (args: {
    readonly queryText: string
    readonly topK?: number
    readonly namespace?: string
    readonly mode?: "vec" | "hybrid"
    readonly scope?: MemoryScopeQuery
  }) => Stream.Stream<
    { readonly record: MemoryRecord; readonly score: number },
    MemoryBackendError
  >
}

export function makeRouter(
  rules: ReadonlyArray<Rule>,
  opts?: RouterOptions,
): MemoryRouter {
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

  const search: MemoryRouter["search"] = (args) => {
    const requestedTopK = args.topK ?? 10
    // Scope filtering happens after ranking because legacy vector rows have no
    // scope columns. Over-fetch keeps a few private rows from starving an
    // otherwise valid result set while preserving backend compatibility.
    const backendArgs =
      args.scope !== undefined
        ? { ...args, topK: Math.max(requestedTopK * 4, 20) }
        : args
    const inner = ((): Stream.Stream<
      { readonly record: MemoryRecord; readonly score: number },
      MemoryBackendError
    > => {
      if (args.namespace !== undefined) {
        const backend = backendFor(args.namespace)
        if (!hasVectorSearch(backend)) {
          return Stream.fail(
            new MemoryBackendError({
              backend: "router",
              op: "search",
              namespace: args.namespace,
              cause: new Error(
                `no vector backend for namespace ${args.namespace}`,
              ),
            }),
          )
        }
        return backend.search(backendArgs)
      }
      // No namespace → fan out across every vector-capable backend.
      const vecBackends = rules
        .map((r) => r.backend)
        .filter(hasVectorSearch)
      if (vecBackends.length === 0) {
        return Stream.fail(
          new MemoryBackendError({
            backend: "router",
            op: "search",
            cause: new Error("no vector backends registered"),
          }),
        )
      }
      const streams = vecBackends.map((b) => b.search(backendArgs))
      return Stream.mergeAll(streams, { concurrency: vecBackends.length })
    })()

    const scoped =
      args.scope === undefined
        ? inner
        : inner.pipe(
            Stream.filter((hit) => matchesMemoryScope(hit.record, args.scope!)),
            Stream.take(requestedTopK),
          )

    if (opts === undefined) return scoped

    // Instrumented path: accumulate per-call stats via Stream.tap, then emit
    // a RetrievalCallEvent once when the stream terminates. Status flips to
    // "error" via Stream.tapError; success is the default (interruption is
    // treated as success since no error occurred).
    const startMs = Date.now()
    let candidateCount = 0
    let topScore: number | undefined
    let status: "success" | "error" = "success"

    const emit = Effect.gen(function* () {
      const ts = yield* opts.clock.nowIso()
      const queryDigest = createHash("sha256")
        .update(args.queryText)
        .digest("hex")
        .slice(0, 16)
      yield* opts.observability.emit({
        ts,
        kind: "RetrievalCall",
        level: "info",
        mode: args.mode ?? "vec",
        queryDigest,
        embedderProvider: opts.embedderInfo.provider,
        embedderModel: opts.embedderInfo.model,
        embedderDimension: opts.embedderInfo.dimension,
        candidateCount,
        ...(topScore !== undefined ? { topScore } : {}),
        ...(args.namespace !== undefined ? { namespace: args.namespace } : {}),
        durationMs: Date.now() - startMs,
        status,
      })
    })

    return scoped.pipe(
      Stream.tap((hit) =>
        Effect.sync(() => {
          candidateCount++
          if (topScore === undefined || hit.score > topScore) {
            topScore = hit.score
          }
        }),
      ),
      Stream.tapError(() => Effect.sync(() => { status = "error" })),
      Stream.ensuring(emit),
    )
  }

  return { put, get, query, delete: del, backendFor, exportAll, search }
}

/**
 * MemoryRouterTag — Effect Context Tag for the MemoryRouter.
 *
 * Additive in Phase 25b; the existing `MemoryRouter` interface and
 * `makeRouter` factory are unchanged. Use the `MemoryLayer` composition
 * helper (`./layer.ts`) to build a Layer that provides this Tag.
 *
 * Note: uses `Context.GenericTag` rather than `Effect.Tag` because the
 * Service identity is structural (the `MemoryRouter` interface), not a
 * class wrapping its own implementation — mirroring the SDKAdapter
 * Tag-aliasing convention in `packages/core/src/session/session-service.ts`.
 */
export const MemoryRouterTag = Context.GenericTag<MemoryRouter>(
  "luna/MemoryRouter",
)
