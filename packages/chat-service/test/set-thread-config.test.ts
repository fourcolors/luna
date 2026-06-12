/**
 * ChatService.setThreadConfig — unit / Tier-2 sim tests.
 *
 * Covers:
 *   1. Effort — same-lane thread: applyFlagSettings called, "effort" in applied,
 *      SessionStore sdkOptions updated.
 *   2. Model (same lane) — setModel called, "model" in applied, store updated.
 *   3. Model (cross lane) — setModel NOT called, "model" in deferred.
 *   4. Unknown thread → all fields in rejected.
 *   5. "max" effort maps to "xhigh" for applyFlagSettings (SDK Settings limit).
 *   6. Per-model clamp: haiku+effort → rejected, applyFlagSettings NOT called;
 *      sonnet+xhigh → clamped to max, ack echoes the effective level.
 *   7. SDK-throw honesty: a rejecting applyFlagSettings lands the field in
 *      `rejected` (never `applied`) and nothing is persisted.
 *   8. Config-before-first-turn: setThreadConfig before any sid is recorded
 *      still persists its intent to thread-session-map.json.
 */
import { afterAll, describe, expect, it } from "vitest"
import {
  Effect,
  Layer,
  Ref,
  Scope,
  Stream,
} from "effect"
import { unlinkSync } from "node:fs"
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
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { ChatService } from "../src/index.js"

// ── helpers ──────────────────────────────────────────────────────────────────

const makeResultMessage = (sessionId: string, uuid: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid,
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    result: "ok",
  }) as unknown as SDKMessage

