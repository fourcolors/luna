import type { Effect, Stream } from "effect"

/**
 * Session types — the options/summary/query shapes SessionService operates on.
 *
 * Kept minimal here; the full SDK-parity `Options` surface (permissionMode,
 * allowedTools, mcpServers, hooks, env, settingSources, etc.) will be modeled
 * with @effect/schema in Phase 4 and attached to `SessionOptions` via
 * structural compatibility. Forward-adding fields is non-breaking for
 * consumers that do a structural narrow; see §5.2 migration policy.
 */

export type SessionStatus = "active" | "idle" | "closed" | "errored"

export interface SessionOptions {
  readonly model: string
  readonly systemPrompt?: string
  readonly title?: string
  readonly tags?: ReadonlyArray<string>
  readonly parentSessionId?: string
  /**
   * Idle-timeout ceiling in ms. The SDK adapter races every query against
   * this watchdog, reset on each yielded message. Catches silent subprocess
   * hangs (DESIGN.md §12.2 invariant #5). Default 120_000 in the adapter.
   */
  readonly idleTimeoutMs?: number
  /**
   * If true, the adapter does NOT race the message Queue against an
   * idle-timeout watchdog. Use ONLY for long-lived interactive sessions
   * (chat threads) where user think-time legitimately exceeds any sane
   * timeout. Trades the silent-hang safety net (§12.2 #5) for survivability
   * across multi-minute pauses. Default: false.
   *
   * NOTE: this opt-out only disables the BETWEEN-turn idle watchdog. Chat
   * threads still get the TURN-AWARE inactivity watchdog below, which is armed
   * only while a turn is in flight — so a wedged subprocess is still caught
   * without false-tripping on inter-turn think-time.
   */
  readonly disableIdleTimeout?: boolean
  /**
   * Turn-aware inactivity watchdog window, in ms. ONLY consulted when
   * `disableIdleTimeout` is true (interactive chat threads — the path the
   * always-on idle timeout above is deliberately off for). The watchdog is
   * ARMED while a turn is in flight (a user prompt was offered and no SDK
   * `result` frame has closed it) and DISARMED between turns, so an hours-long
   * inter-turn pause never trips it. Any SDK message (assistant-delta,
   * tool-call event, partial) resets the window — a legitimately long agentic
   * turn that keeps streaming stays alive.
   *
   * On trip the adapter aborts the SDK query (kills the wedged subprocess),
   * reports a `rate_limit` to the broker so the account cools and the next
   * message routes to a healthy account, and fails the turn with a clean
   * SDKError (surfaced to the client as an assistant-error). It does NOT retry
   * the hung turn — deltas/tools may already have executed.
   *
   * `0` disables the watchdog (legacy `disableIdleTimeout` behavior — the hang
   * is NOT converted). Default in the adapter: 120_000 (env
   * `LUNA_TURN_INACTIVITY_TIMEOUT_MS`). Ignored when `disableIdleTimeout` is
   * false/unset.
   */
  readonly turnInactivityTimeoutMs?: number
  /**
   * Cooldown (ms) applied to the acquired account when the turn-inactivity
   * watchdog trips. Passed to the broker as the `rate_limit` retryAfterMs so
   * the wedged account is parked long enough that the next message fails over.
   * Default in the adapter: 900_000 (15 min; env `LUNA_HANG_COOLDOWN_MS`).
   * Ignored unless the watchdog is active and trips.
   */
  readonly hangCooldownMs?: number
  /**
   * Full SDK-shape options snapshot. Typed loosely here; schema'd in Phase 4.
   *
   * **Reserved keys — adapter-owned (DESIGN.md §12.2 invariant #7):**
   * The adapter ALWAYS overwrites these with adapter-managed values, and
   * will log a warning if the caller supplies them:
   *   - `hooks` — registered via `SDKAdapter.registerHook()`
   *   - `canUseTool` — registered via `SDKAdapter.setPermissionCallback()`
   *   - `abortController` — Scope-owned
   *   - `resume` / `forkSession` — lifecycle-owned
   *
   * All other keys pass through unchanged.
   */
  readonly sdkOptions?: Readonly<Record<string, unknown>>
}

