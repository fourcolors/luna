/**
 * dream-reasoner.test.ts — Tier-1 tests for DreamReasonerDefault.
 *
 * All tests run with SDKClient.fake + a Ref-backed FakeMemory MemoryRouter
 * (copied from packages/core/src/dream/dream.test.ts). ZERO network / model
 * calls. Covers:
 *   1. Well-formed belief_candidate op → DreamOp with correct targetId + after
 *   2. Before-snapshot: seeded id → op.before === existing record (NOT null)
 *   3. Before-snapshot: absent id → op.before === null
 *   4. Malformed (non-JSON) model output → DreamError with op:"parse"
 *   5. SDK error (no success result message) → DreamError
 */
import { describe, expect, it } from "vitest"
import { Cause, Effect, Layer, Ref, Stream } from "effect"
import { DreamError } from "@luna/core"
import type { MemoryRecord } from "@luna/memory"
import { MemoryRouterTag } from "@luna/memory"
import { DreamReasoner } from "@luna/core"
import { deriveBeliefId, makeBeliefRecord } from "@luna/core"
import { SDKClient } from "../src/sdk-client.js"
import { DreamReasonerDefault } from "../src/dream-reasoner.js"
import { makeFakeQuery, makeAssistantMessage, makeResultMessage } from "./fake-sdk.js"
import type { DreamInputs } from "@luna/core"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_INPUTS: DreamInputs = { sessions: [], memories: [] }

// Ref-backed MemoryRouter double (copied from dream.test.ts).
const FakeMemory = (initial: ReadonlyArray<MemoryRecord> = []) =>
  Layer.effect(
    MemoryRouterTag,
    Effect.gen(function* () {
      const store = yield* Ref.make<Map<string, MemoryRecord>>(
        new Map(initial.map((r) => [r.id, r])),
      )
      return {
        put: (rec: MemoryRecord) => Ref.update(store, (m) => new Map(m).set(rec.id, rec)),
        get: (id: string) => Ref.get(store).pipe(Effect.map((m) => m.get(id) ?? null)),
        delete: (id: string) =>
          Ref.modify(store, (m) => {
            const had = m.has(id)
            const next = new Map(m)
            next.delete(id)
            return [had, next]
          }),
        query: () => Stream.empty,
        search: () => Stream.empty,
      } as never
    }),
  )

/** Build an SDKClient.fake that returns a single result message whose `.result`
 *  field contains `resultText`. Uses makeFakeQuery + makeResultMessage shape. */
const fakeClientWithResult = (resultText: string): Layer.Layer<SDKClient> =>
  SDKClient.fake((_params) => {
    // Override the result field of makeResultMessage to carry our JSON.
    const resultMsg = {
      ...makeResultMessage("sid", "uuid-1"),
      result: resultText,
    }
    return makeFakeQuery({ messages: [resultMsg] }).query
  })

/** Build an SDKClient.fake that throws / yields no success result (only an
 *  assistant message with no result message). */
const fakeClientNoSuccess = (): Layer.Layer<SDKClient> =>
  SDKClient.fake((_params) => {
    const assistantMsg = makeAssistantMessage("sid", "some text", "uuid-2")
    return makeFakeQuery({ messages: [assistantMsg] }).query
  })

/** Helper: run reason(inputs) with a given sdk layer + memory layer. */
const runReason = (
  inputs: DreamInputs,
  sdkLayer: Layer.Layer<SDKClient>,
  memLayer: Layer.Layer<typeof MemoryRouterTag>,
) =>
  Effect.gen(function* () {
    const r = yield* DreamReasoner
    return yield* r.reason(inputs)
  }).pipe(
    Effect.provide(DreamReasonerDefault),
    Effect.provide(sdkLayer),
    Effect.provide(memLayer),
  )

// ---------------------------------------------------------------------------
// A canonical belief_candidate raw op payload (what the "model" emits).
// Must carry domain, statement, confidence, evidence so the reasoner can call
// deriveBeliefId + makeBeliefRecord.
// ---------------------------------------------------------------------------
const RAW_BELIEF_OP = {
  kind: "belief_candidate",
  domain: "comms",
  statement: "Operator prefers terse answers",
  confidence: 0.85,
  evidence: ["session:s-1#m-1"],
  rationale: "recurring pattern across 3 sessions",
}

