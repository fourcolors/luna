/**
 * AnalyticsService — Cross-domain queries over session history + telemetry
 * (Phase 27b, post-DuckDB integration).
 *
 * This service implements the analytics skill that allows agents to diagnose
 * issues by querying session transcripts alongside telemetry metrics. It joins
 * two data sources:
 *   - session_history (from SessionHistoryService)
 *   - telemetry_counters (from TelemetryService, to be moved to DuckDB)
 *
 * MVP (this PR):
 *   - Types and Layer skeleton
 *   - Mocked implementation
 *   - BDD tests for the query contract
 *
 * Phase 28 (future):
 *   - DuckDB driver integration
 *   - Real JOIN queries: session_history × telemetry
 *   - Anomaly detection algorithms
 *   - Performance optimization (indexes, materialized views)
 *
 * Architecture:
 *   - Layer.scoped for resource management (DuckDB connections)
 *   - ConfigError if databases unavailable
 *   - No daemon (analytics is pull-based, triggered by agents)
 */

import { Effect, Layer } from "effect"
import type { AnalyticsApi, AnalyticsConfig, AnalyticsQuery, AnalyticsResult } from "./types.js"

export class AnalyticsService extends Effect.Tag("AnalyticsService")<
  AnalyticsService,
  AnalyticsApi
>() {
  /**
   * Build a DuckDB-backed AnalyticsService Layer.
   * @param config Paths to session history and telemetry databases
   * @returns Layer providing AnalyticsApi
   */
  static makeLayer(config: AnalyticsConfig): Layer.Layer<AnalyticsService> {
    return Layer.succeed(AnalyticsService, {
      querySessionMetrics: async (_q) => {
        // TODO: DuckDB integration — query:
        // SELECT s.sessionId, COUNT(*) as messageCount,
        //        SUM(CASE WHEN t.errorCount > 0 THEN 1 ELSE 0 END) as errorCount
        //   FROM session_history s
        //   LEFT JOIN telemetry t ON s.sessionId = t.sessionId
        //   WHERE ...
        //   GROUP BY s.sessionId
        return {
          sessions: [],
          summary: {
            totalSessions: 0,
            totalMessages: 0,
            totalToolUses: 0,
            errorRate: 0,
          },
        }
      },

      explainSession: async (_sessionId) => {
        // TODO: detailed breakdown with JOIN
        return {
          sessionId: _sessionId,
          sessionType: "assistant",
          entrypoint: "unknown",
          sessionStartTime: new Date().toISOString(),
          sessionEndTime: new Date().toISOString(),
          messageCount: 0,
          metrics: {
            toolUsageCount: {},
            totalDuration: 0,
            errorCount: 0,
            successCount: 0,
          },
        }
      },

      findAnomalies: async (_threshold) => {
        // TODO: query for outliers (high error rate, long duration, etc.)
        return []
      },
    })
  }
}
