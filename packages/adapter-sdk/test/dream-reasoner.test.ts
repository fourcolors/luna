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
import {
  DreamError,
  AccountBroker,
  AccountBrokerLayer,
  EnvSecretProvider,
  Clock,
  CLAUDE_CODE_LOGIN_SECRET_REF,
  DEFAULT_DISTILL_OPTIONS,
  DREAM_PROMPT_TOKEN_BUDGET,
  estimateTokens,
} from "@luna/core"
import type { MemoryRecord } from "@luna/memory"
import { MemoryRouterTag } from "@luna/memory"
import { DreamReasoner } from "@luna/core"
import { deriveBeliefId, makeBeliefRecord } from "@luna/core"
import { SDKClient } from "../src/sdk-client.js"
import { buildDreamPrompt, DreamReasonerDefault } from "../src/dream-reasoner.js"
import { makeFakeQuery, makeAssistantMessage, makeResultMessage } from "./fake-sdk.js"
import type { DreamInputs, DistilledSession } from "@luna/core"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

// ---------------------------------------------------------------------------
// Fake AccountBroker (A8/test): DreamReasonerDefault now requires AccountBroker.
// Seed ONE google account (resolvable via env:DREAM_GOOGLE_TOK) + ONE anthropic
// login-ref account (the sentinel that skips the env overlay → back-compat).
// In-memory `fromAccounts` (NO bun:sqlite) + EnvSecretProvider + Clock.
// ---------------------------------------------------------------------------
const GOOGLE_TOK_ENV = "DREAM_GOOGLE_TOK"
const brokerFake = (): Layer.Layer<AccountBroker> =>
  AccountBrokerLayer.fromAccounts([
    { id: "g1", kind: "google", secretRef: `env:${GOOGLE_TOK_ENV}` },
    { id: "a1", kind: "anthropic", secretRef: CLAUDE_CODE_LOGIN_SECRET_REF },
  ]).pipe(Layer.provide(EnvSecretProvider.Default), Layer.provide(Clock.Default))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_INPUTS: DreamInputs = { sessions: [], memories: [] }

// ---------------------------------------------------------------------------
// DistilledSession / DreamInputs fixtures (S4: buildDreamPrompt must consume
// the distilled-session shape from Loop A/B, not raw {summary, messages}).
// DistilledSession is plain data (summary + excerpt + counts) — literals are
// constructed directly here, with NO call into distillSession (that module is
// unit-tested on its own in packages/core/src/dream/distill.test.ts).
// ---------------------------------------------------------------------------
const baseSummary = (id: string): DistilledSession["summary"] => ({
  id,
  parentId: null,
  title: null,
  tags: [],
  createdAt: 0,
  endedAt: null,
  model: "claude-test-model",
  status: "closed",
  lastMessageAt: null,
  lastMessagePreview: null,
})

const makeInputs = (over: Partial<DreamInputs> = {}): DreamInputs => ({
  sessions: over.sessions ?? [],
  memories: over.memories ?? [],
})

const memRecordFixture = (id: string): MemoryRecord => ({
  id,
  namespace: "operator",
  kind: "note",
  content: { id },
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
  tags: [],
})

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

