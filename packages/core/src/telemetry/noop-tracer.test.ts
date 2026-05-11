/**
 * NoopTracerLayer tests — TDD PING phase.
 *
 * NoopTracerLayer provides a no-op Effect Tracer service so that
 * Effect.withSpan / Effect.annotateCurrentSpan work without error in
 * environments that don't have a real tracing backend.
 *
 * Tests:
 *   1. Effect.withSpan succeeds when NoopTracerLayer is provided.
 *   2. Effect.annotateCurrentSpan does not throw.
 *   3. The wrapped effect still returns its value correctly.
 */
import { describe, expect, it } from "vitest"
import { Effect, Layer } from "effect"

import { NoopTracerLayer } from "./noop-tracer.js"

describe("NoopTracerLayer", () => {
  // ── 1. withSpan works without error ──────────────────────────────────────

  it("Effect.withSpan completes without error when NoopTracerLayer is provided", async () => {
    const result = await Effect.runPromise(
      Effect.withSpan("test-span")(Effect.succeed("ok")).pipe(
        Effect.provide(NoopTracerLayer),
      ),
    )

    expect(result).toBe("ok")
  })

  // ── 2. annotateCurrentSpan works without error ────────────────────────────

  it("Effect.annotateCurrentSpan does not throw inside a span", async () => {
    await expect(
      Effect.runPromise(
        Effect.withSpan("annotate-test")(
          Effect.annotateCurrentSpan("key", "value"),
        ).pipe(
          Effect.provide(NoopTracerLayer),
        ),
      ),
    ).resolves.toBeUndefined()
  })

  // ── 3. Wrapped effect returns its value ───────────────────────────────────

  it("Effect.withSpan does not alter the return value of the wrapped effect", async () => {
    const result = await Effect.runPromise(
      Effect.withSpan("value-check")(Effect.succeed(42)).pipe(
        Effect.provide(NoopTracerLayer),
      ),
    )

    expect(result).toBe(42)
  })
})
