// packages/core/src/throttle-kind.ts
//
// THE single source of truth for "does this error text mean the provider is
// refusing us, and if so why". Two independent consumers classify the same
// error strings and must never disagree:
//
//   1. @luna/adapter-sdk's `classifyThrottle` - decides whether a terminal
//      stream error gets reported to the account broker as a cooldown, and
//      with which `kind`.
//   2. `defaultIsRotatableError` (overflow-chain.ts) - decides whether an
//      error should rotate execution to the next chain step.
//
// Those two started as parallel hand-maintained phrase lists and immediately
// drifted: the rotation predicate was missing `insufficient_quota` and
// `model busy`, so an error the adapter cooled the account for would NOT
// have rotated the lane. Any future provider phrase now has exactly one
// place to be added, and both consumers pick it up at once.
//
// This lives in @luna/core (not adapter-sdk) because the dependency edge runs
// adapter-sdk -> core, and core's overflow-chain needs it too. Putting it in
// adapter-sdk would require core to import from adapter-sdk, a cycle.

/** Why a provider refused the request. Drives both the broker cooldown kind
 *  and the overflow-chain rotation decision. */
export type ThrottleKind =
  | "rate_limit"
  | "session_limit"
  | "quota_exhausted"
  | "model_busy"

/**
 * Map already-lowercased error text to a ThrottleKind, or undefined when the
 * text carries no throttle signal at all.
 *
 * ORDER IS SIGNIFICANT and matches the original adapter-sdk ladder: the most
 * specific cause wins, so "session limit reached - quota exhausted" classifies
 * as `session_limit`, not `quota_exhausted`.
 *
 * Status codes use word boundaries (`\b429\b`) and phrases are explicit so the
 * long-standing false-positive guards hold: "prompt contains 11429 tokens" and
 * "disk quota exceeded" must NOT read as throttles. Note that "quota exhausted"
 * is matched while "quota exceeded" deliberately is not - the latter is the
 * disk-space phrasing.
 *
 * @param text error text, ALREADY lowercased by the caller.
 */
export function classifyThrottleKind(text: string): ThrottleKind | undefined {
  // Subscription/OAuth accounts and gateways that cap concurrent sessions.
  if (
    text.includes("session limit") ||
    text.includes("session_limit") ||
    text.includes("session quota") ||
    text.includes("maximum sessions reached")
  ) {
    return "session_limit"
  }

  // Hard allocation gone: raw Gemini RESOURCE_EXHAUSTED leaking through
  // unconverted, or an OpenAI billing `insufficient_quota`.
  if (
    text.includes("quota_exhausted") ||
    text.includes("quota exhausted") ||
    text.includes("insufficient_quota") ||
    text.includes("resource_exhausted")
  ) {
    return "quota_exhausted"
  }

  // Transient capacity: Anthropic surfaces this as 529 (overloaded_error).
  if (
    /\b529\b/.test(text) ||
    text.includes("overloaded") ||
    text.includes("model busy") ||
    text.includes("server overloaded")
  ) {
    return "model_busy"
  }

  // Ordinary rate limiting: Anthropic 429 (rate_limit_error); an
  // Anthropic-format gateway (LiteLLM) normalizes upstream provider limits
  // to 429s as well.
  if (
    /\b429\b/.test(text) ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("too many requests")
  ) {
    return "rate_limit"
  }

  return undefined
}

/** Convenience wrapper for callers holding a raw error rather than text.
 *  Applies the same `message ?? error` + lowercase normalization both
 *  consumers were doing independently. */
export function classifyThrottleKindOf(error: unknown): ThrottleKind | undefined {
  const text = String((error as { message?: unknown })?.message ?? error).toLowerCase()
  return classifyThrottleKind(text)
}