/** Helper: run reason(inputs) with a given sdk layer + memory layer + broker. */
const runReason = (
  inputs: DreamInputs,
  sdkLayer: Layer.Layer<SDKClient>,
  memLayer: Layer.Layer<typeof MemoryRouterTag>,
  brokerLayer: Layer.Layer<AccountBroker> = brokerFake(),
) =>
  Effect.gen(function* () {
    const r = yield* DreamReasoner
    return yield* r.reason(inputs)
  }).pipe(
    Effect.provide(DreamReasonerDefault),
    Effect.provide(sdkLayer),
    Effect.provide(memLayer),
    Effect.provide(brokerLayer),
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

  it("parses a well-formed skill_improvement create op", async () => {
    const raw = {
      kind: "skill_improvement",
      mode: "create",
      title: "Deploy skill",
      prompt: "Author a deploy skill",
      rationale: "operator re-did deploys thrice",
    }
    const ops = await Effect.runPromise(
      runReason(EMPTY_INPUTS, fakeClientWithResult(JSON.stringify([raw])), FakeMemory()),
    )
    expect(ops).toHaveLength(1)
    const op = ops[0]!
    expect(op.kind).toBe("skill_improvement")
    expect(op.targetId.startsWith("skill-imp-")).toBe(true)
    expect(op.after).toMatchObject({
      mode: "create",
      skillId: null,
      title: "Deploy skill",
      prompt: "Author a deploy skill",
    })
  })

  it("parses skill_improvement update requiring skillId", async () => {
    const raw = {
      kind: "skill_improvement",
      mode: "update",
      skillId: "deploy-runbook",
      title: "Tighten deploy skill",
      prompt: "Add rollback section",
      rationale: "rollback missing",
    }
    const ops = await Effect.runPromise(
      runReason(EMPTY_INPUTS, fakeClientWithResult(JSON.stringify([raw])), FakeMemory()),
    )
    expect(ops[0]!.targetId).toBe("deploy-runbook")
    expect(ops[0]!.after).toMatchObject({ mode: "update", skillId: "deploy-runbook" })
  })

  it("rejects skill_improvement update without skillId", async () => {
    const raw = {
      kind: "skill_improvement",
      mode: "update",
      title: "x",
      prompt: "y",
      rationale: "z",
    }
    const exit = await Effect.runPromiseExit(
      runReason(EMPTY_INPUTS, fakeClientWithResult(JSON.stringify([raw])), FakeMemory()),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("buildDreamPrompt includes skill catalog and skill_improvement rules", () => {
    const prompt = buildDreamPrompt({
      sessions: [],
      memories: [],
      skills: [
        {
          id: "deploy-runbook",
          name: "Deploy",
          description: "How to deploy",
          enabled: true,
          source: "user",
        },
      ],
    })
    expect(prompt).toContain("skill_improvement")
    expect(prompt).toContain("SKILL id=deploy-runbook")
    expect(prompt).toContain("source=user")
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

  // -------------------------------------------------------------------------
  // PROVIDER SEAM (A4): the nightly Dream acquires a credential per reason()
  // through the AccountBroker and routes the SDK at a cheap model via
  // LUNA_DREAM_MODEL. These tests capture the SDK `options` the reasoner builds.
  // -------------------------------------------------------------------------
  describe("provider seam (broker routing)", () => {
    /** Capture-only SDKClient.fake that records the last options it saw. */
    const recordingClient = (sink: {
      last: { options: Record<string, unknown> } | null
    }): Layer.Layer<SDKClient> =>
      SDKClient.fake((params) => {
        sink.last = { options: (params.options ?? {}) as Record<string, unknown> }
        const r = { ...makeResultMessage("sid", "uuid-cap"), result: "[]" }
        return makeFakeQuery({ messages: [r] }).query
      })

    it("(a) LUNA_DREAM_MODEL + a google account → options.env has the gateway overlay + options.model set", async () => {
      const sink: { last: { options: Record<string, unknown> } | null } = {
        last: null,
      }
      const prevModel = process.env["LUNA_DREAM_MODEL"]
      const prevTok = process.env[GOOGLE_TOK_ENV]
      process.env["LUNA_DREAM_MODEL"] = "gemini-2.5-flash"
      process.env[GOOGLE_TOK_ENV] = "google-secret-xyz"
      try {
        await Effect.runPromise(
          runReason(EMPTY_INPUTS, recordingClient(sink), FakeMemory()),
        )
      } finally {
        if (prevModel === undefined) delete process.env["LUNA_DREAM_MODEL"]
        else process.env["LUNA_DREAM_MODEL"] = prevModel
        if (prevTok === undefined) delete process.env[GOOGLE_TOK_ENV]
        else process.env[GOOGLE_TOK_ENV] = prevTok
      }
      const opts = sink.last!.options
      expect(opts["model"]).toBe("gemini-2.5-flash")
      const env = opts["env"] as Record<string, string> | undefined
      expect(env).toBeDefined()
      expect(env!["ANTHROPIC_AUTH_TOKEN"]).toBe("google-secret-xyz")
      expect(env!["ANTHROPIC_BASE_URL"]).toBeDefined()
    })

    it("(b) BACK-COMPAT: no LUNA_DREAM_MODEL + login-ref anthropic account → options.env undefined AND options.model undefined", async () => {
      const sink: { last: { options: Record<string, unknown> } | null } = {
        last: null,
      }
      const prevModel = process.env["LUNA_DREAM_MODEL"]
      const prevReasoner = process.env["LUNA_REASONER_MODEL"]
      delete process.env["LUNA_DREAM_MODEL"]
      delete process.env["LUNA_REASONER_MODEL"]
      try {
        await Effect.runPromise(
          runReason(EMPTY_INPUTS, recordingClient(sink), FakeMemory()),
        )
      } finally {
        if (prevModel !== undefined) process.env["LUNA_DREAM_MODEL"] = prevModel
        if (prevReasoner !== undefined)
          process.env["LUNA_REASONER_MODEL"] = prevReasoner
      }
      const opts = sink.last!.options
      expect("model" in opts).toBe(false)
      expect("env" in opts).toBe(false)
      expect(opts["maxTurns"]).toBe(1)
    })

    it("(c) EXHAUSTION: broker with no matching account → reason() returns a DreamError (Left), does NOT throw", async () => {
      const sink: { last: { options: Record<string, unknown> } | null } = {
        last: null,
      }
      const anthropicOnlyBroker: Layer.Layer<AccountBroker> =
        AccountBrokerLayer.fromAccounts([
          { id: "a1", kind: "anthropic", secretRef: CLAUDE_CODE_LOGIN_SECRET_REF },
        ]).pipe(
          Layer.provide(EnvSecretProvider.Default),
          Layer.provide(Clock.Default),
        )
      const prevModel = process.env["LUNA_DREAM_MODEL"]
      process.env["LUNA_DREAM_MODEL"] = "gemini-2.5-flash"
      try {
        const result = await Effect.runPromise(
          Effect.either(
            runReason(
              EMPTY_INPUTS,
              recordingClient(sink),
              FakeMemory(),
              anthropicOnlyBroker,
            ),
          ),
        )
        expect(result._tag).toBe("Left")
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(DreamError)
          expect((result.left as DreamError).op).toBe("reason")
        }
        // The SDK was never invoked because acquire failed first.
        expect(sink.last).toBeNull()
      } finally {
        if (prevModel === undefined) delete process.env["LUNA_DREAM_MODEL"]
        else process.env["LUNA_DREAM_MODEL"] = prevModel
      }
    })
  })
})

// ── flag-ON layer-level end-to-end (the acknowledged follow-up) ─────────────
// Symmetric to the wake test: proves the WHOLE DreamReasonerDefault layer with
// LUNA_REASONER_STRUCTURED_OUTPUT=1 (a) injects outputFormat:{type:"json_schema",
// schema:<top-level ARRAY>} into the options handed to sdk.query, and (b) routes
// pass 1 through validateRawOps(structured_output) instead of parseRawOps(text).
// The headline case serves a frame whose TEXT is unparseable garbage but whose
// structured_output is a valid op array — the wrapped-output failure the OLD
// text-parse path returned a DreamError on, now resolved cleanly.
describe("DreamReasonerDefault — structured output flag ON (end-to-end)", () => {
  const recordingClientWith = (
    sink: { last: { options: Record<string, unknown> } | null },
    frame: SDKMessage,
  ): Layer.Layer<SDKClient> =>
    SDKClient.fake((params) => {
      sink.last = { options: (params.options ?? {}) as Record<string, unknown> }
      return makeFakeQuery({ messages: [frame] }).query
    })

  const withFlag = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env["LUNA_REASONER_STRUCTURED_OUTPUT"]
    if (value === undefined) delete process.env["LUNA_REASONER_STRUCTURED_OUTPUT"]
    else process.env["LUNA_REASONER_STRUCTURED_OUTPUT"] = value
    try {
      await fn()
    } finally {
      if (prev === undefined) delete process.env["LUNA_REASONER_STRUCTURED_OUTPUT"]
      else process.env["LUNA_REASONER_STRUCTURED_OUTPUT"] = prev
    }
  }

  it("flag ON → injects outputFormat(json_schema, top-level ARRAY) into the SDK options", async () => {
    const sink: { last: { options: Record<string, unknown> } | null } = { last: null }
    const frame = {
      ...makeResultMessage("sid", "uuid-dso"),
      result: JSON.stringify([RAW_BELIEF_OP]),
      structured_output: [RAW_BELIEF_OP],
    } as unknown as SDKMessage
    await withFlag("1", async () => {
      await Effect.runPromise(
        runReason(EMPTY_INPUTS, recordingClientWith(sink, frame), FakeMemory()),
      )
    })
    const opts = sink.last!.options
    const outputFormat = opts["outputFormat"] as
      | { type?: string; schema?: { type?: string } }
      | undefined
    expect(outputFormat).toBeDefined()
    expect(outputFormat!.type).toBe("json_schema")
    // Dream's schema is intentionally a TOP-LEVEL ARRAY (vs wake's object).
    expect(outputFormat!.schema?.type).toBe("array")
  })

  it("flag ON → consumes structured_output EVEN WHEN the text result is unparseable garbage (kills the wrapped-output failure class)", async () => {
    const sink: { last: { options: Record<string, unknown> } | null } = { last: null }
    const frame = {
      ...makeResultMessage("sid", "uuid-dgarbage"),
      result: "Here are the dream ops you requested! See below.",
      structured_output: [RAW_BELIEF_OP],
    } as unknown as SDKMessage

    await withFlag("1", async () => {
      const ops = await Effect.runPromise(
        runReason(EMPTY_INPUTS, recordingClientWith(sink, frame), FakeMemory()),
      )
      // Resolved cleanly from the structured op array despite the garbage text.
      expect(ops).toHaveLength(1)
      const op = ops[0]!
      expect(op.kind).toBe("belief_candidate")
      expect(op.targetId).toBe(EXPECTED_ID)
      const after = op.after as MemoryRecord
      expect((after.content as { statement: string }).statement).toBe(
        RAW_BELIEF_OP.statement,
      )
    })
  })

  it("flag OFF (default) → NO outputFormat in the SDK options (byte-identical back-compat)", async () => {
    const sink: { last: { options: Record<string, unknown> } | null } = { last: null }
    const frame = {
      ...makeResultMessage("sid", "uuid-doff"),
      result: JSON.stringify([RAW_BELIEF_OP]),
    } as unknown as SDKMessage
    await withFlag(undefined, async () => {
      const ops = await Effect.runPromise(
        runReason(EMPTY_INPUTS, recordingClientWith(sink, frame), FakeMemory()),
      )
      expect(ops).toHaveLength(1)
    })
    const opts = sink.last!.options
    expect("outputFormat" in opts).toBe(false)
    expect(opts["maxTurns"]).toBe(1)
  })
})

// ── S4 — Loop B integration: buildDreamPrompt + reason() consume distilled ──
// sessions and a bounded memories block, with a pre-flight token budget gate.
describe("buildDreamPrompt — distilled sessions + bounded memories (S4)", () => {
  const MEMORY_HEADER = "CURRENT MEMORY STATE (for dedup/staleness/contradiction ops only):"

  it("(e) renders each session's excerpt verbatim under a 'SESSION <id> (windowMessageCount/messageCount msgs in window):' header, never leaking raw summary fields via JSON.stringify", () => {
    const EXCERPT_MARKER = "USER_SAID_HELLO_MARKER_e7f1"
    const RAW_FIELD_SENTINEL = "SHOULD_NEVER_LEAK_INTO_PROMPT_9f3c"
    const session: DistilledSession = {
      // title carries a sentinel that would leak if buildDreamPrompt ever
      // JSON.stringify'd the whole session/summary object instead of only
      // rendering `summary.id` + the pre-distilled `excerpt`.
      summary: { ...baseSummary("s-42"), title: RAW_FIELD_SENTINEL },
      excerpt: `[user] ${EXCERPT_MARKER}\n[assistant] ok`,
      messageCount: 5,
      windowMessageCount: 2,
    }
    const prompt = buildDreamPrompt(makeInputs({ sessions: [session] }))
    expect(prompt).toContain("SESSION s-42 (2/5 msgs in window):")
    expect(prompt).toContain(EXCERPT_MARKER)
    expect(prompt).not.toContain(RAW_FIELD_SENTINEL)
  })

  it("(f) caps the memories section at memoriesChars and appends a '[… N more memory records omitted]' marker when the rendered lines overflow the budget", () => {
    // 5000 short records comfortably overflows the 40_000-char default budget
    // under any reasonable per-line rendering, without hardcoding the exact
    // per-line format (that's an implementation detail, not part of this spec).
    const many = Array.from({ length: 5000 }, (_, i) =>
      memRecordFixture(`mem-${String(i).padStart(5, "0")}`),
    )
    const prompt = buildDreamPrompt(makeInputs({ memories: many }))
    const idx = prompt.indexOf(MEMORY_HEADER)
    expect(idx).toBeGreaterThanOrEqual(0)
    const memSection = prompt.slice(idx + MEMORY_HEADER.length).trim()
    expect(memSection.length).toBeLessThanOrEqual(DEFAULT_DISTILL_OPTIONS.memoriesChars)
    expect(memSection).toMatch(/\[… \d+ more memory records omitted\]/)
  })

  it("(f2) memories within the budget render with no omission marker", () => {
    const few = [memRecordFixture("mem-1"), memRecordFixture("mem-2"), memRecordFixture("mem-3")]
    const prompt = buildDreamPrompt(makeInputs({ memories: few }))
    const idx = prompt.indexOf(MEMORY_HEADER)
    expect(idx).toBeGreaterThanOrEqual(0)
    const memSection = prompt.slice(idx + MEMORY_HEADER.length).trim()
    expect(memSection).not.toMatch(/omitted/)
  })

  it("(g) reason() pre-flight: a prompt whose estimateTokens exceeds DREAM_PROMPT_TOKEN_BUDGET fails with a DreamError naming both numbers, WITHOUT calling the SDK", async () => {
    // A single oversized excerpt (bypassing distillSession's own perSessionChars
    // cap — constructed directly as plain data, per the task's fixture note)
    // is enough on its own to blow the whole-prompt token budget.
    const HUGE_EXCERPT = "x".repeat(500_000) // ~125,000 estimated tokens
    const hugeSession: DistilledSession = {
      summary: baseSummary("s-huge"),
      excerpt: HUGE_EXCERPT,
      messageCount: 1,
      windowMessageCount: 1,
    }
    const inputs = makeInputs({ sessions: [hugeSession] })
    const expectedTokens = estimateTokens(buildDreamPrompt(inputs))
    expect(expectedTokens).toBeGreaterThan(DREAM_PROMPT_TOKEN_BUDGET) // fixture sanity

    let calls = 0
    const sdkLayer = SDKClient.fake((_params) => {
      calls++
      const r = { ...makeResultMessage("sid", "uuid-preflight"), result: "[]" }
      return makeFakeQuery({ messages: [r] }).query
    })

    const exit = await Effect.runPromiseExit(
      runReason(inputs, sdkLayer, FakeMemory()),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const maybeError = Cause.failureOption(exit.cause)
      expect(maybeError._tag).toBe("Some")
      if (maybeError._tag === "Some") {
        const error = maybeError.value
        expect(error).toBeInstanceOf(DreamError)
        expect((error as DreamError).op).toBe("reason")
        expect((error as DreamError).message).toContain(String(expectedTokens))
        expect((error as DreamError).message).toContain(String(DREAM_PROMPT_TOKEN_BUDGET))
      }
    }
    // The pre-flight must reject BEFORE any sdk.query() call — zero cost on a
    // prompt that would never fit the model's context window anyway.
    expect(calls).toBe(0)
  })
})
