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
  /** Full SDK-shape options snapshot. Typed loosely here; schema'd in Phase 4. */
  readonly sdkOptions?: Readonly<Record<string, unknown>>
}

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
