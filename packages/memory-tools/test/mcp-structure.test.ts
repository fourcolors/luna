/**
 * §4.3 Memory tools MCP structural assertion (rescoped).
 *
 * A real MCP tool invocation through a fake Claude Agent SDK is not
 * achievable in vitest — the SDK would need to be running for real.
 * Instead we assert structural invariants at build time:
 *
 *   1. MemoryToolsLayer() builds successfully and provides a
 *      MemoryToolsService with the expected shape.
 *   2. buildMemoryMcpServer(router) returns a McpSdkServerConfigWithInstance
 *      with type "sdk" and name "memory".
 *   3. makeMemoryTools(router) exposes exactly
 *      ["memory_save", "memory_search", "memory_delete"] in that order.
 *
 * Tests run under bun (bun:sqlite required for SqliteVectorBackend).
 * The LunaSqliteBootstrapLive layer is provided so the SqliteVectorBackend
 * bootstrap race (Phase 27a) is handled correctly.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Option } from "effect"
import {
  Clock,
  FakeReranker,
  MemoryReranker,
  ObservabilityService,
  StubEmbedderLayer,
} from "@luna/core"
import {
  MemoryRouterTag,
  SqliteVectorBackend,
  MemoryLayer,
} from "@luna/memory"
import { LunaSqliteBootstrapLive } from "@luna/memory"
import {
  MemoryToolsLayer,
  MemoryToolsService,
  buildMemoryMcpServer,
  MEMORY_SYSTEM_PROMPT_ADDENDUM,
} from "../src/layer.js"
import { makeMemoryTools } from "../src/tools.js"

const hasBunSqlite = (() =>
  typeof (process.versions as { bun?: string }).bun === "string")()

/** Minimal layer stack that mirrors what MemoryToolsLayer uses internally. */
const baseLayer = Layer.unwrap(
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

describe.skipIf(!hasBunSqlite)("§4.3 MemoryToolsLayer — structural invariants", () => {
  it("MemoryToolsLayer() builds and provides MemoryToolsService with correct shape", async () => {
    // MemoryToolsLayer requires LunaSqliteBootstrap in its R channel.
    const layer = MemoryToolsLayer({ dbPath: ":memory:", embedder: StubEmbedderLayer }).pipe(
      Layer.provide(LunaSqliteBootstrapLive),
      Layer.provide(ObservabilityService.Default),
      Layer.provide(Clock.Default),
    )

    const config = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* MemoryToolsService
        }),
      ).pipe(Effect.provide(layer)),
    )

    // serverName is the literal "memory".
    expect(config.serverName).toBe("memory")

    // server is a non-null object (McpSdkServerConfigWithInstance).
    expect(config.server).not.toBeNull()
    expect(typeof config.server).toBe("object")

    // systemPromptAddendum is a non-empty string containing the word "memory".
    expect(typeof config.systemPromptAddendum).toBe("string")
    expect(config.systemPromptAddendum.length).toBeGreaterThan(0)
    expect(config.systemPromptAddendum.toLowerCase()).toContain("memory")

    // Matches the canonical constant.
    expect(config.systemPromptAddendum).toBe(MEMORY_SYSTEM_PROMPT_ADDENDUM)
    expect(typeof config.createSessionBinding).toBe("function")

    const first = config.createSessionBinding()
    const second = config.createSessionBinding()
    expect(first.serverName).toBe("memory")
    expect(second.serverName).toBe("memory")
    expect(first.server).not.toBe(second.server)
    expect(
      (first.server as { instance?: unknown }).instance,
    ).not.toBe((second.server as { instance?: unknown }).instance)
  })

  it("buildMemoryMcpServer(router) returns object with type='sdk' and name='memory'", async () => {
    const runtime = ManagedRuntime.make(baseLayer) as ManagedRuntime.ManagedRuntime<
      typeof MemoryRouterTag.Service,
      never
    >

    try {
      const router = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* MemoryRouterTag
        }),
      )

      const serverConfig = buildMemoryMcpServer(router)

      // McpSdkServerConfigWithInstance extends McpSdkServerConfig = { type: 'sdk'; name: string }
      expect(serverConfig).not.toBeNull()
      expect(typeof serverConfig).toBe("object")

      // type field must be "sdk" (from McpSdkServerConfig per sdk.d.ts line 933-936).
      expect((serverConfig as { type?: string }).type).toBe("sdk")

      // name field must be "memory" (passed to makeSdkMcpServer).
      expect((serverConfig as { name?: string }).name).toBe("memory")

      // instance field must be a non-null object (McpServer instance).
      expect((serverConfig as { instance?: unknown }).instance).not.toBeNull()
      expect(typeof (serverConfig as { instance?: unknown }).instance).toBe("object")
    } finally {
      await runtime.dispose()
    }
  })

  it("makeMemoryTools(router) exposes exactly [memory_save, memory_search, memory_delete]", async () => {
    const runtime = ManagedRuntime.make(baseLayer) as ManagedRuntime.ManagedRuntime<
      typeof MemoryRouterTag.Service,
      never
    >

    try {
      const router = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* MemoryRouterTag
        }),
      )

      const tools = makeMemoryTools(router)

      // Exactly 3 tools.
      expect(tools).toHaveLength(3)

      const names = tools.map((t) => (t as unknown as { name: string }).name)
      expect(names).toEqual(["memory_save", "memory_search", "memory_delete"])
    } finally {
      await runtime.dispose()
    }
  })

  it("makeMemoryTools(router) marks every memory tool as eagerly loaded", async () => {
    const runtime = ManagedRuntime.make(baseLayer) as ManagedRuntime.ManagedRuntime<
      typeof MemoryRouterTag.Service,
      never
    >

    try {
      const router = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* MemoryRouterTag
        }),
      )

      const tools = makeMemoryTools(router)

      for (const tool of tools) {
        const meta = (tool as unknown as { _meta?: Record<string, unknown> })._meta
        expect(meta).toMatchObject({ "anthropic/alwaysLoad": true })
        expect(typeof meta?.["anthropic/searchHint"]).toBe("string")
        expect((meta?.["anthropic/searchHint"] as string).length).toBeGreaterThan(0)
      }
    } finally {
      await runtime.dispose()
    }
  })
})

