/**
 * AnalyticsService — Cross-domain queries over sessions + events via DuckDB.
 *
 * Architecture:
 *   - makeLayer requires DuckDbService as an R dependency (injected, not owned)
 *   - At boot, applies CREATE TABLE IF NOT EXISTS migrations for `sessions`
 *     and `events` tables so the service works even without EventSink/SessionSync
 *   - All queries use Effect.gen + DuckDbService.query / write
 *   - No async/await — fully Effect-native
 */

import { Effect, Layer } from "effect"
import { DuckDbService } from "../db/duckdb-service.js"
import type {
  AnalyticsApi,
  AnalyticsConfig,
  AnalyticsQuery,
  AnalyticsResult,
  SessionTelemetryJoin,
} from "./types.js"

// ── Schema DDL (idempotent boot migrations) ───────────────────────────────────

const SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT NOT NULL PRIMARY KEY,
    parent_id   TEXT,
    model       TEXT NOT NULL,
    title       TEXT,
    tags        TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL,
    ended_at    TEXT,
    duration_ms REAL
  )
`

const EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    id            TEXT NOT NULL PRIMARY KEY,
    ts            TEXT NOT NULL,
    kind          TEXT NOT NULL,
    level         TEXT NOT NULL,
    session_id    TEXT,
    team          TEXT,
    workflow_id   TEXT,
    tool_name     TEXT,
    duration_ms   REAL,
    status        TEXT,
    estimated_usd REAL,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    error_tag     TEXT,
    raw_json      TEXT NOT NULL
  )
`

// ── Row shapes (cast from unknown[]) ─────────────────────────────────────────

interface SessionAggRow {
  id: string
  model: string | null
  status: string | null
  created_at: string | null
  ended_at: string | null
  duration_ms: number | null
  tool_count: number
  error_count: number
  event_count: number
}

interface ToolCountRow {
  tool_name: string
  cnt: number
}

// ── Service ───────────────────────────────────────────────────────────────────

export class AnalyticsService extends Effect.Tag("AnalyticsService")<
  AnalyticsService,
  AnalyticsApi
