/**
 * output-schema-guard.test.ts — regression tests for the `outputFormat` JSON
 * Schema object-root contract.
 *
 * THE INCIDENT THESE EXIST FOR: `DREAM_OPS_SCHEMA` was declared with
 * `type: "array"` at its root and passed as `options.outputFormat.schema`. The
 * Anthropic API implements structured output as a synthetic tool, so that schema
 * became a tool `input_schema`, which is rejected unless its root is an object:
 *
 *     400 tools.N.custom.input_schema.type: Input should be 'object'
 *
 * The request 400'd before the model ran. Every nightly dream cycle failed for
 * 30 days and 90 consecutive runs. Typecheck could not catch it (the schemas are
 * `Record<string, unknown>`), and the fake SDK accepted the malformed schema
 * happily, so the whole suite stayed green throughout.
 *
 * These tests lock the contract at BOTH enforcement points: the construction-time
 * assert on the known schemas, and the runtime seam that covers every future
 * caller and every inline literal. ZERO model calls.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"
import { SDKClient, type SDKClientService } from "../src/sdk-client.js"
import {
  runBoundedQuery,
  assertObjectRootedOutputSchema,
  InvalidOutputFormatSchemaError,
} from "../src/bounded-query.js"
import { makeFakeQuery } from "./fake-sdk.js"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

const resultMsg = (text: string): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: "s",
    uuid: "u",
    is_error: false,
    duration_ms: 5,
    duration_api_ms: 3,
    num_turns: 1,
    result: text,
  }) as unknown as SDKMessage

const runWith = <A>(
  sdkLayer: Layer.Layer<SDKClient>,
  body: (sdk: SDKClientService) => Effect.Effect<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sdk = yield* SDKClient
      return yield* body(sdk)
    }).pipe(Effect.provide(sdkLayer)),
  )

const OBJECT_ROOTED = {
  type: "object",
  properties: { ops: { type: "array", items: { type: "string" } } },
}

// ---------------------------------------------------------------------------
// The assertion helper
// ---------------------------------------------------------------------------

describe("assertObjectRootedOutputSchema", () => {
  it("accepts a minimal object-rooted schema", () => {
    expect(() =>
      assertObjectRootedOutputSchema({ type: "object" }, "T"),
    ).not.toThrow()
  })

  it("accepts an object root whose nested types are union arrays", () => {
    // Only the ROOT is constrained — nested `type: [...]` unions are legal JSON
    // Schema and wake's digest schema relies on them. The guard must not walk
    // the tree and must not reject these.
    expect(() =>
      assertObjectRootedOutputSchema(
        {
          type: "object",
          properties: {
            picked_action_id: { type: ["integer", "null"] },
            goal_slug: { type: ["string", "null"] },
          },
        },
        "T",
      ),
    ).not.toThrow()
  })

  it("REJECTS an array root — the exact shape that caused the 30-day outage", () => {
    expect(() =>
      assertObjectRootedOutputSchema(
        { type: "array", items: { type: "object" } },
        "DREAM_OPS_SCHEMA",
      ),
    ).toThrow(InvalidOutputFormatSchemaError)
  })

  it("rejects a missing root type", () => {
    expect(() =>
      assertObjectRootedOutputSchema({ properties: {} }, "T"),
    ).toThrow(InvalidOutputFormatSchemaError)
  })

  it('rejects a union root type even when it contains "object"', () => {
    // `["object","null"]` is legal JSON Schema but the tool input_schema
    // contract wants the exact string "object". Accepting it here would let a
    // 400 through at 03:00 instead of failing in CI.
    expect(() =>
      assertObjectRootedOutputSchema({ type: ["object", "null"] }, "T"),
    ).toThrow(InvalidOutputFormatSchemaError)
  })

  it("rejects a bare array, null, and primitives", () => {
    for (const bad of [[], null, undefined, "object", 42, true]) {
      expect(() => assertObjectRootedOutputSchema(bad, "T")).toThrow(
        InvalidOutputFormatSchemaError,
      )
    }
  })

  it("names the schema and the offending root in the message", () => {
    // The provider's own error names a TOOL INDEX the caller never wrote
    // ("tools.8.custom.input_schema"), which is why the original outage took 30
    // days to trace. Our message must point at the schema instead.
    let msg = ""
    try {
      assertObjectRootedOutputSchema({ type: "array" }, "DREAM_OPS_SCHEMA")
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain("DREAM_OPS_SCHEMA")
    expect(msg).toContain('"array"')
  })
})

// ---------------------------------------------------------------------------
// Construction-time enforcement on the real schemas
// ---------------------------------------------------------------------------

describe("shipped reasoner schemas are object-rooted", () => {
  it("importing the reasoners does not throw (the asserts run at module scope)", async () => {
    // If either DREAM_OPS_SCHEMA or WAKE_DIGEST_SCHEMA regressed to a non-object
    // root, these imports would throw and this test would fail. That is the
    // construction-time half of the guard: a bad schema cannot reach a green CI.
    await expect(import("../src/dream-reasoner.js")).resolves.toBeDefined()
    const wake = await import("../src/wake-reasoner.js")
    expect((wake.WAKE_DIGEST_SCHEMA as { type?: unknown }).type).toBe("object")
  })
})

// ---------------------------------------------------------------------------
// Runtime seam enforcement
// ---------------------------------------------------------------------------

describe("runBoundedQuery — outputFormat schema seam", () => {
  it("rejects an array-rooted outputFormat schema WITHOUT spawning the query", async () => {
    // The critical assertion is `built === 0`: a deterministic 400 must never
    // leave the process. This is the check that would have turned the dream
    // outage into a red test instead of 90 silent nightly failures.
    let built = 0
    const sdkLayer = SDKClient.fake(() => {
      built += 1
      return makeFakeQuery({ messages: [resultMsg("unreachable")] }).query
    })

    const out = await runWith(sdkLayer, (sdk) =>
      runBoundedQuery(sdk, {
        prompt: "x",
        options: {
          outputFormat: {
            type: "json_schema",
            schema: { type: "array", items: { type: "object" } },
          },
        },
      } as never),
    )

    expect(built).toBe(0)
    expect(out._tag).toBe("error")
    if (out._tag === "error") {
      expect(out.cause).toBeInstanceOf(InvalidOutputFormatSchemaError)
    }
  })

  it("returns an ERROR OUTCOME, never a defect — a schema bug must not be retried", async () => {
    // A throw here would become an Effect defect, and `defect` is a member of
    // RETRYABLE_WORKER_ERROR_REASONS in core's job-ticker-executor. Throwing
    // would turn a permanent schema bug into 3 retries per fire, forever.
    // `Effect.runPromise` resolving (not rejecting) is the proof.
    const sdkLayer = SDKClient.fake(() => makeFakeQuery({ messages: [] }).query)
    await expect(
      runWith(sdkLayer, (sdk) =>
        runBoundedQuery(sdk, {
          prompt: "x",
          options: {
            outputFormat: { type: "json_schema", schema: { type: "array" } },
          },
        } as never),
      ),
    ).resolves.toMatchObject({ _tag: "error" })
  })

  it("allows an object-rooted outputFormat schema through to the query", async () => {
    let built = 0
    const sdkLayer = SDKClient.fake(() => {
      built += 1
      return makeFakeQuery({ messages: [resultMsg("ok")] }).query
    })

    const out = await runWith(sdkLayer, (sdk) =>
      runBoundedQuery(sdk, {
        prompt: "x",
        options: {
          outputFormat: { type: "json_schema", schema: OBJECT_ROOTED },
        },
      } as never),
    )

    expect(built).toBe(1)
    expect(out._tag).toBe("result")
  })

  it("leaves plain (non-outputFormat) turns completely untouched", async () => {
    // The guard must be inert for every existing caller — prompt-worker and the
    // workflow prompt step pass no outputFormat at all.
    let built = 0
    const sdkLayer = SDKClient.fake(() => {
      built += 1
      return makeFakeQuery({ messages: [resultMsg("plain")] }).query
    })
    const out = await runWith(sdkLayer, (sdk) =>
      runBoundedQuery(sdk, { prompt: "x" }),
    )
    expect(built).toBe(1)
    expect(out._tag).toBe("result")
    if (out._tag === "result") expect(out.text).toBe("plain")
  })
})
