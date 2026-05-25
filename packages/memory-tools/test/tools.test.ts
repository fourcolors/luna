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
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { EmbedderService, StubEmbedderLayer } from "@luna/core"
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
  readonly content?: ReadonlyArray<{ type: string; text: string }>
  readonly isError?: boolean
}

function parseTextResult<T>(r: ToolCallResult): T {
  expect(r.isError).toBeFalsy()
  const first = r.content?.[0]
  expect(first?.type).toBe("text")
  return JSON.parse((first as { text: string }).text) as T
}

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

  it("save → search roundtrip", async () => {
    const [saveTool, searchTool] = tools

    const saved = parseTextResult<{ id: string }>(
      await saveTool.handler(
        { text: "Operator prefers cats over dogs" },
        undefined,
      ),
    )
    expect(saved.id).toMatch(/^mem_/)

    const hits = parseTextResult<
      ReadonlyArray<{ id: string; text: string; score: number }>
    >(
      await searchTool.handler(
        { query: "cats" },
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
        { text: "ephemeral memory to be deleted" },
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
        { query: "ephemeral memory" },
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

    const hits = parseTextResult<ReadonlyArray<{ id: string; text: string }>>(
      await searchTool.handler(
        { query: "hybrid", limit: 3, namespace: "diagnostics" },
        undefined,
      ),
    )

    expect(hits).toEqual([
      { id: "mem_test", text: "hybrid hit", score: 1, tags: [] },
    ])
    expect(calls).toEqual([
      {
        queryText: "hybrid",
        topK: 3,
        namespace: "diagnostics",
        mode: "hybrid",
      },
    ])
  })
})

// Embedder selection tests run regardless of bun (no sqlite involved).
describe("selectEmbedderLayer", () => {
  const ORIG = process.env["LUNA_EMBEDDER"]
  afterEach(() => {
    if (ORIG === undefined) delete process.env["LUNA_EMBEDDER"]
    else process.env["LUNA_EMBEDDER"] = ORIG
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

  // Ollama path: skip if the daemon isn't reachable. selectEmbedderLayer's
  // ollama Layer probes during construction, so a missing daemon would
  // fail the whole effect. Probe lazily inside the test.
  it("returns Ollama when LUNA_EMBEDDER=ollama and daemon is reachable", async () => {
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