const makeAssistantMessage = (
  sessionId: string,
  text: string,
  uuid: string,
): SDKMessage =>
  ({
    type: "assistant",
    session_id: sessionId,
    uuid,
    parent_tool_use_id: null,
    message: {
      id: uuid,
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }) as unknown as SDKMessage

// ── layer setup ──────────────────────────────────────────────────────────────

const noopMemoryRouter: MemoryRouter = {
  search: () => Stream.empty as ReturnType<MemoryRouter["search"]>,
  put: () => Effect.die("noopMemoryRouter.put"),
  get: () => Effect.die("noopMemoryRouter.get"),
  query: () => Stream.die("noopMemoryRouter.query"),
  delete: () => Effect.die("noopMemoryRouter.delete"),
  backendFor: () => { throw new Error("noopMemoryRouter.backendFor") },
  exportAll: () => Effect.die("noopMemoryRouter.exportAll"),
}

const testClock = CoreClock.Test(1_700_000_000_000)
const obsJsonlPath = join(
  tmpdir(),
  `luna-set-thread-config-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
)

afterAll(() => {
  try { unlinkSync(obsJsonlPath) } catch { /* ignore */ }
})

const obsLayer = ObservabilityService.makeLayer({
  logToConsole: false,
  jsonlPath: obsJsonlPath,
}).pipe(Layer.provide(testClock))

const baseLayer = Layer.mergeAll(
  SessionStore.Default,
  testClock,
  obsLayer,
  TelemetryService.makeLayer().pipe(Layer.provide(testClock)),
  Layer.succeed(MemoryRouterTag, noopMemoryRouter),
)

/**
 * Build a fake Query that:
 *   - drives a single-turn echo conversation
 *   - records applyFlagSettings calls in `flagSettingsCalls`
 *   - records setModel calls in `modelCalls`
 *   - optionally REJECTS applyFlagSettings (silent-failure coverage)
 */
const makeRecordingQuery = (params: {
  readonly prompt: AsyncIterable<SDKUserMessage>
  readonly sessionId: string
  readonly flagSettingsCalls: Array<Record<string, unknown>>
  readonly modelCalls: Array<string | undefined>
  readonly failFlagSettings?: boolean
}): Query => {
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    for await (const u of params.prompt) {
      const text = typeof u.message.content === "string"
        ? u.message.content
        : "ok"
      yield makeAssistantMessage(params.sessionId, text, "a1")
      yield makeResultMessage(params.sessionId, "r1")
    }
  }
  const it = gen()
  return Object.assign(it, {
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async (m?: string) => { params.modelCalls.push(m) },
    applyFlagSettings: async (s: Record<string, unknown>) => {
      params.flagSettingsCalls.push(s)
      if (params.failFlagSettings === true) {
        throw new Error("fake: applyFlagSettings rejected")
      }
    },
    setMaxThinkingTokens: async () => {},
    supplyToolPermissionResponse: async () => {},
    mcpServerStatus: async () => ({}),
  } as Partial<Query>) as Query
}

const fullLayer = (
  fakeLayer: Layer.Layer<SDKClient>,
) =>
  Layer.provideMerge(
    ChatService.Default,
    Layer.provideMerge(SDKAdapter.Default, Layer.mergeAll(fakeLayer, baseLayer)),
  )

const runScoped = <A, E>(
  eff: Effect.Effect<A, E, ChatService | SessionStore | CoreClock | ObservabilityService | Scope.Scope | TelemetryService>,
  fakeLayer: Layer.Layer<SDKClient>,
) =>
  Effect.runPromise(
    Effect.scoped(eff).pipe(Effect.provide(fullLayer(fakeLayer))),
  )

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ChatService.setThreadConfig", () => {
  it(
    "effort (live handle): applied immediately via applyFlagSettings, persisted in store",
    async () => {
      const flagCalls: Array<Record<string, unknown>> = []
      const modelCalls: Array<string | undefined> = []

      const fakeLayer = SDKClient.fake((p) =>
        makeRecordingQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "s?",
          flagSettingsCalls: flagCalls,
          modelCalls,
        }),
      )

      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore

          const t = yield* chat.createThread({
            model: "claude-sonnet-4-6",
            title: "effort-test",
          })

          // Drive one turn so the query handle becomes live.
          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.fork(
            sub.pipe(Stream.take(3), Stream.runCollect),
          )
          yield* Effect.sleep("20 millis")
          yield* chat.send(t.id, "hi")
          yield* fiber

          // Now switch effort.
          const result = yield* chat.setThreadConfig({ threadId: t.id, effort: "high" })

          expect(result.applied).toContain("effort")
          expect(result.deferred).not.toContain("effort")
          expect(flagCalls.length).toBeGreaterThan(0)
          expect(flagCalls[0]).toMatchObject({ effortLevel: "high" })

          // Persistence: sdkOptions.effort should be in the store.
          const opts = yield* store.getOptions(t.id)
          expect((opts?.sdkOptions as Record<string, unknown> | undefined)?.["effort"]).toBe("high")
        }),
        fakeLayer,
      )
    },
    { timeout: 10_000 },
  )

  it(
    "'max' effort maps to 'xhigh' in applyFlagSettings (Settings type limit)",
    async () => {
      const flagCalls: Array<Record<string, unknown>> = []
      const fakeLayer = SDKClient.fake((p) =>
        makeRecordingQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "s?",
          flagSettingsCalls: flagCalls,
          modelCalls: [],
        }),
      )

      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const t = yield* chat.createThread({ model: "claude-fable-5", title: "max-effort" })

          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.fork(sub.pipe(Stream.take(3), Stream.runCollect))
          yield* Effect.sleep("20 millis")
          yield* chat.send(t.id, "hi")
          yield* fiber

          const result = yield* chat.setThreadConfig({ threadId: t.id, effort: "max" })

          expect(result.applied).toContain("effort")
          // "max" must be translated to "xhigh" for the live SDK call
          expect(flagCalls[0]).toMatchObject({ effortLevel: "xhigh" })
        }),
        fakeLayer,
      )
    },
    { timeout: 10_000 },
  )

  it(
    "same-lane model switch: setModel called, applied",
    async () => {
      const flagCalls: Array<Record<string, unknown>> = []
      const modelCalls: Array<string | undefined> = []

      const fakeLayer = SDKClient.fake((p) =>
        makeRecordingQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "s?",
          flagSettingsCalls: flagCalls,
          modelCalls,
        }),
      )

      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore

          // Both claude-sonnet-4-6 and claude-haiku-4-5 are anthropic lane.
          const t = yield* chat.createThread({ model: "claude-sonnet-4-6", title: "same-lane" })

          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.fork(sub.pipe(Stream.take(3), Stream.runCollect))
          yield* Effect.sleep("20 millis")
          yield* chat.send(t.id, "hi")
          yield* fiber

          const result = yield* chat.setThreadConfig({ threadId: t.id, model: "claude-haiku-4-5" })

          expect(result.applied).toContain("model")
          expect(result.deferred).not.toContain("model")
          expect(modelCalls).toContain("claude-haiku-4-5")

          const opts = yield* store.getOptions(t.id)
          expect(opts?.model).toBe("claude-haiku-4-5")
        }),
        fakeLayer,
      )
    },
    { timeout: 10_000 },
  )

  it(
    "cross-lane model switch: setModel NOT called, model in deferred",
    async () => {
      const modelCalls: Array<string | undefined> = []

      const fakeLayer = SDKClient.fake((p) =>
        makeRecordingQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "s?",
          flagSettingsCalls: [],
          modelCalls,
        }),
      )

      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService

          // claude-sonnet-4-6 → anthropic; gemini-2.5-flash → google.
          const t = yield* chat.createThread({ model: "claude-sonnet-4-6", title: "cross-lane" })

          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.fork(sub.pipe(Stream.take(3), Stream.runCollect))
          yield* Effect.sleep("20 millis")
          yield* chat.send(t.id, "hi")
          yield* fiber

          const result = yield* chat.setThreadConfig({ threadId: t.id, model: "gemini-2.5-flash" })

          expect(result.deferred).toContain("model")
          expect(result.applied).not.toContain("model")
          // setModel must NOT have been called for a cross-lane switch
          expect(modelCalls).not.toContain("gemini-2.5-flash")
        }),
        fakeLayer,
      )
    },
    { timeout: 10_000 },
  )

  it(
    "unknown thread: all fields rejected gracefully",
    async () => {
      const fakeLayer = SDKClient.fake(() => {
        throw new Error("should not be called for unknown thread")
      })

      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const result = yield* chat.setThreadConfig({
            threadId: "thr_nonexistent",
            model: "claude-sonnet-4-6",
            effort: "high",
          })

          expect(result.applied).toHaveLength(0)
          expect(result.deferred).toHaveLength(0)
          expect(result.rejected).toBeDefined()
          expect(result.rejected!.map((r) => r.field)).toContain("model")
          expect(result.rejected!.map((r) => r.field)).toContain("effort")
        }),
        fakeLayer,
      )
    },
    { timeout: 5_000 },
  )

  it(
    "per-model clamp: effort on a haiku thread is rejected and applyFlagSettings is NOT called",
    async () => {
      // haiku takes no effort parameter — the matrix the hello advertises.
      // A stale/hacked client pushing effort:max at a haiku thread must get
      // a rejected ack and the SDK must never see the call.
      const flagCalls: Array<Record<string, unknown>> = []
      const fakeLayer = SDKClient.fake((p) =>
        makeRecordingQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "s?",
          flagSettingsCalls: flagCalls,
          modelCalls: [],
        }),
      )

      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore
          const t = yield* chat.createThread({ model: "claude-haiku-4-5", title: "haiku-clamp" })

          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.fork(sub.pipe(Stream.take(3), Stream.runCollect))
          yield* Effect.sleep("20 millis")
          yield* chat.send(t.id, "hi")
          yield* fiber

          const result = yield* chat.setThreadConfig({ threadId: t.id, effort: "max" })

          expect(result.applied).not.toContain("effort")
          expect(result.rejected).toBeDefined()
          expect(result.rejected!.map((r) => r.field)).toContain("effort")
          // The live SDK call must never have fired.
          expect(flagCalls).toHaveLength(0)
          // And nothing was persisted.
          const opts = yield* store.getOptions(t.id)
          expect((opts?.sdkOptions as Record<string, unknown> | undefined)?.["effort"]).toBeUndefined()
        }),
        fakeLayer,
      )
    },
    { timeout: 10_000 },
  )

  it(
    "per-model clamp: unsupported level is clamped and the ack echoes the EFFECTIVE effort",
    async () => {
      // sonnet-4-6 supports [low, medium, high, max] — xhigh clamps to max.
      const flagCalls: Array<Record<string, unknown>> = []
      const fakeLayer = SDKClient.fake((p) =>
        makeRecordingQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "s?",
          flagSettingsCalls: flagCalls,
          modelCalls: [],
        }),
      )

      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore
          const t = yield* chat.createThread({ model: "claude-sonnet-4-6", title: "clamp-echo" })

          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.fork(sub.pipe(Stream.take(3), Stream.runCollect))
          yield* Effect.sleep("20 millis")
          yield* chat.send(t.id, "hi")
          yield* fiber

          const result = yield* chat.setThreadConfig({ threadId: t.id, effort: "xhigh" })

          expect(result.applied).toContain("effort")
          // Ack echoes the effective (clamped) level, not the requested one.
          expect(result.effort).toBe("max")
          // Live call ran at xhigh (max→xhigh translation for the live query).
          expect(flagCalls[0]).toMatchObject({ effortLevel: "xhigh" })
          // Persisted value is the effective level.
          const opts = yield* store.getOptions(t.id)
          expect((opts?.sdkOptions as Record<string, unknown> | undefined)?.["effort"]).toBe("max")
        }),
        fakeLayer,
      )
    },
    { timeout: 10_000 },
  )

  it(
    "applyFlagSettings rejects → ack reports rejected (NOT applied) and nothing is persisted",
    async () => {
      const flagCalls: Array<Record<string, unknown>> = []
      const fakeLayer = SDKClient.fake((p) =>
        makeRecordingQuery({
          prompt: p.prompt as AsyncIterable<SDKUserMessage>,
          sessionId: (p as { sessionId?: string }).sessionId ?? "s?",
          flagSettingsCalls: flagCalls,
          modelCalls: [],
          failFlagSettings: true,
        }),
      )

      await runScoped(
        Effect.gen(function* () {
          const chat = yield* ChatService
          const store = yield* SessionStore
          const t = yield* chat.createThread({ model: "claude-sonnet-4-6", title: "sdk-throw" })

          const sub = chat.subscribe(t.id)
          const fiber = yield* Effect.fork(sub.pipe(Stream.take(3), Stream.runCollect))
          yield* Effect.sleep("20 millis")
          yield* chat.send(t.id, "hi")
          yield* fiber

          const result = yield* chat.setThreadConfig({ threadId: t.id, effort: "high" })

          // The SDK call WAS attempted …
          expect(flagCalls).toHaveLength(1)
          // … but the ack must not lie about it succeeding.
          expect(result.applied).not.toContain("effort")
          expect(result.rejected).toBeDefined()
          expect(result.rejected!.map((r) => r.field)).toContain("effort")
          // And the unapplied value must not be persisted.
          const opts = yield* store.getOptions(t.id)
          expect((opts?.sdkOptions as Record<string, unknown> | undefined)?.["effort"]).toBeUndefined()
        }),
        fakeLayer,
      )
    },
    { timeout: 10_000 },
  )

  it(
    "config set BEFORE any SDK session id is recorded survives a restart-load (map keeps it)",
    async () => {
      // The SDK session id arrives asynchronously around the first turn.
      // setThreadConfig fired before any turn must still persist its intent
      // to thread-session-map.json (config-only entry, no sid yet).
      const fs = require("node:fs") as typeof import("node:fs")
      const path = require("node:path") as typeof import("node:path")
      const os = require("node:os") as typeof import("node:os")
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "luna-cfg-presid-"))
      const prevHome = process.env["LUNA_HOME"]
      process.env["LUNA_HOME"] = home
      try {
        const fakeLayer = SDKClient.fake((p) =>
          makeRecordingQuery({
            prompt: p.prompt as AsyncIterable<SDKUserMessage>,
            sessionId: (p as { sessionId?: string }).sessionId ?? "s?",
            flagSettingsCalls: [],
            modelCalls: [],
          }),
        )

        let threadId: string | undefined
        await runScoped(
          Effect.gen(function* () {
            const chat = yield* ChatService
            const t = yield* chat.createThread({ model: "claude-fable-5", title: "pre-sid" })
            threadId = t.id
            // NO user turn sent — the fake never yields, so onSdkSessionId
            // never fires and no sid lands in the map.
            yield* chat.setThreadConfig({ threadId: t.id, effort: "high" })
          }),
          fakeLayer,
        )

        const mapPath = path.join(home, ".luna", "thread-session-map.json")
        expect(fs.existsSync(mapPath)).toBe(true)
        const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as Record<string, unknown>
        const entry = map[threadId!] as Record<string, unknown> | undefined
        expect(entry).toBeDefined()
        // The pre-first-turn selection is in the entry (sid still absent).
        expect(entry!["effort"]).toBe("high")
        expect(entry!["model"]).toBe("claude-fable-5")
        expect(entry!["sid"]).toBeUndefined()
      } finally {
        if (prevHome !== undefined) {
          process.env["LUNA_HOME"] = prevHome
        } else {
          delete process.env["LUNA_HOME"]
        }
        fs.rmSync(home, { recursive: true, force: true })
      }
    },
    { timeout: 10_000 },
  )
})
