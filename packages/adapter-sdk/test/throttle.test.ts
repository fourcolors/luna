/**
 * throttle.test.ts — Tier-1 unit tests for the shared throttle classifier
 * (classifyThrottle): phrase coverage incl. the gateway/Gemini cases, the
 * false-positive guards, and the retry-after clamp that bounds a misparse
 * (ms-valued or HTTP-date retry-after strings).
 */
import { describe, expect, it } from "vitest"
import { classifyThrottle, toRotatableError } from "../src/throttle.js"

describe("classifyThrottle — phrase coverage", () => {
  it.each([
    "API Error: 429 rate_limit_error",
    "overloaded_error: 529",
    "Too Many Requests",
    "rate limit exceeded, please slow down",
    "RESOURCE_EXHAUSTED: quota will reset shortly", // raw Gemini leak
  ])("classifies %j as throttled", (msg) => {
    expect(classifyThrottle(new Error(msg)).throttled).toBe(true)
  })

  it.each([
    "prompt contains 11429 tokens", // digits inside a larger number
    "disk quota exceeded", // EDQUOT, not an API limit
    "ENOENT: no such file",
  ])("does NOT classify %j as throttled", (msg) => {
    expect(classifyThrottle(new Error(msg)).throttled).toBe(false)
  })

  it("stringifies non-Error causes", () => {
    expect(classifyThrottle("got 429 from upstream").throttled).toBe(true)
  })
})

describe("classifyThrottle — retry-after parse + clamp", () => {
  it("parses a seconds-valued retry-after", () => {
    expect(
      classifyThrottle(new Error("429 rate limit; retry-after: 30")),
    ).toEqual({ throttled: true, kind: "rate_limit", retryAfterMs: 30_000 })
  })

  it("clamps a milliseconds-valued retry-after (would otherwise cool ~17h)", () => {
    const cls = classifyThrottle(
      new Error("429 rate limit, retryAfter: 60000"),
    )
    expect(cls.retryAfterMs).toBe(10 * 60 * 1000) // 10-min ceiling
  })

  it("clamps a sub-second value up to the 1s floor", () => {
    const cls = classifyThrottle(new Error("429 retry-after: 0"))
    expect(cls.retryAfterMs).toBe(1_000)
  })

  it("omits retryAfterMs when the text has none", () => {
    expect(classifyThrottle(new Error("429 rate limit"))).toEqual({
      throttled: true,
      kind: "rate_limit",
    })
  })
})

describe("toRotatableError — lift throttle to tagged error", () => {
  it("session_limit → SessionLimitError", () => {
    const err = toRotatableError(
      new Error("session limit reached"),
      "test",
    )
    expect(err).not.toBeNull()
    expect(err!._tag).toBe("SessionLimitError")
    expect(err!.module).toBe("test")
  })

  it("rate_limit → RateLimitError with retryAfterMs", () => {
    const err = toRotatableError(
      new Error("429 rate limit; retry-after: 30"),
      "adapter",
    )
    expect(err).not.toBeNull()
    expect(err!._tag).toBe("RateLimitError")
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(30_000)
  })

  it("quota_exhausted → RateLimitError", () => {
    const err = toRotatableError(
      new Error("quota_exhausted"),
      "adapter",
    )
    expect(err!._tag).toBe("RateLimitError")
  })

  it("model_busy → RateLimitError", () => {
    const err = toRotatableError(new Error("529 overloaded"), "adapter")
    expect(err!._tag).toBe("RateLimitError")
  })

  it("non-throttle → null", () => {
    expect(toRotatableError(new Error("network timeout"), "adapter")).toBeNull()
  })

  it("preserves original cause", () => {
    const cause = new Error("maximum sessions reached")
    const err = toRotatableError(cause, "adapter")
    expect(err!.cause).toBe(cause)
  })
})
