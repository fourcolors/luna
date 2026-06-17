/**
 * Regression: a thread resumed via the subscribe() restart-recovery path
 * MUST receive the same MCP tool servers a freshly-created thread gets.
 *
 * The bug: tool-wiring lived only in an app-level wrapper around the public
 * createThread. subscribe()'s cache-miss recovery calls the INTERNAL
 * createThread directly, so resumed threads came back with allowedTools set
 * but zero mcpServers — the agent "knew" the tool names but nothing
 * implemented them.
 *
 * The fix injects a ThreadToolsProvider into ChatService so every thread
 * creation (new OR resumed) gets the tool config applied at the service
 * seam, below the resume path.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer, Stream, Scope } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SessionStore,
  Clock as CoreClock,
  ObservabilityService,
  TelemetryService,
} from "@luna/core"
import { SDKAdapter, SDKClient } from "@luna/adapter-sdk"
import { MemoryRouterTag, type MemoryRouter } from "@luna/memory"
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import {
  ChatService,
  ThreadToolsProviderTag,
  type ThreadToolsProvider,
  appendThreadSessionEntry,
} from "../src/index.js"

const testClock = CoreClock.Test(1_700_000_000_000)

// A parked Query that never completes — we only care about option capture.
const makeParkedQuery = (sessionId: string) => {
  async function* gen(): AsyncGenerator<SDKMessage> {
    // Yield nothing; park forever so the consumer fiber stays alive.
    await new Promise<void>(() => {})
  }
  return {
    [Symbol.asyncIterator]: gen,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as unknown as ReturnType<SDKClient["query"]>
}

const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("noopMemoryRouter.put"),
  get: () => Effect.die("noopMemoryRouter.get"),
  query: () => Stream.die("noopMemoryRouter.query"),
  delete: () => Effect.die("noopMemoryRouter.delete"),
  backendFor: () => {
    throw new Error("noopMemoryRouter.backendFor")
  },
  exportAll: () => Effect.die("noopMemoryRouter.exportAll"),
}

describe("ChatService resume tool-wiring", () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "luna-resume-tools-"))
    process.env["LUNA_HOME"] = home
  })

  afterEach(() => {
    delete process.env["LUNA_HOME"]
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it("resumed thread (subscribe recovery) receives the provider's mcpServers", async () => {
    const threadId = "thr_resume_regression"
    const sdkSessionId = "sdk-sess-resume-123"
    // Pre-seed the persisted map so subscribe() takes the recovery branch.
    appendThreadSessionEntry(home, threadId, sdkSessionId)

    let capturedOptions: Record<string, unknown> | undefined
    const fakeLayer = SDKClient.fake((p) => {
      capturedOptions = (p.options ?? {}) as Record<string, unknown>
      return makeParkedQuery(
        (p as { sessionId?: string }).sessionId ?? "thr-?",
      )
    })

    const provider: ThreadToolsProvider = {
      decorate: () => ({
        mcpServers: { memory: { type: "sdk", instance: {} } },
        onBound: () => {},
      }),
    }

    const baseLayer = Layer.mergeAll(
      SessionStore.Default,
      testClock,
      ObservabilityService.makeLayer({
        logToConsole: false,
        jsonlPath: join(home, "events.jsonl"),
      }).pipe(Layer.provide(testClock)),
      TelemetryService.makeLayer().pipe(Layer.provide(testClock)),
      Layer.succeed(ThreadToolsProviderTag, provider),
      Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    )
    const fullLayer = Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
    )

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          // Consume one frame to trigger the cache-miss recovery, then wait
          // for the resumed SDK query to spin up and capture its options.
          yield* chat
            .subscribe(threadId)
            .pipe(Stream.take(1), Stream.runDrain)
          yield* Effect.sleep("50 millis")
        }),
      ).pipe(Effect.provide(fullLayer)),
    )

    expect(capturedOptions).toBeDefined()
    expect(capturedOptions!["mcpServers"]).toMatchObject({
      memory: { type: "sdk", instance: {} },
    })
  })

  it("new thread (createThread) applies the provider's mcpServers + merged systemPrompt", async () => {
    let capturedOptions: Record<string, unknown> | undefined
    const fakeLayer = SDKClient.fake((p) => {
      capturedOptions = (p.options ?? {}) as Record<string, unknown>
      return makeParkedQuery(
        (p as { sessionId?: string }).sessionId ?? "thr-?",
      )
    })

    const bound: string[] = []
    const provider: ThreadToolsProvider = {
      decorate: (opts) => ({
        mcpServers: { scheduler: { type: "sdk", instance: {} } },
        systemPrompt: `LUNA-IDENTITY\n\n${opts.systemPrompt ?? ""}`.trim(),
        onBound: (id) => bound.push(id),
      }),
    }

    const baseLayer = Layer.mergeAll(
      SessionStore.Default,
      testClock,
      ObservabilityService.makeLayer({
        logToConsole: false,
        jsonlPath: join(home, "events.jsonl"),
      }).pipe(Layer.provide(testClock)),
      TelemetryService.makeLayer().pipe(Layer.provide(testClock)),
      Layer.succeed(ThreadToolsProviderTag, provider),
      Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    )
    const fullLayer = Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
    )

    const created = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const summary = yield* chat.createThread({ model: "claude-test" })
          yield* Effect.sleep("50 millis")
          return summary
        }),
      ).pipe(Effect.provide(fullLayer)),
    )

    expect(capturedOptions!["mcpServers"]).toMatchObject({
      scheduler: { type: "sdk", instance: {} },
    })
    expect(capturedOptions!["systemPrompt"]).toContain("LUNA-IDENTITY")
    // onBound fired with the new session id.
    expect(bound).toContain(created.id)
  })

  it("createThread does NOT persist the provider's live mcpServers (cyclic-serialize hang regression)", async () => {
    // Regression: decorate() injects LIVE in-process MCP server objects into
    // sdkOptions.mcpServers; those carry CYCLIC references. The ChatService
    // SessionStore was switched to the SQLite backend (PR #153), which
    // JSON.stringify-es the options blob to fill options_json — and a cyclic
    // value made that throw, which Effect.orDie turned into a silently-dropped
    // defect that hung EVERY new-thread request. The fix strips mcpServers from
    // the persisted snapshot while keeping them on the LIVE options handed to
    // the adapter. This asserts both halves with a genuinely cyclic value, so
    // the test would have reproduced the original failure had options been
    // serialized with the live mcpServers.
    let capturedOptions: Record<string, unknown> | undefined
    const fakeLayer = SDKClient.fake((p) => {
      capturedOptions = (p.options ?? {}) as Record<string, unknown>
      return makeParkedQuery(
        (p as { sessionId?: string }).sessionId ?? "thr-?",
      )
    })

    // A live MCP server object with a self-reference (the cyclic structure
    // that JSON.stringify cannot serialize).
    const liveServer: Record<string, unknown> = { type: "sdk", instance: {} }
    liveServer["self"] = liveServer

    const provider: ThreadToolsProvider = {
      decorate: () => ({
        mcpServers: { memory: liveServer },
        onBound: () => {},
      }),
    }

    const baseLayer = Layer.mergeAll(
      SessionStore.Default,
      testClock,
      ObservabilityService.makeLayer({
        logToConsole: false,
        jsonlPath: join(home, "events.jsonl"),
      }).pipe(Layer.provide(testClock)),
      TelemetryService.makeLayer().pipe(Layer.provide(testClock)),
      Layer.succeed(ThreadToolsProviderTag, provider),
      Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    )
    const fullLayer = Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
    )

    const persisted = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore
          // Must NOT hang / die — the headline regression.
          const summary = yield* chat.createThread({ model: "claude-test" })
          yield* Effect.sleep("50 millis")
          const opts = yield* store.getOptions(summary.id)
          return opts
        }),
      ).pipe(Effect.provide(fullLayer)),
    )

    // LIVE path: the adapter still received the (cyclic) mcpServers.
    expect(capturedOptions!["mcpServers"]).toBeDefined()
    expect((capturedOptions!["mcpServers"] as Record<string, unknown>)["memory"]).toBeDefined()

    // PERSISTED path: mcpServers stripped from the durable snapshot — neither
    // the top-level mirror nor the sdkOptions copy survives, so the row is
    // JSON-serializable.
    expect(persisted).not.toBeNull()
    expect((persisted as Record<string, unknown>)["mcpServers"]).toBeUndefined()
    const sdk = (persisted as { sdkOptions?: Record<string, unknown> }).sdkOptions
    expect(sdk?.["mcpServers"]).toBeUndefined()
    // The persisted blob must be JSON-serializable (the actual bug surface).
    expect(() => JSON.stringify(persisted)).not.toThrow()
  })

  it("fires onUnbound with the session id when the thread scope closes", async () => {
    const fakeLayer = SDKClient.fake((p) =>
      makeParkedQuery((p as { sessionId?: string }).sessionId ?? "thr-?"),
    )

    const bound: string[] = []
    const unbound: string[] = []
    const provider: ThreadToolsProvider = {
      decorate: () => ({
        mcpServers: {},
        onBound: (id) => bound.push(id),
        onUnbound: (id) => unbound.push(id),
      }),
    }

    const baseLayer = Layer.mergeAll(
      SessionStore.Default,
      testClock,
      ObservabilityService.makeLayer({
        logToConsole: false,
        jsonlPath: join(home, "events.jsonl"),
      }).pipe(Layer.provide(testClock)),
      TelemetryService.makeLayer().pipe(Layer.provide(testClock)),
      Layer.succeed(ThreadToolsProviderTag, provider),
      Layer.succeed(MemoryRouterTag, noopMemoryRouter),
    )
    const fullLayer = Layer.provideMerge(
      ChatService.Default,
      Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
    )

    const created = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const summary = yield* chat.createThread({ model: "claude-test" })
          yield* Effect.sleep("50 millis")
          return summary
        }),
      ).pipe(Effect.provide(fullLayer)),
    )

    // The scope has now closed → the thread finalizer ran → onUnbound fired
    // with the same session id onBound saw. This is the leak fix: per-session
    // provider state (e.g. the module-scope sandbox re-attach closures) is
    // released on teardown instead of accumulating for the process lifetime.
    expect(bound).toContain(created.id)
    expect(unbound).toContain(created.id)
  })
})
