/**
 * throttle-session-limit.test.ts — Unit tests for session limit throttle classification
 * in @luna/adapter-sdk (classifyThrottle).
 */
import { describe, expect, it } from "vitest"
import { classifyThrottle } from "../src/throttle.js"

describe("classifyThrottle — session limit classification", () => {
  it.each([
    "API Error: session limit reached for current account",
    "429 session_limit_reached",
    "Session limit exceeded on subscription plan",
    "maximum sessions reached, please retry later",
    "429 Session quota exhausted",
  ])("classifies %j as throttled with kind 'session_limit'", (msg) => {
    const res = classifyThrottle(new Error(msg))
    expect(res.throttled).toBe(true)
    expect(res.kind).toBe("session_limit")
  })

  it("parses retry-after along with session_limit kind", () => {
    const res = classifyThrottle(
      new Error("429 session limit reached; retry-after: 45"),
    )
    expect(res).toEqual({
      throttled: true,
      kind: "session_limit",
      retryAfterMs: 45_000,
    })
  })
})

describe("classifyThrottle — kind classification matrix", () => {
  it("classifies quota_exhausted errors", () => {
    const res1 = classifyThrottle(new Error("quota_exhausted: monthly allocation met"))
    expect(res1).toEqual({ throttled: true, kind: "quota_exhausted" })

    const res2 = classifyThrottle(new Error("RESOURCE_EXHAUSTED: token quota reset at midnight"))
    expect(res2).toEqual({ throttled: true, kind: "quota_exhausted" })
  })

  it("classifies model_busy errors", () => {
    const res1 = classifyThrottle(new Error("overloaded_error: 529"))
    expect(res1).toEqual({ throttled: true, kind: "model_busy" })

    const res2 = classifyThrottle(new Error("server overloaded, back off"))
    expect(res2).toEqual({ throttled: true, kind: "model_busy" })
  })

  it("classifies standard rate_limit errors", () => {
    const res1 = classifyThrottle(new Error("API Error 429: rate_limit_error"))
    expect(res1).toEqual({ throttled: true, kind: "rate_limit" })

    const res2 = classifyThrottle(new Error("Too Many Requests"))
    expect(res2).toEqual({ throttled: true, kind: "rate_limit" })
  })

  it("returns throttled: false for non-throttle errors", () => {
    expect(classifyThrottle(new Error("prompt contains 11429 tokens")).throttled).toBe(false)
    expect(classifyThrottle(new Error("disk quota exceeded")).throttled).toBe(false)
    expect(classifyThrottle(new Error("Invalid API key provided")).throttled).toBe(false)
  })
})
