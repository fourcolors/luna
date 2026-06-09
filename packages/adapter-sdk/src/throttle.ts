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

export interface ThrottleClassification {
  readonly throttled: boolean
  /** Parsed + clamped retry-after in ms, when the error text carried one. */
  readonly retryAfterMs?: number
}

/**
 * Classify a terminal stream error as a throttle (HTTP 429/529, rate-limit /
 * overload phrasing). Word-boundary status codes + explicit phrases so
 * "11429 tokens" / "disk quota exceeded" don't false-positive into a cooldown.
 * Anthropic throttles surface as 429 (rate_limit_error) / 529
 * (overloaded_error); an Anthropic-format gateway (LiteLLM) normalizes
 * upstream provider limits to 429s, and "resource_exhausted" covers a raw
 * Gemini RESOURCE_EXHAUSTED leaking through unconverted.
 */
export function classifyThrottle(cause: unknown): ThrottleClassification {
  const text = String(
    (cause as { message?: unknown })?.message ?? cause,
  ).toLowerCase()
  const throttled =
    /\b(429|529)\b/.test(text) ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("too many requests") ||
    text.includes("resource_exhausted") ||
    text.includes("overloaded")
  if (!throttled) return { throttled: false }
  // Best-effort retry-after parse: "retry-after: 30" / "retry after 30s".
  // Assumes SECONDS (the HTTP convention), clamped to bound a misparse.
  const m = text.match(/retry[-_ ]?after[^0-9]*([0-9]+)/)
  if (!m || !m[1]) return { throttled: true }
  const retryAfterMs = Math.min(
    Math.max(Number(m[1]) * 1000, RETRY_AFTER_MIN_MS),
    RETRY_AFTER_MAX_MS,
  )
  return { throttled: true, retryAfterMs }
}
