/**
 * Analytics types — queries combining session history + telemetry data.
 *
 * The analytics skill uses these types to provide cross-domain diagnostics:
 * answering questions like "what tools ran in this session and how long did they take?"
 * or "which sessions encountered errors and what was the pattern?"
 */

export interface SessionTelemetryJoin {
  // Session fields
  readonly sessionId: string
  readonly sessionType: "user" | "assistant" | "system"
  readonly entrypoint: string
  readonly sessionStartTime: string
  readonly sessionEndTime: string
  readonly messageCount: number

  // Telemetry aggregates for this session
  readonly metrics: {
    readonly toolUsageCount: Record<string, number>
    readonly totalDuration: number // milliseconds
    readonly errorCount: number
    readonly successCount: number
  }
}

export interface AnalyticsQuery {
  readonly sessionId?: string
  readonly toolName?: string
  readonly skillName?: string
  readonly startTime?: string // ISO 8601
  readonly endTime?: string // ISO 8601
  readonly includeMetrics?: boolean
  readonly limit?: number
}

export interface AnalyticsResult {
  readonly sessions: SessionTelemetryJoin[]
  readonly summary: {
    readonly totalSessions: number
    readonly totalMessages: number
    readonly totalToolUses: number
    readonly errorRate: number
  }
}

export interface AnalyticsApi {
  /**
   * Execute a cross-domain query joining session history + telemetry.
   * Returns sessions with aggregated metrics.
   */
  readonly querySessionMetrics: (q: AnalyticsQuery) => Promise<AnalyticsResult>

  /**
   * Detailed breakdown of a single session's operations.
   */
  readonly explainSession: (sessionId: string) => Promise<SessionTelemetryJoin>

  /**
   * Find anomalies: sessions with high error rates, long durations, etc.
   */
  readonly findAnomalies: (threshold?: {
    errorRate?: number
    duration?: number
  }) => Promise<SessionTelemetryJoin[]>
}

export interface AnalyticsConfig {
  readonly sessionHistoryDbPath: string
  readonly telemetryDbPath: string
}
