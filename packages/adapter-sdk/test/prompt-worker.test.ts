/**
 * prompt-worker.test.ts — Tier-1 tests for the Phase-12b prompt worker.
 *
 * Uses `SDKClient.fake` + in-memory `AgentNotesService.Memory` — ZERO model
 * calls and ZERO DB I/O. Covers:
 *   - parsePromptPayload validator (well-formed, malformed, partial)
 *   - buildPromptWorker dispatch path
 *   - "obs_note" delivery sink writes to AgentNotesService
 *   - "log" delivery sink (no-op write; worker still returns text)
 *   - SDK stream with no success message → WorkerError(worker_failed)
 *   - SDK query() throw → WorkerError(worker_failed)
 *   - PromptWorkerLayer registers the worker into WorkerRegistry at boot
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import {
  AgentNotesService,
  Clock,
  WorkerRegistry,
  WorkerError,
  makeWorkerRegistry,
  type WorkerContext,
} from "@luna/core"
import { SDKClient } from "../src/sdk-client.js"
import {
  PromptWorkerLayer,
  buildPromptWorker,
  parsePromptPayload,
  type PromptPayload,
} from "../src/prompt-worker.js"
import type {
  ChatThreadDelivery,
  ChatThreadPoster,
} from "../src/chat-thread-poster.js"
import { makeFakeQuery, makeAssistantMessage } from "./fake-sdk.js"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { DEFAULT_QUERY_TIMEOUT_MS } from "../src/bounded-query.js"

// ── Helpers ─────────────────────────────────────────────────────────────────

const fakeClientWithText = (text: string): Layer.Layer<SDKClient> =>
  SDKClient.fake((_params) => {
    const resultMsg = {
      type: "result",
      subtype: "success",
      session_id: "sid",
      uuid: "uuid-1",
      is_error: false,
      duration_ms: 5,
      duration_api_ms: 3,
      num_turns: 1,
      result: text,
    } as unknown as SDKMessage
    return makeFakeQuery({ messages: [resultMsg] }).query
  })

const fakeClientNoSuccess = (): Layer.Layer<SDKClient> =>
  SDKClient.fake((_params) => {
    return makeFakeQuery({
      messages: [makeAssistantMessage("sid", "just text, no result", "u")],
    }).query
  })

const fakeClientThrows = (): Layer.Layer<SDKClient> =>
  SDKClient.fake((_params) => {
    return makeFakeQuery({
      messages: [makeAssistantMessage("sid", "x", "u")],
      throwAfter: 0,
    }).query
  })

const ctx: WorkerContext = {
  jobId: "test-job",
  runId: 42,
  attempt: 1,
  deadline: 0,
}

// ── parsePromptPayload ───────────────────────────────────────────────────────

describe("parsePromptPayload", () => {
  it("accepts the minimal payload (user_prompt only)", () => {
    const result = parsePromptPayload({ user_prompt: "Hello" })
    expect(typeof result).not.toBe("string")
    expect((result as PromptPayload).user_prompt).toBe("Hello")
  })

  it("collects optional fields when present", () => {
    const result = parsePromptPayload({
      user_prompt: "x",
      system_prompt: "You are a brief generator.",
      model: "claude-sonnet-4-5",
      allowed_tools: ["mcp__memory__memory_search", "Read"],
      max_turns: 3,
      deliver_to: { kind: "obs_note", kind_tag: "daily_brief" },
    })
    const r = result as PromptPayload
    expect(r.system_prompt).toBe("You are a brief generator.")
    expect(r.model).toBe("claude-sonnet-4-5")
    expect(r.allowed_tools).toEqual([
      "mcp__memory__memory_search",
      "Read",
    ])
    expect(r.max_turns).toBe(3)
    expect(r.deliver_to).toEqual({
      kind: "obs_note",
      kind_tag: "daily_brief",
    })
  })

  it("rejects missing user_prompt", () => {
    expect(parsePromptPayload({})).toMatch(/user_prompt/)
    expect(parsePromptPayload({ user_prompt: "" })).toMatch(/non-empty/)
    expect(parsePromptPayload({ user_prompt: 42 })).toMatch(/user_prompt/)
  })

  it("rejects non-object payloads", () => {
    expect(parsePromptPayload(null)).toMatch(/object/)
    expect(parsePromptPayload(42)).toMatch(/object/)
    expect(parsePromptPayload("x")).toMatch(/object/)
  })

  it("rejects unknown deliver_to.kind", () => {
    const r = parsePromptPayload({
      user_prompt: "x",
      deliver_to: { kind: "telegram" },
    })
    expect(r).toMatch(/deliver_to.kind/)
  })

  it("accepts a well-formed chat_thread deliver_to (#124)", () => {
    const r = parsePromptPayload({
      user_prompt: "x",
      deliver_to: { kind: "chat_thread", thread_id: "thr_abc" },
    }) as PromptPayload
    expect(r.deliver_to).toEqual({ kind: "chat_thread", thread_id: "thr_abc" })
  })

  it("rejects a chat_thread deliver_to with a missing/empty thread_id", () => {
    expect(
      parsePromptPayload({ user_prompt: "x", deliver_to: { kind: "chat_thread" } }),
    ).toMatch(/thread_id/)
    expect(
      parsePromptPayload({
        user_prompt: "x",
        deliver_to: { kind: "chat_thread", thread_id: "" },
      }),
    ).toMatch(/thread_id/)
  })

  it("filters non-string entries out of allowed_tools", () => {
    const r = parsePromptPayload({
      user_prompt: "x",
      allowed_tools: ["good", 42, null, "also_good"],
    }) as PromptPayload
    expect(r.allowed_tools).toEqual(["good", "also_good"])
  })

  it("clamps max_turns to >= 1 and truncates fractions", () => {
    expect((parsePromptPayload({ user_prompt: "x", max_turns: 0 }) as PromptPayload).max_turns).toBe(1)
    expect((parsePromptPayload({ user_prompt: "x", max_turns: -3 }) as PromptPayload).max_turns).toBe(1)
    expect((parsePromptPayload({ user_prompt: "x", max_turns: 2.7 }) as PromptPayload).max_turns).toBe(2)
  })
})

// ── buildPromptWorker (direct closure tests, no Layer plumbing) ─────────────

describe("buildPromptWorker", () => {
  const TestNotes = AgentNotesService.Memory.pipe(Layer.provide(Clock.Default))

  it("happy path: SDK result text returned as WorkerResult.outputText", async () => {
    const sdkLayer = fakeClientWithText("Today's brief: nothing happened.")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildPromptWorker(sdk, notes)
      const result = yield* worker({ user_prompt: "hi" }, ctx)
      expect(result.outputText).toBe("Today's brief: nothing happened.")
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
    )
  })

  it("deliver_to=obs_note writes an AgentNote with the result", async () => {
    const sdkLayer = fakeClientWithText("Brief body.")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildPromptWorker(sdk, notes)

      yield* worker(
        {
          user_prompt: "what's new?",
          deliver_to: {
            kind: "obs_note",
            kind_tag: "daily_brief",
            session_id: "brief-session",
          },
        },
        ctx,
      )

      const recent = yield* notes.getRecent("brief-session", 5)
      expect(recent.length).toBe(1)
      expect(recent[0]?.summary).toBe("Brief body.")
      expect(recent[0]?.kind).toBe("daily_brief")
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
    )
  })

  it("deliver_to=log does NOT write an AgentNote", async () => {
    const sdkLayer = fakeClientWithText("Body.")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildPromptWorker(sdk, notes)
      yield* worker(
        { user_prompt: "x", deliver_to: { kind: "log" } },
        ctx,
      )
      const recent = yield* notes.getRecentAcrossSessions(50)
      expect(recent.length).toBe(0)
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
    )
  })

  it("deliver_to=chat_thread posts the result to the poster (#124)", async () => {
    const sdkLayer = fakeClientWithText("Done — found 3 options.")
    const captured: ChatThreadDelivery[] = []
    const poster: ChatThreadPoster = {
      post: (delivery) =>
        Effect.sync(() => {
          captured.push(delivery)
        }),
    }
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildPromptWorker(sdk, notes, null, poster)
      const result = yield* worker(
        {
          user_prompt: "find options",
          label: "Research flights",
          source: "suggested-action",
          deliver_to: { kind: "chat_thread", thread_id: "thr_main" },
        },
        ctx,
      )
      // The worker still returns the text (delivery is a side effect).
      expect(result.outputText).toBe("Done — found 3 options.")
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
    )
    expect(captured).toEqual([
      {
        threadId: "thr_main",
        text: "Done — found 3 options.",
        source: "suggested-action",
        label: "Research flights",
      },
    ])
  })

  it("deliver_to=chat_thread without a poster logs-and-drops, still returns text (#124)", async () => {
    const sdkLayer = fakeClientWithText("Body.")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      // No poster wired (null) — the worker must not throw.
      const worker = buildPromptWorker(sdk, notes, null, null)
      const result = yield* worker(
        {
          user_prompt: "x",
          deliver_to: { kind: "chat_thread", thread_id: "thr_gone" },
        },
        ctx,
      )
      expect(result.outputText).toBe("Body.")
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
    )
  })

  it("bad payload → WorkerError(reason='bad_payload')", async () => {
    const sdkLayer = fakeClientWithText("never invoked")
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildPromptWorker(sdk, notes)
      const result = yield* Effect.either(
        worker({ /* no user_prompt */ }, ctx),
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left).toBeInstanceOf(WorkerError)
        expect(result.left.reason).toBe("bad_payload")
        expect(result.left.kind).toBe("prompt")
      }
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
    )
  })

  it("SDK with no success message → WorkerError(reason='worker_failed')", async () => {
    const sdkLayer = fakeClientNoSuccess()
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildPromptWorker(sdk, notes)
      const result = yield* Effect.either(
        worker({ user_prompt: "x" }, ctx),
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left.reason).toBe("worker_failed")
        expect(result.left.message).toMatch(/no type:result/)
      }
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
    )
  })

  it("SDK stream throws → WorkerError(reason='worker_failed')", async () => {
    const sdkLayer = fakeClientThrows()
    const prog = Effect.gen(function* () {
      const sdk = yield* SDKClient
      const notes = yield* AgentNotesService
      const worker = buildPromptWorker(sdk, notes)
      const result = yield* Effect.either(
        worker({ user_prompt: "x" }, ctx),
      )
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") {
        expect(result.left.reason).toBe("worker_failed")
      }
    })
    await Effect.runPromise(
      prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
    )
  })

  it(
    "payload timeout_ms: a hung turn → WorkerError(worker_failed, timed out) + subprocess aborted",
    async () => {
      let captured: AbortController | undefined
      const sdkLayer = SDKClient.fake((params) => {
        const ac = params.options?.abortController as
          | AbortController
          | undefined
        captured = ac
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          await new Promise<void>((resolve) => {
            if (ac?.signal.aborted) return resolve()
            ac?.signal.addEventListener("abort", () => resolve(), { once: true })
            setTimeout(resolve, 30_000).unref?.()
          })
        }
        return gen() as unknown as import("../src/sdk-client.js").Query
      })
      const prog = Effect.gen(function* () {
        const sdk = yield* SDKClient
        const notes = yield* AgentNotesService
        const worker = buildPromptWorker(sdk, notes)
        const result = yield* Effect.either(
          worker({ user_prompt: "hang", timeout_ms: 50 }, ctx),
        )
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(WorkerError)
          expect(result.left.reason).toBe("worker_failed")
          expect(result.left.message).toMatch(/timed out/)
        }
        expect(captured?.signal.aborted).toBe(true)
      })
      await Effect.runPromise(
        prog.pipe(Effect.provide(Layer.mergeAll(sdkLayer, TestNotes))),
      )
    },
    10_000,
  )
})

