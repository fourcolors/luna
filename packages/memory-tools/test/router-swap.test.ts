/**
 * S04 router-swap E2E - the actual swap proof (see DESIGN.md §10.6).
 *
 * A second, test-only `MemoryVectorBackend` (`TestVectorBackend`, defined in
 * packages/memory/test/backend-contract.ts) serves `memory_search` through
 * the agent-facing path, driven through `MemoryToolsLayer` itself (not just
 * `makeMemoryTools` + a router resolved by hand):
 *
 *   1. `MemoryToolsLayerOptions.routerLayer` swaps the router's backend at
 *      `MemoryToolsLayer`'s own composition point -
 *      `MemoryToolsLayer({ routerLayer, dbPath: UNOPENABLE_DB_PATH })` builds
 *      successfully even though `dbPath` alone could never open. If
 *      `routerLayer` were ever silently ignored and `MemoryToolsLayer` fell
 *      back to `MemoryRouterLayer(dbPath)`, this build would fail in BOTH
 *      the bun and vitest-node lanes (see UNOPENABLE_DB_PATH below).
 *   2. The tool handlers are pulled off the real SDK `McpServer` instance
 *      `config.server` produces (`instance._registeredTools[name].handler`),
 *      the same introspection packages/local-shell-tools/test/mcp-structure.test.ts
 *      and packages/tools/test/define-tool-package.test.ts already use, and
 *      driven through the real `defineTool` SDK-boundary wrapper.
 *   3. The injected backend is wrapped to record every `mode` it receives,
 *      and the test asserts it saw `"hybrid"` - `memory_search` hardcodes
 *      `mode: "hybrid"` (tools.ts:277).
 *   4. Three records with different token overlap against the query are
 *      saved before searching, and the returned hit order is asserted, so
 *      "returns ranked results" is exercised rather than trivially true of
 *      a one-element result set.
 *
 * Deploy note: TestVectorBackend is test-only (packages/memory/test/) and
 * never ships in production wiring - a second production backend with one
 * consumer is the speculative abstraction NEXT.md decision 2 forbids.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Clock, ObservabilityService, StubEmbedderLayer } from "@luna/core"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import {
  BackendUnderTest,
  runMemoryBackendContract,
  TestVectorBackend,
} from "../../memory/test/backend-contract.js"
import {
  makeMemoryRouterLayer,
  MemoryToolsLayer,
  MemoryToolsService,
} from "../src/layer.js"

interface ToolCallResult {
  readonly content?: ReadonlyArray<{ type: string; text: string }>
  readonly isError?: boolean
}

type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<ToolCallResult>

function parseTextResult<T>(r: ToolCallResult): T {
  expect(r.isError).toBeFalsy()
  const first = r.content?.[0]
  expect(first?.type).toBe("text")
  return JSON.parse((first as { text: string }).text) as T
}

/**
 * Pull a registered tool's real handler off the SDK `McpServer` instance
 * `defineToolPackage` produces - the same introspection
 * packages/local-shell-tools/test/mcp-structure.test.ts and
 * packages/tools/test/define-tool-package.test.ts use, so this test drives
 * the actual boot artifact rather than a handler built by hand.
 */
function registeredHandler(server: unknown, toolName: string): ToolHandler {
  const instance = (server as { instance?: { _registeredTools?: Record<string, unknown> } })
    .instance
  const tool = instance?._registeredTools?.[toolName] as { handler: ToolHandler } | undefined
  if (tool === undefined) {
    throw new Error(`tool "${toolName}" is not registered on this MCP server instance`)
  }
  return tool.handler
}

// A dbPath no sqlite driver can open: the parent directory does not exist,
// and (unlike resolveDbPath()) MemoryToolsLayer never mkdirp's a
// caller-supplied dbPath (see layer.ts's comment at the routerLayer
// Layer.provide call). This makes "routerLayer was honored, not silently
// ignored" an assertional, lane-independent proof: under bun, falling back
// to MemoryRouterLayer(dbPath) would throw opening this path; under
// vitest-node, the missing bun:sqlite module throws first. Either way, a
// regression that stopped honoring routerLayer fails the build in BOTH
// lanes, not just incidentally in one.
const UNOPENABLE_DB_PATH = "/nonexistent-s04-swap-proof/unreachable/memory.db"

// MemoryLayer (not the backend) always needs these three - matches
// packages/memory-tools/test/layer.test.ts's supportLayer.
const supportLayer = Layer.mergeAll(
  ObservabilityService.Default.pipe(Layer.provide(Clock.Default)),
  StubEmbedderLayer,
  Clock.Default,
)

