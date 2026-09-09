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
  | "credit_exhausted"
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
  // unconverted, an OpenAI billing `insufficient_quota`, or Claude Code's own
  // subscription-plan usage caps ("You've hit your weekly limit · resets ...",
  // and its 5-hour-window sibling "hit your usage limit"). These are the exact
  // literal phrases the `claude` CLI (Claude.ai OAuth "login" credential kind)
  // emits when a Pro/Max plan's rolling quota is exhausted — distinct from an
  // API 429/session cap, and previously unmatched by this table entirely, which
  // silently defeated BOTH the broker cooldown and chat-service's account-
  // rotation gate (`defaultIsRotatableError`) for exactly the "auto" path this
  // classification exists to serve. See account-rotation.sim.test.ts for the
  // end-to-end rotation behavior this phrase now drives.
  if (
    text.includes("quota_exhausted") ||
    text.includes("quota exhausted") ||
    text.includes("insufficient_quota") ||
    text.includes("resource_exhausted") ||
    text.includes("weekly limit") ||
    text.includes("hit your usage limit") ||
    text.includes("usage limit reached")
  ) {
    return "quota_exhausted"
  }

  // Claude Code subscription CREDIT exhaustion. Distinct from the rolling
  // windows above: these are the literal prefixes the `claude` CLI emits when a
  // seat has no usage credits left (`USAGE_LIMIT_ERROR_PREFIXES`, exported from
  // @anthropic-ai/claude-agent-sdk >= ~0.3.2xx), plus the first-party API's
  // "credit balance is too low" (Console-side, so not in the CLI's list).
  //
  // Why this is its own kind rather than more `quota_exhausted` phrases: the
  // window these refusals name is HOURS TO DAYS (a 7-day overage pool, an admin
  // re-enabling a seat), so the broker gives it the long cooldown. Reusing
  // `quota_exhausted` would either leave it on the 60s default (thrash: cool,
  // re-pick the dead account, fail, repeat every minute) or drag Gemini's
  // per-MINUTE `resource_exhausted` up to a 3-hour bench with it.
  //
  // ORDER: this branch sits BELOW `quota_exhausted` deliberately. The SDK's
  // "you've hit your" / "you've reached your" prefixes are broad enough to
  // swallow "You've hit your weekly limit", which must keep classifying as
  // `quota_exhausted` for the existing rotation behavior. Ordering it here
  // means only genuinely-new phrasing reaches `credit_exhausted`.
  //
  // The real incident this closes: "Claude Code returned an error result:
  // You're out of usage credits. Switch to another model to continue." matched
  // NOTHING in this table, so `classifyThrottleKind` returned undefined, which
  // no-op'd BOTH consumers — the adapter never reported a throttle (no
  // cooldown) and `defaultIsRotatableError` refused to rotate. One thread ate
  // the same refusal 17 times while a healthy sibling account sat idle.
  if (
    text.includes("out of usage credits") ||
    text.includes("out of extra usage") ||
    text.includes("out of usage · add funds") ||
    text.includes("out of usage · contact your admin") ||
    text.includes("doesn't include usage credits") ||
    text.includes("doesn't include usage") ||
    text.includes("doesn't include extra usage") ||
    text.includes("usage allocation has been disabled") ||
    text.includes("usage limit is set to $0") ||
    text.includes("requires usage credits") ||
    text.includes("credit balance is too low") ||
    text.includes("you've hit your") ||
    text.includes("you've reached your")
  ) {
    return "credit_exhausted"
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
