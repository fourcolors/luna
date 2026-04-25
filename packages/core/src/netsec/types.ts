/**
 * NetSecClient — public types (Phase 16).
 *
 * Mediated HTTP client with egress allowlists and policy enforcement.
 * TLS pinning is a Phase 16 goal; implemented as cert-fingerprint
 * verification on custom fetch.
 *
 * Design intent per DESIGN §2.2.9:
 *   - Wrap Node.js fetch behind an allowlist policy.
 *   - Block egress to hosts not in the allowlist when strict mode is on.
 *   - Optional TLS fingerprint pinning per host.
 *   - Emit ObservabilityService events for blocked/allowed requests
 *     (uses ToolCall event with toolName="netsec:fetch").
 *   - All errors are typed (no unknown throws).
 */
import type { Effect } from "effect"

/** HTTP methods supported. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

/** Result of an HTTP request. */
export interface HttpResponse {
  readonly status: number
  readonly statusText: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** An allowlist entry for a specific host or pattern. */
export interface AllowlistEntry {
  /**
   * Hostname or glob pattern (e.g., "api.example.com", "*.anthropic.com").
   * Use "*" to allow all hosts (disables allowlist for that entry).
   */
  readonly host: string
  /** Allowed HTTP methods. Default: all methods. */
  readonly methods?: HttpMethod[]
  /**
   * Optional SHA-256 fingerprint of the TLS certificate to pin.
   * Format: "sha256/<base64>". If set, requests to this host will be
   * rejected if the cert fingerprint doesn't match.
   */
  readonly tlsFingerprint?: string
}

/** Tagged error: request blocked by egress policy. */
export class EgressBlockedError extends Error {
  readonly _tag = "EgressBlockedError" as const
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`Egress blocked for ${url}: ${reason}`)
    this.name = "EgressBlockedError"
  }
}

/** Tagged error: TLS fingerprint mismatch. */
export class TlsPinViolationError extends Error {
  readonly _tag = "TlsPinViolationError" as const
  constructor(
    readonly host: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`TLS pin violation for ${host}: expected ${expected}, got ${actual}`)
    this.name = "TlsPinViolationError"
  }
}

/** Tagged error: HTTP request failed (network error, timeout). */
export class HttpRequestError extends Error {
  readonly _tag = "HttpRequestError" as const
  constructor(
    readonly url: string,
    override readonly cause: unknown,
  ) {
    super(`HTTP request failed for ${url}: ${String(cause)}`)
    this.name = "HttpRequestError"
  }
}

export type NetSecError = EgressBlockedError | TlsPinViolationError | HttpRequestError

export interface NetSecConfig {
  /**
   * If true, only requests to explicitly allowed hosts are permitted.
   * If false (default), all requests are allowed and the allowlist is
   * used for TLS pinning only.
   */
  readonly strictMode?: boolean

  /** Egress allowlist entries. */
  readonly allowlist?: AllowlistEntry[]

  /** Default timeout per request in milliseconds. Default: 30000. */
  readonly timeoutMs?: number
}

export interface RequestOptions {
  readonly method?: HttpMethod
  readonly headers?: Record<string, string>
  readonly body?: string
  /** Per-request timeout override in ms. */
  readonly timeoutMs?: number
}

export interface NetSecClientApi {
  /**
   * Make an HTTP request through the policy engine.
   * Blocked by allowlist → EgressBlockedError.
   * TLS pin mismatch → TlsPinViolationError.
   * Network/timeout → HttpRequestError.
   */
  readonly fetch: (
    url: string,
    opts?: RequestOptions,
  ) => Effect.Effect<HttpResponse, NetSecError>

  /**
   * Add a new allowlist entry at runtime.
   */
  readonly allow: (entry: AllowlistEntry) => Effect.Effect<void>

  /**
   * Check if a URL is currently allowed by the policy.
   * Returns true if allowed, false if blocked.
   */
  readonly isAllowed: (url: string, method?: HttpMethod) => Effect.Effect<boolean>
}