const EXPECTED_ID = deriveBeliefId(RAW_BELIEF_OP.domain, RAW_BELIEF_OP.statement)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DreamReasonerDefault", () => {
  it("parses a well-formed belief_candidate op → correct targetId + proposed belief after", async () => {
    const json = JSON.stringify([RAW_BELIEF_OP])
    const ops = await Effect.runPromise(
      runReason(EMPTY_INPUTS, fakeClientWithResult(json), FakeMemory()),
    )
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    expect(op.kind).toBe("belief_candidate")
    expect(op.targetId).toBe(EXPECTED_ID)
    // `after` must be a proposed belief MemoryRecord
    const after = op.after as MemoryRecord
    expect(after.id).toBe(EXPECTED_ID)
    expect((after.content as { status: string }).status).toBe("proposed")
    expect((after.content as { statement: string }).statement).toBe(RAW_BELIEF_OP.statement)
    expect((after.content as { confidence: number }).confidence).toBe(RAW_BELIEF_OP.confidence)
  })

  it("before-snapshot: when the belief id is pre-seeded in memory → op.before === the existing record", async () => {
    const existingRecord = makeBeliefRecord({
      statement: RAW_BELIEF_OP.statement,
      confidence: 0.7,
      domain: RAW_BELIEF_OP.domain,
      status: "proposed",
      now: 100,
    })
    // existingRecord.id === EXPECTED_ID (deriveBeliefId is deterministic)
    expect(existingRecord.id).toBe(EXPECTED_ID)

    const json = JSON.stringify([RAW_BELIEF_OP])
    const ops = await Effect.runPromise(
      runReason(EMPTY_INPUTS, fakeClientWithResult(json), FakeMemory([existingRecord])),
    )
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    // before should be the existing record, not null
    expect(op.before).not.toBeNull()
    expect((op.before as MemoryRecord).id).toBe(EXPECTED_ID)
    expect((op.before as MemoryRecord).createdAt).toBe(100)
  })

  it("before-snapshot: when the belief id is absent from memory → op.before === null", async () => {
    const json = JSON.stringify([RAW_BELIEF_OP])
    const ops = await Effect.runPromise(
      runReason(EMPTY_INPUTS, fakeClientWithResult(json), FakeMemory([])),
    )
    expect(ops).toHaveLength(1)
    expect(ops[0]!.before).toBeNull()
  })

  it("malformed (non-JSON) model output → DreamError with op:'parse'", async () => {
    const exit = await Effect.runPromiseExit(
      runReason(EMPTY_INPUTS, fakeClientWithResult("not json at all"), FakeMemory()),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      // Extract the DreamError using Cause.failureOption (typed channel)
      const maybeError = Cause.failureOption(exit.cause)
      expect(maybeError._tag).toBe("Some")
      if (maybeError._tag === "Some") {
        const error = maybeError.value
        expect(error).toBeInstanceOf(DreamError)
        expect((error as DreamError).op).toBe("parse")
      }
    }
  })

  it("no success-result message in SDK stream → typed DreamError (not a defect)", async () => {
    const exit = await Effect.runPromiseExit(
      runReason(EMPTY_INPUTS, fakeClientNoSuccess(), FakeMemory()),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const maybeError = Cause.failureOption(exit.cause)
      expect(maybeError._tag).toBe("Some")
      if (maybeError._tag === "Some") {
        const error = maybeError.value
        expect(error._tag).toBe("DreamError")
        expect(error).toBeInstanceOf(DreamError)
        expect((error as DreamError).op).toBe("reason")
      }
    }
  })

  it("SDK stream throws mid-iteration → typed DreamError (not a defect/crash)", async () => {
    // The fake's `throwAfter: 1` yields one message then throws inside the async
    // generator — exercising the Stream.fromAsyncIterable error mapper. The error
    // MUST surface on the typed E channel (DreamError), never as a defect.
    const sdkThrows = SDKClient.fake((_params) =>
      makeFakeQuery({
        messages: [makeAssistantMessage("sid", "partial", "uuid-3")],
        throwAfter: 1,
      }).query,
    )
    const exit = await Effect.runPromiseExit(
      runReason(EMPTY_INPUTS, sdkThrows, FakeMemory()),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const maybeError = Cause.failureOption(exit.cause)
      expect(maybeError._tag).toBe("Some")
      if (maybeError._tag === "Some") {
        const error = maybeError.value
        expect(error._tag).toBe("DreamError")
        expect(error).toBeInstanceOf(DreamError)
        expect((error as DreamError).op).toBe("reason")
      }
    }
  })

  it(
    "a hung reasoning turn → typed DreamError (timed out) + subprocess aborted",
    async () => {
      // Faithful hang: yields nothing until aborted. LUNA_DREAM_TIMEOUT_MS is
      // read at layer-build time, so set it before runReason and restore after.
      let captured: AbortController | undefined
      const sdkHang = SDKClient.fake((params) => {
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

      const prev = process.env["LUNA_DREAM_TIMEOUT_MS"]
      process.env["LUNA_DREAM_TIMEOUT_MS"] = "50"
      try {
        const exit = await Effect.runPromiseExit(
          runReason(EMPTY_INPUTS, sdkHang, FakeMemory()),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const maybeError = Cause.failureOption(exit.cause)
          expect(maybeError._tag).toBe("Some")
          if (maybeError._tag === "Some") {
            const error = maybeError.value
            expect(error).toBeInstanceOf(DreamError)
            expect((error as DreamError).op).toBe("reason")
            expect((error as DreamError).message).toMatch(/timed out/)
          }
        }
        expect(captured?.signal.aborted).toBe(true)
      } finally {
        if (prev === undefined) delete process.env["LUNA_DREAM_TIMEOUT_MS"]
        else process.env["LUNA_DREAM_TIMEOUT_MS"] = prev
      }
    },
    10_000,
  )

  it("rejects ops with an unknown kind → DreamError", async () => {
    const json = JSON.stringify([
      { kind: "delete_everything", domain: "ops", statement: "bad", confidence: 1, evidence: [], rationale: "no" },
    ])
    const exit = await Effect.runPromiseExit(
      runReason(EMPTY_INPUTS, fakeClientWithResult(json), FakeMemory()),
    )
    expect(exit._tag).toBe("Failure")
  })

  // -------------------------------------------------------------------------
  // REGRESSION: the silent-3am-failure bug.
  //
  // Before the fix, DreamReasonerDefault called sdk.query({ prompt, options:{
  // maxTurns:1 } }) with NO pathToClaudeCodeExecutable. On the production
  // container the SDK's bundled musl binary isn't executable, so the cron
  // failed every night with "Claude Code native binary not found", swallowed
  // by the trigger agent. ChatService.callSDK reads LUNA_CLAUDE_CODE_EXECUTABLE
  // for chat; dream now reads it too. This test captures the params the
  // reasoner hands to the SDK and asserts the env var is propagated.
  // -------------------------------------------------------------------------
  describe("env injection (regression: silent 3am failure)", () => {
    /** Capture-only SDKClient.fake that records the last params it saw. */
    const recordingClient = (
      sink: { last: { prompt: unknown; options: unknown } | null },
    ): Layer.Layer<SDKClient> =>
      SDKClient.fake((params) => {
        sink.last = { prompt: params.prompt, options: params.options }
        const r = { ...makeResultMessage("sid", "uuid-cap"), result: "[]" }
        return makeFakeQuery({ messages: [r] }).query
      })

    it("propagates LUNA_CLAUDE_CODE_EXECUTABLE → options.pathToClaudeCodeExecutable", async () => {
      const sink: { last: { prompt: unknown; options: unknown } | null } = {
        last: null,
      }
      const prev = process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]
      process.env["LUNA_CLAUDE_CODE_EXECUTABLE"] = "/usr/local/bin/claude-test"
      try {
        await Effect.runPromise(
          runReason(EMPTY_INPUTS, recordingClient(sink), FakeMemory()),
        )
      } finally {
        if (prev === undefined) delete process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]
        else process.env["LUNA_CLAUDE_CODE_EXECUTABLE"] = prev
      }
      expect(sink.last).not.toBeNull()
      const opts = sink.last!.options as {
        readonly maxTurns?: number
        readonly pathToClaudeCodeExecutable?: string
      }
      expect(opts.maxTurns).toBe(1)
      expect(opts.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude-test")
    })

    it("omits pathToClaudeCodeExecutable when the env var is unset (preserves prior behavior)", async () => {
      const sink: { last: { prompt: unknown; options: unknown } | null } = {
        last: null,
      }
      const prev = process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]
      delete process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]
      try {
        await Effect.runPromise(
          runReason(EMPTY_INPUTS, recordingClient(sink), FakeMemory()),
        )
      } finally {
        if (prev !== undefined) process.env["LUNA_CLAUDE_CODE_EXECUTABLE"] = prev
      }
      const opts = sink.last!.options as Record<string, unknown>
      expect("pathToClaudeCodeExecutable" in opts).toBe(false)
    })

    it("treats a whitespace-only env var as unset", async () => {
      const sink: { last: { prompt: unknown; options: unknown } | null } = {
        last: null,
      }
      const prev = process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]
      process.env["LUNA_CLAUDE_CODE_EXECUTABLE"] = "   "
      try {
        await Effect.runPromise(
          runReason(EMPTY_INPUTS, recordingClient(sink), FakeMemory()),
        )
      } finally {
        if (prev === undefined) delete process.env["LUNA_CLAUDE_CODE_EXECUTABLE"]
        else process.env["LUNA_CLAUDE_CODE_EXECUTABLE"] = prev
      }
      const opts = sink.last!.options as Record<string, unknown>
      expect("pathToClaudeCodeExecutable" in opts).toBe(false)
    })
  })
})