>() {
  /**
   * Build an AnalyticsService Layer that requires DuckDbService.
   * @param _config reserved for future options (dbPath is provided via DuckDbService)
   */
  static makeLayer(
    _config: AnalyticsConfig,
  ): Layer.Layer<AnalyticsService, never, DuckDbService> {
    return Layer.effect(
      AnalyticsService,
      Effect.gen(function* () {
        const db = yield* DuckDbService

        // Boot: ensure tables exist (idempotent)
        yield* db
          .migrate("analytics-sessions", 1, SESSIONS_DDL)
          .pipe(Effect.catchAllCause(() => Effect.void))
        yield* db
          .migrate("analytics-events", 1, EVENTS_DDL)
          .pipe(Effect.catchAllCause(() => Effect.void))

        // ── querySessionMetrics ───────────────────────────────────────────────
        const querySessionMetrics = (
          q: AnalyticsQuery,
        ): Effect.Effect<AnalyticsResult, import("../db/duckdb-service.js").DuckDbError> =>
          Effect.gen(function* () {
            const conditions: string[] = ["1=1"]
            const params: unknown[] = []

            if (q.sessionId) {
              conditions.push("s.id = ?")
              params.push(q.sessionId)
            }
            if (q.startTime) {
              conditions.push("s.created_at >= ?")
              params.push(q.startTime)
            }
            if (q.endTime) {
              conditions.push("s.created_at <= ?")
              params.push(q.endTime)
            }
            if (q.toolName) {
              // Filter to sessions that have at least one event with this tool
              conditions.push(
                "s.id IN (SELECT DISTINCT session_id FROM events WHERE tool_name = ?)",
              )
              params.push(q.toolName)
            }

            const limitClause =
              q.limit !== undefined ? `LIMIT ${Number(q.limit)}` : ""
            const where = conditions.join(" AND ")

            const sql = `
              SELECT
                s.id,
                s.model,
                s.status,
                s.created_at,
                s.ended_at,
                s.duration_ms,
                COUNT(CASE WHEN e.kind = 'ToolCall' THEN 1 END) AS tool_count,
                COUNT(CASE WHEN e.status = 'error'  THEN 1 END) AS error_count,
                COUNT(e.id) AS event_count
              FROM sessions s
              LEFT JOIN events e ON e.session_id = s.id
              WHERE ${where}
              GROUP BY s.id
              ${limitClause}
            `

            const rows = (yield* db.query(sql, params)) as SessionAggRow[]

            // For each session, also fetch per-tool counts
            const sessions: SessionTelemetryJoin[] = []
            let totalMessages = 0
            let totalToolUses = 0
            let totalErrors = 0

            for (const row of rows) {
              const toolRows = (yield* db.query(
                `SELECT tool_name, COUNT(*) AS cnt
                 FROM events
                 WHERE session_id = ? AND tool_name IS NOT NULL
                 GROUP BY tool_name`,
                [row.id],
              )) as ToolCountRow[]

              const toolUsageCount: Record<string, number> = {}
              for (const tr of toolRows) {
                toolUsageCount[tr.tool_name] = Number(tr.cnt)
              }

              const messageCount = Number(row.event_count)
              const toolCount = Number(row.tool_count)
              const errorCount = Number(row.error_count)
              const successCount = toolCount - errorCount

              totalMessages += messageCount
              totalToolUses += toolCount
              totalErrors += errorCount

              sessions.push({
                sessionId: row.id,
                sessionType: "assistant",
                entrypoint: row.model ?? "unknown",
                sessionStartTime: row.created_at ?? new Date().toISOString(),
                sessionEndTime:
                  row.ended_at ?? row.created_at ?? new Date().toISOString(),
                messageCount,
                metrics: {
                  toolUsageCount,
                  totalDuration: Number(row.duration_ms ?? 0),
                  errorCount,
                  successCount: Math.max(0, successCount),
                },
              })
            }

            const totalSessions = sessions.length
            const errorRate =
              totalToolUses > 0 ? totalErrors / totalToolUses : 0

            return {
              sessions,
              summary: {
                totalSessions,
                totalMessages,
                totalToolUses,
                errorRate,
              },
            } satisfies AnalyticsResult
          })

        // ── explainSession ────────────────────────────────────────────────────
        const explainSession = (
          sessionId: string,
        ): Effect.Effect<SessionTelemetryJoin, import("../db/duckdb-service.js").DuckDbError> =>
          Effect.gen(function* () {
            const sessionRows = (yield* db.query(
              `SELECT id, model, status, created_at, ended_at, duration_ms
               FROM sessions WHERE id = ?`,
              [sessionId],
            )) as SessionAggRow[]

            const sessionRow = sessionRows[0]

            const toolRows = (yield* db.query(
              `SELECT tool_name, COUNT(*) AS cnt
               FROM events
               WHERE session_id = ? AND tool_name IS NOT NULL
               GROUP BY tool_name`,
              [sessionId],
            )) as ToolCountRow[]

            const toolUsageCount: Record<string, number> = {}
            for (const tr of toolRows) {
              toolUsageCount[tr.tool_name] = Number(tr.cnt)
            }

            const errorRows = (yield* db.query(
              `SELECT
                 COUNT(CASE WHEN status = 'error' THEN 1 END) AS error_count,
                 COUNT(*) AS total_count
               FROM events WHERE session_id = ?`,
              [sessionId],
            )) as Array<{ error_count: number; total_count: number }>

            const errorCount = Number(errorRows[0]?.error_count ?? 0)
            const totalCount = Number(errorRows[0]?.total_count ?? 0)
            const successCount = Math.max(0, totalCount - errorCount)

            return {
              sessionId,
              sessionType: "assistant",
              entrypoint: sessionRow?.model ?? "unknown",
              sessionStartTime:
                sessionRow?.created_at ?? new Date().toISOString(),
              sessionEndTime:
                sessionRow?.ended_at ??
                sessionRow?.created_at ??
                new Date().toISOString(),
              messageCount: totalCount,
              metrics: {
                toolUsageCount,
                totalDuration: Number(sessionRow?.duration_ms ?? 0),
                errorCount,
                successCount,
              },
            } satisfies SessionTelemetryJoin
          })

        // ── findAnomalies ─────────────────────────────────────────────────────
        const findAnomalies = (
          threshold?: { errorRate?: number; duration?: number },
        ): Effect.Effect<
          ReadonlyArray<SessionTelemetryJoin>,
          import("../db/duckdb-service.js").DuckDbError
        > =>
          Effect.gen(function* () {
            const errorRateThreshold = threshold?.errorRate ?? 0.5
            const durationThreshold = threshold?.duration ?? null

            // Build HAVING clause dynamically
            const havingParts: string[] = []

            // errorRate condition: error_count / total_events > threshold
            // Guard against division by zero with CASE
            havingParts.push(
              `(CASE WHEN total_events > 0 THEN CAST(error_count AS REAL) / total_events ELSE 0 END) > ${errorRateThreshold}`,
            )

            if (durationThreshold !== null) {
              havingParts.push(
                `OR s.duration_ms > ${Number(durationThreshold)}`,
              )
            }

            const having = havingParts.join(" ")

            const sql = `
              SELECT
                s.id,
                s.model,
                s.status,
                s.created_at,
                s.ended_at,
                s.duration_ms,
                COUNT(CASE WHEN e.status = 'error' THEN 1 END) AS error_count,
                COUNT(e.id) AS total_events
              FROM sessions s
              LEFT JOIN events e ON e.session_id = s.id
              WHERE s.ended_at IS NOT NULL
              GROUP BY s.id
              HAVING ${having}
            `

            const rows = (yield* db.query(sql)) as Array<{
              id: string
              model: string | null
              status: string | null
              created_at: string | null
              ended_at: string | null
              duration_ms: number | null
              error_count: number
              total_events: number
            }>

            const results: SessionTelemetryJoin[] = []

            for (const row of rows) {
              const toolRows = (yield* db.query(
                `SELECT tool_name, COUNT(*) AS cnt
                 FROM events
                 WHERE session_id = ? AND tool_name IS NOT NULL
                 GROUP BY tool_name`,
                [row.id],
              )) as ToolCountRow[]

              const toolUsageCount: Record<string, number> = {}
              for (const tr of toolRows) {
                toolUsageCount[tr.tool_name] = Number(tr.cnt)
              }

              const errorCount = Number(row.error_count)
              const totalEvents = Number(row.total_events)
              const successCount = Math.max(0, totalEvents - errorCount)

              results.push({
                sessionId: row.id,
                sessionType: "assistant",
                entrypoint: row.model ?? "unknown",
                sessionStartTime: row.created_at ?? new Date().toISOString(),
                sessionEndTime:
                  row.ended_at ??
                  row.created_at ??
                  new Date().toISOString(),
                messageCount: totalEvents,
                metrics: {
                  toolUsageCount,
                  totalDuration: Number(row.duration_ms ?? 0),
                  errorCount,
                  successCount,
                },
              })
            }

            return results
          })

        return { querySessionMetrics, explainSession, findAnomalies } satisfies AnalyticsApi
      }),
    )
  }
}
