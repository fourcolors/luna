/**
 * Cross-package parity guard for throttle classification.
 *
 * Two predicates decide what happens to a refused request, and they used to
 * keep SEPARATE hand-maintained phrase lists:
 *
 *   - `classifyThrottle`        (@luna/adapter-sdk) -> cool the account down
 *   - `defaultIsRotatableError` (@luna/core)        -> rotate the lane
 *
 * They had already drifted: `insufficient_quota` and `model busy` cooled the
 * account but would NOT have rotated the lane, so a caller using the overflow
 * chain would burn its attempts on an account the adapter had just benched.
 * Both now read the shared table in core's throttle-kind.ts, and this suite
 * fails the moment one of them learns a phrase the other doesn't.
 *
 * This test lives in adapter-sdk because the dependency edge runs
 * adapter-sdk -> core, so only this side can import both.
 */

import { describe, it, expect } from "vitest"
import { defaultIsRotatableError, classifyThrottleKind } from "@luna/core"
import { classifyThrottle } from "../src/throttle.js"

/** Every phrase the shared table recognizes, plus the two that were missing
 *  from the rotation predicate before the tables were unified. */
const THROTTLE_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["session limit", "session limit reached for this account"],
  ["session_limit", "error: session_limit"],
  ["session quota", "session quota met"],
  ["maximum sessions reached", "maximum sessions reached"],
  ["quota_exhausted", "quota_exhausted: monthly allocation met"],
  ["quota exhausted", "quota exhausted for this key"],
  // Previously rotation-blind.
  ["insufficient_quota", "insufficient_quota: add credits"],
  ["resource_exhausted", "RESOURCE_EXHAUSTED: token quota reset at midnight"],
  ["529", "API Error 529"],
  ["overloaded", "overloaded_error"],
  // Previously rotation-blind.
  ["model busy", "model busy, retry shortly"],
  ["server overloaded", "server overloaded, back off"],
  ["429", "API Error 429: rate_limit_error"],
  ["rate limit", "rate limit exceeded"],
  ["rate_limit", "rate_limit_error"],
  ["too many requests", "Too Many Requests"],
]

/** Text that must NOT read as a throttle on either side. These are the
 *  long-standing false-positive guards: a token count containing "429", the
 *  disk-space phrasing, and an auth failure. */
const NON_THROTTLE_PHRASES: ReadonlyArray<readonly [string, string]> = [
  ["embedded 429 in a number", "prompt contains 11429 tokens"],
  ["disk quota, not billing quota", "disk quota exceeded"],
  ["auth failure", "Invalid API key provided"],
  ["plain failure", "connection reset by peer"],
]

describe("throttle classification parity (adapter-sdk <-> core)", () => {
  it.each(THROTTLE_PHRASES)(
    "both predicates treat %s as a throttle",
    (_label, message) => {
      const error = new Error(message)
      expect(classifyThrottle(error).throttled).toBe(true)
      expect(defaultIsRotatableError(error)).toBe(true)
    },
  )

  it.each(NON_THROTTLE_PHRASES)(
    "neither predicate treats %s as a throttle",
    (_label, message) => {
      const error = new Error(message)
      expect(classifyThrottle(error).throttled).toBe(false)
      expect(defaultIsRotatableError(error)).toBe(false)
    },
  )

  it("classifyThrottle's kind is exactly what the shared table returns", () => {
    for (const [, message] of THROTTLE_PHRASES) {
      const expected = classifyThrottleKind(message.toLowerCase())
      expect(classifyThrottle(new Error(message)).kind).toBe(expected)
    }
  })

  it("the more specific cause wins when phrases overlap", () => {
    // Both "session limit" and "quota exhausted" appear; session_limit is the
    // more specific reason and must win, matching the documented ladder order.
    const res = classifyThrottle(new Error("session limit reached - quota exhausted"))
    expect(res.kind).toBe("session_limit")
    expect(defaultIsRotatableError(new Error("session limit reached - quota exhausted"))).toBe(true)
  })

  it("non-throttle tagged errors stay non-rotatable regardless of their text", () => {
    // A tagged terminal error must not rotate even if its message happens to
    // contain throttle-ish words - the tag check runs first.
    for (const _tag of [
      "AllAccountsExhaustedError",
      "ConfigError",
      "ValidationError",
      "IntegrityError",
      "PermissionError",
    ]) {
      expect(defaultIsRotatableError({ _tag, message: "rate limit" })).toBe(false)
    }
  })
})
