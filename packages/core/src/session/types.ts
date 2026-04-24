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
  readonly status: SessionStatus
}

export interface SessionQuery {
  readonly status?: SessionStatus
  readonly tag?: string
  readonly parentId?: string
  readonly limit?: number
}