// ── PromptWorkerLayer (end-to-end registration) ─────────────────────────────

describe("PromptWorkerLayer", () => {
  it("registers a worker under 'prompt' that the WorkerRegistry can dispatch", async () => {
    const sdkLayer = fakeClientWithText("registered worker output")
    const stack = PromptWorkerLayer().pipe(
      Layer.provide(
        Layer.mergeAll(
          sdkLayer,
          makeWorkerRegistry({}),
          AgentNotesService.Memory.pipe(Layer.provide(Clock.Default)),
          Clock.Default,
        ),
      ),
    )
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const kinds = yield* reg.listKinds
      expect([...kinds]).toEqual(["prompt"])
      const out = yield* reg.dispatch("prompt", { user_prompt: "hi" }, ctx)
      expect(out.outputText).toBe("registered worker output")
    })
    // Need to ALSO expose WorkerRegistry to the test program, so provideMerge
    // the inner stack (otherwise the WorkerRegistry is consumed by the
    // PromptWorkerLayer and not visible above).
    const exposed = PromptWorkerLayer().pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sdkLayer,
          makeWorkerRegistry({}),
          AgentNotesService.Memory.pipe(Layer.provide(Clock.Default)),
          Clock.Default,
        ),
      ),
    )
    await Effect.runPromise(prog.pipe(Effect.provide(exposed)))
  })

  it("custom kind override registers under that kind instead of 'prompt'", async () => {
    const sdkLayer = fakeClientWithText("ok")
    const exposed = PromptWorkerLayer({ kind: "daily_brief" }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sdkLayer,
          makeWorkerRegistry({}),
          AgentNotesService.Memory.pipe(Layer.provide(Clock.Default)),
          Clock.Default,
        ),
      ),
    )
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const kinds = yield* reg.listKinds
      expect([...kinds]).toEqual(["daily_brief"])
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed)))
  })

  // job-ticker-oban-deadlines (Seam 2 boot wiring): the production
  // registration MUST carry a `defaultTimeoutMs` so the JobTicker's outer
  // backstop is `defaultTimeoutMs + grace` instead of the bare 5-min
  // `workerDeadline` fallback — a bare-function registration here would
  // silently regress every prompt job back to the pre-slice 5-min ceiling.
  it("registers with defaultTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS (Seam 1/2 boot wiring)", async () => {
    const sdkLayer = fakeClientWithText("ok")
    const exposed = PromptWorkerLayer().pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          sdkLayer,
          makeWorkerRegistry({}),
          AgentNotesService.Memory.pipe(Layer.provide(Clock.Default)),
          Clock.Default,
        ),
      ),
    )
    const prog = Effect.gen(function* () {
      const reg = yield* WorkerRegistry
      const entry = yield* reg.lookupEntry("prompt")
      expect(entry?.defaultTimeoutMs).toBe(DEFAULT_QUERY_TIMEOUT_MS)
    })
    await Effect.runPromise(prog.pipe(Effect.provide(exposed)))
  })
})
