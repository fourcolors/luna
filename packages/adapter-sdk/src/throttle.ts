// packages/adapter-sdk/src/throttle.ts
//
// Throttle classification for terminal SDK stream errors, shared by the chat
// adapter (adapter.ts) and the wake/dream reasoners (brokered-turn.ts) so the
// 429-phrase list and the retry-after parse live in ONE place — a phrase added
// for a new provider reaches every broker-reporting lane at once.

/** Floor/ceiling for a parsed retry-after, in ms. The parse is best-effort
 * string sniffing: a gateway that embeds a MILLISECOND value (e.g.
 * "retryAfter: 60000") or an HTTP-date ("Retry-After: Wed, 21 Oct…") would
 * otherwise yield a wildly wrong cooldown (16.7 h / the day-of-month in
 * seconds). The clamp bounds the damage of any misparse; chain failover only
 * needs "cool this account for a while", not a precise horizon. */
const RETRY_AFTER_MIN_MS = 1_000
const RETRY_AFTER_MAX_MS = 10 * 60 * 1000 // 10 min

export type ThrottleKind =
  | "rate_limit"
  | "session_limit"
  | "quota_exhausted"
  | "model_busy"

export interface ThrottleClassification {
  readonly throttled: boolean
  readonly kind?: ThrottleKind
  /** Parsed + clamped retry-after in ms, when the error text carried one. */
  readonly retryAfterMs?: number
}

/**
 * Classify a terminal stream error as a throttle (HTTP 429/529, rate-limit /
 * session-limit / overload / quota phrasing). Word-boundary status codes +
 * explicit phrases so "11429 tokens" / "disk quota exceeded" don't false-positive
 * into a cooldown.
 * Anthropic throttles surface as 429 (rate_limit_error) / 529
 * (overloaded_error); session limit errors surface on OAuth subscription accounts
 * or gateway session limits; "resource_exhausted" / "quota_exhausted" covers raw
 * Gemini or OpenAI API quota errors.
 */
export function classifyThrottle(cause: unknown): ThrottleClassification {
  const text = String(
    (cause as { message?: unknown })?.message ?? cause,
  ).toLowerCase()

  let kind: ThrottleKind | undefined

  if (
    text.includes("session limit") ||
    text.includes("session_limit") ||
    text.includes("session quota") ||
    text.includes("maximum sessions reached")
  ) {
    kind = "session_limit"
  } else if (
    text.includes("quota_exhausted") ||
    text.includes("quota exhausted") ||
    text.includes("insufficient_quota") ||
    text.includes("resource_exhausted")
  ) {
    kind = "quota_exhausted"
  } else if (
    /\b529\b/.test(text) ||
    text.includes("overloaded") ||
    text.includes("model busy") ||
    text.includes("server overloaded")
  ) {
    kind = "model_busy"
  } else if (
    /\b429\b/.test(text) ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("too many requests")
  ) {
    kind = "rate_limit"
  }

  if (!kind) return { throttled: false }

  // Best-effort retry-after parse: "retry-after: 30" / "retry after 30s".
  // Assumes SECONDS (the HTTP convention), clamped to bound a misparse.
  const m = text.match(/retry[-_ ]?after[^0-9]*([0-9]+)/)
  if (!m || !m[1]) return { throttled: true, kind }
  const retryAfterMs = Math.min(
    Math.max(Number(m[1]) * 1000, RETRY_AFTER_MIN_MS),
    RETRY_AFTER_MAX_MS,
  )
  return { throttled: true, kind, retryAfterMs }
}