// The load-bearing wiring mechanism MemoryToolsLayer's rerankerLayer option
// relies on: `Effect.serviceOption(MemoryReranker)` has R=never (does NOT
// bubble MemoryReranker into the layer's declared requirements), so it only
// resolves to Some when a reranker layer was EXPLICITLY composed via
// Layer.provide directly onto the same Effect.gen - never from some far-away
// ambient layer elsewhere in a larger app's composition. Proven in isolation
// here (independent of the SDK's opaque McpServer instance, which vitest
// cannot drive - see this file's header) because it is exactly the mechanism
// packages/memory-tools/src/layer.ts's MemoryToolsLayer uses internally.
describe("Effect.serviceOption(MemoryReranker) composition (the MemoryToolsLayer wiring mechanism)", () => {
  it("resolves Some when a reranker layer is composed via Layer.provide on the same Effect.gen", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.serviceOption(MemoryReranker)
      }).pipe(Effect.provide(FakeReranker.of({ a: 90 }))),
    )
    expect(Option.isSome(result)).toBe(true)
  })

  it("resolves None when no reranker layer is provided at all", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Effect.serviceOption(MemoryReranker)
      }),
    )
    expect(Option.isNone(result)).toBe(true)
  })
})

// Non-bun structural check: MEMORY_SYSTEM_PROMPT_ADDENDUM is always defined,
// regardless of runtime.
describe("§4.3 MemoryToolsService — constant invariants (all runtimes)", () => {
  it("MEMORY_SYSTEM_PROMPT_ADDENDUM is a non-empty string containing 'memory'", () => {
    expect(typeof MEMORY_SYSTEM_PROMPT_ADDENDUM).toBe("string")
    expect(MEMORY_SYSTEM_PROMPT_ADDENDUM.length).toBeGreaterThan(0)
    expect(MEMORY_SYSTEM_PROMPT_ADDENDUM.toLowerCase()).toContain("memory")
    expect(MEMORY_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__memory__memory_save",
    )
    expect(MEMORY_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__memory__memory_search",
    )
    expect(MEMORY_SYSTEM_PROMPT_ADDENDUM).toContain(
      "mcp__memory__memory_delete",
    )
    expect(MEMORY_SYSTEM_PROMPT_ADDENDUM).toContain("fully qualified")
  })
})
