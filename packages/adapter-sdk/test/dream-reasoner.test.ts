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

  it("no success-result message in SDK stream → DreamError", async () => {
    const exit = await Effect.runPromiseExit(
      runReason(EMPTY_INPUTS, fakeClientNoSuccess(), FakeMemory()),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("rejects ops with an unknown kind → DreamError", async () => {
    const json = JSON.stringify([
      { kind: "delete_everything", domain: "ops", statement: "bad", confidence: 1, evidence: [], rationale: "no" },
    ])
    const exit = await Effect.runPromiseExit(
      runReason(EMPTY_INPUTS, fakeClientWithResult(json), FakeMemory()),
    )
    expect(exit._tag).toBe("Failure")
  })
})
