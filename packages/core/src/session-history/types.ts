/**
 * Session history types — the contract for storing and querying agent sessions
 * alongside telemetry data for analytics.
 *
 * Mirrors sol-agent's cc_sessions table but designed for Luna's Effect/Layer
 * architecture and DuckDB backend.
 */

export interface SessionRecord {
  readonly type: "user" | "assistant" | "system"
  readonly entrypoint: string
  readonly sessionId: string
  readonly uuid: string
  readonly parentUuid: string | null
  readonly timestamp: string // ISO 8601
  readonly requestId: string | null
  readonly toolUseId: string | null
  readonly textContent: string
  readonly toolName: string | null
  readonly skillName: string | null
}

export interface SessionHistoryQuery {
  readonly sessionId?: string
  readonly type?: SessionRecord["type"]
  readonly toolName?: string
  readonly skillName?: string
  readonly startTime?: string // ISO 8601
  readonly endTime?: string // ISO 8601
  readonly limit?: number
}

export interface SessionHistoryApi {
  /**
   * Record a single message/event in session history.
   * Returns the UUID of the recorded message.
   */
  readonly record: (rec: SessionRecord) => Promise<string>

  /**
   * Query session history with optional filters.
   */
  readonly query: (q: SessionHistoryQuery) => Promise<SessionRecord[]>

  /**
   * Get a single session's full transcript.
   */
  readonly getSession: (sessionId: string) => Promise<SessionRecord[]>

  /**
   * Delete old session records (cleanup/retention policy).
   * Returns count of deleted rows.
   */
  readonly deleteOlderThan: (isoTimestamp: string) => Promise<number>
}

export interface SessionHistoryConfig {
  readonly dbPath: string
  readonly enableAudit?: boolean
}