/** Keys the SDK adapter claims exclusive ownership of. See SessionOptions docs. */
export const RESERVED_SDK_OPTION_KEYS = [
  "hooks",
  "canUseTool",
  "abortController",
  "resume",
  "forkSession",
] as const
export type ReservedSdkOptionKey = (typeof RESERVED_SDK_OPTION_KEYS)[number]

export interface SessionSummary {
  readonly id: string
  readonly parentId: string | null
  readonly title: string | null
  readonly tags: ReadonlyArray<string>
  readonly createdAt: number
  readonly endedAt: number | null
  readonly model: string
  /**
   * The session's persisted effort preference, when one is set: a real
   * effort level from `sdkOptions.effort` ("low" … "max") or "ultracode"
   * when the ultracode flag-settings token is persisted. Reflects
   * mid-thread switches (setThreadConfig), not just creation. Additive —
   * absent when the session has no explicit effort.
   */
  readonly effort?: string
  readonly status: SessionStatus
  /**
   * Wall-clock ts of the most recently appended message, or null if none yet.
   * Updated by SessionStore.appendMessage. Powers the chat sidebar's
   * recent-first ordering without requiring callers to scan the message log.
   */
  readonly lastMessageAt: number | null
  /**
   * Short text excerpt derived from the most recently appended message
   * (assistant text or user text, truncated). Null if the latest message is
   * not text-bearing (system/result/stream_event/etc.) or none exists yet.
   * Best-effort — adapters that store opaque payloads may produce nulls.
   */
  readonly lastMessagePreview: string | null
}

export interface SessionQuery {
  readonly status?: SessionStatus
  readonly tag?: string
  readonly parentId?: string
  readonly limit?: number
  /**
   * Sort order. Default "createdAt" (newest-first). Use "lastMessageAt" for
   * the chat sidebar's recent-activity-first list — sessions with no messages
   * fall back to createdAt to keep brand-new threads visible.
   */
  readonly orderBy?: "createdAt" | "lastMessageAt"
  /**
   * When true, only sessions that have at least one top-level user message
   * (kind='user', parent_id IS NULL) are returned. Applied BEFORE `limit` so
   * the page never under-fills with empty/probe threads. Used by the chat
   * sidebar, where a thread is not a real conversation until the user types.
   */
  readonly hasUserMessage?: boolean
  /**
   * Session ids to omit from the result. Applied BEFORE `limit` so excluded
   * sessions never occupy a page slot and evict rows that would otherwise be
   * returned. Used by the chat sidebar to drop archived threads in the store
   * query rather than post-filtering the already-limited page. An empty (or
   * omitted) list is a no-op.
   */
  readonly excludeIds?: ReadonlyArray<string>
}

/**
 * Opaque stand-ins for SDK message types. Core stays SDK-dependency-free at
 * runtime (see messages.ts + DESIGN.md §12.2 #6); the real SDK types live in
 * `@luna/adapter-sdk`. Callers who have the real types can pass
 * them through structurally — `unknown` is a supertype of every concrete
 * SDK message shape.
 */
export type SDKUserMessageLike = unknown
export type SDKMessageLike = unknown

/**
 * Scoped session handle returned by `SessionService.openScoped`.
 *
 * Per DESIGN.md §3.1 + §3.4 #4: this handle is pinned to the caller's Scope.
 * When the Scope closes, the underlying SDK query is interrupted and the
 * session's status is flipped to `closed` via a Scope finalizer.
 *
 * The `replies` stream is the adapter's own Stream — we do NOT fork a fiber
 * (§3.4 #1 — no cross-Scope Fiber references); the Stream's internal Scope
 * management composes with the caller's Scope for proper LIFO finalization.
 */
export interface ScopedSession {
  readonly id: string
  readonly send: (msg: SDKUserMessageLike) => Effect.Effect<void, never>
  readonly replies: Stream.Stream<SDKMessageLike, never>
  readonly close: Effect.Effect<void, never>
}