/**
 * Build a routerLayer over TestVectorBackend that also records every `mode`
 * the backend's `search` receives, so the test can assert the agent-facing
 * path actually requested `"hybrid"` (tools.ts hardcodes it) rather than
 * merely that SOME mode happened to return hits.
 */
function makeSpyingRouterLayer(modesSeen: string[]) {
  return Layer.unwrapEffect(
    Effect.gen(function* () {
      const backend = yield* TestVectorBackend
      const spying: typeof backend = {
        ...backend,
        search: (args) => {
          modesSeen.push(args.mode ?? "vec")
          return backend.search(args)
        },
      }
      return makeMemoryRouterLayer(Layer.succeed(TestVectorBackend, spying), TestVectorBackend)
    }),
  ).pipe(Layer.provide(TestVectorBackend.Default))
}

// TestVectorBackend's own keyed+search surface satisfies the shared
// MemoryBackend contract (this is the piece the router-swap E2E below
// doesn't cover - that drives put + search only).
runMemoryBackendContract("TestVectorBackend", () =>
  Layer.effect(BackendUnderTest, TestVectorBackend).pipe(
    Layer.provide(TestVectorBackend.Default),
  ),
)

describe("S04 router-swap E2E - a second MemoryVectorBackend through MemoryToolsLayer", () => {
  it("MemoryToolsLayer({ routerLayer }) builds a working MemoryToolsService with an unopenable dbPath", async () => {
    const routerLayer = makeSpyingRouterLayer([])
    // LunaSqliteBootstrapLive is only supplied to satisfy MemoryToolsLayer's
    // declared R (unchanged regardless of routerLayer, see layer.ts and
    // DESIGN.md §10.6) - the TestVectorBackend build path never touches it.
    const layer = MemoryToolsLayer({
      routerLayer,
      embedder: StubEmbedderLayer,
      dbPath: UNOPENABLE_DB_PATH,
    }).pipe(Layer.provide(supportLayer), Layer.provide(LunaSqliteBootstrapLive))

    const config = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* MemoryToolsService
        }),
      ).pipe(Effect.provide(layer)),
    )

    expect(config.serverName).toBe("memory")
    expect(typeof config.server).toBe("object")
    expect((config.server as { type?: string }).type).toBe("sdk")
    expect((config.server as { name?: string }).name).toBe("memory")
  })

  it("memory_search returns ranked hits from the injected backend, driven through MemoryToolsLayer's registered tool handlers", async () => {
    const modesSeen: string[] = []
    const routerLayer = makeSpyingRouterLayer(modesSeen)
    const layer = MemoryToolsLayer({
      routerLayer,
      embedder: StubEmbedderLayer,
      dbPath: UNOPENABLE_DB_PATH,
    }).pipe(Layer.provide(supportLayer), Layer.provide(LunaSqliteBootstrapLive))

    // ManagedRuntime keeps every Layer's scope (ObservabilityService's
    // PubSub included) alive across BOTH handler invocations below -
    // matches tools.test.ts's and S03's router tests' rationale exactly: a
    // plain Effect.runPromise that resolves config and returns closes the
    // Layer scope immediately after.
    const runtime = ManagedRuntime.make(layer)
    try {
      const config = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* MemoryToolsService
        }),
      )

      const save = registeredHandler(config.server, "memory_save")
      const search = registeredHandler(config.server, "memory_search")

      const saved = parseTextResult<{ id: string }>(
        await save({ text: "the quarterly review happened on Tuesday" }, undefined),
      )
      expect(saved.id).toMatch(/^mem_/)
      // Two distractors with progressively less token overlap against the
      // query below, so "returns ranked results" is exercised - a single
      // saved record would make hits[0] trivially the only element.
      await save({ text: "quarterly planning starts next week" }, undefined)
      await save({ text: "the weather was fine on Tuesday" }, undefined)

      const hits = parseTextResult<ReadonlyArray<{ id: string; text: string; score: number }>>(
        await search({ query: "quarterly review" }, undefined),
      )

      expect(hits.length).toBeGreaterThan(1)
      expect(hits[0]!.id).toBe(saved.id)
      expect(hits[0]!.text).toContain("quarterly review")
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
      }
      // memory_search hardcodes mode:"hybrid" - assert the injected backend
      // actually received it through the full MemoryToolsLayer path.
      expect(modesSeen).toContain("hybrid")
    } finally {
      await runtime.dispose()
    }
  })
})
