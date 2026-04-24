/**
 * SessionOptionsSchema — validates our added fields; passes sdkOptions opaque.
 *
 * Scope (c) per Phase 4 advisor verdict: we do NOT validate the SDK's
 * Options surface. That stays the SDK's own runtime responsibility.
 */
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  decodeSessionOptions,
  SessionOptionsSchema,
} from "../../src/schema/session-options.js"
import * as S from "effect/Schema"

describe("SessionOptionsSchema", () => {
  it("accepts a minimal valid options bundle", async () => {
    const out = await Effect.runPromise(
      decodeSessionOptions({ model: "claude-sonnet-4-5" }),
    )
    expect(out.model).toBe("claude-sonnet-4-5")
  })

  it("rejects empty model", async () => {
    const exit = await Effect.runPromiseExit(
      decodeSessionOptions({ model: "" }),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("rejects non-positive idleTimeoutMs", async () => {
    const exit = await Effect.runPromiseExit(
      decodeSessionOptions({ model: "m", idleTimeoutMs: 0 }),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("accepts systemPrompt as string, array, and preset struct", async () => {
    await Effect.runPromise(
      decodeSessionOptions({ model: "m", systemPrompt: "you are X" }),
    )
    await Effect.runPromise(
      decodeSessionOptions({ model: "m", systemPrompt: ["a", "b"] }),
    )
    await Effect.runPromise(
      decodeSessionOptions({
        model: "m",
        systemPrompt: { type: "preset", preset: "claude_code", append: "hi" },
      }),
    )
  })

  it("rejects invalid systemPrompt preset shape", async () => {
    const exit = await Effect.runPromiseExit(
      decodeSessionOptions({
        model: "m",
        // @ts-expect-error — bad preset literal
        systemPrompt: { type: "preset", preset: "gpt4" },
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("passes sdkOptions through as opaque record (scope (c))", async () => {
    const out = await Effect.runPromise(
      decodeSessionOptions({
        model: "m",
        sdkOptions: {
          maxTurns: 3,
          env: { FOO: "1" },
          // Weird keys are fine — SDK owns its own validation.
          someFutureField: { nested: [1, 2] },
        },
      }),
    )
    expect(out.sdkOptions?.maxTurns).toBe(3)
    expect((out.sdkOptions?.env as { FOO: string }).FOO).toBe("1")
  })

  it("is encodable → identity round-trip", () => {
    const encode = S.encodeSync(SessionOptionsSchema)
    const decode = S.decodeSync(SessionOptionsSchema)
    const input = {
      model: "claude-sonnet-4-5",
      idleTimeoutMs: 60_000,
      tags: ["a", "b"],
    }
    expect(encode(decode(input))).toEqual(input)
  })
})
