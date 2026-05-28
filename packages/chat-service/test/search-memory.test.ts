/**
 * ChatService.searchMemory — unit tests.
 *
 * Strategy: provide a fake MemoryRouter via Layer.succeed(MemoryRouterTag, …)
 * and drive ChatService.Default with the same baseLayer pattern used in
 * chat-service.sim.test.ts. SDKClient.fake is included because
 * ChatService.Default requires SDKAdapter which requires SDKClient.
 */
import { afterAll, describe, expect, it } from "vitest"
import { Chunk, Effect, Layer, Stream } from "effect"
import { unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  TelemetryService,
  MemoryBackendError,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import { ChatService } from "../src/index.js"

/* -------------------------------------------------------------------------- */
/* Shared test infrastructure (mirrors chat-service.sim.test.ts)              */
/* -------------------------------------------------------------------------- */

const testClock = CoreClock.Test(1_700_000_000_000)
const obsJsonlPath = join(
  tmpdir(),
  `luna-search-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
)

afterAll(() => {
  try {
    unlinkSync(obsJsonlPath)
  } catch {
    /* ignore */
  }
})

const obsLayer = ObservabilityService.makeLayer({
  logToConsole: false,
  jsonlPath: obsJsonlPath,
}).pipe(Layer.provide(testClock))

const telemetryLayer = TelemetryService.makeLayer().pipe(
  Layer.provide(testClock),
)

const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  testClock,
  obsLayer,
  telemetryLayer,
)

// A no-op SDKClient — searchMemory never talks to the SDK, but
// ChatService.Default requires SDKAdapter which requires SDKClient.
const noopSdkLayer = SDKClient.fake(() => {
  throw new Error("SDKClient.fake: not used in searchMemory tests")
})

/* -------------------------------------------------------------------------- */
/* Fake MemoryRouter factory                                                   */
/* -------------------------------------------------------------------------- */

type SearchResult = {
  readonly record: {
    id: string
    namespace: string
    kind: string
    content: unknown
    schemaVersion: number
    createdAt: number
    updatedAt: number
    tags: string[]
  }
  readonly score: number
}

const makeFakeRouter = (
  results: Array<{ id: string; kind: string; content: unknown; score: number }>,
): MemoryRouter => ({
  search: (_args) =>
    Stream.fromIterable(
      results.map(
        (r): SearchResult => ({
          record: {
            id: r.id,
            namespace: "default",
            kind: r.kind,
            content: r.content,
            schemaVersion: 1,
            createdAt: 0,
            updatedAt: 0,
            tags: [],
          },
          score: r.score,
        }),
      ),
    ) as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("router.put unused in searchMemory tests"),
  get: () => Effect.die("router.get unused in searchMemory tests"),
  query: () => Stream.die("router.query unused in searchMemory tests"),
  delete: () => Effect.die("router.delete unused in searchMemory tests"),
  backendFor: () => {
    throw new Error("router.backendFor unused in searchMemory tests")
  },
  exportAll: () => Effect.die("router.exportAll unused in searchMemory tests"),
})

/* -------------------------------------------------------------------------- */
/* Layer builder — merges ChatService.Default with a given MemoryRouter       */
/* -------------------------------------------------------------------------- */

const makeTestLayer = (router: MemoryRouter) =>
  Layer.provideMerge(
    ChatService.Default,
    Layer.provideMerge(
      SDKAdapter.Default,
      Layer.mergeAll(
        noopSdkLayer,
        baseLayer,
        Layer.succeed(MemoryRouterTag, router),
      ),
    ),
  )

const runWith = <A>(
  program: Effect.Effect<A, never, ChatService>,
  router: MemoryRouter,
): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(makeTestLayer(router))))

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("ChatService.searchMemory", () => {
  it("returns hits with content coerced to string for string content", async () => {
    const router = makeFakeRouter([
      { id: "m1", kind: "feedback", content: "hello world", score: 0.9 },
      { id: "m2", kind: "project", content: "another", score: 0.8 },
    ])

    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "hello", topK: 5 })
    })

    const result = await runWith(program, router)
    if ("error" in result)
      throw new Error(`expected hits, got error: ${result.error.message}`)
    expect(result.hits.length).toBe(2)
    expect(result.hits[0]).toEqual({
      id: "m1",
      kind: "feedback",
      content: "hello world",
      score: 0.9,
    })
  })

  it("coerces non-string content via JSON.stringify", async () => {
    const router = makeFakeRouter([
      {
        id: "m1",
        kind: "feedback",
        content: { note: "structured" },
        score: 0.7,
      },
    ])

    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "x", topK: 5 })
    })

    const result = await runWith(program, router)
    if ("error" in result) throw new Error("expected hits")
    expect(result.hits[0]?.content).toBe('{"note":"structured"}')
  })

  it("returns error with kind=no-vector-backend when search fails with that message", async () => {
    const failRouter: MemoryRouter = {
      ...makeFakeRouter([]),
      search: () =>
        Stream.fail(
          new MemoryBackendError({
            backend: "router",
            op: "search",
            cause: new Error("no vector backends registered"),
          }),
        ),
    }

    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "x", topK: 5 })
    })

    const result = await runWith(program, failRouter)
    if (!("error" in result)) throw new Error("expected error")
    expect(result.error.kind).toBe("no-vector-backend")
    expect(result.error.message).toContain("no vector backends")
  })

  it("returns error with kind=internal for other failures", async () => {
    const failRouter: MemoryRouter = {
      ...makeFakeRouter([]),
      search: () =>
        Stream.fail(
          new MemoryBackendError({
            backend: "sqlite",
            op: "search",
            cause: new Error("DB locked"),
          }),
        ),
    }

    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "x", topK: 5 })
    })

    const result = await runWith(program, failRouter)
    if (!("error" in result)) throw new Error("expected error")
    expect(result.error.kind).toBe("internal")
    expect(result.error.message).toContain("DB locked")
  })

  it("uses topK=10 default when omitted", async () => {
    let receivedTopK: number | undefined

    const capturingRouter: MemoryRouter = {
      ...makeFakeRouter([]),
      search: (args) => {
        receivedTopK = args.topK
        return Stream.empty as ReturnType<MemoryRouter["search"]>
      },
    }

    const program = Effect.gen(function* () {
      const svc = yield* ChatService
      return yield* svc.searchMemory({ queryText: "x" })
    })

    await runWith(program, capturingRouter)
    expect(receivedTopK).toBe(10)
  })
})
