/**
 * Memory tools Tier-1 tests.
 *
 *   1. save → search roundtrip (StubEmbedder, in-memory sqlite)
 *   2. delete removes a previously-saved record
 *   3. default embedder selection is StubEmbedder when env is unset
 *   4. LUNA_EMBEDDER=ollama selects the Ollama Layer
 *      (skipped when the daemon isn't reachable)
 *
 * Tests 1 + 2 invoke the SDK tool handlers directly — that's the same
 * boundary the agent crosses, and it exercises the full Effect → SDK
 * promise translation. They run inside a single Layer scope so the
 * three handlers share the same router/backend/db.
 *
 * Tests 3 + 4 verify embedder selection by inspecting the resolved
 * EmbedderService.provider tag rather than hitting the live network.
 *
 * Skipped under stock node (no bun:sqlite) — same gate as the rest of
 * the @luna/memory test suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import {
  Clock,
  EmbedderService,
  ObservabilityService,
  RerankError,
  StubEmbedderLayer,
  type MemoryRerankerApi,
  type RerankScore,
} from "@luna/core"
import {
  LunaSqliteBootstrapLive,
  MemoryRouterTag,
  SqliteVectorBackend,
  MemoryLayer,
  makeRecord,
  type MemoryRouter,
} from "@luna/memory"
import { makeMemoryTools } from "../src/tools.js"
import { selectEmbedderLayer } from "../src/layer.js"

const hasBunSqlite = (() => {
  return typeof (process.versions as { bun?: string }).bun === "string"
})()

interface ToolCallResult {
  // `text?:` (not `text:`) because content blocks are a union (text/image/
  // audio/resource) and only the text variant carries `text` - matches the
  // real SDK CallToolResult shape closely enough for the `as { text: string }`
  // cast below to stay valid on the text blocks these tests actually parse.
  readonly content?: ReadonlyArray<{ type: string; text?: string }>
  readonly isError?: boolean | undefined
}

function parseTextResult<T>(r: ToolCallResult): T {
  expect(r.isError).toBeFalsy()
  const first = r.content?.[0]
  expect(first?.type).toBe("text")
  return JSON.parse((first as { text: string }).text) as T
}

// InferShape marks kind/tags/limit/namespace as required-but-possibly-
// undefined keys under exactOptionalPropertyTypes, so every handler call
// must pass them explicitly even when omitted by the caller here.
const saveArgs = (a: {
  text: string
  kind?: string
  tags?: Array<string>
  namespace?: string
}) => ({ text: a.text, kind: a.kind, tags: a.tags, namespace: a.namespace })

const searchArgs = (a: {
  query: string
  kind?: string
  limit?: number
  namespace?: string
}) => ({ query: a.query, kind: a.kind, limit: a.limit, namespace: a.namespace })

describe.skipIf(!hasBunSqlite)("memory tools", () => {
  // Build the in-memory sqlite-vector router fresh per test so save/delete
  // state can't leak between cases. We use a ManagedRuntime to keep the
  // Layer scope alive across handler invocations within one test.
  const baseLayer = Layer.unwrapEffect(
    Effect.gen(function* () {
      const backend = yield* SqliteVectorBackend
      return MemoryLayer({ rules: [{ pattern: "*", backend }] })
    }),
  ).pipe(
    Layer.provideMerge(SqliteVectorBackend.fromPath(":memory:")),
    Layer.provideMerge(StubEmbedderLayer),
    Layer.provideMerge(LunaSqliteBootstrapLive),
    Layer.provideMerge(ObservabilityService.Default),
    Layer.provideMerge(Clock.Default),
  )

  let runtime: ManagedRuntime.ManagedRuntime<
    typeof MemoryRouterTag.Service,
    never
  >
  let tools: ReturnType<typeof makeMemoryTools>

  beforeEach(async () => {
    runtime = ManagedRuntime.make(baseLayer) as never
    const router = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* MemoryRouterTag
      }),
    )
    tools = makeMemoryTools(router)
  })

  afterEach(async () => {
    await runtime.dispose()
  })

  it("save with explicit kind round-trips and is surfaced on search", async () => {
    const [saveTool, searchTool] = tools

    const saved = parseTextResult<{ id: string }>(
      await saveTool.handler(
        saveArgs({ text: "Quarterly review happened last Tuesday", kind: "episodic" }),
        undefined,
      ),
    )

    const hits = parseTextResult<
      ReadonlyArray<{
        id: string
        kind: string
        createdAt: number
        updatedAt: number
      }>
    >(
      await searchTool.handler(
        searchArgs({ query: "quarterly review", kind: "episodic" }),
        undefined,
      ),
    )
    expect(hits.length).toBeGreaterThan(0)
    const hit = hits.find((h) => h.id === saved.id)
    expect(hit).toBeDefined()
    expect(hit!.kind).toBe("episodic")
    expect(typeof hit!.createdAt).toBe("number")
    expect(hit!.createdAt).toBeGreaterThan(0)
    expect(hit!.updatedAt).toBeGreaterThanOrEqual(hit!.createdAt)
  })

  it("save defaults kind to \"semantic\" when omitted", async () => {
    const [saveTool, searchTool] = tools

    const saved = parseTextResult<{ id: string }>(
      await saveTool.handler(
        saveArgs({ text: "Operator likes terse answers" }),
        undefined,
      ),
    )

    const hits = parseTextResult<
      ReadonlyArray<{ id: string; kind: string }>
    >(
      await searchTool.handler(
        searchArgs({ query: "terse answers" }),
        undefined,
      ),
    )
    const hit = hits.find((h) => h.id === saved.id)
    expect(hit).toBeDefined()
    expect(hit!.kind).toBe("semantic")
  })

    it("save → search roundtrip", async () => {
    const [saveTool, searchTool] = tools

    const saved = parseTextResult<{ id: string }>(
      await saveTool.handler(
        saveArgs({ text: "Operator prefers cats over dogs" }),
        undefined,
      ),
    )
    expect(saved.id).toMatch(/^mem_/)

    const hits = parseTextResult<
      ReadonlyArray<{ id: string; text: string; score: number }>
    >(
      await searchTool.handler(
        searchArgs({ query: "cats" }),
        undefined,
      ),
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.id).toBe(saved.id)
    expect(hits[0]!.text).toContain("cats")
  })

  it("delete removes a previously-saved record", async () => {
    const [saveTool, searchTool, delTool] = tools

    const saved = parseTextResult<{ id: string }>(
      await saveTool.handler(
        saveArgs({ text: "ephemeral memory to be deleted" }),
        undefined,
      ),
    )

    const removed = parseTextResult<{ deleted: boolean }>(
      await delTool.handler({ id: saved.id }, undefined),
    )
    expect(removed.deleted).toBe(true)

    // Search should no longer return the deleted id.
    const hits = parseTextResult<ReadonlyArray<{ id: string }>>(
      await searchTool.handler(
        searchArgs({ query: "ephemeral memory" }),
        undefined,
      ),
    )
    expect(hits.find((h) => h.id === saved.id)).toBeUndefined()

    // Second delete returns false.
    const second = parseTextResult<{ deleted: boolean }>(
      await delTool.handler({ id: saved.id }, undefined),
    )
    expect(second.deleted).toBe(false)
  })
})

describe("memory tools search mode", () => {
  it("uses hybrid search to match the tool contract", async () => {
    const calls: Array<Parameters<MemoryRouter["search"]>[0]> = []
    const router = {
      put: () => Effect.void,
      get: () => Effect.succeed(null),
      query: () => Stream.empty,
      delete: () => Effect.succeed(false),
      backendFor: () => {
        throw new Error("not used")
      },
      exportAll: () => Effect.succeed([]),
      search: (args: Parameters<MemoryRouter["search"]>[0]) => {
        calls.push(args)
        return Stream.succeed({
          record: makeRecord({
            id: "mem_test",
            namespace: args.namespace ?? "notes",
            kind: "note",
            content: { text: "hybrid hit" },
          }),
          score: 1,
        })
      },
    } satisfies MemoryRouter
    const [, searchTool] = makeMemoryTools(router)

    const hits = parseTextResult<
      ReadonlyArray<{
        id: string
        text: string
        score: number
        tags: ReadonlyArray<string>
        kind: string
        namespace: string
        createdAt: number
        updatedAt: number
      }>
    >(
      await searchTool.handler(
        searchArgs({ query: "hybrid", limit: 3, namespace: "diagnostics" }),
        undefined,
      ),
    )

    expect(hits).toHaveLength(1)
    const hit = hits[0]!
    expect(hit.id).toBe("mem_test")
    expect(hit.text).toBe("hybrid hit")
    expect(hit.score).toBe(1)
    expect(hit.tags).toEqual([])
    expect(hit.kind).toBe("note")
    expect(hit.namespace).toBe("diagnostics")
    expect(typeof hit.createdAt).toBe("number")
    expect(typeof hit.updatedAt).toBe("number")
    expect(calls).toEqual([
      {
        queryText: "hybrid",
        topK: 3,
        namespace: "diagnostics",
        mode: "hybrid",
        scope: { observerId: "luna", subjectId: "operator" },
      },
    ])
  })

  it("over-fetches and post-filters when a kind is supplied", async () => {
    const calls: Array<Parameters<MemoryRouter["search"]>[0]> = []
    const records = [
      makeRecord({
        id: "mem_sem",
        namespace: "notes",
        kind: "semantic",
        content: { text: "semantic hit" },
      }),
      makeRecord({
        id: "mem_epi",
        namespace: "notes",
        kind: "episodic",
        content: { text: "episodic hit" },
      }),
    ]
    const router = {
      put: () => Effect.void,
      get: () => Effect.succeed(null),
      query: () => Stream.empty,
      delete: () => Effect.succeed(false),
      backendFor: () => {
        throw new Error("not used")
      },
      exportAll: () => Effect.succeed([]),
      search: (args: Parameters<MemoryRouter["search"]>[0]) => {
        calls.push(args)
        return Stream.fromIterable(
          records.map((record, i) => ({ record, score: 1 - i * 0.1 })),
        )
      },
    } satisfies MemoryRouter
    const [, searchTool] = makeMemoryTools(router)

    const hits = parseTextResult<
      ReadonlyArray<{ id: string; kind: string }>
    >(
      await searchTool.handler(
        searchArgs({ query: "anything", limit: 3, kind: "episodic" }),
        undefined,
      ),
    )

    // Only the episodic record survives the post-filter.
    expect(hits).toHaveLength(1)
    expect(hits[0]!.id).toBe("mem_epi")
    expect(hits[0]!.kind).toBe("episodic")
    // Over-fetch heuristic: kind filter → max(limit*4, 20) = 20.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.topK).toBe(20)
  })
})

describe("memory tools scope isolation", () => {
  it("does not delete a private record owned by another observer", async () => {
    let deleted = false
    const foreign = makeRecord({
      id: "foreign",
      namespace: "notes",
      kind: "semantic",
      content: { text: "private helper memory" },
      scope: {
        observerId: "helper",
        subjectId: "operator",
        visibility: "private",
      },
    })
    const router = {
      put: () => Effect.void,
      get: () => Effect.succeed(foreign),
      query: () => Stream.empty,
      delete: () =>
        Effect.sync(() => {
          deleted = true
          return true
        }),
      backendFor: () => {
        throw new Error("not used")
      },
      exportAll: () => Effect.succeed([]),
      search: () => Stream.empty,
    } satisfies MemoryRouter
    const [, , deleteTool] = makeMemoryTools(router)
    const result = parseTextResult<{ deleted: boolean }>(
      await deleteTool.handler({ id: "foreign" }, undefined),
    )
    expect(result.deleted).toBe(false)
    expect(deleted).toBe(false)
  })
})

const originalFetch = globalThis.fetch

const setFetch = (fetchImpl: typeof globalThis.fetch) => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchImpl,
  })
}

const restoreFetch = () => {
  if (originalFetch === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { fetch?: typeof globalThis.fetch }).fetch
  } else {
    setFetch(originalFetch)
  }
}

const okJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as Response

// Embedder selection tests run regardless of bun (no sqlite involved).
describe("selectEmbedderLayer", () => {
  const ORIG = {
    LUNA_EMBEDDER: process.env["LUNA_EMBEDDER"],
    LUNA_OLLAMA_BASE_URL: process.env["LUNA_OLLAMA_BASE_URL"],
    LUNA_OLLAMA_EMBED_MODEL: process.env["LUNA_OLLAMA_EMBED_MODEL"],
    LUNA_OLLAMA_EMBED_DIMENSION: process.env["LUNA_OLLAMA_EMBED_DIMENSION"],
    LUNA_OLLAMA_PROBE_TIMEOUT_MS: process.env["LUNA_OLLAMA_PROBE_TIMEOUT_MS"],
    LUNA_OLLAMA_PROBE_ATTEMPTS: process.env["LUNA_OLLAMA_PROBE_ATTEMPTS"],
    LUNA_OLLAMA_PROBE_BACKOFF_MS: process.env["LUNA_OLLAMA_PROBE_BACKOFF_MS"],
    OLLAMA_HOST: process.env["OLLAMA_HOST"],
  }
  afterEach(() => {
    restoreFetch()
    for (const [key, value] of Object.entries(ORIG)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("returns Stub when LUNA_EMBEDDER is unset", async () => {
    delete process.env["LUNA_EMBEDDER"]
    const layer = selectEmbedderLayer()
    const provider = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const e = yield* EmbedderService
          return e.provider
        }),
      ).pipe(Effect.provide(layer)),
    )
    expect(provider).toBe("stub")
  })

  it("passes Ollama model and base URL from env", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      okJson({ embeddings: [[1, 0, 0]] }),
    )
    setFetch(mockFetch as unknown as typeof globalThis.fetch)

    process.env["LUNA_EMBEDDER"] = "ollama"
    process.env["LUNA_OLLAMA_BASE_URL"] = "http://ollama.example:11434"
    process.env["LUNA_OLLAMA_EMBED_MODEL"] = "qwen3-embedding:0.6b"
    process.env["LUNA_OLLAMA_EMBED_DIMENSION"] = "3"
    const layer = selectEmbedderLayer()

    const provider = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const e = yield* EmbedderService
          return e.provider
        }),
      ).pipe(Effect.provide(layer)),
    )

    expect(provider).toBe("ollama")
    expect(mockFetch).toHaveBeenCalledWith(
      "http://ollama.example:11434/api/embed",
      expect.objectContaining({
        body: JSON.stringify({
          model: "qwen3-embedding:0.6b",
          input: "ping",
        }),
      }),
    )
  })

  it("clamps LUNA_OLLAMA_PROBE_ATTEMPTS at 5 even when env asks for more", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network down"))
    setFetch(mockFetch as unknown as typeof globalThis.fetch)

    process.env["LUNA_EMBEDDER"] = "ollama"
    process.env["LUNA_OLLAMA_EMBED_DIMENSION"] = "3"
    process.env["LUNA_OLLAMA_PROBE_ATTEMPTS"] = "10"
    process.env["LUNA_OLLAMA_PROBE_BACKOFF_MS"] = "1"
    const layer = selectEmbedderLayer()

    // Known dimension + persistent failure -> degrades non-fatally, but the
    // clamp must still cap real attempts at 5, not the requested 10.
    const provider = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const e = yield* EmbedderService
          return e.provider
        }),
      ).pipe(Effect.provide(layer)),
    )
    expect(provider).toBe("ollama")
    expect(mockFetch).toHaveBeenCalledTimes(5)
  })

  it("rejects a junk LUNA_OLLAMA_PROBE_ATTEMPTS and falls back to the default of 3", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network down"))
    setFetch(mockFetch as unknown as typeof globalThis.fetch)

    process.env["LUNA_EMBEDDER"] = "ollama"
    process.env["LUNA_OLLAMA_PROBE_ATTEMPTS"] = "not-a-number"
    process.env["LUNA_OLLAMA_PROBE_BACKOFF_MS"] = "1"
    // No declared dimension -> degrade path can't engage, so this proves
    // the attempt count directly: exactly 3 fetch calls, then fatal.
    const layer = selectEmbedderLayer()

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const e = yield* EmbedderService
            return e.provider
          }),
        ).pipe(Effect.provide(layer)),
      ),
    ).rejects.toBeTruthy()
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  // Live Ollama path: opt-in only. A local daemon can be reachable while the
  // default embedding model is absent, which should not make unit tests flaky.
  it("returns Ollama when LUNA_EMBEDDER=ollama and daemon is reachable", async () => {
    if (process.env["LUNA_TEST_OLLAMA"] !== "1") {
      console.warn("[memory-tools] skipping Ollama test — set LUNA_TEST_OLLAMA=1")
      return
    }
    let reachable = false
    try {
      const res = await fetch("http://127.0.0.1:11434/", {
        signal: AbortSignal.timeout(500),
      })
      reachable = res.ok || res.status < 500
    } catch {
      reachable = false
    }
    if (!reachable) {
      // Match the it.skipIf semantics without needing the value at module load.
      console.warn("[memory-tools] skipping Ollama test — daemon unreachable")
      return
    }
    process.env["LUNA_EMBEDDER"] = "ollama"
    const layer = selectEmbedderLayer()
    const provider = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const e = yield* EmbedderService
          return e.provider
        }),
      ).pipe(Effect.provide(layer)),
    )
    expect(provider).toBe("ollama")
  })
})

// ---------------------------------------------------------------------------
// memory_search reranking (Phase 3, PR #332 bench) - LUNA_MEMORY_RERANK gate,
// fallback-on-failure, and the unscored-candidate-stays-ungated policy.
// ---------------------------------------------------------------------------
describe.skipIf(!hasBunSqlite)("memory_search reranking", () => {
  const baseLayer = Layer.unwrapEffect(
    Effect.gen(function* () {
      const backend = yield* SqliteVectorBackend
      return MemoryLayer({ rules: [{ pattern: "*", backend }] })
    }),
  ).pipe(
    Layer.provideMerge(SqliteVectorBackend.fromPath(":memory:")),
    Layer.provideMerge(StubEmbedderLayer),
    Layer.provideMerge(LunaSqliteBootstrapLive),
    Layer.provideMerge(ObservabilityService.Default),
    Layer.provideMerge(Clock.Default),
  )

  let runtime: ManagedRuntime.ManagedRuntime<typeof MemoryRouterTag.Service, never>
  let router: MemoryRouter

  beforeEach(async () => {
    runtime = ManagedRuntime.make(baseLayer) as never
    router = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* MemoryRouterTag
      }),
    )
    delete process.env["LUNA_MEMORY_RERANK"]
    delete process.env["LUNA_RERANK_THRESHOLD"]
  })

  afterEach(async () => {
    await runtime.dispose()
    delete process.env["LUNA_MEMORY_RERANK"]
    delete process.env["LUNA_RERANK_THRESHOLD"]
    delete process.env["LUNA_RERANK_MAX_CANDIDATES"]
  })

  const seedRecords = async (records: ReadonlyArray<{ id: string; text: string }>) => {
    for (const r of records) {
      await runtime.runPromise(
        router.put(
          makeRecord({ id: r.id, namespace: "notes", kind: "semantic", content: { text: r.text } }),
        ),
      )
    }
  }

  const fakeRerankerOf = (scoresById: Record<string, number>): MemoryRerankerApi => ({
    rerank: (args) =>
      Effect.succeed(
        args.candidates
          .filter((c) => c.id in scoresById)
          .map((c): RerankScore => ({ id: c.id, llmScore: scoresById[c.id]! })),
      ),
  })

  const failingReranker = (): MemoryRerankerApi => ({
    rerank: () =>
      Effect.fail(new RerankError({ op: "timeout", message: "simulated rerank timeout" })),
  })

  it("flag OFF: does not call the reranker even when one is provided (byte-identical to before)", async () => {
    await seedRecords([
      { id: "m1", text: "operator likes espresso" },
      { id: "m2", text: "operator dislikes decaf" },
    ])
    let called = false
    const reranker: MemoryRerankerApi = {
      rerank: () => {
        called = true
        return Effect.succeed([])
      },
    }
    const [, searchTool] = makeMemoryTools(router, undefined, { reranker })
    const hits = parseTextResult<ReadonlyArray<{ id: string; llmScore?: number }>>(
      await searchTool.handler(
        searchArgs({ query: "espresso" }),
        undefined,
      ),
    )
    expect(called).toBe(false)
    expect(hits.every((h) => h.llmScore === undefined)).toBe(true)
  })

  it("flag ON: reranks and drops junk below the threshold", async () => {
    await seedRecords([
      { id: "good", text: "operator's favorite coffee is espresso" },
      { id: "junk", text: "the weather in Lisbon was sunny yesterday" },
    ])
    process.env["LUNA_MEMORY_RERANK"] = "1"
    process.env["LUNA_RERANK_THRESHOLD"] = "75"
    const reranker = fakeRerankerOf({ good: 92, junk: 10 })
    const [, searchTool] = makeMemoryTools(router, undefined, { reranker })
    const hits = parseTextResult<ReadonlyArray<{ id: string; llmScore?: number }>>(
      await searchTool.handler(
        searchArgs({ query: "favorite coffee" }),
        undefined,
      ),
    )
    expect(hits.map((h) => h.id)).toEqual(["good"])
    expect(hits[0]!.llmScore).toBe(92)
  })

  it("flag ON: HARD-caps reranked candidates at LUNA_RERANK_MAX_CANDIDATES even when limit exceeds it", async () => {
    // Seed 6 records so retrieval yields a pool larger than the cap.
    await seedRecords(
      Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, text: `record number ${i} about coffee` })),
    )
    process.env["LUNA_MEMORY_RERANK"] = "1"
    process.env["LUNA_RERANK_MAX_CANDIDATES"] = "3"
    process.env["LUNA_RERANK_THRESHOLD"] = "0"
    let sentIds: ReadonlyArray<string> = []
    const spy: MemoryRerankerApi = {
      rerank: (args) => {
        sentIds = args.candidates.map((c) => c.id)
        return Effect.succeed(args.candidates.map((c) => ({ id: c.id, llmScore: 90 })))
      },
    }
    const [, searchTool] = makeMemoryTools(router, undefined, { reranker: spy })
    const hits = parseTextResult<ReadonlyArray<{ id: string }>>(
      // limit 6 > cap 3: the cap must WIN (latency bound), not be raised to limit.
      await searchTool.handler(
        searchArgs({ query: "coffee", limit: 6 }),
        undefined,
      ),
    )
    // Exactly the cap reaches the reranker, despite limit=6 and 6 records
    // seeded (so the retrieved pool genuinely exceeded the cap of 3).
    expect(sentIds.length).toBe(3)
    // Out-of-cap candidates never appear in the reranked (returned) output.
    const rerankedIds = new Set(sentIds)
    expect(hits.every((h) => rerankedIds.has(h.id))).toBe(true)
    expect(hits.length).toBe(3)
  })

  it("flag ON: unscored candidates (reranker returned nothing for them) survive ungated at the tail", async () => {
    await seedRecords([
      { id: "scored-low", text: "irrelevant record" },
      { id: "unscored", text: "another record the reranker never scored" },
    ])
    process.env["LUNA_MEMORY_RERANK"] = "1"
    process.env["LUNA_RERANK_THRESHOLD"] = "75"
    // Only "scored-low" comes back, below threshold -> dropped. "unscored" is
    // never mentioned by the reranker -> must still be returned (ungated).
    const reranker = fakeRerankerOf({ "scored-low": 5 })
    const [, searchTool] = makeMemoryTools(router, undefined, { reranker })
    const hits = parseTextResult<ReadonlyArray<{ id: string; llmScore?: number }>>(
      await searchTool.handler(
        searchArgs({ query: "record", limit: 10 }),
        undefined,
      ),
    )
    expect(hits.map((h) => h.id)).toEqual(["unscored"])
    expect(hits[0]!.llmScore).toBeUndefined()
  })

  it("flag ON: falls back to un-reranked order when the reranker fails", async () => {
    await seedRecords([
      { id: "m1", text: "operator likes espresso" },
      { id: "m2", text: "operator likes tea" },
    ])
    process.env["LUNA_MEMORY_RERANK"] = "1"
    const [, searchTool] = makeMemoryTools(router, undefined, { reranker: failingReranker() })
    const hits = parseTextResult<ReadonlyArray<{ id: string; llmScore?: number }>>(
      await searchTool.handler(
        searchArgs({ query: "espresso" }),
        undefined,
      ),
    )
    // Falls back to plain hybrid search - still returns results, none reranked.
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.llmScore === undefined)).toBe(true)
  })

  it("flag ON: falls back to un-reranked order when the reranker DIES (defect, not typed error)", async () => {
    await seedRecords([
      { id: "m1", text: "operator likes espresso" },
      { id: "m2", text: "operator likes tea" },
    ])
    process.env["LUNA_MEMORY_RERANK"] = "1"
    const dyingReranker: MemoryRerankerApi = {
      rerank: () => Effect.die(new Error("unexpected plumbing throw")),
    }
    const [, searchTool] = makeMemoryTools(router, undefined, { reranker: dyingReranker })
    const hits = parseTextResult<ReadonlyArray<{ id: string; llmScore?: number }>>(
      await searchTool.handler(
        searchArgs({ query: "espresso" }),
        undefined,
      ),
    )
    // A defect must degrade exactly like a typed RerankError - memory_search
    // never fails because reranking failed.
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.llmScore === undefined)).toBe(true)
  })

  it("no reranker provided + flag ON: behaves exactly as flag OFF (no reranker to call)", async () => {
    await seedRecords([{ id: "m1", text: "operator likes espresso" }])
    process.env["LUNA_MEMORY_RERANK"] = "1"
    const [, searchTool] = makeMemoryTools(router) // no options -> no reranker
    const hits = parseTextResult<ReadonlyArray<{ id: string; llmScore?: number }>>(
      await searchTool.handler(
        searchArgs({ query: "espresso" }),
        undefined,
      ),
    )
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.llmScore === undefined)).toBe(true)
  })
})
