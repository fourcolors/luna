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
})
