/**
 * Error taxonomy — verify tagged error pattern matching per DESIGN.md §6.
 */
import { describe, expect, it } from "vitest"
import { Effect, Exit } from "effect"
import {
  ConfigError,
  RateLimitError,
  SDKError,
  TransientError,
} from "../src/errors.js"

describe("Root error taxonomy", () => {
  it("TransientError is a tagged error instance", () => {
    const err = new TransientError({
      module: "test",
      op: "read",
      cause: new Error("boom"),
    })
    expect(err._tag).toBe("TransientError")
    expect(err.module).toBe("test")
  })

  it("tagged errors propagate through Effect and are catchable by tag", async () => {
    const program = Effect.fail(
      new RateLimitError({ module: "account", cause: "429" }),
    ).pipe(
      Effect.catchTag("RateLimitError", (e) =>
        Effect.succeed(`caught:${e.module}`),
      ),
    )
    const result = await Effect.runPromise(program)
    expect(result).toBe("caught:account")
  })

  it("unhandled tagged errors surface via Exit", async () => {
    const program = Effect.fail(
      new SDKError({ op: "query", cause: "x" }),
    )
    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("distinct error tags do not cross-match", async () => {
    const program = Effect.fail(
      new ConfigError({
        module: "boot",
        key: "ANTHROPIC_API_KEY",
        message: "missing",
      }),
    ).pipe(
      // Try to catch the wrong tag — must NOT match
      Effect.catchTag("RateLimitError", () => Effect.succeed("wrong")),
    )
    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
